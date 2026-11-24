-- ============================================================
-- 20261124160000_ai_lock_fencing_and_send_idempotency.sql
--
-- 1. Adds monotonic `ai_processing_fencing_token` to `conversations`
--    plus lease acquisition (`acquire_ai_conversation_lease`),
--    heartbeat renewal (`renew_ai_conversation_lock`), and
--    fencing verification (`verify_ai_conversation_lease`).
-- 2. Creates `ai_outbound_intents` to track outbound WhatsApp send
--    intentions before calling Meta API, explicitly separating:
--    not_started | processing | confirmed | failed_definitive | unknown_outcome
-- 3. Adds `ai_cron_locks` for single-flight cron execution protection.
--
-- Idempotent and non-destructive.
-- ============================================================

-- 1. Fencing token on conversations
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_processing_fencing_token bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.acquire_ai_conversation_lease(
  p_conversation_id uuid,
  p_lock_token text,
  p_ttl_seconds integer DEFAULT 45
)
RETURNS TABLE(acquired boolean, fencing_token bigint) AS $$
  WITH locked AS (
    UPDATE conversations
    SET ai_processing_lock_until = now() + (GREATEST(p_ttl_seconds, 5) || ' seconds')::interval,
        ai_processing_lock_token = p_lock_token,
        ai_processing_fencing_token = COALESCE(ai_processing_fencing_token, 0) + 1
    WHERE id = p_conversation_id
      AND (
        ai_processing_lock_until IS NULL
        OR ai_processing_lock_until < now()
        OR ai_processing_lock_token = p_lock_token
      )
    RETURNING ai_processing_fencing_token
  )
  SELECT
    EXISTS (SELECT 1 FROM locked) AS acquired,
    COALESCE((SELECT ai_processing_fencing_token FROM locked LIMIT 1), 0) AS fencing_token;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.renew_ai_conversation_lock(
  p_conversation_id uuid,
  p_lock_token text,
  p_fencing_token bigint,
  p_ttl_seconds integer DEFAULT 45
)
RETURNS boolean AS $$
  WITH renewed AS (
    UPDATE conversations
    SET ai_processing_lock_until = now() + (GREATEST(p_ttl_seconds, 5) || ' seconds')::interval
    WHERE id = p_conversation_id
      AND ai_processing_lock_token = p_lock_token
      AND ai_processing_fencing_token = p_fencing_token
      AND ai_processing_lock_until >= now()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM renewed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.verify_ai_conversation_lease(
  p_conversation_id uuid,
  p_lock_token text,
  p_fencing_token bigint
)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM conversations
    WHERE id = p_conversation_id
      AND ai_processing_lock_token = p_lock_token
      AND ai_processing_fencing_token = p_fencing_token
      AND ai_processing_lock_until >= now()
  );
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.acquire_ai_conversation_lease(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_ai_conversation_lock(uuid, text, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_ai_conversation_lease(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_ai_conversation_lease(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_ai_conversation_lock(uuid, text, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_ai_conversation_lease(uuid, text, bigint) TO service_role;

-- 2. Outbound send idempotency ledger
CREATE TABLE IF NOT EXISTS ai_outbound_intents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  idempotency_key   text NOT NULL UNIQUE,
  intent_type       text NOT NULL CHECK (intent_type IN ('text', 'media', 'handoff', 'lead_update')),
  status            text NOT NULL DEFAULT 'not_started'
                    CHECK (status IN ('not_started', 'processing', 'confirmed', 'failed_definitive', 'unknown_outcome')),
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  wa_message_id     text,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_outbound_intents_conv_created
  ON ai_outbound_intents(conversation_id, created_at DESC);

ALTER TABLE ai_outbound_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_outbound_intents_select ON ai_outbound_intents;
CREATE POLICY ai_outbound_intents_select ON ai_outbound_intents FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- 3. Single-flight cron lock table
CREATE TABLE IF NOT EXISTS ai_cron_locks (
  cron_name    text PRIMARY KEY,
  lock_token   text NOT NULL,
  locked_until timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_cron_locks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.acquire_ai_cron_lock(
  p_cron_name text,
  p_lock_token text,
  p_ttl_seconds integer DEFAULT 55
)
RETURNS boolean AS $$
  INSERT INTO ai_cron_locks (cron_name, lock_token, locked_until, updated_at)
  VALUES (
    p_cron_name,
    p_lock_token,
    now() + (GREATEST(p_ttl_seconds, 10) || ' seconds')::interval,
    now()
  )
  ON CONFLICT (cron_name) DO UPDATE
  SET lock_token = EXCLUDED.lock_token,
      locked_until = EXCLUDED.locked_until,
      updated_at = now()
  WHERE ai_cron_locks.locked_until < now()
     OR ai_cron_locks.lock_token = EXCLUDED.lock_token
  RETURNING true;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.release_ai_cron_lock(
  p_cron_name text,
  p_lock_token text
)
RETURNS boolean AS $$
  WITH deleted AS (
    DELETE FROM ai_cron_locks
    WHERE cron_name = p_cron_name
      AND lock_token = p_lock_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM deleted);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.acquire_ai_cron_lock(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_ai_cron_lock(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_ai_cron_lock(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ai_cron_lock(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.get_ai_usage_summary(uuid, timestamptz, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_usage_summary(uuid, timestamptz, timestamptz, text, text, text) TO service_role;
