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
 * GET /api/ai/properties/[id]/cover (viewer+)
 * Returns the property's cover image path and resolved public URL.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { id: propertyId } = await params

    const { data: prop, error } = await supabase
      .from('properties')
      .select('id, cover_image_path')
      .eq('account_id', accountId)
      .eq('id', propertyId)
      .maybeSingle()

    if (error || !prop) {
      return NextResponse.json({ error: 'Property not found' }, { status: 404 })
    }

    const coverPath = prop.cover_image_path || null
    const coverUrl = coverPath
      ? supabase.storage.from(PROPERTY_MEDIA_BUCKET).getPublicUrl(coverPath).data.publicUrl
      : null

    return NextResponse.json({
      cover_image_path: coverPath,
      cover_image_url: coverUrl,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/properties/[id]/cover (agent+)
 * Uploads and sets the visual identity cover photo of the property.
 * Completely separate from Clara's commercial media library.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: propertyId } = await params

    const { data: prop, error: propErr } = await supabase
      .from('properties')
      .select('id, cover_image_path')
      .eq('id', propertyId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (propErr || !prop) {
      return NextResponse.json({ error: 'Empreendimento não encontrado' }, { status: 404 })
    }

    const contentTypeHeader = request.headers.get('content-type') || ''
    let storagePath: string | null = null

    if (contentTypeHeader.includes('multipart/form-data')) {
      const formData = await request.formData()
      const file = formData.get('file') as File | null

      if (!file || !(file instanceof File)) {
        return NextResponse.json({ error: 'Nenhum arquivo enviado.' }, { status: 400 })
      }

      const fileName = file.name || 'cover.jpg'
      const mimeType = file.type || ''

      const isExtValid = isSupportedImageFilename(fileName)
      const isMimeValid = isSupportedImageMime(mimeType)

      if (!isExtValid && !isMimeValid) {
        return NextResponse.json(
          {
            error:
              'Formato de arquivo não suportado. Utilize imagens JPG, PNG, WEBP, GIF, BMP, TIFF, HEIC, HEIF ou AVIF.',
          },
          { status: 400 },
        )
      }

      if (file.size > MAX_UPLOAD_INPUT_BYTES) {
        return NextResponse.json(
          { error: 'Arquivo excede o tamanho máximo de 16 MB.' },
          { status: 400 },
        )
      }

      const rawBuffer = Buffer.from(await file.arrayBuffer())
      const normalized = await normalizePropertyImage(rawBuffer)

      storagePath = buildMediaPath(accountId, `cover-${fileName.replace(/\.[^/.]+$/, '')}.jpg`)

      const admin = supabaseAdmin()
      const { error: uploadErr } = await admin.storage
        .from(PROPERTY_MEDIA_BUCKET)
        .upload(storagePath, normalized.buffer, {
          contentType: normalized.contentType,
          upsert: true,
        })

      if (uploadErr) {
        console.error('[property/cover] Storage upload error:', uploadErr)
        return NextResponse.json(
          { error: `Falha ao salvar foto de capa: ${uploadErr.message}` },
          { status: 500 },
        )
      }
    } else {
      const body = await request.json().catch(() => null)
      if (typeof body?.storage_path === 'string' && body.storage_path.trim().length > 0) {
        storagePath = body.storage_path.trim()
      } else {
        return NextResponse.json({ error: 'storage_path is required' }, { status: 400 })
      }
    }

    if (!storagePath) {
      return NextResponse.json({ error: 'Falha ao obter caminho da capa' }, { status: 400 })
    }

    // Update properties.cover_image_path
    const { error: updateErr } = await supabase
      .from('properties')
      .update({
        cover_image_path: storagePath,
        updated_at: new Date().toISOString(),
      })
      .eq('id', propertyId)
      .eq('account_id', accountId)

    if (updateErr) {
      console.error('[property/cover] DB update error:', updateErr)
      return NextResponse.json({ error: 'Falha ao atualizar foto de capa' }, { status: 500 })
    }

    const publicUrl = supabase.storage
      .from(PROPERTY_MEDIA_BUCKET)
      .getPublicUrl(storagePath).data.publicUrl

    return NextResponse.json({
      cover_image_path: storagePath,
      cover_image_url: publicUrl,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/properties/[id]/cover (agent+)
 * Clears the property's cover image.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: propertyId } = await params

    const { data: prop, error: fetchErr } = await supabase
      .from('properties')
      .select('id, cover_image_path')
      .eq('id', propertyId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (fetchErr || !prop) {
      return NextResponse.json({ error: 'Empreendimento não encontrado' }, { status: 404 })
    }

    const oldPath = prop.cover_image_path

    const { error: updateErr } = await supabase
      .from('properties')
      .update({
        cover_image_path: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', propertyId)
      .eq('account_id', accountId)

    if (updateErr) {
      console.error('[property/cover] DB delete cover error:', updateErr)
      return NextResponse.json({ error: 'Falha ao remover foto de capa' }, { status: 500 })
    }

    if (oldPath) {
      // Best-effort cleanup of storage object
      await supabase.storage.from(PROPERTY_MEDIA_BUCKET).remove([oldPath]).catch(() => {})
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
