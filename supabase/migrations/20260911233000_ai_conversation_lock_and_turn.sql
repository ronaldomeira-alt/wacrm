-- ============================================================
-- 20260911233000_ai_conversation_lock_and_turn.sql
--
-- Adds structural conversation lock, timestamp tracking, and atomic
-- RPCs to prevent race conditions and duplicate AI turns across
-- concurrent webhooks and fast-arriving customer WhatsApp messages.
--
-- Non-destructive & idempotent.
-- ============================================================

-- 1. Conversation lock & turn tracking columns
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_processing_lock_until timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_processing_lock_token text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_last_inbound_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_last_turn_processed_at timestamptz DEFAULT NULL;

-- 2. Atomic lock acquisition RPC
CREATE OR REPLACE FUNCTION public.acquire_ai_conversation_lock(
  p_conversation_id uuid,
  p_lock_token text,
  p_ttl_seconds integer DEFAULT 45
)
RETURNS boolean AS $$
  WITH locked AS (
    UPDATE conversations
    SET ai_processing_lock_until = now() + (GREATEST(p_ttl_seconds, 5) || ' seconds')::interval,
        ai_processing_lock_token = p_lock_token
    WHERE id = p_conversation_id
      AND (
        ai_processing_lock_until IS NULL
        OR ai_processing_lock_until < now()
        OR ai_processing_lock_token = p_lock_token
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM locked);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- 3. Atomic lock release RPC
CREATE OR REPLACE FUNCTION public.release_ai_conversation_lock(
  p_conversation_id uuid,
  p_lock_token text
)
RETURNS boolean AS $$
  WITH released AS (
    UPDATE conversations
    SET ai_processing_lock_until = NULL,
        ai_processing_lock_token = NULL
    WHERE id = p_conversation_id
      AND ai_processing_lock_token = p_lock_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM released);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- 4. Permissions
GRANT EXECUTE ON FUNCTION public.acquire_ai_conversation_lock(uuid, text, integer) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.release_ai_conversation_lock(uuid, text) TO service_role, authenticated;
