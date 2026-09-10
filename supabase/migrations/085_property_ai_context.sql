-- ============================================================
-- 085_property_ai_context.sql — ETAPA 3: Núcleo de Conhecimento e Dados da IA
--
-- Adds:
-- 1. `property_ai_contexts` — 1:1 with `properties` for real estate developments.
-- 2. `ai_knowledge_documents.property_id` & `source_type` for isolated document storage.
-- 3. `ai_knowledge_chunks.property_id` for isolated RAG chunk indexing.
-- 4. `ai_configs` extensions for behavior, identity, team presentation, and business hours.
-- 5. `conversations.property_id` and AI transfer/handoff tracking fields.
-- 6. Isolated search RPCs (`match_property_ai_knowledge_semantic` and `match_property_ai_knowledge_fts`).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Ensure vector extension exists in extensions schema
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
SET search_path TO public, extensions, auth;

-- ============================================================
-- 1. property_ai_contexts
-- ============================================================
CREATE TABLE IF NOT EXISTS property_ai_contexts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  property_id          uuid NOT NULL UNIQUE REFERENCES properties(id) ON DELETE CASCADE,
  stage                text NOT NULL DEFAULT 'lancamento'
                         CHECK (stage IN ('pre_lancamento', 'lancamento', 'pronto', 'na_planta', 'em_construcao')),
  subjective_knowledge text,
  book_storage_path    text,
  book_filename        text,
  book_file_size       bigint,
  book_page_count      integer,
  book_extracted_text  text,
  book_indexed_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_ai_contexts_account 
  ON property_ai_contexts(account_id);
CREATE INDEX IF NOT EXISTS idx_property_ai_contexts_property 
  ON property_ai_contexts(property_id);

ALTER TABLE property_ai_contexts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_ai_contexts_select ON property_ai_contexts;
CREATE POLICY property_ai_contexts_select ON property_ai_contexts FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS property_ai_contexts_insert ON property_ai_contexts;
CREATE POLICY property_ai_contexts_insert ON property_ai_contexts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS property_ai_contexts_update ON property_ai_contexts;
CREATE POLICY property_ai_contexts_update ON property_ai_contexts FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS property_ai_contexts_delete ON property_ai_contexts;
CREATE POLICY property_ai_contexts_delete ON property_ai_contexts FOR DELETE
  USING (is_account_member(account_id, 'agent'));

CREATE OR REPLACE FUNCTION public.update_property_ai_contexts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS property_ai_contexts_updated_at ON property_ai_contexts;
CREATE TRIGGER property_ai_contexts_updated_at
  BEFORE UPDATE ON property_ai_contexts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_property_ai_contexts_updated_at();

