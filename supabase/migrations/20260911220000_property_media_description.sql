-- ============================================================
-- 20260911220000_property_media_description.sql
--
-- Enhances property_images to support optional per-media descriptions,
-- tracking of update timestamps, and raises the property-media Storage
-- bucket limit to 16 MB for high-resolution smartphone photos.
--
-- Non-destructive & idempotent.
-- ============================================================

-- 1. Add description and updated_at to property_images if not present
ALTER TABLE property_images
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 2. Update property-media storage bucket limit to 16 MB
UPDATE storage.buckets
SET file_size_limit = 16777216 -- 16 MB
WHERE id = 'property-media';
