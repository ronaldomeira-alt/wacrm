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

/**
 * Retrieves the available media list for a given property to feed into Clara's prompt context.
 */
export async function getAvailablePropertyMedia(
  db: SupabaseClient,
  accountId: string,
  propertyId: string,
): Promise<PropertyMediaSummary[]> {
  try {
    const { data: images, error } = await db
      .from('property_images')
      .select('id, storage_path, file_name, content_type, description, is_cover, position')
      .eq('account_id', accountId)
      .eq('property_id', propertyId)
      .order('is_cover', { ascending: false })
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })

    if (error || !images) {
      console.error('[property-media-service] Error fetching property media:', error)
      return []
    }

    return images.map((img) => {
      const publicUrl = db.storage
        .from(PROPERTY_MEDIA_BUCKET)
        .getPublicUrl(img.storage_path).data.publicUrl

      return {
        id: img.id,
        type: 'image' as const,
        description: img.description || null,
        file_name: img.file_name,
        is_cover: img.is_cover ?? false,
        url: publicUrl,
      }
    })
  } catch (err) {
    console.error('[property-media-service] Error loading available property media:', err)
    return []
  }
}

/**
 * Validates requested media items from the LLM turn against the database and Storage:
 * 1. Checks that the media exists.
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
    const { data: rows, error } = await db
      .from('property_images')
      .select('id, property_id, storage_path, file_name, content_type, description')
      .eq('account_id', accountId)
      .eq('property_id', propertyId)
      .in('id', mediaIds)

    if (error || !rows || rows.length === 0) {
      return []
    }

    const rowMap = new Map<string, (typeof rows)[0]>()
    for (const r of rows) {
      rowMap.set(r.id, r)
    }

    const resolved: ResolvedMediaToSend[] = []

    for (const req of cappedRequests) {
      const row = rowMap.get(req.media_id)
      if (!row) continue

      // Security check: must match property_id
      if (req.property_id && req.property_id !== propertyId) {
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
    console.error('[property-media-service] Error resolving media to send:', err)
    return []
  }
}
