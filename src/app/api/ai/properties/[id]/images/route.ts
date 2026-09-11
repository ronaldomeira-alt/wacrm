import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

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
 * Records the metadata row for a file the client already uploaded
 * directly to the `property-media` Storage bucket (same two-step flow
 * as chat-media: upload first via the Supabase client, then POST the
 * resulting path here). The first image ever added to a property is
 * automatically set as its cover.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: propertyId } = await params

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

    const { data: prop, error: propErr } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (propErr || !prop) {
      return NextResponse.json({ error: 'Property not found' }, { status: 404 })
    }

    const { count } = await supabase
      .from('property_images')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', propertyId)

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
        is_cover: !count,
        position: count ?? 0,
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
