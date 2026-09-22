import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  normalizePropertyImage,
  MAX_UPLOAD_INPUT_BYTES,
  isSupportedImageFilename,
  isSupportedImageMime,
} from '@/lib/media/normalize-property-image'
import {
  PROPERTY_MEDIA_BUCKET,
  PROPERTY_MEDIA_MAX_BYTES,
  buildMediaPath,
} from '@/lib/storage/upload-media'
import { isVideoContentType } from '@/lib/ai/property-media-service'
import type { PropertyImage } from '@/types'

/**
 * The only two containers the WhatsApp Cloud API accepts for outbound
 * video (see meta-api.ts / MediaKind). The gallery's video slot always
 * transcodes client-side (prepare-property-video.ts, reusing the
 * existing transcode-mov-webcodecs.ts infra) before reaching this route,
 * so this is a floor that rejects an un-normalized original — never the
 * place normalization itself happens.
 */
const ALLOWED_VIDEO_UPLOAD_MIME_TYPES = new Set(['video/mp4', 'video/3gpp'])
const ALLOWED_VIDEO_UPLOAD_EXTENSIONS = new Set(['mp4', 'm4v', '3gp', '3gpp'])

function isVideoUpload(fileName: string, mimeType: string): boolean {
  if (mimeType && mimeType.toLowerCase().startsWith('video/')) return true
  const ext = fileName.split('.').pop()?.toLowerCase()
  return Boolean(ext && ALLOWED_VIDEO_UPLOAD_EXTENSIONS.has(ext))
}

