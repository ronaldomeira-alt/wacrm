-- ============================================================
-- 20260912140000_ai_contextual_reactivation.sql
--
-- Adds tracking columns and indexes for Clara's global contextual
-- reactivation layer for conversations interrupted by customer silence.
--
-- Non-destructive & idempotent.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_reactivation_status text
    CHECK (ai_reactivation_status IN ('scheduled', 'sent', 'cancelled', 'skipped', 'failed')),
  ADD COLUMN IF NOT EXISTS ai_reactivation_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_reactivation_scheduled_for timestamptz,
  ADD COLUMN IF NOT EXISTS ai_reactivation_last_message_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_reactivation_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN conversations.ai_reactivation_status IS
  'Status of the contextual reactivation when a customer stops responding: scheduled | sent | cancelled | skipped | failed. NULL = not yet evaluated.';
COMMENT ON COLUMN conversations.ai_reactivation_sent_at IS
  'Timestamp when the contextual reactivation message was sent.';
COMMENT ON COLUMN conversations.ai_reactivation_scheduled_for IS
  'Timestamp when reactivation is scheduled to be evaluated/sent (e.g. 08:00 opening if 3h window fell outside business hours).';
COMMENT ON COLUMN conversations.ai_reactivation_last_message_at IS
  'Timestamp of the conversation last_message_at when reactivation was evaluated, used to detect if newer messages arrived.';
COMMENT ON COLUMN conversations.ai_reactivation_count IS
  'Count of reactivation attempts sent for this conversation.';

CREATE INDEX IF NOT EXISTS idx_conversations_reactivation_candidates
  ON conversations (account_id, last_message_at)
  WHERE status <> 'closed' AND assigned_agent_id IS NULL AND ai_autoreply_disabled = false;
