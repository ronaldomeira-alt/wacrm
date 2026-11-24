-- ============================================================
-- 20261124193000_ai_usage_summary_measured_counts.sql
--
-- Extends `get_ai_usage_summary` totals with `cost_measured_calls`
-- and `cache_measured_calls` so the UI can distinguish historical
-- rows where cost/cache were not recorded (NULL) from real zeros.
--
-- Non-destructive & idempotent.
-- ============================================================

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
      cached_tokens,
      reasoning_tokens,
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
      COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::bigint AS cost_measured_calls,
      COUNT(*) FILTER (WHERE cached_tokens IS NOT NULL)::bigint AS cache_measured_calls,
      COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
      COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)::bigint AS cached_tokens,
      COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0)::bigint AS reasoning_tokens,
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
        COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)::bigint AS cached_tokens,
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
        COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)::bigint AS cached_tokens,
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
        COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)::bigint AS cached_tokens,
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
        COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)::bigint AS cached_tokens,
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

REVOKE ALL ON FUNCTION public.get_ai_usage_summary(uuid, timestamptz, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_usage_summary(uuid, timestamptz, timestamptz, text, text, text) TO service_role;
