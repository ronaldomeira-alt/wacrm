import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { PROPERTY_MEDIA_BUCKET } from '@/lib/storage/upload-media'

type Params = { params: Promise<{ id: string; imageId: string }> }

/**
 * PATCH /api/ai/properties/[id]/images/[imageId] (agent+)
 *
 * Supports:
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

    if ('description' in body) {
      updates.description = typeof body.description === 'string' ? body.description.trim() || null : null
    }

    if (typeof body.position === 'number') {
      updates.position = body.position
    }

    if (Object.keys(updates).length <= 1 && !('description' in body) && typeof body.position !== 'number') {
      return NextResponse.json(
        { error: 'Supported updates: { description: string }, { position: number }' },
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
 * Removes the commercial media row and its Storage object.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: propertyId, imageId } = await params

    const { data: image, error: fetchErr } = await supabase
      .from('property_images')
      .select('id, storage_path')
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

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
