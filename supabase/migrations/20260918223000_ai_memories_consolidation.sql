-- Memory consolidation for Clara (candidate -> active, conflict handling,
-- evidence ledger, value history) — see src/lib/ai/memory-consolidation.ts.
--
-- Before this migration, every approved learning became its own
-- `ai_memories` row unconditionally: no comparison against what already
-- existed, so "18,94 m²" and "19 m²" learned a week apart would sit as two
-- separate rows, both presented to the model as independent facts. This
-- migration only touches the schema; memory-consolidation.ts is what
-- compares new observations against existing rows and decides whether to
-- reinforce, consolidate, conflict, or replace.

-- 'candidate': learned but not yet consolidated — excluded from
--   retrieveScopedMemories (status = 'active' only), so a single
--   unconfirmed observation is never presented to the model as fact.
-- 'conflict': contradicts an existing 'active' row for the same
--   scope/target/knowledge_type; held aside until it either accumulates
--   enough independent evidence to replace the active row, or is
--   superseded by an official-source confirmation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_memories_status_check') THEN
    ALTER TABLE ai_memories DROP CONSTRAINT ai_memories_status_check;
  END IF;
  ALTER TABLE ai_memories ADD CONSTRAINT ai_memories_status_check
    CHECK (status IN ('active', 'candidate', 'conflict', 'inactive', 'archived', 'deprecated'));
END $$;

-- Independent-confirmation ledger (jsonb array of {kind, conversationId,
-- messageId, agentId, ref, note, recordedAt}) — the thing consolidation
-- thresholds are actually computed from, kept separate from
-- occurrence_count (which stays a raw, non-deduped repetition counter).
ALTER TABLE ai_memories ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Prior values a memory held before being overwritten by a higher-trust
-- contradiction (official source, or 3 independent confirmations of new
-- info) — so "R$270k -> R$274k -> R$284k" stays one row with history,
-- never three concurrent rows.
ALTER TABLE ai_memories ADD COLUMN IF NOT EXISTS value_history jsonb NOT NULL DEFAULT '[]'::jsonb;
