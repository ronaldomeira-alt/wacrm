-- ============================================================
-- 20260921222100_property_media_video_mime.sql
--
-- Extends the existing `property-media` Storage bucket (migration
-- 20260911201110) to also accept commercial videos for the property's
-- media gallery ("Mídia" tab), alongside the existing photos.
--
-- No new bucket, no new table — videos are `property_images` rows like
-- photos, differentiated by `content_type`. Videos are normalized
-- (transcoded to H.264/AAC MP4, capped at 16MB) client-side via the
-- existing transcode-mov-webcodecs.ts infra BEFORE upload, so only the
-- two WhatsApp Cloud API-accepted video containers need to be allowed
-- here — the bucket never receives an incompatible original file.
--
-- `file_size_limit` is already 16 MB (raised by migration
-- 20260911220000) — matches the 16 MB WhatsApp video cap, so it is left
-- unchanged.
--
-- Idempotent — safe to re-run.
-- ============================================================

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/3gpp']
WHERE id = 'property-media';
