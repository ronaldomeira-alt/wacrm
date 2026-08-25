-- ============================================================
-- 082_ai_score_personal_whatsapp.sql — custom feature, not part of
-- the upstream wacrm template.
--
-- Two independent, minimal additions to `contacts`:
--
--   1. `is_personal_whatsapp` — Sim/Não flag mirroring has_purchased
--      (048): true once the lead has moved off the business number
--      (8810/profissional) onto the agent's personal WhatsApp.
--      Defaults to false so every existing contact starts as "Não".
--
--   2. `ai_score` (integer, 0–10) + `ai_score_reason` +
--      `ai_score_updated_at` — lead-warmth score written by the same
--      lead-analysis job that already writes tags (see
--      src/lib/ai/lead-analysis.ts). Defaults to 0 for every existing
--      and new contact; only that job (or a future explicit UI)
--      writes it.
--
-- Also adds `filter_contacts_combined`, a single RPC that lets the
-- Contacts page's "Filtrar" panel combine tags (any/all) + score
-- range + is_personal_whatsapp, all optional and independently
-- combinable. filter_contacts_by_tags / filter_contacts_by_all_tags
-- (025/039) are left in place rather than dropped, to keep this
-- migration additive.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_personal_whatsapp BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_score INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_score_reason TEXT,
  ADD COLUMN IF NOT EXISTS ai_score_updated_at TIMESTAMPTZ;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_ai_score_range;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_ai_score_range CHECK (ai_score BETWEEN 0 AND 10);

CREATE OR REPLACE FUNCTION public.filter_contacts_combined(
  p_tag_ids UUID[] DEFAULT ARRAY[]::UUID[],
  p_tag_mode TEXT DEFAULT 'any',
  p_min_score INT DEFAULT 0,
  p_max_score INT DEFAULT 10,
  p_personal_whatsapp TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT c.id, c.created_at
    FROM contacts c
    WHERE c.archived_at IS NULL
      AND c.ai_score BETWEEN p_min_score AND p_max_score
      AND (
        p_personal_whatsapp IS NULL
        OR (p_personal_whatsapp = 'yes' AND c.is_personal_whatsapp)
        OR (p_personal_whatsapp = 'no' AND NOT c.is_personal_whatsapp)
      )
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
      AND (
        -- No tags selected (or NULL) — skip tag filtering entirely.
        p_tag_ids IS NULL OR array_length(p_tag_ids, 1) IS NULL
        OR (
          p_tag_mode = 'all' AND (
            SELECT COUNT(DISTINCT ct.tag_id)
            FROM contact_tags ct
            WHERE ct.contact_id = c.id AND ct.tag_id = ANY(p_tag_ids)
          ) = array_length(p_tag_ids, 1)
        )
        OR (
          p_tag_mode <> 'all' AND EXISTS (
            SELECT 1 FROM contact_tags ct
            WHERE ct.contact_id = c.id AND ct.tag_id = ANY(p_tag_ids)
          )
        )
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_combined(UUID[], TEXT, INT, INT, TEXT, TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_combined(UUID[], TEXT, INT, INT, TEXT, TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_combined(UUID[], TEXT, INT, INT, TEXT, TEXT, INT, INT) TO authenticated;
