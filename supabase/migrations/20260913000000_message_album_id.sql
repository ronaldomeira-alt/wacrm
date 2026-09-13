-- Add album_id and album_index to messages table to bind media items sent in a batch
ALTER TABLE messages ADD COLUMN IF NOT EXISTS album_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS album_index integer;

-- Create index for quick lookup of messages belonging to the same album
CREATE INDEX IF NOT EXISTS idx_messages_album_id ON messages(album_id) WHERE album_id IS NOT NULL;
