-- ============================================================
-- 20261125220000_ai_usage_usd_breakdown.sql
--
-- Extends `ai_usage_log` and `get_ai_usage_summary` for USD cost view:
-- 1. Adds high-precision USD component columns (`input_cost_usd`,
--    `cache_cost_usd`, `output_cost_usd`), `billed_cost_usd`
--    (actual charge vs subscription equivalent), `opencode_allowance_usd`,
--    `billing_source`, and `cost_source` ('provider_confirmed' |
--    'estimated' | 'unknown').
-- 2. Widens `cost_usd` and `cost_brl` to numeric(16,10) so sub-cent
--    calculations never lose precision before visual rounding.
-- 3. Reconstructs historical USD costs for completed calls with
--    sufficient token/model/provider/timestamp metadata, strictly
--    separating OpenCode Go tariffs from DeepSeek Official tariffs
--    and applying official UTC peak-hour multipliers (2x on Mon-Fri
--    01:00-04:00 and 06:00-10:00 UTC for DeepSeek V4.1 Flash / V4 Pro).
-- 4. Updates `get_ai_usage_summary` so unknown rows remain NULL (never
--    coerced to 0) and returns per-component USD breakdowns across
--    totals, daily, by_provider, by_model, and by_mode.
--
-- Non-destructive & idempotent.
-- ============================================================

-- 1. Extend ai_usage_log precision and columns
ALTER TABLE ai_usage_log
  ALTER COLUMN cost_usd TYPE numeric(16,10),
  ALTER COLUMN cost_brl TYPE numeric(16,10);

ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS input_cost_usd numeric(16,10),
  ADD COLUMN IF NOT EXISTS cache_cost_usd numeric(16,10),
  ADD COLUMN IF NOT EXISTS output_cost_usd numeric(16,10),
  ADD COLUMN IF NOT EXISTS billed_cost_usd numeric(16,10),
  ADD COLUMN IF NOT EXISTS opencode_allowance_usd numeric(16,10),
  ADD COLUMN IF NOT EXISTS billing_source text,
  ADD COLUMN IF NOT EXISTS cost_source text;

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_cost_source_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_cost_source_check
  CHECK (cost_source IS NULL OR cost_source IN ('provider_confirmed', 'estimated', 'unknown'));

