-- ============================================================
-- 20260914141753_conversation_supervision_queue.sql — "Sem
-- supervisão" Inbox queue.
--
-- Problem: `unread_count` only tracks "has a customer message been
-- seen" — it's never touched by an agent send or a Clara (AI)
-- auto-reply send. There's no signal distinguishing "Clara answered
-- (or flagged she needs a human) and nobody on the team has looked"
-- from "the customer messaged and nobody has looked yet" — both just
-- show as unread_count > 0.
--
-- This adds a second, independent axis — human review of Clara's
-- activity — derived from two timestamps so it can never drift out
-- of sync with itself:
--   - last_ai_reply_at: bumped whenever Clara (not a deterministic
--     Flow/automation bot send — see 033's ai_generated distinction)
--     sends a message, OR whenever she flags ai_transfer_status =
--     'pending_human' (the AI transfer system added in
--     085_property_ai_context.sql) — a turn can end in a handoff
--     with NO accompanying message (src/lib/ai/auto-reply.ts only
--     sends when turnResult.responseText is non-empty, but always
--     runs "POST-TURN HANDOFF HANDLING" when the model signals
--     transfer_required), so relying on messages alone would miss
--     that case.
--   - last_reviewed_at / last_reviewed_by: bumped whenever a human
--     engages with the conversation — sends a message themselves, or
--     explicitly marks it reviewed from the Inbox, or takes it over
--     (see the /api/ai/autoreply route change accompanying this
--     migration).
--
-- needs_review is GENERATED (not written by the app) so the "Sem
-- supervisão" rule has exactly one source of truth: a conversation
-- is unsupervised whenever Clara's most recent activity is newer
-- than the most recent human review. This also gives "reopens after
-- a new Clara reply following review" for free — no extra logic, no
-- cron, no drift.
--
-- Deliberately NOT built on ai_transfer_status directly, and NOT
-- reusing ai_last_turn_processed_at (20260911233000_ai_conversation_
-- lock_and_turn.sql): that column is stamped after every processed
-- turn, including ones where the bot produced neither a message nor
-- a transfer flag (e.g. it chose to stay silent) — using it here
-- would flag conversations for review that Clara never actually
-- surfaced anything on, which is exactly the "fragile heuristic"
-- this feature needs to avoid. last_ai_reply_at only moves on the
-- two concrete, unambiguous actions above.
--
-- Deliberately NOT a status enum: everything here is derivable from
-- two timestamps, so a parallel state column would just be a second
-- source of truth that can disagree with itself.
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
  'Timestamp of the most recent Clara activity worth a human review on this conversation: a real message (ai_generated=true) or an ai_transfer_status transition into pending_human. Never set by a deterministic Flow/automation bot send.';
COMMENT ON COLUMN conversations.last_reviewed_at IS
  'Timestamp of the most recent human engagement with this conversation (an agent message send, an explicit "mark as reviewed", or taking the conversation over).';
COMMENT ON COLUMN conversations.last_reviewed_by IS
  'auth.users.id of the human who last reviewed this conversation (see last_reviewed_at).';
COMMENT ON COLUMN conversations.needs_review IS
  '"Sem supervisão": true whenever Clara has done something (replied, or flagged pending_human) more recently than any human has reviewed the conversation. Derived, not written directly.';

-- Partial index: the Inbox counter/filter only ever cares about the
-- account's currently-unsupervised, non-closed conversations — same
-- shape as the unanswered-conversations query pattern (047/061).
CREATE INDEX idx_conversations_needs_review
  ON conversations (account_id)
  WHERE needs_review AND status <> 'closed';

-- ============================================================
-- TRIGGER 1 — messages: Clara reply bumps last_ai_reply_at, a human
-- agent's own message bumps last_reviewed_at/by. Mirrors
-- notify_conversation_assigned's (027) and list_conversation_last_
-- agent_senders' (054) shape: plain plpgsql, SECURITY DEFINER
-- (message inserts happen under both the RLS-scoped user client and
-- the service-role webhook/AI client), and a swallowed exception so
-- a bug here can never block a message from sending.
--
-- Only sender_type='agent' inserts with a real sender_id count as
-- human review — same qualifier list_conversation_last_agent_senders
-- already uses to mean "an actual person sent this". Only
-- sender_type='bot' AND ai_generated=true counts as a Clara reply —
-- a Flow/automation send (ai_generated false) is a different,
-- already-reviewed-by-design mechanism and must not enter this queue.
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

-- ============================================================
-- TRIGGER 2 — conversations: a transition into ai_transfer_status =
-- 'pending_human' also counts as Clara activity worth reviewing,
-- even on a turn where the model produced no message (see the
-- header comment). BEFORE UPDATE so it mutates NEW in place — no
-- extra self-referencing UPDATE statement, and scoped to `UPDATE OF
-- ai_transfer_status` so it can never recurse (this trigger's own
-- write never touches that column). Only fires on entry into
-- pending_human, not on pending_human -> transferred (a human
-- reply, already covered by trigger 1) or any transition to 'none'
-- (Resume AI) or 'resolved' (unused today).
-- ============================================================
CREATE OR REPLACE FUNCTION mark_ai_transfer_pending_as_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.ai_transfer_status = 'pending_human'
     AND OLD.ai_transfer_status IS DISTINCT FROM 'pending_human' THEN
    NEW.last_ai_reply_at := GREATEST(
      COALESCE(NEW.last_ai_reply_at, '-infinity'::timestamptz),
      COALESCE(NEW.ai_transfer_at, now())
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to mark AI transfer activity for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION mark_ai_transfer_pending_as_activity() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_ai_transfer_pending_marks_activity ON conversations;
CREATE TRIGGER trg_ai_transfer_pending_marks_activity
  BEFORE UPDATE OF ai_transfer_status ON conversations
  FOR EACH ROW EXECUTE FUNCTION mark_ai_transfer_pending_as_activity();
