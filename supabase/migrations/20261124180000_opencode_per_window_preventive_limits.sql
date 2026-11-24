-- ============================================================
-- 20261124180000_opencode_per_window_preventive_limits.sql
--
-- Replaces the single global OpenCode Go preventive cap with
-- independent per-window preventive controls on `ai_configs`:
--   - 5h window: disabled by default (uses full capacity until 100%)
--   - Weekly window: enabled at 90% by default
--   - Monthly window: disabled by default (uses full capacity until 100%)
--
-- Non-destructive: preserves existing legacy columns in `ai_configs`
-- without dropping them.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS opencode_5h_preventive_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS opencode_5h_preventive_pct numeric(5,2) NOT NULL DEFAULT 90.00,
  ADD COLUMN IF NOT EXISTS opencode_weekly_preventive_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS opencode_weekly_preventive_pct numeric(5,2) NOT NULL DEFAULT 90.00,
  ADD COLUMN IF NOT EXISTS opencode_monthly_preventive_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS opencode_monthly_preventive_pct numeric(5,2) NOT NULL DEFAULT 90.00;

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_opencode_5h_pct_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_opencode_5h_pct_check
  CHECK (opencode_5h_preventive_pct BETWEEN 1 AND 100);

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_opencode_weekly_pct_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_opencode_weekly_pct_check
  CHECK (opencode_weekly_preventive_pct BETWEEN 1 AND 100);

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_opencode_monthly_pct_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_opencode_monthly_pct_check
  CHECK (opencode_monthly_preventive_pct BETWEEN 1 AND 100);
