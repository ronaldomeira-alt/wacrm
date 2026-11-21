-- ============================================================
-- 088_match_lifecycle_and_notifications.sql
--
-- Evolução segura, idempotente e 100% NÃO-DESTRUTIVA do módulo Match:
-- 1. Novos estados de ciclo de vida (`em_analise`, `ignorado`) e metadados
--    de visualização, reabertura por mudança material e snapshot de decisão.
-- 2. Expansão de `notifications` para suportar alertas internos de Match
--    (`match_created`, `match_reopened`, `match_interest`) com `metadata`.
-- 3. Ativação do Supabase Realtime em `lead_property_matches` e
--    `property_match_projections` (anteriormente ausentes da publicação).
-- 4. Índices parciais para ordenação por recência e agregação por lead.
-- 5. Atualização da RPC `get_match_tab_counts` (6 estados + contatos ativos).
-- 6. Nova RPC paginada `get_match_lead_groups` que agrupa TODOS os leads no
--    PostgreSQL (eliminando o truncamento de 1.000 linhas do PostgREST) e limita
--    apenas a prévia exibida por card (Top 20), SEM excluir nenhuma linha da tabela.
-- 7. Higienização reversível de status de contatos já arquivados/pausados
--    (ZERO exclusões físicas; ZERO notificações retroativas).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Evolução de `lead_property_matches` (ciclo de vida + reabertura)
-- ------------------------------------------------------------
ALTER TABLE public.lead_property_matches
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ignored_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopen_reason text,
  ADD COLUMN IF NOT EXISTS reopen_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status_snapshot jsonb;

ALTER TABLE public.lead_property_matches
  DROP CONSTRAINT IF EXISTS lead_property_matches_match_status_check;

ALTER TABLE public.lead_property_matches
  ADD CONSTRAINT lead_property_matches_match_status_check
  CHECK (match_status IN ('novo', 'em_analise', 'enviado', 'pausado', 'arquivado', 'ignorado'));

-- Índices para ordenação por recência, agrupamento por lead e listagem de ignorados
CREATE INDEX IF NOT EXISTS idx_lead_property_matches_account_created
  ON public.lead_property_matches (account_id, created_at DESC)
  WHERE suppressed = false;

CREATE INDEX IF NOT EXISTS idx_lead_property_matches_account_lead_score
  ON public.lead_property_matches (account_id, lead_id, match_score DESC, commercial_priority DESC);

CREATE INDEX IF NOT EXISTS idx_lead_property_matches_account_suppressed
  ON public.lead_property_matches (account_id, updated_at DESC)
  WHERE suppressed = true;

CREATE INDEX IF NOT EXISTS idx_lpm_acc_status_lead
  ON public.lead_property_matches (account_id, match_status, lead_id, match_score DESC)
  WHERE suppressed = false;

-- ------------------------------------------------------------
-- 2. Evolução de `notifications` (suporte a alertas internos de Match)
-- ------------------------------------------------------------
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'match_created', 'match_reopened', 'match_interest'));

