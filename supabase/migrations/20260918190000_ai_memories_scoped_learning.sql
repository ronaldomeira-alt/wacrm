-- Scoped AI memory for Clara (GLOBAL / PROPERTY / AD / CONVERSATION).
--
-- The `ai_memories` table already exists in production — it was created
-- directly against the Management API by an earlier, uncommitted
-- experiment (never wired into any deployed code, confirmed empty of
-- real traffic: 74 rows, all `source_type = 'backfill_migration'`). This
-- migration is the first time its schema is captured in git, so the
-- table becomes reproducible instead of a hand-applied artifact — the
-- CREATE is `IF NOT EXISTS` so it is a no-op in production and a real
-- create on any environment that doesn't have it yet (e.g. a fresh
-- Supabase branch). The ALTERs that follow are this migration's actual
-- payload: `agent_id` (to tell Ronaldo's style from Thatianna's from
-- Clara's own) and a hard scope/target-id consistency check (production
-- already had one `scope='property'` row with `property_id IS NULL`
-- before this migration — that class of row is now impossible).

CREATE TABLE IF NOT EXISTS ai_memories (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope               text NOT NULL CHECK (scope IN ('global', 'property', 'ad', 'conversation')),
  knowledge_type      text NOT NULL,
  title               text NOT NULL,
  content             text NOT NULL,
  property_id         uuid REFERENCES properties(id) ON DELETE CASCADE,
  ad_id               text,
  conversation_id     uuid REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES contacts(id) ON DELETE CASCADE,
  source_type         text NOT NULL DEFAULT 'learning_scan'
                      CHECK (source_type IN ('learning_scan', 'audio_transcript', 'manual', 'agent_chat', 'ad_referral', 'suggestion_approved', 'backfill_migration')),
  source_message_id   uuid REFERENCES messages(id) ON DELETE SET NULL,
  confidence          text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low', 'medium', 'high')),
  occurrence_count    integer NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived', 'deprecated')),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_memories_account_scope ON ai_memories(account_id, scope);
CREATE INDEX IF NOT EXISTS idx_ai_memories_property ON ai_memories(account_id, property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_memories_ad ON ai_memories(account_id, ad_id) WHERE ad_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_memories_conversation ON ai_memories(account_id, conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_memories_contact ON ai_memories(account_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_memories_status ON ai_memories(account_id, status);

ALTER TABLE ai_memories ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_memories' AND policyname = 'ai_memories_select') THEN
    CREATE POLICY ai_memories_select ON ai_memories FOR SELECT USING (is_account_member(account_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_memories' AND policyname = 'ai_memories_insert') THEN
    CREATE POLICY ai_memories_insert ON ai_memories FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_memories' AND policyname = 'ai_memories_update') THEN
    CREATE POLICY ai_memories_update ON ai_memories FOR UPDATE USING (is_account_member(account_id, 'admin'::account_role_enum));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_memories' AND policyname = 'ai_memories_delete') THEN
    CREATE POLICY ai_memories_delete ON ai_memories FOR DELETE USING (is_account_member(account_id, 'admin'::account_role_enum));
  END IF;
END $$;

-- Which corretor (Ronaldo, Thatianna...) a `language_style` /
-- `communication_pattern` memory was learned from — matches
-- `messages.sender_id`'s own convention (loose uuid, no FK: it points at
-- auth.users, which Postgres RLS/policies already treat as the source of
-- truth via `profiles.user_id` elsewhere in this schema without a formal
-- FK). NULL means "the team in general", not "unknown" — a memory only
-- gets an agent_id when a batch consistently and recurrently attributes
-- the pattern to one specific named corretor.
ALTER TABLE ai_memories ADD COLUMN IF NOT EXISTS agent_id uuid;
CREATE INDEX IF NOT EXISTS idx_ai_memories_agent ON ai_memories(account_id, agent_id) WHERE agent_id IS NOT NULL;

-- Structural isolation guarantee: a scoped memory MUST carry the id that
-- scopes it. Before this constraint, production already had a
-- scope='property' row with property_id NULL (dead weight, never
-- retrievable by anything, but proof the invariant wasn't enforced).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_memories_scope_target_check'
  ) THEN
    ALTER TABLE ai_memories ADD CONSTRAINT ai_memories_scope_target_check CHECK (
      (scope = 'global') OR
      (scope = 'property' AND property_id IS NOT NULL) OR
      (scope = 'ad' AND ad_id IS NOT NULL) OR
      (scope = 'conversation' AND conversation_id IS NOT NULL)
    );
  END IF;
END $$;
