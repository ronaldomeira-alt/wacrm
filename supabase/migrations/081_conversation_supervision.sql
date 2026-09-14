-- ============================================================
-- 081_conversation_supervision.sql — "Sem supervisão" Inbox queue.
--
-- Problem: `unread_count` (001) only tracks "has a customer message
-- been seen" — it's never touched by an agent send or a Clara
-- (AI, `messages.ai_generated = true`) auto-reply send. So today
-- there's no signal distinguishing "Clara answered and nobody on the
-- team has looked" from "the customer messaged and nobody has looked
-- yet" — both just show as unread_count > 0.
--
-- This adds a second, independent axis — human review of Clara's
-- activity — derived from two plain timestamps so it can never drift
-- out of sync with itself:
--   - last_ai_reply_at: bumped whenever Clara (not a deterministic
--     Flow/automation bot send — see 033's ai_generated distinction)
--     sends a message on the conversation.
--   - last_reviewed_at / last_reviewed_by: bumped whenever a human
--     engages with the conversation — sends a message themselves, or
--     explicitly marks it reviewed from the Inbox.
--
-- needs_review is GENERATED (not written by the app) so the "Sem
-- supervisão" rule has exactly one source of truth: a conversation
-- is unsupervised whenever Clara's most recent reply is newer than
-- the most recent human review. This also gives the "reopens after a
-- new Clara reply following review" behavior for free — no extra
-- logic, no cron, no drift.
--
-- Deliberately NOT a status enum: everything here is derivable from
-- the two timestamps, so a parallel state column would just be a
-- second source of truth that can disagree with itself.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN last_ai_reply_at TIMESTAMPTZ,
  ADD COLUMN last_reviewed_at TIMESTAMPTZ,
  ADD COLUMN last_reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE conversations
  ADD COLUMN needs_review BOOLEAN GENERATED ALWAYS AS (
    last_ai_reply_at IS NOT NULL
    AND (last_reviewed_at IS NULL OR last_ai_reply_at > last_reviewed_at)
  ) STORED;

COMMENT ON COLUMN conversations.last_ai_reply_at IS
  'Timestamp of the most recent message Clara (AI, ai_generated=true) sent on this conversation. Never set by a deterministic Flow/automation bot send.';
COMMENT ON COLUMN conversations.last_reviewed_at IS
  'Timestamp of the most recent human engagement with this conversation (an agent message send, an explicit "mark as reviewed", or taking the conversation over).';
COMMENT ON COLUMN conversations.last_reviewed_by IS
  'auth.users.id of the human who last reviewed this conversation (see last_reviewed_at).';
COMMENT ON COLUMN conversations.needs_review IS
  '"Sem supervisão": true whenever Clara has replied more recently than any human has reviewed the conversation. Derived, not written directly.';

-- Partial index: the Inbox counter/filter only ever cares about the
-- account's currently-unsupervised, non-closed conversations — same
-- shape as the unanswered-conversations query pattern (047/061).
CREATE INDEX idx_conversations_needs_review
  ON conversations (account_id)
  WHERE needs_review AND status <> 'closed';

-- ============================================================
-- TRIGGER — keep last_ai_reply_at / last_reviewed_at in sync with
-- every message send, so needs_review updates itself with zero app
-- code. Mirrors notify_conversation_assigned's shape (027): plain
-- plpgsql, SECURITY DEFINER (message inserts happen under both the
-- RLS-scoped user client and the service-role webhook client, and
-- this bookkeeping update must succeed either way), and a swallowed
-- exception so a bug here can never block a message from sending.
--
-- Only sender_type='agent' inserts with a real sender_id count as
-- human review — same qualifier list_conversation_last_agent_senders
-- (054) already uses to mean "an actual person sent this", not a
-- system/API send with no attributable user.
--
-- Only sender_type='bot' AND ai_generated=true counts as a Clara
-- reply — a Flow/automation send (sender_type='bot', ai_generated
-- false) is a different, already-reviewed-by-design mechanism and
-- must not enter this queue (033's own distinction).
-- ============================================================
CREATE OR REPLACE FUNCTION update_conversation_review_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_type = 'bot' AND NEW.ai_generated THEN
    UPDATE conversations
    SET last_ai_reply_at = NEW.created_at
    WHERE id = NEW.conversation_id;
  ELSIF NEW.sender_type = 'agent' AND NEW.sender_id IS NOT NULL THEN
    UPDATE conversations
    SET last_reviewed_at = NEW.created_at,
        last_reviewed_by = NEW.sender_id
    WHERE id = NEW.conversation_id;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let this bookkeeping update block a message from sending.
  RAISE WARNING 'Failed to update review state for conversation %: %', NEW.conversation_id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION update_conversation_review_state() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_conversation_review_state ON messages;
CREATE TRIGGER trg_conversation_review_state
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION update_conversation_review_state();
