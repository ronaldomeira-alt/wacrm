-- ============================================================
-- 20260912100000_property_ad_mappings_creative.sql
--
-- Persists real Meta Ad Creative telemetry and visual preview assets
-- directly on property_ad_mappings rows (eliminating reliance on
-- passive/stale conversation referrals or property media galleries).
-- ============================================================

ALTER TABLE property_ad_mappings
  ADD COLUMN IF NOT EXISTS creative_id text,
  ADD COLUMN IF NOT EXISTS creative_image_url text,
  ADD COLUMN IF NOT EXISTS creative_thumbnail_url text,
  ADD COLUMN IF NOT EXISTS creative_type text,
  ADD COLUMN IF NOT EXISTS creative_storage_path text,
  ADD COLUMN IF NOT EXISTS campaign_name text,
  ADD COLUMN IF NOT EXISTS adset_name text,
  ADD COLUMN IF NOT EXISTS creative_headline text,
  ADD COLUMN IF NOT EXISTS creative_body text,
  ADD COLUMN IF NOT EXISTS creative_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_property_ad_mappings_creative_id
  ON property_ad_mappings(creative_id) WHERE creative_id IS NOT NULL;
