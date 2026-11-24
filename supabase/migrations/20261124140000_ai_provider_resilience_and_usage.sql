-- ============================================================
-- 20261124140000_ai_provider_resilience_and_usage.sql
--
-- Etapa 2 infrastructure for WACRM AI resilience & usage accuracy:
-- 1. Extend `ai_configs` with OpenCode Go key, secondary provider/model,
--    independent timeouts (45s default), fallback toggle, and quota guards.
-- 2. Create `ai_provider_circuits` for persistent circuit breaker state.
-- 3. Create `ai_fallback_events` for fallback audit trail.
-- 4. Create `ai_reply_queue` for persistent automatic recovery when both
--    providers are unavailable.
-- 5. Extend `ai_usage_log` with cache/reasoning tokens, latency, status,
--    fallback flag, cost USD/BRL, and consumption_type; plus Postgres
--    aggregation RPC `get_ai_usage_summary` to eliminate PostgREST 1,000-row
--    truncation.
--
-- Idempotent and non-destructive.
-- ============================================================

-- 1. Extend ai_configs
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS opencode_go_api_key text,
  ADD COLUMN IF NOT EXISTS fallback_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS secondary_provider text,
  ADD COLUMN IF NOT EXISTS secondary_model text,
  ADD COLUMN IF NOT EXISTS primary_timeout_ms integer NOT NULL DEFAULT 45000,
  ADD COLUMN IF NOT EXISTS secondary_timeout_ms integer NOT NULL DEFAULT 45000,
  ADD COLUMN IF NOT EXISTS opencode_wacrm_reserve_pct numeric(5,2) NOT NULL DEFAULT 15.00,
  ADD COLUMN IF NOT EXISTS opencode_global_preventive_pct numeric(5,2) NOT NULL DEFAULT 75.00,
  ADD COLUMN IF NOT EXISTS opencode_margin_pct numeric(5,2) NOT NULL DEFAULT 25.00,
  ADD COLUMN IF NOT EXISTS circuit_failure_threshold integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS circuit_cooldown_seconds integer NOT NULL DEFAULT 120;

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'deepseek', 'opencode_go'));

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_secondary_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_secondary_provider_check
  CHECK (secondary_provider IS NULL OR secondary_provider IN ('openai', 'anthropic', 'deepseek', 'opencode_go'));

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_primary_timeout_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_primary_timeout_check
  CHECK (primary_timeout_ms BETWEEN 5000 AND 120000);

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_secondary_timeout_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_secondary_timeout_check
  CHECK (secondary_timeout_ms BETWEEN 5000 AND 120000);

-- 2. Persistent Circuit Breaker State
CREATE TABLE IF NOT EXISTS ai_provider_circuits (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider               text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'deepseek', 'opencode_go')),
  state                  text NOT NULL DEFAULT 'operational'
                         CHECK (state IN ('operational', 'suspended', 'quota_exhausted', 'auth_failed', 'half_open', 'disabled')),
  consecutive_failures   integer NOT NULL DEFAULT 0,
  last_failure_at        timestamptz,
  last_failure_reason    text,
  last_error_code        text,
  opened_at              timestamptz,
  next_probe_at          timestamptz,
  quota_reset_at         timestamptz,
  probe_in_flight_until  timestamptz,
  last_success_at        timestamptz,
  last_latency_ms        integer,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_circuits_account
  ON ai_provider_circuits(account_id);

ALTER TABLE ai_provider_circuits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_provider_circuits_select ON ai_provider_circuits;
CREATE POLICY ai_provider_circuits_select ON ai_provider_circuits FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- 3. Fallback Events Audit Trail
CREATE TABLE IF NOT EXISTS ai_fallback_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  mode            text NOT NULL,
  from_provider   text NOT NULL,
  from_model      text NOT NULL,
  to_provider     text NOT NULL,
  to_model        text NOT NULL,
  error_code      text NOT NULL,
  reason          text NOT NULL,
  latency_ms      integer,
  recovered       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_fallback_events_account_created
  ON ai_fallback_events(account_id, created_at DESC);