-- ============================================================
-- 2. Extend ai_knowledge_documents with property_id & source_type
-- ============================================================
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'text';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_knowledge_documents_source_type_check'
  ) THEN
    ALTER TABLE ai_knowledge_documents
      ADD CONSTRAINT ai_knowledge_documents_source_type_check
      CHECK (source_type IN ('text', 'pdf_book', 'subjective_text'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_documents_property
  ON ai_knowledge_documents(property_id);

-- Update RLS on ai_knowledge_documents to allow agents to manage knowledge
DROP POLICY IF EXISTS ai_knowledge_documents_insert ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_insert ON ai_knowledge_documents FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS ai_knowledge_documents_update ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_update ON ai_knowledge_documents FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS ai_knowledge_documents_delete ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_delete ON ai_knowledge_documents FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ============================================================
-- 3. Extend ai_knowledge_chunks with property_id
-- ============================================================
ALTER TABLE ai_knowledge_chunks
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_property
  ON ai_knowledge_chunks(property_id);

-- Update RLS on ai_knowledge_chunks to allow agents to manage chunks
DROP POLICY IF EXISTS ai_knowledge_chunks_insert ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_insert ON ai_knowledge_chunks FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS ai_knowledge_chunks_update ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_update ON ai_knowledge_chunks FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS ai_knowledge_chunks_delete ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_delete ON ai_knowledge_chunks FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ============================================================
-- 4. Extend ai_configs with behavior, identity & business hours
-- ============================================================
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS identity_name text NOT NULL DEFAULT 'Assistente Virtual',
  ADD COLUMN IF NOT EXISTS tone_style text NOT NULL DEFAULT 'cordial_natural',
  ADD COLUMN IF NOT EXISTS team_presentation text,
  ADD COLUMN IF NOT EXISTS global_never_rules text,
  ADD COLUMN IF NOT EXISTS business_hours_start integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS business_hours_end integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS business_days integer[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  ADD COLUMN IF NOT EXISTS off_hours_instructions text,
  ADD COLUMN IF NOT EXISTS safety_message_limit integer NOT NULL DEFAULT 10;

-- ============================================================
-- 5. Extend conversations with property_id & transfer tracking
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_transfer_status text DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS ai_transfer_reason text,
  ADD COLUMN IF NOT EXISTS ai_transfer_boundary_type text,
  ADD COLUMN IF NOT EXISTS ai_transfer_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_ai_transfer_status_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_ai_transfer_status_check
      CHECK (ai_transfer_status IN ('none', 'pending_human', 'transferred', 'resolved'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_property
  ON conversations(property_id);

-- ============================================================
-- 6. Isolated Search RPCs: Global + Current Property Only
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Semantic Search RPC with strict property isolation
CREATE OR REPLACE FUNCTION public.match_property_ai_knowledge_semantic(
  p_account_id      uuid,
  p_property_id     uuid,          -- NULL = only global chunks; UUID = global + current property chunks
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, distance real, is_global boolean) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::extensions.vector(1536)) AS distance,
         (c.property_id IS NULL) AS is_global
  FROM public.ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
    AND (
      (p_property_id IS NOT NULL AND c.property_id = p_property_id)
      OR c.property_id IS NULL
    )
  ORDER BY c.embedding <=> p_query_embedding::extensions.vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions;

-- Lexical Full-Text Search RPC with strict property isolation
CREATE OR REPLACE FUNCTION public.match_property_ai_knowledge_fts(
  p_account_id  uuid,
  p_property_id uuid,          -- NULL = only global chunks; UUID = global + current property chunks
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real, is_global boolean) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank,
         (c.property_id IS NULL) AS is_global
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND (
      (p_property_id IS NOT NULL AND c.property_id = p_property_id)
      OR c.property_id IS NULL
    )
    AND c.fts @@ plainto_tsquery('simple', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_property_ai_knowledge_semantic(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_property_ai_knowledge_semantic(uuid, uuid, text, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.match_property_ai_knowledge_fts(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_property_ai_knowledge_fts(uuid, uuid, text, integer) TO authenticated, service_role;

-- ============================================================
-- 7. property_ad_mappings (CTWA Ad -> Property deterministic resolution)
-- ============================================================
CREATE TABLE IF NOT EXISTS property_ad_mappings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  property_id  uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ad_source_id text NOT NULL, -- Meta Ad ID / source_id from CTWA referral
  ad_name      text,          -- User friendly label for this ad
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ad_source_id)
);

CREATE INDEX IF NOT EXISTS idx_property_ad_mappings_lookup
  ON property_ad_mappings(account_id, ad_source_id);

CREATE INDEX IF NOT EXISTS idx_property_ad_mappings_property
  ON property_ad_mappings(property_id);

ALTER TABLE property_ad_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_ad_mappings_select ON property_ad_mappings;
CREATE POLICY property_ad_mappings_select ON property_ad_mappings FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS property_ad_mappings_insert ON property_ad_mappings;
CREATE POLICY property_ad_mappings_insert ON property_ad_mappings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS property_ad_mappings_update ON property_ad_mappings;
CREATE POLICY property_ad_mappings_update ON property_ad_mappings FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS property_ad_mappings_delete ON property_ad_mappings;
CREATE POLICY property_ad_mappings_delete ON property_ad_mappings FOR DELETE
  USING (is_account_member(account_id, 'agent'));

