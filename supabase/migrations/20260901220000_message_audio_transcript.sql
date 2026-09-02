-- 20260901220000_message_audio_transcript.sql
--
-- Auto-transcription of inbound (customer) voice notes. Two columns,
-- both nullable and only ever populated for content_type = 'audio' rows
-- whose sender_type = 'customer':
--
--   transcript_text        — the transcribed text itself.
--   transcript_generated_at — when it was produced, purely informational
--     (lets the UI show "transcrito às HH:MM" later if ever wanted; not
--     read by any query yet).
--
-- Deliberately a dedicated column, not a reuse of content_text (which is
-- already dual-purpose for plain text + media captions, see
-- src/lib/inbox/conversations.ts): audio never has a real caption (the
-- composer's voice-note flow bypasses the caption step entirely — see
-- message-composer.tsx), but overloading content_text here would make
-- every future reader re-derive "this must be a transcript, not a
-- caption, because audio never has captions" instead of it being
-- explicit in the schema. A separate column also keeps this feature
-- opt-out-able (drop the column, nothing else breaks) and keeps full-text
-- search over literal message content (content_text) from silently
-- picking up AI-generated text as if the customer had typed it.
--
-- NEVER populated for sender_type = 'agent'/'bot' — only the customer's
-- own voice notes are transcribed, by product decision (2026-09-01):
-- the business only cares about the customer's stated intent, and the
-- agent already knows what they themselves said.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS transcript_text TEXT,
  ADD COLUMN IF NOT EXISTS transcript_generated_at TIMESTAMPTZ;

COMMENT ON COLUMN messages.transcript_text IS
  'AI transcription of an inbound (customer) audio message. Never set for agent/bot-sent audio. Never sent back to the customer — internal use only (AI context + inbox UI, both agent-facing).';
