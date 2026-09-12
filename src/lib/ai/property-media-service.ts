import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MAX_AI_MEDIA_PER_TURN,
  type AiMediaSendAction,
  type PropertyMediaSummary,
} from './types'
import { PROPERTY_MEDIA_BUCKET } from '@/lib/storage/upload-media'

export interface ResolvedMediaToSend {
  mediaId: string
  propertyId: string
  storagePath: string
  publicUrl: string
  caption: string | null
  fileName: string
  contentType: string
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/jpg'])

function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { code?: string; message?: string }
  const code = err.code || ''
  const msg = (err.message || '').toLowerCase()
  return code === '42703' || code === 'PGRST204' || msg.includes('does not exist') || (msg.includes('column') && msg.includes('description'))
}

/**
 * Retrieves the available media list for a given property to feed into Clara's prompt context.
 */
export async function getAvailablePropertyMedia(
  db: SupabaseClient,
  accountId: string,
  propertyId: string,
): Promise<PropertyMediaSummary[]> {
  try {
    let images: Array<{
      id: string
      storage_path: string
      file_name: string
      content_type: string
      description?: string | null
      is_cover: boolean | null
      position: number | null
    }> | null = null

    // 1. First fetch property cover_image_path if available to ensure cover is NEVER treated as sendable media
    const { data: propertyRow } = await db
      .from('properties')
      .select('cover_image_path')
      .eq('id', propertyId)
      .maybeSingle()

    const coverPath = propertyRow?.cover_image_path || null

    const primaryQuery = await db
      .from('property_images')
      .select('id, storage_path, file_name, content_type, description, is_cover, position')
      .eq('account_id', accountId)
      .eq('property_id', propertyId)
      .eq('is_cover', false)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })

    if (primaryQuery.error) {
      if (isMissingColumnError(primaryQuery.error)) {
        console.warn(
          '[property-media-service] Column description missing in property_images (code 42703/PGRST204). Falling back to base columns.',
        )
        const fallbackQuery = await db
          .from('property_images')
          .select('id, storage_path, file_name, content_type, is_cover, position')
          .eq('account_id', accountId)
          .eq('property_id', propertyId)
          .eq('is_cover', false)
          .order('position', { ascending: true })
          .order('created_at', { ascending: true })

        if (fallbackQuery.error) {
          console.error('[property-media-service] Fallback query failed fetching property media:', fallbackQuery.error)
          return []
        }
        images = fallbackQuery.data
      } else {
        console.error('[property-media-service] Error fetching property media:', primaryQuery.error)
        return []
      }
    } else {
      images = primaryQuery.data
    }

    if (!images || images.length === 0) {
      return []
    }

    // Filter out any image whose storage_path matches the property's cover image path or has is_cover === true
    const filteredImages = images.filter((img) => {
      if (img.is_cover === true) return false
      if (coverPath && img.storage_path === coverPath) return false
      return true
    })

    return filteredImages.map((img) => {
      const publicUrl = db.storage
        .from(PROPERTY_MEDIA_BUCKET)
        .getPublicUrl(img.storage_path).data.publicUrl

      return {
        id: img.id,
        type: 'image' as const,
        description: img.description || null,
        file_name: img.file_name,
        is_cover: false,
        url: publicUrl,
      }
    })
  } catch (err) {
    console.error('[property-media-service] Unexpected error loading available property media:', err)
    return []
  }
}

/**
 * Validates requested media items from the LLM turn against the database and Storage:
 * 1. Checks that the media exists and is not a cover image.
 * 2. Checks that the media belongs to the specified account and active property.
 * 3. Enforces that the content_type is an allowed image.
 * 4. Caps to MAX_AI_MEDIA_PER_TURN items.
 * 5. Resolves valid public URLs.
 */
export async function validateAndResolveMediaToSend(
  db: SupabaseClient,
  accountId: string,
  propertyId: string | null,
  requestedMedia: AiMediaSendAction[] | null | undefined,
): Promise<ResolvedMediaToSend[]> {
  if (!propertyId || !Array.isArray(requestedMedia) || requestedMedia.length === 0) {
    return []
  }

  // Cap requested media per turn
  const cappedRequests = requestedMedia.slice(0, MAX_AI_MEDIA_PER_TURN)
  const mediaIds = Array.from(
    new Set(cappedRequests.map((m) => m.media_id).filter((id): id is string => Boolean(id))),
  )

  if (mediaIds.length === 0) return []

  try {
    // Also fetch property cover_image_path to guard against sending cover
    const { data: propertyRow } = await db
      .from('properties')
      .select('cover_image_path')
      .eq('id', propertyId)
      .maybeSingle()

    const coverPath = propertyRow?.cover_image_path || null

    let rows: Array<{
      id: string
      property_id: string
      storage_path: string
      file_name: string
      content_type: string
      is_cover?: boolean | null
      description?: string | null
    }> | null = null

    const primaryQuery = await db
      .from('property_images')
      .select('id, property_id, storage_path, file_name, content_type, description, is_cover')
      .eq('account_id', accountId)
      .eq('property_id', propertyId)
      .in('id', mediaIds)

    if (primaryQuery.error) {
      if (isMissingColumnError(primaryQuery.error)) {
        console.warn(
          '[property-media-service] Column description missing in validateAndResolveMediaToSend. Falling back to base columns.',
        )
        const fallbackQuery = await db
          .from('property_images')
          .select('id, property_id, storage_path, file_name, content_type, is_cover')
          .eq('account_id', accountId)
          .eq('property_id', propertyId)
          .in('id', mediaIds)

        if (fallbackQuery.error) {
          console.error('[property-media-service] Fallback query failed in validateAndResolveMediaToSend:', fallbackQuery.error)
          return []
        }
        rows = fallbackQuery.data
      } else {
        console.error('[property-media-service] Error in validateAndResolveMediaToSend:', primaryQuery.error)
        return []
      }
    } else {
      rows = primaryQuery.data
    }

    if (!rows || rows.length === 0) {
      return []
    }

    const rowMap = new Map<string, (typeof rows)[0]>()
    for (const r of rows) {
      // Never allow is_cover === true or storage_path matching cover_image_path
      if (r.is_cover === true) continue
      if (coverPath && r.storage_path === coverPath) continue
      rowMap.set(r.id, r)
    }

    const resolved: ResolvedMediaToSend[] = []

    for (const req of cappedRequests) {
      const row = rowMap.get(req.media_id)
      if (!row) continue

      // Security check: must match property_id
      if (req.property_id && req.property_id !== propertyId && req.property_id !== row.property_id) {
        console.warn(
          `[property-media-service] Media property mismatch: req=${req.property_id}, active=${propertyId}`,
        )
        continue
      }

      // Security check: MIME type
      const contentType = row.content_type?.toLowerCase() || 'image/jpeg'
      if (!ALLOWED_IMAGE_TYPES.has(contentType) && !contentType.startsWith('image/')) {
        console.warn(`[property-media-service] Unsupported media MIME type: ${contentType}`)
        continue
      }

      const {
        data: { publicUrl },
      } = db.storage.from(PROPERTY_MEDIA_BUCKET).getPublicUrl(row.storage_path)

      if (!publicUrl) continue

      resolved.push({
        mediaId: row.id,
        propertyId: row.property_id,
        storagePath: row.storage_path,
        publicUrl,
        caption: req.caption?.trim() || null,
        fileName: row.file_name,
        contentType,
      })
    }

    return resolved
  } catch (err) {
    console.error('[property-media-service] Unexpected error resolving media to send:', err)
    return []
  }
}
