-- ============================================================
-- 20260911150000_properties_normalized_name_unique.sql
--
-- Closes the gap found by the concurrency audit: two overlapping calls
-- to resolveOrCreateProperty() (src/lib/ai/property-learning-apply.ts)
-- for the very same empreendimento — e.g. two overlapping cron runs, or
-- a manual approval racing the auto-apply path — could both pass the
-- identity/evidence checks and both INSERT, producing two duplicate
-- properties. `properties` had no uniqueness protection at all beyond
-- its UUID primary key (see 045_properties_and_weekly_agenda.sql).
--
-- `normalized_name` stores the COMPACT identity form — lowercase,
-- accents stripped, every separator (spaces, hyphens, punctuation)
-- removed entirely, not just collapsed to a space. This is deliberately
-- the SAME notion of identity resolvePropertyIdentity's own exact-match
-- check already uses (compactForMatch() / `existingCompact ===
-- candidateCompact` in src/lib/ai/property-identity.ts) — "Live Park"
-- and "LivePark" and "Live-Park" and "Live  Park" all collapse to the
-- identical "livepark". An earlier version of this migration used the
-- SPACED form (normalizeForMatch()) instead, which the concurrency
-- audit found insufficient: "livepark" and "live park" are different
-- strings to Postgres even though the resolver treats them as one
-- identity, so two differently-spaced spellings of the same brand-new
-- name could still race past a spaced-form constraint. Using the same
-- compact form the resolver itself uses for "these are the same
-- property" closes that gap: IDENTITY (resolver) = NORMALIZATION
-- (persisted) = UNIQUENESS KEY (database).
--
-- A name that normalizes to nothing (e.g. entirely non-Latin script,
-- with no ASCII letters or digits at all) stores NULL rather than an
-- empty string — two such degenerate, unrelated names must never be
-- treated as "the same property" just because they share a blank key.
--
-- A PARTIAL unique index (not a NOT NULL column + full UNIQUE
-- constraint) on purpose: it protects every insert that supplies
-- normalized_name (which is every path this migration/change actually
-- touches) without imposing a hard precondition on any other existing
-- or future insert path into `properties` that might not populate it —
-- degrading safely (unprotected, not broken) rather than failing loudly
-- for something outside this fix's scope (e.g. the manual "Novo
-- Empreendimento" UI form is deliberately left untouched here).
--
-- Safety check performed BEFORE writing this migration (read-only query
-- against production, 2026-09-11), using the NEW compact normalization:
--   SELECT account_id, regexp_replace(lower(unaccent(name)), '[^a-z0-9]+', '', 'g') AS compact_name,
--          array_agg(name), count(*)
--   FROM properties GROUP BY account_id, compact_name HAVING count(*) > 1;
-- returned zero rows — all 3 existing properties (Live Park ->
-- "livepark", Avant Home -> "avanthome", "Puerto Ventura - Locação" ->
-- "puertoventuralocacao") are distinct within their single account, so
-- creating this index is safe. If a future environment DOES have a
-- compact-identity duplicate, CREATE UNIQUE INDEX below fails loudly
-- and the migration aborts without altering, merging, or deleting any
-- data — by design, this migration never resolves conflicts on your
-- behalf.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS normalized_name TEXT;

-- One-time backfill for rows that pre-date this column. Every new
-- insert going forward supplies normalized_name directly from the JS
-- compactForMatch() implementation; this UPDATE is a best-effort SQL
-- approximation of that same compact normalization, used only once.
-- NULLIF converts an all-separator/non-Latin name's empty result to
-- NULL, matching the application's own null-for-empty handling.
UPDATE properties
SET normalized_name = NULLIF(regexp_replace(lower(unaccent(name)), '[^a-z0-9]+', '', 'g'), '')
WHERE normalized_name IS NULL;

-- The actual concurrency guard: two concurrent inserts for the same
-- (account_id, normalized_name) can never both succeed — the loser gets
-- a 23505 unique_violation, which resolveOrCreateProperty() now treats
-- as "someone else just created it", recovering the winner's id instead
-- of failing. Because normalized_name is the compact form, this catches
-- races between differently-spaced/separated spellings of the same
-- empreendimento, not just byte-identical strings. Two different
-- accounts each having their own "Live Park" never conflicts
-- (account_id is part of the key). Two different, unrelated properties
-- that both happen to normalize to NULL never conflict either (NULL is
-- excluded from the index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_account_normalized_name
  ON properties (account_id, normalized_name)
  WHERE normalized_name IS NOT NULL;