/** Counts existing commercial media (is_cover=false) split by photo/video, so the two galleries enforce independent 5-item caps instead of sharing one. */
async function countCommercialMediaByType(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  propertyId: string,
): Promise<{ photos: number; videos: number }> {
  const { data } = await supabase
    .from('property_images')
    .select('content_type')
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
    .eq('is_cover', false)

  let photos = 0
  let videos = 0
  for (const row of data || []) {
    if (isVideoContentType((row as { content_type: string | null }).content_type)) {
      videos++
    } else {
      photos++
    }
  }
  return { photos, videos }
}

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/properties/[id]/images (viewer+)
 * Lists the property's commercial sendable media gallery (capped at 5, strictly excluding cover photo).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { id: propertyId } = await params

    const { data: images, error } = await supabase
      .from('property_images')
      .select('*')
      .eq('account_id', accountId)
      .eq('property_id', propertyId)
      .eq('is_cover', false)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[property/images] Error fetching images:', error)
      return NextResponse.json({ error: 'Failed to fetch images' }, { status: 500 })
    }

    return NextResponse.json({ images: images || [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/properties/[id]/images (agent+)
 *
 * Supports both:
 * 1. Multipart `FormData` with a `file` field (+ optional `description`):
 *    - Validates MIME / extension (JPEG, PNG, WEBP, GIF, BMP, TIFF, HEIC, HEIF, AVIF)
 *    - Normalizes image with `sharp` to Meta WhatsApp Cloud API standards (JPEG/PNG <= 5MB, EXIF auto-rotate)
 *    - Uploads directly to `property-media` Storage bucket via `supabaseAdmin`
 *    - Inserts a record in `property_images`
 *
 * 2. JSON body `{ storage_path, file_name, file_size, content_type, description }`:
 *    - Backwards-compatible metadata insert for files already uploaded to storage.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: propertyId } = await params

    const { data: prop, error: propErr } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (propErr || !prop) {
      return NextResponse.json({ error: 'Property not found' }, { status: 404 })
    }

    const contentTypeHeader = request.headers.get('content-type') || ''

    // -------------------------------------------------------------
    // Option A: Multipart FormData Upload (Server-Side Normalization)
    // -------------------------------------------------------------
    if (contentTypeHeader.includes('multipart/form-data')) {
      const formData = await request.formData()
      const file = formData.get('file') as File | null
      const descriptionRaw = formData.get('description')
      const description =
        typeof descriptionRaw === 'string' && descriptionRaw.trim().length > 0
          ? descriptionRaw.trim()
          : null

      if (!file || !(file instanceof File)) {
        return NextResponse.json({ error: 'Nenhum arquivo enviado.' }, { status: 400 })
      }

      const fileName = file.name || 'image.jpg'
      const mimeType = file.type || ''

      // -------------------------------------------------------------
      // Video upload — separate branch, returns early. No `sharp`
      // normalization here: the gallery's video slot already transcodes
      // client-side (prepare-property-video.ts, reusing the existing
      // transcode-mov-webcodecs.ts infra) before this request is made,
      // so this route only validates the FINAL file is one of the two
      // containers WhatsApp accepts and within the 16 MB ceiling — it
      // never attempts to normalize or re-encode video itself.
      // -------------------------------------------------------------
      if (isVideoUpload(fileName, mimeType)) {
        const normalizedMime = mimeType.toLowerCase()
        if (!ALLOWED_VIDEO_UPLOAD_MIME_TYPES.has(normalizedMime)) {
          return NextResponse.json(
            {
              error: `Formato de vídeo não suportado para "${fileName}". Envie um MP4 (H.264/AAC) — vídeos do celular são convertidos automaticamente antes do envio.`,
            },
            { status: 400 },
          )
        }

        if (file.size > PROPERTY_MEDIA_MAX_BYTES) {
          return NextResponse.json(
            { error: `O vídeo "${fileName}" ultrapassa o limite de 16 MB.` },
            { status: 400 },
          )
        }

        const { photos, videos } = await countCommercialMediaByType(supabase, accountId, propertyId)
        if (videos >= 5) {
          return NextResponse.json(
            { error: 'Limite máximo de 5 vídeos atingido para este empreendimento.' },
            { status: 400 },
          )
        }

        const videoExt = normalizedMime === 'video/3gpp' ? '3gp' : 'mp4'
        const baseNameWithoutExt = fileName.replace(/\.[^.]+$/, '') || 'video'
        const storagePath = buildMediaPath(accountId, `${baseNameWithoutExt}.${videoExt}`)

        const arrayBuffer = await file.arrayBuffer()
        const admin = supabaseAdmin()
        const { error: uploadErr } = await admin.storage
          .from(PROPERTY_MEDIA_BUCKET)
          .upload(storagePath, arrayBuffer, {
            contentType: normalizedMime,
            cacheControl: '3600',
            upsert: true,
          })

        if (uploadErr) {
          console.error('[property/images] Video storage upload error:', uploadErr)
          return NextResponse.json(
            { error: `Falha ao salvar vídeo no armazenamento: ${uploadErr.message}` },
            { status: 500 },
          )
        }

        let image: PropertyImage | null = null
        const fullPayload = {
          account_id: accountId,
          property_id: propertyId,
          storage_path: storagePath,
          file_name: fileName,
          file_size: file.size,
          content_type: normalizedMime,
          description,
          is_cover: false,
          position: photos + videos,
          updated_at: new Date().toISOString(),
        }

        const { data: insertedFull, error: insertErr } = await supabase
          .from('property_images')
          .insert(fullPayload)
          .select()
          .single()

        if (!insertErr && insertedFull) {
          image = insertedFull
        } else if (insertErr && insertErr.code === 'PGRST204') {
          // Fallback for schema v1 (without description/updated_at columns) — same shape as the image path below.
          console.warn('[property/images] Schema fallback (video): inserting without description/updated_at')
          const basePayload = {
            account_id: accountId,
            property_id: propertyId,
            storage_path: storagePath,
            file_name: fileName,
            file_size: file.size,
            content_type: normalizedMime,
            is_cover: false,
            position: photos + videos,
          }
          const { data: insertedBase, error: baseInsertErr } = await supabase
            .from('property_images')
            .insert(basePayload)
            .select()
            .single()

          if (baseInsertErr || !insertedBase) {
            console.error('[property/images] Video DB insert fallback error:', baseInsertErr)
            await admin.storage.from(PROPERTY_MEDIA_BUCKET).remove([storagePath]).catch(() => {})
            return NextResponse.json({ error: 'Falha ao salvar registro do vídeo' }, { status: 500 })
          }
          image = insertedBase
        } else {
          console.error('[property/images] Video DB insert error:', insertErr)
          await admin.storage.from(PROPERTY_MEDIA_BUCKET).remove([storagePath]).catch(() => {})
          return NextResponse.json({ error: 'Falha ao salvar registro do vídeo' }, { status: 500 })
        }

        return NextResponse.json({ image }, { status: 201 })
      }

      // Validate format support by MIME or extension (iPhone HEIC might have empty MIME)
      const isExtValid = isSupportedImageFilename(fileName)
      const isMimeValid = isSupportedImageMime(mimeType)

      if (!isExtValid && !isMimeValid) {
        return NextResponse.json(
          {
            error: `Formato de arquivo não suportado para "${fileName}". Formatos aceitos: JPG, PNG, WEBP, GIF, BMP, TIFF, HEIC, HEIF, AVIF.`,
          },
          { status: 400 },
        )
      }

      if (file.size > MAX_UPLOAD_INPUT_BYTES) {
        return NextResponse.json(
          { error: `O arquivo "${fileName}" ultrapassa o limite de 16 MB.` },
          { status: 400 },
        )
      }

      const arrayBuffer = await file.arrayBuffer()
      const inputBuffer = Buffer.from(arrayBuffer)

      // Normalize image to Meta WhatsApp Cloud API standards (<= 5MB, JPEG/PNG, EXIF auto-rotate)
      let normalized
      try {
        normalized = await normalizePropertyImage(inputBuffer)
      } catch (normErr) {
        console.error('[property/images] Image normalization error:', normErr)
        return NextResponse.json(
          {
            error:
              normErr instanceof Error
                ? normErr.message
                : `Falha ao processar "${fileName}". Certifique-se de que é uma imagem válida.`,
          },
          { status: 422 },
        )
      }

      // Generate normalized file name and storage path
      const baseExt = normalized.format === 'png' ? 'png' : 'jpg'
      const baseNameWithoutExt = fileName.replace(/\.[^.]+$/, '') || 'photo'
      const normalizedFileName = `${baseNameWithoutExt}.${baseExt}`
      const storagePath = buildMediaPath(accountId, normalizedFileName)

      // Upload normalized Blob to Supabase Storage via supabaseAdmin
      const admin = supabaseAdmin()
      const { error: uploadErr } = await admin.storage
        .from(PROPERTY_MEDIA_BUCKET)
        .upload(storagePath, normalized.blob, {
          contentType: normalized.contentType,
          cacheControl: '3600',
          upsert: true,
        })

      if (uploadErr) {
        console.error('[property/images] Storage upload error:', uploadErr)
        return NextResponse.json(
          { error: `Falha ao salvar arquivo no armazenamento: ${uploadErr.message}` },
          { status: 500 },
        )
      }

      // Enforce max 5 photos for commercial sendable media (excluding cover
      // and independent of the video count — see countCommercialMediaByType).
      const { photos: photoCount, videos: videoCount } = await countCommercialMediaByType(
        supabase,
        accountId,
        propertyId,
      )

      if (photoCount >= 5) {
        return NextResponse.json(
          { error: 'Limite máximo de 5 fotos comerciais atingido para este empreendimento.' },
          { status: 400 },
        )
      }

      const isCover = false
      const position = photoCount + videoCount

      // Attempt insert with all fields (schema v2 with description & updated_at)
      let image: PropertyImage | null = null
      const fullPayload = {
        account_id: accountId,
        property_id: propertyId,
        storage_path: storagePath,
        file_name: fileName, // keep original filename for reference
        file_size: normalized.fileSize,
        content_type: normalized.contentType,
        description: description,
        is_cover: isCover,
        position: position,
        updated_at: new Date().toISOString(),
      }

      const { data: insertedFull, error: insertErr } = await supabase
        .from('property_images')
        .insert(fullPayload)
        .select()
        .single()

      if (!insertErr && insertedFull) {
        image = insertedFull
      } else if (insertErr && insertErr.code === 'PGRST204') {
        // Fallback for schema v1 (without description/updated_at columns)
        console.warn('[property/images] Schema fallback: inserting without description/updated_at')
        const basePayload = {
          account_id: accountId,
          property_id: propertyId,
          storage_path: storagePath,
          file_name: fileName,
          file_size: normalized.fileSize,
          content_type: normalized.contentType,
          is_cover: isCover,
          position: position,
        }

        const { data: insertedBase, error: baseInsertErr } = await supabase
          .from('property_images')
          .insert(basePayload)
          .select()
          .single()

        if (baseInsertErr || !insertedBase) {
          console.error('[property/images] DB insert fallback error:', baseInsertErr)
          await admin.storage.from(PROPERTY_MEDIA_BUCKET).remove([storagePath]).catch(() => {})
          return NextResponse.json({ error: 'Falha ao salvar registro da imagem' }, { status: 500 })
        }
        image = insertedBase
      } else {
        console.error('[property/images] DB insert error:', insertErr)
        // Clean up storage if DB insert fails
        await admin.storage.from(PROPERTY_MEDIA_BUCKET).remove([storagePath]).catch(() => {})
        return NextResponse.json({ error: 'Falha ao salvar registro da imagem' }, { status: 500 })
      }

      return NextResponse.json({ image }, { status: 201 })
    }

    // -------------------------------------------------------------
    // Option B: JSON Body (Legacy / Direct path insert)
    // -------------------------------------------------------------
    const body = await request.json().catch(() => null)
    const storagePath = typeof body?.storage_path === 'string' ? body.storage_path.trim() : ''
    const fileName = typeof body?.file_name === 'string' ? body.file_name.trim() : ''
    const fileSize = typeof body?.file_size === 'number' ? body.file_size : null
    const contentType = typeof body?.content_type === 'string' ? body.content_type : null
    const description = typeof body?.description === 'string' ? body.description.trim() || null : null

    if (!storagePath || !fileName) {
      return NextResponse.json(
        { error: 'storage_path and file_name are required' },
        { status: 400 },
      )
    }

    const { photos: photoCount, videos: videoCount } = await countCommercialMediaByType(
      supabase,
      accountId,
      propertyId,
    )
    const isVideoRow = isVideoContentType(contentType)

    if (isVideoRow ? videoCount >= 5 : photoCount >= 5) {
      return NextResponse.json(
        {
          error: isVideoRow
            ? 'Limite máximo de 5 vídeos atingido para este empreendimento.'
            : 'Limite máximo de 5 fotos comerciais atingido para este empreendimento.',
        },
        { status: 400 },
      )
    }

    const isCover = false
    const position = photoCount + videoCount

    let image: PropertyImage | null = null
    const fullPayload = {
      account_id: accountId,
      property_id: propertyId,
      storage_path: storagePath,
      file_name: fileName,
      file_size: fileSize,
      content_type: contentType,
      description: description,
      is_cover: isCover,
      position: position,
      updated_at: new Date().toISOString(),
    }

    const { data: insertedFull, error: insertErr } = await supabase
      .from('property_images')
      .insert(fullPayload)
      .select()
      .single()

    if (!insertErr && insertedFull) {
      image = insertedFull
    } else if (insertErr && insertErr.code === 'PGRST204') {
      const basePayload = {
        account_id: accountId,
        property_id: propertyId,
        storage_path: storagePath,
        file_name: fileName,
        file_size: fileSize,
        content_type: contentType,
        is_cover: isCover,
        position: position,
      }
      const { data: insertedBase, error: baseInsertErr } = await supabase
        .from('property_images')
        .insert(basePayload)
        .select()
        .single()

      if (baseInsertErr || !insertedBase) {
        console.error('[property/images] Error saving image:', baseInsertErr)
        return NextResponse.json({ error: 'Failed to save image' }, { status: 500 })
      }
      image = insertedBase
    } else {
      console.error('[property/images] Error saving image:', insertErr)
      return NextResponse.json({ error: 'Failed to save image' }, { status: 500 })
    }

    return NextResponse.json({ image }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
