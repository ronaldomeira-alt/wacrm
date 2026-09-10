import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/properties/[id]/ads (viewer+)
 * Returns all CTWA ad mappings linked to this property.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { id: propertyId } = await params

    const { data: mappings, error } = await supabase
      .from('property_ad_mappings')
      .select('id, property_id, ad_source_id, ad_name, created_at')
      .eq('account_id', accountId)
      .eq('property_id', propertyId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[property/ads] Error fetching ad mappings:', error)
      return NextResponse.json({ error: 'Failed to fetch ad mappings' }, { status: 500 })
    }

    return NextResponse.json({ mappings: mappings || [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/properties/[id]/ads (agent+)
 * Links a Meta CTWA ad identifier to this property.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: propertyId } = await params

    const body = await request.json().catch(() => null)
    const adSourceId = typeof body?.ad_source_id === 'string' ? body.ad_source_id.trim() : null
    const adName = typeof body?.ad_name === 'string' ? body.ad_name.trim() : null

    if (!adSourceId) {
      return NextResponse.json(
        { error: 'ad_source_id is required' },
        { status: 400 },
      )
    }

    // Verify property belongs to account
    const { data: prop, error: propErr } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (propErr || !prop) {
      return NextResponse.json({ error: 'Property not found' }, { status: 404 })
    }

    // Upsert mapping for this account and ad_source_id
    const { data: mapping, error: insertErr } = await supabase
      .from('property_ad_mappings')
      .upsert(
        {
          account_id: accountId,
          property_id: propertyId,
          ad_source_id: adSourceId,
          ad_name: adName || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,ad_source_id' },
      )
      .select()
      .single()

    if (insertErr) {
      console.error('[property/ads] Error saving ad mapping:', insertErr)
      return NextResponse.json({ error: 'Failed to save ad mapping' }, { status: 500 })
    }

    return NextResponse.json({ mapping })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/properties/[id]/ads (agent+)
 * Unlinks an ad mapping.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: propertyId } = await params

    const url = new URL(request.url)
    const mappingId = url.searchParams.get('mappingId')
    const adSourceId = url.searchParams.get('adSourceId')

    if (!mappingId && !adSourceId) {
      return NextResponse.json(
        { error: 'mappingId or adSourceId query param is required' },
        { status: 400 },
      )
    }

    let query = supabase
      .from('property_ad_mappings')
      .delete()
      .eq('account_id', accountId)
      .eq('property_id', propertyId)

    if (mappingId) {
      query = query.eq('id', mappingId)
    } else if (adSourceId) {
      query = query.eq('ad_source_id', adSourceId)
    }

    const { error } = await query
    if (error) {
      console.error('[property/ads] Error deleting ad mapping:', error)
      return NextResponse.json({ error: 'Failed to delete ad mapping' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
