-- Migration: 20260912200000_media_objects_async_normalization.sql
-- Description: Add columns for asynchronous server-side normalization of HEIC/HEIF media

ALTER TABLE public.media_objects
  ADD COLUMN IF NOT EXISTS normalized_key text,
  ADD COLUMN IF NOT EXISTS original_key text,
  ADD COLUMN IF NOT EXISTS processing_status text DEFAULT 'none' CHECK (processing_status IN ('none', 'pending', 'processing', 'completed', 'failed')),
  ADD COLUMN IF NOT EXISTS processing_error text;

CREATE INDEX IF NOT EXISTS media_objects_processing_status_idx
  ON public.media_objects (processing_status)
  WHERE processing_status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS media_objects_original_key_idx
  ON public.media_objects (original_key)
  WHERE original_key IS NOT NULL;
