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
  buildMediaPath,
} from '@/lib/storage/upload-media'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/properties/[id]/images (viewer+)
 * Lists the property's photo/plan gallery, cover first then by position.
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
      .order('is_cover', { ascending: false })
      .order('position', { ascending: true })

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

      // Query count to set first image as cover and assign position
      const { count } = await supabase
        .from('property_images')
        .select('id', { count: 'exact', head: true })
        .eq('property_id', propertyId)

      const isCover = !count || count === 0
      const position = count ?? 0

      const { data: image, error: insertErr } = await supabase
        .from('property_images')
        .insert({
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
        })
        .select()
        .single()

      if (insertErr) {
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

    const { count } = await supabase
      .from('property_images')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', propertyId)

    const isCover = !count || count === 0
    const position = count ?? 0

    const { data: image, error: insertErr } = await supabase
      .from('property_images')
      .insert({
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
      })
      .select()
      .single()

    if (insertErr) {
      console.error('[property/images] Error saving image:', insertErr)
      return NextResponse.json({ error: 'Failed to save image' }, { status: 500 })
    }

    return NextResponse.json({ image }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