-- ------------------------------------------------------------
-- 3. Ativação do Supabase Realtime nas tabelas de Match
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'lead_property_matches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lead_property_matches;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'property_match_projections'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.property_match_projections;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. RPC `get_match_tab_counts` atualizada (6 estados + filtro de contatos ativos)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_match_tab_counts(p_account_id uuid)
RETURNS TABLE (
  match_status text,
  distinct_leads bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH normalized AS (
    SELECT
      m.lead_id,
      CASE
        WHEN m.suppressed = true OR m.match_status = 'ignorado'
          OR (m.score_breakdown->'_lifecycle'->>'state') = 'ignorado'
          THEN 'ignorado'
        WHEN m.match_status = 'enviado' THEN 'enviado'
        WHEN m.match_status = 'pausado' THEN 'pausado'
        WHEN m.match_status = 'arquivado' THEN 'arquivado'
        WHEN m.match_status = 'em_analise'
          OR (m.score_breakdown->'_lifecycle'->>'state') = 'em_analise'
          THEN 'em_analise'
        ELSE 'novo'
      END AS effective_status,
      p.status AS prop_status,
      c.paused_at AS contact_paused_at,
      c.archived_at AS contact_archived_at
    FROM public.lead_property_matches m
    JOIN public.property_match_projections p
      ON p.account_id = m.account_id
     AND p.property_id = m.property_id
    JOIN public.contacts c
      ON c.id = m.lead_id
     AND c.account_id = m.account_id
    WHERE m.account_id = p_account_id
  )
  SELECT
    effective_status AS match_status,
    COUNT(DISTINCT lead_id) AS distinct_leads
  FROM normalized
  WHERE
    (effective_status IN ('novo', 'em_analise') AND prop_status = 'ativo' AND contact_archived_at IS NULL AND contact_paused_at IS NULL)
    OR (effective_status IN ('enviado', 'pausado', 'arquivado', 'ignorado'))
  GROUP BY effective_status;
$$;

REVOKE ALL ON FUNCTION public.get_match_tab_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_match_tab_counts(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. RPC paginada `get_match_lead_groups`
--    Agrupa TODOS os leads no PostgreSQL preservando 100% das linhas no banco,
--    retornando até `p_max_matches_per_lead` (padrão 20) por card para visualização rápida.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_match_lead_groups(
  p_account_id uuid,
  p_status text DEFAULT 'novo',
  p_min_score integer DEFAULT 0,
  p_max_score integer DEFAULT 100,
  p_min_maturity integer DEFAULT 0,
  p_max_maturity integer DEFAULT 100,
  p_min_ai_score integer DEFAULT 0,
  p_lead_search text DEFAULT NULL,
  p_property_search text DEFAULT NULL,
  p_date_filter text DEFAULT 'all',
  p_view_filter text DEFAULT 'all',
  p_sort_by text DEFAULT 'recent_desc',
  p_limit integer DEFAULT 36,
  p_offset integer DEFAULT 0,
  p_max_matches_per_lead integer DEFAULT 20
)
RETURNS TABLE (
  lead_id uuid,
  lead jsonb,
  profile_maturity integer,
  ai_score integer,
  status_matches_count bigint,
  unread_matches_count bigint,
  is_unread boolean,
  is_recent boolean,
  latest_match_at timestamptz,
  first_match_at timestamptz,
  viewed_at timestamptz,
  reopened_at timestamptz,
  reopen_reason text,
  best_match jsonb,
  matches jsonb,
  total_groups bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH active_contacts AS (
    SELECT
      c.id AS lead_id,
      jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'phone', c.phone,
        'ai_score', COALESCE(c.ai_score, 0),
        'ai_score_reason', c.ai_score_reason,
        'paused_at', c.paused_at,
        'archived_at', c.archived_at,
        'has_purchased', COALESCE(c.has_purchased, false),
        'is_personal_whatsapp', COALESCE(c.is_personal_whatsapp, false)
      ) AS lead,
      COALESCE(c.ai_score, 0) AS ai_score
    FROM public.contacts c
    WHERE c.account_id = p_account_id
      AND (
        p_status IN ('arquivado', 'pausado', 'ignorado', 'enviado')
        OR (c.archived_at IS NULL AND c.paused_at IS NULL)
      )
      AND (p_min_ai_score <= 0 OR COALESCE(c.ai_score, 0) >= p_min_ai_score)
      AND (
        p_lead_search IS NULL OR btrim(p_lead_search) = ''
        OR c.name ILIKE '%' || btrim(p_lead_search) || '%'
        OR c.phone ILIKE '%' || btrim(p_lead_search) || '%'
      )
  ),
  matched_rows AS (
    SELECT
      m.id,
      m.lead_id,
      m.match_score,
      m.commercial_priority,
      m.profile_maturity,
      m.created_at,
      m.viewed_at,
      m.reopened_at,
      m.reopen_reason,
      COALESCE(m.reopened_at, m.created_at) AS ref_at,
      (p_status = 'novo' AND m.viewed_at IS NULL) AS is_row_unread,
      (COALESCE(m.reopened_at, m.created_at) >= now() - interval '7 days') AS is_row_recent
    FROM public.lead_property_matches m
    JOIN public.property_match_projections p
      ON p.account_id = m.account_id AND p.property_id = m.property_id
    WHERE m.account_id = p_account_id
      AND m.match_status = p_status
      AND m.suppressed = false
      AND (
        p_status IN ('arquivado', 'pausado', 'ignorado', 'enviado')
        OR p.status = 'ativo'
      )
      AND m.match_score >= p_min_score
      AND m.match_score <= p_max_score
      AND m.profile_maturity >= p_min_maturity
      AND m.profile_maturity <= p_max_maturity
      AND (
        p_property_search IS NULL OR btrim(p_property_search) = ''
        OR p.title ILIKE '%' || btrim(p_property_search) || '%'
        OR p.neighborhood ILIKE '%' || btrim(p_property_search) || '%'
        OR COALESCE(p.code, '') ILIKE '%' || btrim(p_property_search) || '%'
      )
      AND (
        p_date_filter = 'all'
        OR (p_date_filter = 'today' AND COALESCE(m.reopened_at, m.created_at) >= date_trunc('day', now()))
        OR (p_date_filter = '24h' AND COALESCE(m.reopened_at, m.created_at) >= now() - interval '24 hours')
        OR (p_date_filter = '7d' AND COALESCE(m.reopened_at, m.created_at) >= now() - interval '7 days')
        OR (p_date_filter = '30d' AND COALESCE(m.reopened_at, m.created_at) >= now() - interval '30 days')
        OR (p_date_filter = 'older' AND COALESCE(m.reopened_at, m.created_at) < now() - interval '7 days')
      )
      AND (
        p_view_filter = 'all'
        OR (p_view_filter = 'unread' AND p_status = 'novo' AND m.viewed_at IS NULL)
        OR (p_view_filter = 'viewed' AND NOT (p_status = 'novo' AND m.viewed_at IS NULL))
      )
  ),
  lead_aggregates AS (
    SELECT
      mr.lead_id,
      MAX(mr.profile_maturity)::integer AS profile_maturity,
      COUNT(*)::bigint AS status_matches_count,
      COUNT(*) FILTER (WHERE mr.is_row_unread)::bigint AS unread_matches_count,
      BOOL_OR(mr.is_row_unread) AS is_unread,
      BOOL_OR(mr.is_row_recent) AS is_recent,
      MAX(mr.ref_at) AS latest_match_at,
      MIN(mr.created_at) AS first_match_at,
      MAX(mr.viewed_at) AS viewed_at,
      MAX(mr.reopened_at) AS reopened_at,
      MAX(mr.reopen_reason) AS reopen_reason,
      MAX(mr.match_score) AS max_match_score,
      MAX(mr.commercial_priority) AS max_priority
    FROM matched_rows mr
    GROUP BY mr.lead_id
  ),
  combined AS (
    SELECT
      ac.lead_id,
      ac.lead,
      ac.ai_score,
      la.profile_maturity,
      la.status_matches_count,
      la.unread_matches_count,
      la.is_unread,
      la.is_recent,
      la.latest_match_at,
      la.first_match_at,
      la.viewed_at,
      la.reopened_at,
      la.reopen_reason,
      la.max_match_score,
      la.max_priority,
      COUNT(*) OVER()::bigint AS total_groups,
      ROW_NUMBER() OVER (
        ORDER BY
          CASE WHEN p_sort_by = 'recent_desc' THEN EXTRACT(EPOCH FROM la.latest_match_at) END DESC NULLS LAST,
          CASE WHEN p_sort_by = 'priority_desc' THEN la.max_priority END DESC NULLS LAST,
          CASE WHEN p_sort_by = 'ai_score_desc' THEN ac.ai_score END DESC NULLS LAST,
          la.max_match_score DESC NULLS LAST,
          la.max_priority DESC NULLS LAST,
          la.latest_match_at DESC NULLS LAST,
          ac.lead_id ASC
      ) AS page_order
    FROM lead_aggregates la
    JOIN active_contacts ac ON ac.lead_id = la.lead_id
  ),
  page_slice AS (
    SELECT *
    FROM combined
    ORDER BY page_order ASC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 36), 500))
    OFFSET GREATEST(0, COALESCE(p_offset, 0))
  ),
  slice_matches AS (
    SELECT
      ps.lead_id,
      m_sub.rn,
      m_sub.match_json
    FROM page_slice ps
    CROSS JOIN LATERAL (
      SELECT
        ROW_NUMBER() OVER (ORDER BY m.match_score DESC, m.commercial_priority DESC, m.created_at DESC) AS rn,
        jsonb_build_object(
          'id', m.id,
          'account_id', m.account_id,
          'lead_id', m.lead_id,
          'property_id', m.property_id,
          'match_score', m.match_score,
          'score_breakdown', m.score_breakdown,
          'profile_maturity', m.profile_maturity,
          'commercial_priority', m.commercial_priority,
          'match_status', m.match_status,
          'suppressed', m.suppressed,
          'origin', m.origin,
          'sent_at', m.sent_at,
          'paused_at', m.paused_at,
          'archived_at', m.archived_at,
          'viewed_at', m.viewed_at,
          'ignored_at', m.ignored_at,
          'reopened_at', m.reopened_at,
          'reopen_reason', m.reopen_reason,
          'is_unread', (p_status = 'novo' AND m.viewed_at IS NULL),
          'is_recent', (COALESCE(m.reopened_at, m.created_at) >= now() - interval '7 days'),
          'created_at', m.created_at,
          'updated_at', m.updated_at,
          'contacts', ps.lead,
          'property', jsonb_build_object(
            'propertyId', p.property_id,
            'title', p.title,
            'code', p.code,
            'propertyType', p.property_type,
            'neighborhood', p.neighborhood,
            'city', p.city,
            'priceMin', p.price_min,
            'priceMax', p.price_max,
            'bedroomsMin', p.bedrooms_min,
            'bedroomsMax', p.bedrooms_max,
            'deliveryStatus', p.delivery_status,
            'coverUrl', p.cover_url,
            'publicUrl', p.public_url,
            'features', COALESCE(p.features, '{}'::text[])
          )
        ) AS match_json
      FROM public.lead_property_matches m
      JOIN public.property_match_projections p
        ON p.account_id = m.account_id AND p.property_id = m.property_id
      WHERE m.account_id = p_account_id
        AND m.lead_id = ps.lead_id
        AND m.match_status = p_status
        AND m.suppressed = false
        AND (
          p_status IN ('arquivado', 'pausado', 'ignorado', 'enviado')
          OR p.status = 'ativo'
        )
      ORDER BY m.match_score DESC, m.commercial_priority DESC, m.created_at DESC
      LIMIT GREATEST(1, p_max_matches_per_lead)
    ) m_sub
  ),
  slice_agg AS (
    SELECT
      sm.lead_id,
      (jsonb_agg(sm.match_json ORDER BY sm.rn ASC))->0 AS best_match,
      jsonb_agg(sm.match_json ORDER BY sm.rn ASC) AS matches
    FROM slice_matches sm
    GROUP BY sm.lead_id
  )
  SELECT
    ps.lead_id,
    ps.lead,
    ps.profile_maturity,
    ps.ai_score,
    ps.status_matches_count,
    ps.unread_matches_count,
    ps.is_unread,
    ps.is_recent,
    ps.latest_match_at,
    ps.first_match_at,
    ps.viewed_at,
    ps.reopened_at,
    ps.reopen_reason,
    sa.best_match,
    COALESCE(sa.matches, '[]'::jsonb) AS matches,
    ps.total_groups
  FROM page_slice ps
  LEFT JOIN slice_agg sa ON sa.lead_id = ps.lead_id
  ORDER BY ps.page_order ASC;
