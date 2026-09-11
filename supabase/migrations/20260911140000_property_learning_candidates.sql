-- ============================================================
-- 20260911140000_property_learning_candidates.sql
--
-- Durable evidence ledger backing the "identity resolution + 7 distinct
-- conversations" safety gate on automatic property creation (see
-- src/lib/ai/property-identity.ts). Every learning scan that spots a
-- property name with NO safe/ambiguous match against existing
-- `properties` records which conversations (and which of those had real
-- estate context, not just a bare name mention) evidenced it. A brand
-- new provisional property may only be auto-created once
-- context_conversation_ids reaches MIN_PROPERTY_LEARNING_CONVERSATIONS —
-- accumulated across cron runs, since each run only re-scans messages
-- since the last cursor.
--
-- One row per (account, normalized name); cleared once the property is
-- actually created (or once resolved onto an existing one, at which
-- point evidence is moot since it always finds a safe match afterward).
-- ============================================================

CREATE TABLE IF NOT EXISTS property_learning_candidates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  conversation_ids TEXT[] NOT NULL DEFAULT '{}',
  context_conversation_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_property_learning_candidates_account
  ON property_learning_candidates(account_id);

ALTER TABLE property_learning_candidates ENABLE ROW LEVEL SECURITY;

-- Same governance as `properties`: any agent can read/write within
-- their own account; the learning cron writes through the service role,
-- which bypasses RLS entirely.
DROP POLICY IF EXISTS property_learning_candidates_select ON property_learning_candidates;
DROP POLICY IF EXISTS property_learning_candidates_insert ON property_learning_candidates;
DROP POLICY IF EXISTS property_learning_candidates_update ON property_learning_candidates;
DROP POLICY IF EXISTS property_learning_candidates_delete ON property_learning_candidates;
CREATE POLICY property_learning_candidates_select ON property_learning_candidates
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY property_learning_candidates_insert ON property_learning_candidates
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY property_learning_candidates_update ON property_learning_candidates
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY property_learning_candidates_delete ON property_learning_candidates
  FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON property_learning_candidates;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON property_learning_candidates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
