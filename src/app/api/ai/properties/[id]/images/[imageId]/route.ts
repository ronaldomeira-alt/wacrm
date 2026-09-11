import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { PROPERTY_MEDIA_BUCKET } from '@/lib/storage/upload-media'

type Params = { params: Promise<{ id: string; imageId: string }> }

/**
 * PATCH /api/ai/properties/[id]/images/[imageId] (agent+)
 *
 * Supports:
 * - `{ is_cover: true }`: sets this image as property's cover and unsets any previous one.
 * - `{ description: string | null }`: updates the media description.
 * - `{ position: number }`: updates display order.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: propertyId, imageId } = await params

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }

    if (body.is_cover === true) {
      const { error: clearErr } = await supabase
        .from('property_images')
        .update({ is_cover: false })
        .eq('account_id', accountId)
        .eq('property_id', propertyId)
        .eq('is_cover', true)

      if (clearErr) {
        console.error('[property/images] Error clearing previous cover:', clearErr)
        return NextResponse.json({ error: 'Failed to update cover' }, { status: 500 })
      }
      updates.is_cover = true
    }

    if ('description' in body) {
      updates.description = typeof body.description === 'string' ? body.description.trim() || null : null
    }

    if (typeof body.position === 'number') {
      updates.position = body.position
    }

    if (Object.keys(updates).length <= 1 && !('description' in body) && body.is_cover !== true) {
      return NextResponse.json(
        { error: 'Supported updates: { is_cover: true }, { description: string }, { position: number }' },
        { status: 400 },
      )
    }

    let { data: image, error: updateErr } = await supabase
      .from('property_images')
      .update(updates)
      .eq('id', imageId)
      .eq('account_id', accountId)
      .eq('property_id', propertyId)
      .select()
      .single()

    // If updated_at or description is missing in DB schema cache, strip them and retry
    if (updateErr && updateErr.code === 'PGRST204') {
      const strippedUpdates = { ...updates }
      delete strippedUpdates.updated_at
      delete strippedUpdates.description
      if (Object.keys(strippedUpdates).length > 0) {
        const retryRes = await supabase
          .from('property_images')
          .update(strippedUpdates)
          .eq('id', imageId)
          .eq('account_id', accountId)
          .eq('property_id', propertyId)
          .select()
          .single()
        image = retryRes.data
        updateErr = retryRes.error
      } else {
        // Only description/updated_at were being updated, fetch existing row
        const fetchRes = await supabase
          .from('property_images')
          .select('*')
          .eq('id', imageId)
          .eq('account_id', accountId)
          .single()
        image = fetchRes.data
        updateErr = null
      }
    }

    if (updateErr || !image) {
      console.error('[property/images] Error updating image:', updateErr)
      return NextResponse.json({ error: 'Image not found or update failed' }, { status: 404 })
    }

    return NextResponse.json({ image })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/properties/[id]/images/[imageId] (agent+)
 * Removes the metadata row and its Storage object.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: propertyId, imageId } = await params

    const { data: image, error: fetchErr } = await supabase
      .from('property_images')
      .select('id, storage_path, is_cover')
      .eq('id', imageId)
      .eq('account_id', accountId)
      .eq('property_id', propertyId)
      .maybeSingle()

    if (fetchErr || !image) {
      return NextResponse.json({ error: 'Image not found' }, { status: 404 })
    }

    const { error: delErr } = await supabase
      .from('property_images')
      .delete()
      .eq('id', imageId)
      .eq('account_id', accountId)

    if (delErr) {
      console.error('[property/images] Error deleting image row:', delErr)
      return NextResponse.json({ error: 'Failed to delete image' }, { status: 500 })
    }

    // Best-effort: an orphaned Storage object is a nit, not worth failing
    // the request over (mirrors deleteAccountMedia's own fire-and-forget use).
    await supabase.storage.from(PROPERTY_MEDIA_BUCKET).remove([image.storage_path])

    // The deleted image was the cover — promote the next one (by position)
    // so the property always has a cover while it still has any image.
    if (image.is_cover) {
      const { data: next } = await supabase
        .from('property_images')
        .select('id')
        .eq('account_id', accountId)
        .eq('property_id', propertyId)
        .order('position', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (next) {
        await supabase.from('property_images').update({ is_cover: true }).eq('id', next.id)
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
