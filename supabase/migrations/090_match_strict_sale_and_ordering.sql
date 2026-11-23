-- ============================================================
-- Migration 090: Elegibilidade Exclusiva de Venda e Ordenação Comercial Oficial no Match
-- 1. Desativa projeções de locação no catálogo do Match (exclusivo para venda).
-- 2. Atualiza `get_match_tab_counts` e `get_match_lead_groups` para exigir
--    `p.status = 'ativo' AND p.operation = 'venda'` nas abas ativas ('novo', 'em_analise'),
--    alinhando `lead_aggregates.max_match_score` com o `best_match` real exibido no card.
-- 3. Define a hierarquia oficial de ordenação padrão (`p_sort_by = 'score_desc'`):
--    1º Percentual de Match (max_match_score DESC)
--    2º Maturidade comercial do lead (profile_maturity DESC)
--    3º Score ou temperatura do lead (ai_score DESC)
--    4º Desempate técnico determinístico (latest_match_at DESC, lead_id ASC)
-- ============================================================

-- 1. Desativa projeções de imóveis de locação para o Match (estoque exclusivo de venda)
UPDATE public.property_match_projections
SET status = 'inativo',
    updated_at = now()
WHERE operation = 'locacao'
  AND status = 'ativo';

-- 2. RPC `get_match_tab_counts` com join em `property_match_projections` (somente venda ativa nas abas ativas)
CREATE OR REPLACE FUNCTION public.get_match_tab_counts(p_account_id uuid)
RETURNS TABLE (
  match_status text,
  distinct_leads bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.match_status,
    COUNT(DISTINCT m.lead_id) AS distinct_leads
  FROM public.lead_property_matches m
  JOIN public.contacts c ON c.id = m.lead_id
  JOIN public.property_match_projections p
    ON p.account_id = m.account_id AND p.property_id = m.property_id
  WHERE m.account_id = p_account_id
    AND m.suppressed = false
    AND (
      m.match_status IN ('arquivado', 'pausado', 'ignorado', 'enviado')
      OR (
        c.archived_at IS NULL
        AND c.paused_at IS NULL
        AND m.match_score >= 90
        AND p.status = 'ativo'
        AND p.operation = 'venda'
      )
    )
  GROUP BY m.match_status;
$$;

REVOKE ALL ON FUNCTION public.get_match_tab_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_match_tab_counts(uuid) TO authenticated, service_role;

-- 3. RPC paginada `get_match_lead_groups` com ordenação comercial oficial antes da paginação
CREATE OR REPLACE FUNCTION public.get_match_lead_groups(
  p_account_id uuid,
  p_status text DEFAULT 'novo',
  p_min_score integer DEFAULT 90,
  p_max_score integer DEFAULT 100,
  p_min_maturity integer DEFAULT 0,
  p_max_maturity integer DEFAULT 100,
  p_min_ai_score integer DEFAULT 0,
  p_lead_search text DEFAULT NULL,
  p_property_search text DEFAULT NULL,
  p_date_filter text DEFAULT 'all',
  p_view_filter text DEFAULT 'all',
  p_sort_by text DEFAULT 'score_desc',
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
SECURITY DEFINER
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
  lead_aggregates AS (
    SELECT
      m.lead_id,
      MAX(m.profile_maturity)::integer AS profile_maturity,
      COUNT(*)::bigint AS status_matches_count,
      COUNT(*) FILTER (WHERE p_status = 'novo' AND m.viewed_at IS NULL)::bigint AS unread_matches_count,
      BOOL_OR(p_status = 'novo' AND m.viewed_at IS NULL) AS is_unread,
      BOOL_OR(COALESCE(m.reopened_at, m.created_at) >= now() - interval '7 days') AS is_recent,
      MAX(COALESCE(m.reopened_at, m.created_at)) AS latest_match_at,
      MIN(m.created_at) AS first_match_at,
      MAX(m.viewed_at) AS viewed_at,
      MAX(m.reopened_at) AS reopened_at,
      MAX(m.reopen_reason) AS reopen_reason,
      MAX(m.match_score) AS max_match_score,
      MAX(m.commercial_priority) AS max_priority
    FROM public.lead_property_matches m
    JOIN public.property_match_projections p
      ON p.account_id = m.account_id AND p.property_id = m.property_id
    WHERE m.account_id = p_account_id
      AND m.match_status = p_status
      AND m.suppressed = false
      AND m.match_score >= p_min_score
      AND m.match_score <= p_max_score
      AND m.profile_maturity >= p_min_maturity
      AND m.profile_maturity <= p_max_maturity
      AND (
        p_status IN ('arquivado', 'pausado', 'ignorado', 'enviado')
        OR (p.status = 'ativo' AND p.operation = 'venda')
      )
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
    GROUP BY m.lead_id
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
          la.profile_maturity DESC NULLS LAST,
          ac.ai_score DESC NULLS LAST,
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
        ROW_NUMBER() OVER (
          ORDER BY
            m.match_score DESC,
            m.profile_maturity DESC,
            m.commercial_priority DESC,
            COALESCE(m.reopened_at, m.created_at) DESC,
            m.id ASC
        ) AS rn,
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
        AND m.match_score >= p_min_score
        AND m.match_score <= p_max_score
        AND m.profile_maturity >= p_min_maturity
        AND m.profile_maturity <= p_max_maturity
        AND (
          p_status IN ('arquivado', 'pausado', 'ignorado', 'enviado')
          OR (p.status = 'ativo' AND p.operation = 'venda')
        )
        AND (
          p_property_search IS NULL OR btrim(p_property_search) = ''
          OR p.title ILIKE '%' || btrim(p_property_search) || '%'
          OR p.neighborhood ILIKE '%' || btrim(p_property_search) || '%'
          OR COALESCE(p.code, '') ILIKE '%' || btrim(p_property_search) || '%'
        )
      ORDER BY
        m.match_score DESC,
        m.profile_maturity DESC,
        m.commercial_priority DESC,
        COALESCE(m.reopened_at, m.created_at) DESC,
        m.id ASC
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