-- 2. Backfill / reconstruct historical rows where provider didn't already confirm exact cost
WITH computed AS (
  SELECT
    id,
    status,
    prompt_tokens,
    completion_tokens,
    COALESCE(cached_tokens, 0) AS cached_tok,
    COALESCE(usd_brl_rate, 5.8)::numeric(10,4) AS eff_rate,
    provider,
    model,
    billing_source,
    (
      EXTRACT(ISODOW FROM (created_at AT TIME ZONE 'UTC')) BETWEEN 1 AND 5
      AND (
        ((created_at AT TIME ZONE 'UTC')::time >= time '01:00' AND (created_at AT TIME ZONE 'UTC')::time < time '04:00')
        OR
        ((created_at AT TIME ZONE 'UTC')::time >= time '06:00' AND (created_at AT TIME ZONE 'UTC')::time < time '10:00')
      )
    ) AS is_ds_peak
  FROM ai_usage_log
  WHERE cost_source IS NULL OR cost_source <> 'provider_confirmed'
),
priced AS (
  SELECT
    id,
    status,
    prompt_tokens,
    completion_tokens,
    LEAST(cached_tok, prompt_tokens) AS eff_cached,
    GREATEST(0, prompt_tokens - LEAST(cached_tok, prompt_tokens)) AS eff_uncached,
    eff_rate,
    provider,
    billing_source,
    CASE
      WHEN provider = 'deepseek' AND model IN ('deepseek-flash', 'deepseek-chat') THEN
        CASE WHEN is_ds_peak THEN 0.30 ELSE 0.15 END
      WHEN provider = 'deepseek' AND model = 'deepseek-v4-pro' THEN
        CASE WHEN is_ds_peak THEN 1.32 ELSE 0.66 END
      WHEN provider = 'opencode_go' AND model = 'deepseek-v4.1-flash' THEN
        CASE WHEN is_ds_peak THEN 0.30 ELSE 0.15 END
      WHEN provider = 'opencode_go' AND model = 'deepseek-v4-pro' THEN
        CASE WHEN is_ds_peak THEN 1.32 ELSE 0.66 END
      WHEN provider = 'opencode_go' AND model = 'glm-5.3-flash' THEN 0.15
      WHEN provider = 'opencode_go' AND model = 'mimo-v2.6-flash' THEN 0.14
      WHEN provider = 'opencode_go' AND model = 'qwen3.8-flash' THEN 0.15
      WHEN provider = 'opencode_go' AND model LIKE '%-free' THEN 0.0
      WHEN provider = 'openai' AND model IN ('gpt-5.4-mini', 'gpt-4o-mini') THEN 0.15
      WHEN provider = 'openai' AND model = 'gpt-4.1-mini' THEN 0.40
      WHEN provider = 'openai' AND model = 'gpt-4.1' THEN 2.00
      WHEN provider = 'openai' AND model = 'gpt-4o' THEN 2.50
      WHEN provider = 'openai' AND model = 'o4-mini' THEN 1.10
      WHEN provider = 'anthropic' AND model = 'claude-haiku-4-5-20251001' THEN 0.80
      WHEN provider = 'anthropic' AND model = 'claude-3-5-haiku-latest' THEN 0.80
      WHEN provider = 'anthropic' AND model IN ('claude-sonnet-4-5-20250929', 'claude-3-5-sonnet-latest') THEN 3.00
      ELSE NULL
    END::numeric(16,10) AS in_per_1m,
    CASE
      WHEN provider = 'deepseek' AND model IN ('deepseek-flash', 'deepseek-chat') THEN
        CASE WHEN is_ds_peak THEN 0.006 ELSE 0.003 END
      WHEN provider = 'deepseek' AND model = 'deepseek-v4-pro' THEN
        CASE WHEN is_ds_peak THEN 0.044 ELSE 0.022 END
      WHEN provider = 'opencode_go' AND model = 'deepseek-v4.1-flash' THEN
        CASE WHEN is_ds_peak THEN 0.006 ELSE 0.003 END
      WHEN provider = 'opencode_go' AND model = 'deepseek-v4-pro' THEN
        CASE WHEN is_ds_peak THEN 0.044 ELSE 0.022 END
      WHEN provider = 'opencode_go' AND model = 'glm-5.3-flash' THEN 0.03
      WHEN provider = 'opencode_go' AND model = 'mimo-v2.6-flash' THEN 0.0028
      WHEN provider = 'opencode_go' AND model = 'qwen3.8-flash' THEN 0.016
      WHEN provider = 'opencode_go' AND model LIKE '%-free' THEN 0.0
      WHEN provider = 'openai' AND model IN ('gpt-5.4-mini', 'gpt-4o-mini') THEN 0.075
      WHEN provider = 'openai' AND model = 'gpt-4.1-mini' THEN 0.10
      WHEN provider = 'openai' AND model = 'gpt-4.1' THEN 0.50
      WHEN provider = 'openai' AND model = 'gpt-4o' THEN 1.25
      WHEN provider = 'openai' AND model = 'o4-mini' THEN 0.275
      WHEN provider = 'anthropic' AND model IN ('claude-haiku-4-5-20251001', 'claude-3-5-haiku-latest') THEN 0.08
      WHEN provider = 'anthropic' AND model IN ('claude-sonnet-4-5-20250929', 'claude-3-5-sonnet-latest') THEN 0.30
      ELSE NULL
    END::numeric(16,10) AS cache_per_1m,
    CASE
      WHEN provider = 'deepseek' AND model IN ('deepseek-flash', 'deepseek-chat') THEN
        CASE WHEN is_ds_peak THEN 1.20 ELSE 0.60 END
      WHEN provider = 'deepseek' AND model = 'deepseek-v4-pro' THEN
        CASE WHEN is_ds_peak THEN 3.96 ELSE 1.98 END
      WHEN provider = 'opencode_go' AND model = 'deepseek-v4.1-flash' THEN
        CASE WHEN is_ds_peak THEN 1.20 ELSE 0.60 END
      WHEN provider = 'opencode_go' AND model = 'deepseek-v4-pro' THEN
        CASE WHEN is_ds_peak THEN 3.96 ELSE 1.98 END
      WHEN provider = 'opencode_go' AND model = 'glm-5.3-flash' THEN 0.50
      WHEN provider = 'opencode_go' AND model = 'mimo-v2.6-flash' THEN 0.28
      WHEN provider = 'opencode_go' AND model = 'qwen3.8-flash' THEN 0.47
      WHEN provider = 'opencode_go' AND model LIKE '%-free' THEN 0.0
      WHEN provider = 'openai' AND model IN ('gpt-5.4-mini', 'gpt-4o-mini') THEN 0.60
      WHEN provider = 'openai' AND model = 'gpt-4.1-mini' THEN 1.60
      WHEN provider = 'openai' AND model = 'gpt-4.1' THEN 8.00
      WHEN provider = 'openai' AND model = 'gpt-4o' THEN 10.00
      WHEN provider = 'openai' AND model = 'o4-mini' THEN 4.40
      WHEN provider = 'anthropic' AND model = 'claude-haiku-4-5-20251001' THEN 4.00
      WHEN provider = 'anthropic' AND model = 'claude-3-5-haiku-latest' THEN 4.00
      WHEN provider = 'anthropic' AND model IN ('claude-sonnet-4-5-20250929', 'claude-3-5-sonnet-latest') THEN 15.00
      ELSE NULL
    END::numeric(16,10) AS out_per_1m
  FROM computed
)
UPDATE ai_usage_log AS t
SET
  input_cost_usd = CASE
    WHEN p.status = 'completed' AND (p.prompt_tokens > 0 OR p.completion_tokens > 0) AND p.in_per_1m IS NOT NULL
      THEN ROUND((p.eff_uncached::numeric * p.in_per_1m) / 1000000.0, 10)
    ELSE NULL
  END,
  cache_cost_usd = CASE
    WHEN p.status = 'completed' AND (p.prompt_tokens > 0 OR p.completion_tokens > 0) AND p.cache_per_1m IS NOT NULL
      THEN ROUND((p.eff_cached::numeric * p.cache_per_1m) / 1000000.0, 10)
    ELSE NULL
  END,
  output_cost_usd = CASE
    WHEN p.status = 'completed' AND (p.prompt_tokens > 0 OR p.completion_tokens > 0) AND p.out_per_1m IS NOT NULL
      THEN ROUND((p.completion_tokens::numeric * p.out_per_1m) / 1000000.0, 10)
    ELSE NULL
  END,
  cost_usd = CASE
    WHEN p.status = 'completed' AND (p.prompt_tokens > 0 OR p.completion_tokens > 0) AND p.in_per_1m IS NOT NULL
      THEN ROUND(
        (p.eff_uncached::numeric * p.in_per_1m + p.eff_cached::numeric * p.cache_per_1m + p.completion_tokens::numeric * p.out_per_1m) / 1000000.0,
        10
      )
    ELSE NULL
  END,
  cost_brl = CASE
    WHEN p.status = 'completed' AND (p.prompt_tokens > 0 OR p.completion_tokens > 0) AND p.in_per_1m IS NOT NULL
      THEN ROUND(
        ((p.eff_uncached::numeric * p.in_per_1m + p.eff_cached::numeric * p.cache_per_1m + p.completion_tokens::numeric * p.out_per_1m) / 1000000.0) * p.eff_rate,
        10
      )
    ELSE NULL
  END,
  billed_cost_usd = CASE
    WHEN p.status = 'completed' AND (p.prompt_tokens > 0 OR p.completion_tokens > 0) AND p.in_per_1m IS NOT NULL
      THEN CASE
        WHEN p.provider = 'opencode_go' THEN 0::numeric(16,10)
        ELSE ROUND(
          (p.eff_uncached::numeric * p.in_per_1m + p.eff_cached::numeric * p.cache_per_1m + p.completion_tokens::numeric * p.out_per_1m) / 1000000.0,
          10
        )
      END
    ELSE NULL
  END,
  billing_source = CASE
    WHEN p.status = 'completed' AND (p.prompt_tokens > 0 OR p.completion_tokens > 0) AND p.in_per_1m IS NOT NULL
      THEN COALESCE(p.billing_source, CASE WHEN p.provider = 'opencode_go' THEN 'go' ELSE 'direct_api' END)
    ELSE p.billing_source
  END,
  consumption_type = CASE
    WHEN p.status = 'completed' AND (p.prompt_tokens > 0 OR p.completion_tokens > 0) AND p.in_per_1m IS NOT NULL
      THEN CASE WHEN p.provider = 'opencode_go' THEN 'estimated' ELSE 'confirmed' END
    ELSE 'unknown'
  END,
  cost_source = CASE
    WHEN p.status = 'completed' AND (p.prompt_tokens > 0 OR p.completion_tokens > 0) AND p.in_per_1m IS NOT NULL
      THEN 'estimated'
    ELSE 'unknown'
  END
