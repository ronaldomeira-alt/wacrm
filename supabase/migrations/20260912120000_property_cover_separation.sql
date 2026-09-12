-- ============================================================
-- 20260912120000_property_cover_separation.sql
--
-- Separates Property Cover Image (internal CRM visual identity)
-- from Property Commercial Media (sendable by Clara, capped at 5).
--
-- Non-destructive & idempotent.
-- ============================================================

-- 1. Add cover_image_path to properties table if not present
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS cover_image_path text;

-- 2. Migrate existing covers from property_images to properties.cover_image_path
UPDATE properties p
SET cover_image_path = pi.storage_path
FROM property_images pi
WHERE pi.property_id = p.id
  AND pi.is_cover = true
  AND (p.cover_image_path IS NULL OR p.cover_image_path = '');

-- 3. Remove is_cover rows from property_images so they are no longer in the sendable media collection
-- (the physical storage objects are preserved in Supabase Storage for the cover)
DELETE FROM property_images
WHERE is_cover = true;