ALTER TABLE ai_fallback_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_fallback_events_select ON ai_fallback_events;
CREATE POLICY ai_fallback_events_select ON ai_fallback_events FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- 4. Persistent Recovery Queue for Unanswered Inbound Messages
CREATE TABLE IF NOT EXISTS ai_reply_queue (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id    uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  inbound_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  execution_token    uuid NOT NULL DEFAULT gen_random_uuid(),
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'completed', 'cancelled_human', 'cancelled_window', 'needs_human_supervision')),
  attempts           integer NOT NULL DEFAULT 0,
  max_attempts       integer NOT NULL DEFAULT 6,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  last_error         text,
  last_error_code    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_reply_queue_active_conversation
  ON ai_reply_queue(conversation_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_ai_reply_queue_due
  ON ai_reply_queue(status, next_attempt_at)
  WHERE status = 'pending';

ALTER TABLE ai_reply_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_reply_queue_select ON ai_reply_queue;
CREATE POLICY ai_reply_queue_select ON ai_reply_queue FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- 5. Extend ai_usage_log
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS cached_tokens integer,
  ADD COLUMN IF NOT EXISTS reasoning_tokens integer,
  ADD COLUMN IF NOT EXISTS latency_ms integer,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS error_reason text,
  ADD COLUMN IF NOT EXISTS fallback_used boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attempt_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS cost_usd numeric(12,6),
  ADD COLUMN IF NOT EXISTS cost_brl numeric(12,6),
  ADD COLUMN IF NOT EXISTS usd_brl_rate numeric(10,4),
  ADD COLUMN IF NOT EXISTS consumption_type text NOT NULL DEFAULT 'confirmed';

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'deepseek', 'opencode_go'));

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN (
    'auto_reply', 'draft', 'lead_analysis', 'followup', 'learning',
    'ctwa_rescue', 'template_fill', 'smart_send', 'playground', 'test', 'recovery'
  ));

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_status_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_status_check
  CHECK (status IN ('completed', 'failed', 'timeout', 'aborted'));

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_consumption_type_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_consumption_type_check
  CHECK (consumption_type IN ('confirmed', 'estimated', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_account_filters
  ON ai_usage_log(account_id, created_at DESC, provider, model, mode);

-- 6. Postgres Aggregation RPC for Usage Panel (eliminates 1,000-row PostgREST truncation)
CREATE OR REPLACE FUNCTION get_ai_usage_summary(
  p_account_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz DEFAULT now(),
  p_provider text DEFAULT NULL,
  p_model text DEFAULT NULL,
  p_mode text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH filtered AS (
    SELECT
      created_at,
      mode,
      provider,
      model,
      prompt_tokens,
      completion_tokens,
      COALESCE(cached_tokens, 0) AS cached_tokens,
      COALESCE(reasoning_tokens, 0) AS reasoning_tokens,
      total_tokens,
      latency_ms,
      status,
      fallback_used,
      cost_usd,
      cost_brl,
      consumption_type
    FROM ai_usage_log
    WHERE account_id = p_account_id
      AND created_at >= p_start_at
      AND created_at <= p_end_at
      AND (p_provider IS NULL OR provider = p_provider)
      AND (p_model IS NULL OR model = p_model)
      AND (p_mode IS NULL OR mode = p_mode)
  ),
  totals AS (
    SELECT
      COUNT(*)::bigint AS attempts,
      COUNT(*) FILTER (WHERE status = 'completed')::bigint AS completed_calls,
      COUNT(*) FILTER (WHERE status <> 'completed')::bigint AS failed_calls,
      COUNT(*) FILTER (WHERE fallback_used)::bigint AS fallback_calls,
      COUNT(*) FILTER (WHERE consumption_type = 'confirmed')::bigint AS confirmed_calls,
      COUNT(*) FILTER (WHERE consumption_type = 'estimated')::bigint AS estimated_calls,
      COUNT(*) FILTER (WHERE consumption_type = 'unknown')::bigint AS unknown_calls,
      COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
      COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens,
      COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
      COALESCE(SUM(cost_usd), 0)::numeric(14,6) AS cost_usd,
      COALESCE(SUM(cost_brl), 0)::numeric(14,6) AS cost_brl,
      ROUND(AVG(latency_ms))::integer AS avg_latency_ms
    FROM filtered
  ),
  by_provider AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'provider', provider,
        'attempts', attempts,
        'completed_calls', completed_calls,
        'prompt_tokens', prompt_tokens,
        'completion_tokens', completion_tokens,
        'cached_tokens', cached_tokens,
        'total_tokens', total_tokens,
        'cost_usd', cost_usd,
        'cost_brl', cost_brl
      ) ORDER BY total_tokens DESC
    ), '[]'::jsonb) AS items
    FROM (
      SELECT
        provider,
        COUNT(*)::bigint AS attempts,
        COUNT(*) FILTER (WHERE status = 'completed')::bigint AS completed_calls,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(cost_usd), 0)::numeric(14,6) AS cost_usd,
        COALESCE(SUM(cost_brl), 0)::numeric(14,6) AS cost_brl
      FROM filtered
      GROUP BY provider
    ) s
  ),
  by_mode AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'mode', mode,
        'calls', calls,
        'prompt_tokens', prompt_tokens,
        'completion_tokens', completion_tokens,
        'cached_tokens', cached_tokens,
        'total_tokens', total_tokens,
        'cost_usd', cost_usd,
        'cost_brl', cost_brl
      ) ORDER BY total_tokens DESC
    ), '[]'::jsonb) AS items
    FROM (
      SELECT
        mode,
        COUNT(*)::bigint AS calls,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(cost_usd), 0)::numeric(14,6) AS cost_usd,
        COALESCE(SUM(cost_brl), 0)::numeric(14,6) AS cost_brl
      FROM filtered
      GROUP BY mode
    ) s
  ),
  by_model AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'provider', provider,
        'model', model,
        'calls', calls,
        'prompt_tokens', prompt_tokens,
        'completion_tokens', completion_tokens,
        'cached_tokens', cached_tokens,
        'total_tokens', total_tokens,
        'cost_usd', cost_usd,
        'cost_brl', cost_brl
      ) ORDER BY total_tokens DESC
    ), '[]'::jsonb) AS items
    FROM (
      SELECT
        provider,
        model,
        COUNT(*)::bigint AS calls,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(cost_usd), 0)::numeric(14,6) AS cost_usd,
        COALESCE(SUM(cost_brl), 0)::numeric(14,6) AS cost_brl
      FROM filtered
      GROUP BY provider, model
    ) s
  ),
  daily AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'date', day_key,
        'calls', calls,
        'prompt_tokens', prompt_tokens,
        'completion_tokens', completion_tokens,
        'cached_tokens', cached_tokens,
        'total_tokens', total_tokens,
        'cost_usd', cost_usd,
        'cost_brl', cost_brl
      ) ORDER BY day_key ASC
    ), '[]'::jsonb) AS items
    FROM (
      SELECT
        to_char(created_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS day_key,
        COUNT(*)::bigint AS calls,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(cost_usd), 0)::numeric(14,6) AS cost_usd,
        COALESCE(SUM(cost_brl), 0)::numeric(14,6) AS cost_brl
      FROM filtered
      GROUP BY day_key
    ) s
  )
  SELECT jsonb_build_object(
    'totals', (SELECT row_to_json(totals)::jsonb FROM totals),
    'by_provider', (SELECT items FROM by_provider),
    'by_mode', (SELECT items FROM by_mode),
    'by_model', (SELECT items FROM by_model),
    'daily', (SELECT items FROM daily)
  );
$$;
