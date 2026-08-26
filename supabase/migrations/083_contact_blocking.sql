-- ============================================================
-- 083_contact_blocking.sql — Bloquear Lead
--
-- Same convention as contacts.archived_at (069_contact_archiving.sql):
-- a nullable timestamp, reversible, orthogonal to deleting the row. A
-- blocked contact stays in the database (history preserved) but is
-- excluded from the Inbox conversation list and, per the webhook's
-- early guard (see processMessage in src/app/api/whatsapp/webhook/
-- route.ts), stops generating any new conversation/message/automation/
-- AI/follow-up activity the moment they message in again.
--
-- No RLS change needed — contacts_update already allows any account
-- member to write any column.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS blocked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_contacts_account_blocked
  ON contacts (account_id, blocked_at);