FROM priced p
WHERE t.id = p.id;

-- 3. Update PostgreSQL aggregation RPC with component USD totals & strict NULL preservation for unknowns
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
      input_cost_usd,
      cache_cost_usd,
      output_cost_usd,
      billed_cost_usd,
      cost_brl,
      consumption_type,
      cost_source
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
      COUNT(*) FILTER (WHERE cost_usd IS NULL)::bigint AS cost_unknown_calls,
      COUNT(*) FILTER (WHERE cost_source = 'provider_confirmed')::bigint AS provider_confirmed_calls,
      COUNT(*) FILTER (WHERE cost_source = 'estimated')::bigint AS cost_estimated_calls,
      COUNT(*) FILTER (WHERE cached_tokens IS NOT NULL)::bigint AS cache_measured_calls,
      COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
      COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)::bigint AS cached_tokens,
      COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0)::bigint AS reasoning_tokens,
      COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
      CASE
        WHEN COUNT(*) = 0 THEN 0::numeric(16,10)
        WHEN COUNT(*) FILTER (WHERE cost_usd IS NOT NULL) = 0 THEN NULL
        ELSE SUM(cost_usd)::numeric(16,10)
      END AS cost_usd,
      CASE
        WHEN COUNT(*) = 0 THEN 0::numeric(16,10)
        WHEN COUNT(*) FILTER (WHERE input_cost_usd IS NOT NULL) = 0 THEN NULL
        ELSE SUM(input_cost_usd)::numeric(16,10)
      END AS input_cost_usd,
      CASE
        WHEN COUNT(*) = 0 THEN 0::numeric(16,10)
        WHEN COUNT(*) FILTER (WHERE cache_cost_usd IS NOT NULL) = 0 THEN NULL
        ELSE SUM(cache_cost_usd)::numeric(16,10)
      END AS cache_cost_usd,
      CASE
        WHEN COUNT(*) = 0 THEN 0::numeric(16,10)
        WHEN COUNT(*) FILTER (WHERE output_cost_usd IS NOT NULL) = 0 THEN NULL
        ELSE SUM(output_cost_usd)::numeric(16,10)
      END AS output_cost_usd,
      CASE
        WHEN COUNT(*) = 0 THEN 0::numeric(16,10)
        WHEN COUNT(*) FILTER (WHERE billed_cost_usd IS NOT NULL) = 0 THEN NULL
        ELSE SUM(billed_cost_usd)::numeric(16,10)
      END AS billed_cost_usd,
      CASE
        WHEN COUNT(*) = 0 THEN 0::numeric(16,10)
        WHEN COUNT(*) FILTER (WHERE cost_brl IS NOT NULL) = 0 THEN NULL
        ELSE SUM(cost_brl)::numeric(16,10)
      END AS cost_brl,
      ROUND(AVG(latency_ms))::integer AS avg_latency_ms
    FROM filtered
  ),
  by_provider AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'provider', provider,
        'attempts', attempts,
        'completed_calls', completed_calls,
        'cost_measured_calls', cost_measured_calls,
        'cost_unknown_calls', cost_unknown_calls,
        'prompt_tokens', prompt_tokens,
        'completion_tokens', completion_tokens,
        'cached_tokens', cached_tokens,
        'total_tokens', total_tokens,
        'cost_usd', cost_usd,
        'input_cost_usd', input_cost_usd,
        'cache_cost_usd', cache_cost_usd,
        'output_cost_usd', output_cost_usd,
        'billed_cost_usd', billed_cost_usd,
        'cost_brl', cost_brl
      ) ORDER BY total_tokens DESC
    ), '[]'::jsonb) AS items
    FROM (
      SELECT
        provider,
        COUNT(*)::bigint AS attempts,
        COUNT(*) FILTER (WHERE status = 'completed')::bigint AS completed_calls,
        COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::bigint AS cost_measured_calls,
        COUNT(*) FILTER (WHERE cost_usd IS NULL)::bigint AS cost_unknown_calls,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)::bigint AS cached_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        SUM(cost_usd)::numeric(16,10) AS cost_usd,
        SUM(input_cost_usd)::numeric(16,10) AS input_cost_usd,
        SUM(cache_cost_usd)::numeric(16,10) AS cache_cost_usd,
        SUM(output_cost_usd)::numeric(16,10) AS output_cost_usd,
        SUM(billed_cost_usd)::numeric(16,10) AS billed_cost_usd,
        SUM(cost_brl)::numeric(16,10) AS cost_brl
      FROM filtered
      GROUP BY provider
    ) s
  ),
  by_mode AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'mode', mode,
        'calls', calls,
        'cost_measured_calls', cost_measured_calls,
        'cost_unknown_calls', cost_unknown_calls,
        'prompt_tokens', prompt_tokens,
        'completion_tokens', completion_tokens,
        'cached_tokens', cached_tokens,
        'total_tokens', total_tokens,
        'cost_usd', cost_usd,
        'input_cost_usd', input_cost_usd,
        'cache_cost_usd', cache_cost_usd,
        'output_cost_usd', output_cost_usd,
        'billed_cost_usd', billed_cost_usd,
        'cost_brl', cost_brl
      ) ORDER BY total_tokens DESC
    ), '[]'::jsonb) AS items
    FROM (
      SELECT
        mode,
        COUNT(*)::bigint AS calls,
        COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::bigint AS cost_measured_calls,
        COUNT(*) FILTER (WHERE cost_usd IS NULL)::bigint AS cost_unknown_calls,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)::bigint AS cached_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        SUM(cost_usd)::numeric(16,10) AS cost_usd,
        SUM(input_cost_usd)::numeric(16,10) AS input_cost_usd,
        SUM(cache_cost_usd)::numeric(16,10) AS cache_cost_usd,
        SUM(output_cost_usd)::numeric(16,10) AS output_cost_usd,
        SUM(billed_cost_usd)::numeric(16,10) AS billed_cost_usd,
        SUM(cost_brl)::numeric(16,10) AS cost_brl
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
        'cost_measured_calls', cost_measured_calls,
        'cost_unknown_calls', cost_unknown_calls,
        'prompt_tokens', prompt_tokens,
        'completion_tokens', completion_tokens,
        'cached_tokens', cached_tokens,
        'total_tokens', total_tokens,
        'cost_usd', cost_usd,
        'input_cost_usd', input_cost_usd,
        'cache_cost_usd', cache_cost_usd,
        'output_cost_usd', output_cost_usd,
        'billed_cost_usd', billed_cost_usd,
        'cost_brl', cost_brl
      ) ORDER BY total_tokens DESC
    ), '[]'::jsonb) AS items
    FROM (
      SELECT
        provider,
        model,
        COUNT(*)::bigint AS calls,
        COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::bigint AS cost_measured_calls,
        COUNT(*) FILTER (WHERE cost_usd IS NULL)::bigint AS cost_unknown_calls,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)::bigint AS cached_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        SUM(cost_usd)::numeric(16,10) AS cost_usd,
        SUM(input_cost_usd)::numeric(16,10) AS input_cost_usd,
        SUM(cache_cost_usd)::numeric(16,10) AS cache_cost_usd,
        SUM(output_cost_usd)::numeric(16,10) AS output_cost_usd,
        SUM(billed_cost_usd)::numeric(16,10) AS billed_cost_usd,
        SUM(cost_brl)::numeric(16,10) AS cost_brl
      FROM filtered
      GROUP BY provider, model
    ) s
  ),
  daily AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'date', day_key,
        'calls', calls,
        'cost_measured_calls', cost_measured_calls,
        'cost_unknown_calls', cost_unknown_calls,
        'prompt_tokens', prompt_tokens,
        'completion_tokens', completion_tokens,
        'cached_tokens', cached_tokens,
        'total_tokens', total_tokens,
        'cost_usd', cost_usd,
        'input_cost_usd', input_cost_usd,
        'cache_cost_usd', cache_cost_usd,
        'output_cost_usd', output_cost_usd,
        'billed_cost_usd', billed_cost_usd,
        'cost_brl', cost_brl
      ) ORDER BY day_key ASC
    ), '[]'::jsonb) AS items
    FROM (
      SELECT
        to_char(created_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS day_key,
        COUNT(*)::bigint AS calls,
        COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::bigint AS cost_measured_calls,
        COUNT(*) FILTER (WHERE cost_usd IS NULL)::bigint AS cost_unknown_calls,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(COALESCE(cached_tokens, 0)), 0)::bigint AS cached_tokens,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        SUM(cost_usd)::numeric(16,10) AS cost_usd,
        SUM(input_cost_usd)::numeric(16,10) AS input_cost_usd,
        SUM(cache_cost_usd)::numeric(16,10) AS cache_cost_usd,
        SUM(output_cost_usd)::numeric(16,10) AS output_cost_usd,
        SUM(billed_cost_usd)::numeric(16,10) AS billed_cost_usd,
        SUM(cost_brl)::numeric(16,10) AS cost_brl
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
