-- ============================================================
-- 086_match_foundation.sql
--
-- Fundação do Túnel WACRM ↔ Meus Imóveis:
-- 1. Proveniência de tags em `contact_tags` (CTWA vs Conversa vs Manual)
-- 2. Suporte a pausa em `contacts` (`paused_at`)
-- 3. Tabela `property_match_projections` (Cache local dos imóveis para o Match)
-- 4. Tabela `lead_property_matches` (Pares Lead ↔ Imóvel com score e supressão)
-- 5. Tabela `property_shares` (Tokens individuais opacos por envio via WhatsApp pessoal)
-- 6. Tabela `tracking_events` (Registro de aberturas, navegações e "Tenho interesse")
--
-- Idempotente — seguro para executar repetidamente.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Proveniência em contact_tags
-- ------------------------------------------------------------
ALTER TABLE contact_tags
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'conversation',
  ADD COLUMN IF NOT EXISTS originally_from_ctwa boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_tags_source_check'
  ) THEN
    ALTER TABLE contact_tags
      ADD CONSTRAINT contact_tags_source_check
      CHECK (source IN ('ctwa', 'conversation', 'manual'));
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Pausa em contacts
-- ------------------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS paused_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_contacts_account_paused
  ON contacts (account_id, paused_at);

-- ------------------------------------------------------------
-- 3. property_match_projections
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_match_projections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  code text,
  title text NOT NULL,
  operation text NOT NULL DEFAULT 'venda' CHECK (operation IN ('venda', 'locacao')),
  property_type text NOT NULL DEFAULT 'apartamento',
  neighborhood text NOT NULL,
  city text NOT NULL DEFAULT 'João Pessoa',
  price_min numeric NOT NULL DEFAULT 0,
  price_max numeric NOT NULL DEFAULT 0,
  area_min numeric,
  area_max numeric,
  bedrooms_min integer,
  bedrooms_max integer,
  delivery_status text NOT NULL DEFAULT 'pronto' CHECK (delivery_status IN ('pronto', 'planta', 'em_construcao')),
  delivery_deadline date,
  features text[] NOT NULL DEFAULT '{}',
  cover_url text,
  public_url text,
  status text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo', 'arquivado')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_property_match_projections_account
  ON property_match_projections(account_id);
CREATE INDEX IF NOT EXISTS idx_property_match_projections_lookup
  ON property_match_projections(account_id, property_id);

ALTER TABLE property_match_projections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_match_projections_select ON property_match_projections;
CREATE POLICY property_match_projections_select ON property_match_projections FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS property_match_projections_insert ON property_match_projections;
CREATE POLICY property_match_projections_insert ON property_match_projections FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS property_match_projections_update ON property_match_projections;
CREATE POLICY property_match_projections_update ON property_match_projections FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS property_match_projections_delete ON property_match_projections;
CREATE POLICY property_match_projections_delete ON property_match_projections FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ------------------------------------------------------------
-- 4. lead_property_matches
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_property_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  match_score numeric(5,2) NOT NULL DEFAULT 0,
  score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  profile_maturity integer NOT NULL DEFAULT 0,
  commercial_priority numeric(6,2) NOT NULL DEFAULT 0,
  match_status text NOT NULL DEFAULT 'novo' CHECK (match_status IN ('novo', 'enviado', 'pausado', 'arquivado')),
  suppressed boolean NOT NULL DEFAULT false,
  origin text NOT NULL DEFAULT 'match_automatico' CHECK (origin IN ('match_automatico', 'envio_manual', 'origem_ctwa')),
  sent_at timestamptz,
  paused_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, lead_id, property_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_property_matches_account
  ON lead_property_matches(account_id);
CREATE INDEX IF NOT EXISTS idx_lead_property_matches_lead
  ON lead_property_matches(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_property_matches_property
  ON lead_property_matches(property_id);
CREATE INDEX IF NOT EXISTS idx_lead_property_matches_status
  ON lead_property_matches(account_id, match_status) WHERE NOT suppressed;

ALTER TABLE lead_property_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_property_matches_select ON lead_property_matches;
CREATE POLICY lead_property_matches_select ON lead_property_matches FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS lead_property_matches_insert ON lead_property_matches;
CREATE POLICY lead_property_matches_insert ON lead_property_matches FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS lead_property_matches_update ON lead_property_matches;
CREATE POLICY lead_property_matches_update ON lead_property_matches FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS lead_property_matches_delete ON lead_property_matches;
CREATE POLICY lead_property_matches_delete ON lead_property_matches FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ------------------------------------------------------------
-- 5. property_shares
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  match_id uuid REFERENCES lead_property_matches(id) ON DELETE SET NULL,
  tracking_token text NOT NULL UNIQUE,
  channel text NOT NULL DEFAULT 'whatsapp_pessoal',
  message_text text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  first_opened_at timestamptz,
  last_opened_at timestamptz,
  open_count integer NOT NULL DEFAULT 0,
  is_interested boolean NOT NULL DEFAULT false,
  interested_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_shares_account ON property_shares(account_id);
CREATE INDEX IF NOT EXISTS idx_property_shares_token ON property_shares(tracking_token);
CREATE INDEX IF NOT EXISTS idx_property_shares_lead ON property_shares(lead_id);

ALTER TABLE property_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_shares_select ON property_shares;
CREATE POLICY property_shares_select ON property_shares FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS property_shares_insert ON property_shares;
CREATE POLICY property_shares_insert ON property_shares FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS property_shares_update ON property_shares;
CREATE POLICY property_shares_update ON property_shares FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS property_shares_delete ON property_shares;
CREATE POLICY property_shares_delete ON property_shares FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ------------------------------------------------------------
-- 6. tracking_events
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  share_id uuid NOT NULL REFERENCES property_shares(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  event_name text NOT NULL CHECK (event_name IN ('public_link.opened', 'public_related_property.opened', 'public_interest.clicked')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tracking_events_share ON tracking_events(share_id);
CREATE INDEX IF NOT EXISTS idx_tracking_events_lead ON tracking_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_tracking_events_property ON tracking_events(property_id);

ALTER TABLE tracking_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tracking_events_select ON tracking_events;
CREATE POLICY tracking_events_select ON tracking_events FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS tracking_events_insert ON tracking_events;
CREATE POLICY tracking_events_insert ON tracking_events FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
