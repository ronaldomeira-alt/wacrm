-- ============================================================
-- 20260911100000_properties_provisional_status.sql
--
-- Backs "Imóveis Provisórios": the learning cron can now create a
-- `properties` row on its own when the corretor keeps discussing an
-- empreendimento on WhatsApp without ever registering it, instead of
-- discarding that learning for lack of a property_id.
--
-- `status` defaults to 'ativo' so every existing property (Live Park,
-- Avant Home, Puerto Ventura, any manually-created one) is unaffected —
-- no backfill needed. `created_from_learning` is audit-only, to tell
-- auto-created listings apart from manually registered ones later.
-- ============================================================

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ativo'
    CHECK (status IN ('provisorio', 'ativo'));

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS created_from_learning boolean NOT NULL DEFAULT false;
