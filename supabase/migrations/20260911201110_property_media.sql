-- ============================================================
-- 20260911180000_property_media.sql
--
-- Adds photo/plan gallery support for a property's AI knowledge modal
-- (Central de IA → Conhecimento → aba "Mídia"): a `property-media`
-- Storage bucket plus a `property_images` metadata table (one row per
-- uploaded file — storage path, cover flag, display order).
--
-- Mirrors the `chat-media` bucket (migration 023) and its account-scoped
-- storage RLS: public reads (so <img> tags work without auth), writes
-- gated by the object path's `account-<account_id>` first segment.
--
-- Path convention: property-media/account-<account_id>/<timestamp>-<basename>.<ext>
-- (built by the existing `buildMediaPath` helper in src/lib/storage/upload-media.ts —
-- the client uploads directly to Storage, then POSTs the resulting path
-- here to create the metadata row, same two-step flow as chat-media).
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. property-media storage bucket — images only, 8 MB/file
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'property-media',
  'property-media',
  TRUE,
  8388608, -- 8 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Property media is publicly readable" ON storage.objects;
CREATE POLICY "Property media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'property-media');

DROP POLICY IF EXISTS "Members can upload property media" ON storage.objects;
CREATE POLICY "Members can upload property media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'property-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update property media" ON storage.objects;
CREATE POLICY "Members can update property media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'property-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete property media" ON storage.objects;
CREATE POLICY "Members can delete property media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'property-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- 2. property_images — one row per uploaded file
-- ============================================================
CREATE TABLE IF NOT EXISTS property_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  property_id   uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  storage_path  text NOT NULL,
  file_name     text NOT NULL,
  file_size     bigint,
  content_type  text,
  is_cover      boolean NOT NULL DEFAULT false,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_images_property
  ON property_images(property_id, position);
CREATE INDEX IF NOT EXISTS idx_property_images_account
  ON property_images(account_id);

-- At most one cover per property — enforced with a partial unique index
-- rather than a trigger; the API clears the previous cover in the same
-- request before setting the new one (see PATCH /api/ai/properties/[id]/images/[imageId]).
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_images_one_cover
  ON property_images(property_id) WHERE is_cover;

ALTER TABLE property_images ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_images_select ON property_images;
CREATE POLICY property_images_select ON property_images FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS property_images_insert ON property_images;
CREATE POLICY property_images_insert ON property_images FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS property_images_update ON property_images;
CREATE POLICY property_images_update ON property_images FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS property_images_delete ON property_images;
CREATE POLICY property_images_delete ON property_images FOR DELETE
  USING (is_account_member(account_id, 'agent'));
