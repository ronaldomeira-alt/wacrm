-- 20260913150000_messages_metadata.sql — generic jsonb bag for
-- message-level metadata that the client has assumed exists for a
-- while (message-bubble.tsx / message-thread.tsx already read/write
-- `message.metadata`, e.g. `thumbnail_url`, batch-cancel flags) but
-- was never actually added to the schema, so it always came back
-- empty on any row loaded from the database. First real use: a
-- persisted R2 key for a video message's thumbnail, so the preview
-- survives a conversation reload instead of only living in browser
-- memory (see the video-pipeline thumbnail-persistence fix).

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS metadata JSONB;
