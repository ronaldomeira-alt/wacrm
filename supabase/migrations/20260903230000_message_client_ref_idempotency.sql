-- Idempotency key for outbound sends whose client can't tell whether a
-- prior, ambiguously-timed-out attempt already reached Meta.
--
-- Root cause of the voice-note double-send incident (2026-09-03): the
-- pending-audio pipeline (src/lib/inbox/pending-audio-sync.ts) times out
-- and retries the POST to /api/whatsapp/send on the client. Aborting that
-- fetch only stops the client from waiting — it does NOT stop the server,
-- which had already called Meta and was simply slow to respond (Hostinger
-- cold start, a slow DB write, etc). The retry then sends a second,
-- genuinely new message to the customer. The same risk applies to the
-- recovery sweep (scanAndRetryAllPendingAudio) resuming a "failed-send"
-- record whose earlier attempt may have actually succeeded server-side.
--
-- `client_ref` lets a caller pass a stable id (the pending-audio record's
-- id, unchanged across every retry of the same recording) so
-- sendMessageToConversation can recognize "I've already sent this exact
-- client-side attempt" and return the existing message instead of calling
-- Meta again. NULL for every other send path (regular text/media/template
-- sends aren't retried, so they don't need one).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS messages_client_ref_unique
  ON messages (client_ref)
  WHERE client_ref IS NOT NULL;
