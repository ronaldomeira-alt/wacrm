-- ============================================================
-- 084_calendar_watch_channels.sql — custom feature, not part of the
-- upstream wacrm template.
--
-- Backs the Google Calendar → CRM half of sync (src/lib/calendar/
-- google-watch.ts, inbound-sync-service.ts). The existing
-- calendar_connections row (migration 053) only ever needed OAuth
-- tokens for the one-way CRM → Google push; receiving Google's own
-- Events.watch push notifications needs a few more fields:
--
--   channel_id / resource_id  — identify the push-notification
--     channel registered with Google (events.watch/channels.stop).
--     channel_id is what the inbound webhook looks the connection up
--     by (Google echoes it back as X-Goog-Channel-Id on every call).
--   channel_token_encrypted   — a secret we mint and hand to Google
--     at registration time; echoed back as X-Goog-Channel-Token on
--     every notification so the public webhook route can verify a
--     request actually came from the channel we registered, not a
--     forged POST hitting the endpoint blind.
--   channel_expires_at        — Google's channel TTL; a scheduled
--     GET /api/calendar/google/watch-cron tick re-registers channels
--     nearing this before they lapse.
--   sync_token                — Google Calendar's incremental-sync
--     cursor (events.list's nextSyncToken). Independent of the watch
--     channel's lifecycle — renewing the channel never resets this.
-- ============================================================

ALTER TABLE calendar_connections
  ADD COLUMN IF NOT EXISTS channel_id TEXT,
  ADD COLUMN IF NOT EXISTS resource_id TEXT,
  ADD COLUMN IF NOT EXISTS channel_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS channel_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_token TEXT;

-- Sparse unique index — most rows will have a channel once connected,
-- but never enforce uniqueness on NULL (a connection that hasn't
-- registered a channel yet, or lost it) via a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_connections_channel_id
  ON calendar_connections(channel_id) WHERE channel_id IS NOT NULL;

-- ============================================================
-- appointments — last known Google event etag, so an inbound change
-- that's just the echo of our own CRM → Google push (see
-- CalendarSyncService.sync) can be told apart from a genuine external
-- edit (iPhone / Google Calendar Web / Android) and skipped instead
-- of overwriting CRM-only fields (notes, contact_id, client_name,
-- property_id, type) that a Google event has no concept of.
-- ============================================================
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS external_calendar_etag TEXT;