$$;

REVOKE ALL ON FUNCTION public.get_match_lead_groups(uuid, text, integer, integer, integer, integer, integer, text, text, text, text, text, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_match_lead_groups(uuid, text, integer, integer, integer, integer, integer, text, text, text, text, text, integer, integer, integer) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Higienização 100% NÃO-DESTRUTIVA dos registros históricos existentes
--    Preserva TODAS as ~54.051 linhas existentes em `lead_property_matches`
--    (ZERO DELETEs; ZERO notificações retroativas).
-- ------------------------------------------------------------

-- 6.1 Move matches 'novo' de contatos já arquivados no CRM para 'arquivado' (reversível)
UPDATE public.lead_property_matches m
SET
  match_status = 'arquivado',
  archived_at = COALESCE(m.archived_at, c.archived_at, now()),
  updated_at = now()
FROM public.contacts c
WHERE c.id = m.lead_id
  AND c.account_id = m.account_id
  AND c.archived_at IS NOT NULL
  AND m.match_status = 'novo'
  AND m.suppressed = false;

-- 6.2 Move matches 'novo' de contatos já pausados no CRM para 'pausado' (reversível)
UPDATE public.lead_property_matches m
SET
  match_status = 'pausado',
  paused_at = COALESCE(m.paused_at, c.paused_at, now()),
  updated_at = now()
FROM public.contacts c
WHERE c.id = m.lead_id
  AND c.account_id = m.account_id
  AND c.paused_at IS NOT NULL
  AND c.archived_at IS NULL
  AND m.match_status = 'novo'
  AND m.suppressed = false;

COMMIT;
