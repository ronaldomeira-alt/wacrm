-- ============================================================
-- 088_match_lifecycle_and_notifications.sql
--
-- Evolução segura e idempotente do módulo Match:
-- 1. Novos estados de ciclo de vida (`em_analise`, `ignorado`) e metadados
--    de visualização, reabertura por mudança material e snapshot de decisão.
-- 2. Expansão de `notifications` para suportar alertas internos de Match
--    (`match_created`, `match_reopened`, `match_interest`) com `metadata`.
-- 3. Ativação do Supabase Realtime em `lead_property_matches` e
--    `property_match_projections` (anteriormente ausentes da publicação).
-- 4. Índices parciais para ordenação por recência sem scan completo.
-- 5. Atualização da RPC `get_match_tab_counts` para refletir todos os 6 estados
--    e excluir leads arquivados/pausados das abas ativas (`novo`/`em_analise`).
-- 6. Higienização segura dos registros históricos (sem exclusão indiscriminada
--    e sem disparar notificações retroativas).
--
-- Reversibilidade: todas as colunas adicionadas são opcionais ou possuem default;
-- nenhum dado comercial válido (enviado, pausado, arquivado, top-25 por lead) é perdido.
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

-- Índices para ordenação por recência e listagem de ignorados sem regressão de performance
CREATE INDEX IF NOT EXISTS idx_lead_property_matches_account_created
  ON public.lead_property_matches (account_id, created_at DESC)
  WHERE suppressed = false;

CREATE INDEX IF NOT EXISTS idx_lead_property_matches_account_suppressed
  ON public.lead_property_matches (account_id, updated_at DESC)
  WHERE suppressed = true;

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
-- 5. Higienização segura dos registros históricos existentes
--    (Preserva histórico comercial e evita perda de leads válidos)
-- ------------------------------------------------------------

-- 5.1 Move matches 'novo' de contatos que já estão arquivados no CRM para 'arquivado'
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

-- 5.2 Move matches 'novo' de contatos que já estão pausados no CRM para 'pausado'
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

-- 5.3 Remove excesso de linhas redundantes 'novo' além do Top 25 por lead
--     (ex.: leads que acumularam até 306 matches de 69% por falta de teto no recálculo por imóvel).
--     Preserva 100% dos top 25 imóveis de cada lead e 100% de enviados/pausados/arquivados/ignorados.
WITH ranked_novos AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, lead_id
      ORDER BY match_score DESC, commercial_priority DESC, created_at DESC
    ) AS rn
  FROM public.lead_property_matches
  WHERE match_status = 'novo'
    AND suppressed = false
    AND viewed_at IS NULL
)
DELETE FROM public.lead_property_matches m
USING ranked_novos r
WHERE m.id = r.id
  AND r.rn > 25;

COMMIT;
