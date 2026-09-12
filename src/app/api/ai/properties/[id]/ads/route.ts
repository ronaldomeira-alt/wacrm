import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { fetchMetaAdCreative, cacheAdCreativeImage } from '@/lib/whatsapp/meta-ad-creative'

type Params = { params: Promise<{ id: string }> }

const PROPERTY_MEDIA_BUCKET = 'property-media'

/**
 * GET /api/ai/properties/[id]/ads (viewer+)
 * Returns all CTWA ad mappings linked to this property.
 * 
 * Strict Rule: Returns the genuine Meta Ad creative image/thumbnail.
 * NEVER falls back to property_images or general property gallery media.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { id: propertyId } = await params

    const { data: mappings, error } = await supabase
      .from('property_ad_mappings')
      .select('*')
      .eq('account_id', accountId)
      .eq('property_id', propertyId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[property/ads] Error fetching ad mappings:', error)
      return NextResponse.json({ error: 'Failed to fetch ad mappings' }, { status: 500 })
    }

    const hydratedMappings = await Promise.all(
      (mappings || []).map(async (m) => {
        let finalImageUrl: string | null = null
        let leadHeadline: string | null = null
        let leadBody: string | null = null
        let leadSourceUrl: string | null = null
        let hasLeadTelemetry = false

        // 1. Storage Cached Image (if saved in DB or standard storage path)
        const possiblePaths = [
          m.creative_storage_path,
          `account-${accountId}/ad-creatives/${m.ad_source_id}.jpg`,
          `account-${accountId}/ad-creatives/${m.ad_source_id}.png`,
          `account-${accountId}/ad-creatives/${m.ad_source_id}.webp`,
        ].filter(Boolean) as string[]

        for (const path of possiblePaths) {
          try {
            const { data: storageData } = supabase.storage
              .from(PROPERTY_MEDIA_BUCKET)
              .getPublicUrl(path)
            if (storageData?.publicUrl) {
              finalImageUrl = storageData.publicUrl
              break
            }
          } catch {
            // keep looking
          }
        }

        // 2. Direct Meta Creative Image / Thumbnail
        if (!finalImageUrl) {
          finalImageUrl = m.creative_image_url || m.creative_thumbnail_url || null
        }

        // 3. Auto-resolve & Cache if missing
        if (!finalImageUrl) {
          try {
            const { data: wcfg } = await supabase
              .from('whatsapp_config')
              .select('access_token')
              .eq('account_id', accountId)
              .maybeSingle()

            if (wcfg?.access_token) {
              const token = decrypt(wcfg.access_token)
              const resolved = await fetchMetaAdCreative(m.ad_source_id, token)
              if (resolved.success && resolved.creative_image_url) {
                const cached = await cacheAdCreativeImage({
                  supabase,
                  accountId,
                  adSourceId: m.ad_source_id,
                  remoteUrl: resolved.creative_image_url,
                })
                if (cached?.publicUrl) {
                  finalImageUrl = cached.publicUrl
                } else {
                  finalImageUrl = resolved.creative_image_url
                }
              }
            }
          } catch (autoErr) {
            console.warn('[property/ads] On-the-fly resolution failed:', m.ad_source_id, autoErr)
          }
        }

        // 3. Fallback: Check past inbound lead telemetry in conversations
        try {
          const { data: convs } = await supabase
            .from('conversations')
            .select('id, ctwa_referral')
            .eq('account_id', accountId)
            .filter('ctwa_referral->>source_id', 'eq', m.ad_source_id)
            .limit(1)

          if (convs && convs.length > 0 && convs[0].ctwa_referral) {
            const ref = convs[0].ctwa_referral as Record<string, unknown>
            leadHeadline = typeof ref.headline === 'string' ? ref.headline : null
            leadBody = typeof ref.body === 'string' ? ref.body : null
            leadSourceUrl = typeof ref.source_url === 'string' ? ref.source_url : null
            hasLeadTelemetry = true

            // Only use as secondary fallback if creative image is not already set
            if (!finalImageUrl) {
              finalImageUrl =
                typeof ref.image_url === 'string'
                  ? ref.image_url
                  : typeof ref.thumbnail_url === 'string'
                    ? ref.thumbnail_url
                    : null
            }
          }
        } catch (telemetryErr) {
          console.warn('[property/ads] Telemetry lookup failed for ad:', m.ad_source_id, telemetryErr)
        }

        const mediaType = m.creative_type === 'video' ? 'video' : 'image'

        return {
          id: m.id,
          property_id: m.property_id,
          ad_source_id: m.ad_source_id,
          ad_name: m.ad_name,
          campaign_name: m.campaign_name || null,
          adset_name: m.adset_name || null,
          creative_id: m.creative_id || null,
          creative_type: m.creative_type || 'image',
          image_url: finalImageUrl,
          thumbnail_url: m.creative_thumbnail_url || finalImageUrl,
          headline: m.creative_headline || leadHeadline,
          body: m.creative_body || leadBody,
          media_type: mediaType,
          source_url: leadSourceUrl,
          has_lead_telemetry: hasLeadTelemetry,
          creative_synced_at: m.creative_synced_at || null,
          created_at: m.created_at,
          verified: true,
          platform: 'Meta Ads · Click to WhatsApp',
          image_origin_label: finalImageUrl ? 'Criativo Meta' : null,
        }
      }),
    )

    return NextResponse.json({ mappings: hydratedMappings })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/properties/[id]/ads (agent+)
 * Links a Meta CTWA ad identifier to this property, resolving and storing its real creative.
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

    // Attempt to resolve real creative from Meta Graph API
    let metaCreativeResult: Awaited<ReturnType<typeof fetchMetaAdCreative>> | null = null
    let storagePath: string | null = null

    try {
      const { data: wcfg } = await supabase
        .from('whatsapp_config')
        .select('access_token')
        .eq('account_id', accountId)
        .maybeSingle()

      if (wcfg?.access_token) {
        const token = decrypt(wcfg.access_token)
        metaCreativeResult = await fetchMetaAdCreative(adSourceId, token)

        if (metaCreativeResult.success && metaCreativeResult.creative_image_url) {
          const cached = await cacheAdCreativeImage({
            supabase,
            accountId,
            adSourceId,
            remoteUrl: metaCreativeResult.creative_image_url,
          })
          if (cached) {
            storagePath = cached.storagePath
          }
        }
      }
    } catch (metaErr) {
      console.warn('[property/ads/post] Meta creative lookup failed gracefully:', metaErr)
    }

    const finalAdName =
      adName ||
      metaCreativeResult?.ad_name ||
      metaCreativeResult?.campaign_name ||
      null

    // Upsert mapping for this account and ad_source_id
    const upsertPayload: Record<string, unknown> = {
      account_id: accountId,
      property_id: propertyId,
      ad_source_id: adSourceId,
      ad_name: finalAdName,
      updated_at: new Date().toISOString(),
    }

    if (metaCreativeResult && metaCreativeResult.success) {
      upsertPayload.creative_id = metaCreativeResult.creative_id
      upsertPayload.creative_image_url = metaCreativeResult.creative_image_url
      upsertPayload.creative_thumbnail_url = metaCreativeResult.creative_thumbnail_url
      upsertPayload.creative_type = metaCreativeResult.creative_type
      upsertPayload.creative_storage_path = storagePath
      upsertPayload.campaign_name = metaCreativeResult.campaign_name
      upsertPayload.adset_name = metaCreativeResult.adset_name
      upsertPayload.creative_headline = metaCreativeResult.headline
      upsertPayload.creative_body = metaCreativeResult.body
      upsertPayload.creative_synced_at = new Date().toISOString()
    }

    let { data: mapping, error: insertErr } = await supabase
      .from('property_ad_mappings')
      .upsert(upsertPayload, { onConflict: 'account_id,ad_source_id' })
      .select()
      .single()

    if (insertErr && (insertErr as { code?: string }).code === '42703') {
      // If new creative_* columns have not been migrated yet, fallback to base columns
      const basePayload = {
        account_id: accountId,
        property_id: propertyId,
        ad_source_id: adSourceId,
        ad_name: finalAdName,
        updated_at: new Date().toISOString(),
      }
      const retry = await supabase
        .from('property_ad_mappings')
        .upsert(basePayload, { onConflict: 'account_id,ad_source_id' })
        .select()
        .single()
      mapping = retry.data
      insertErr = retry.error
    }

    if (insertErr) {
      console.error('[property/ads] Error saving ad mapping:', insertErr)
      return NextResponse.json({ error: 'Failed to save ad mapping' }, { status: 500 })
    }

    return NextResponse.json({ mapping, creative: metaCreativeResult })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/ai/properties/[id]/ads (agent+)
 * Synchronizes/refreshes the Meta creative on-demand for an existing ad mapping.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: propertyId } = await params

    const body = await request.json().catch(() => null)
    const adSourceId = typeof body?.ad_source_id === 'string' ? body.ad_source_id.trim() : null
    const mappingId = typeof body?.mapping_id === 'string' ? body.mapping_id.trim() : null

    if (!adSourceId && !mappingId) {
      return NextResponse.json(
        { error: 'ad_source_id or mapping_id is required' },
        { status: 400 },
      )
    }

    let query = supabase
      .from('property_ad_mappings')
      .select('*')
      .eq('account_id', accountId)
      .eq('property_id', propertyId)

    if (mappingId) {
      query = query.eq('id', mappingId)
    } else if (adSourceId) {
      query = query.eq('ad_source_id', adSourceId)
    }

    const { data: mapping, error: findErr } = await query.maybeSingle()

    if (findErr || !mapping) {
      return NextResponse.json({ error: 'Ad mapping not found' }, { status: 404 })
    }

    // Query Meta Graph API for fresh creative
    const { data: wcfg } = await supabase
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!wcfg?.access_token) {
      return NextResponse.json(
        { error: 'Meta access token not configured in whatsapp_config' },
        { status: 400 },
      )
    }

    const token = decrypt(wcfg.access_token)
    const creativeResult = await fetchMetaAdCreative(mapping.ad_source_id, token)

    if (!creativeResult.success) {
      return NextResponse.json(
        {
          error: creativeResult.raw_error || 'Falha ao sincronizar criativo com a Meta.',
          success: false,
        },
        { status: 400 },
      )
    }

    let storagePath = mapping.creative_storage_path
    if (creativeResult.creative_image_url) {
      const cached = await cacheAdCreativeImage({
        supabase,
        accountId,
        adSourceId: mapping.ad_source_id,
        remoteUrl: creativeResult.creative_image_url,
      })
      if (cached) {
        storagePath = cached.storagePath
      }
    }

    const patchPayload: Record<string, unknown> = {
      creative_id: creativeResult.creative_id,
      creative_image_url: creativeResult.creative_image_url,
      creative_thumbnail_url: creativeResult.creative_thumbnail_url,
      creative_type: creativeResult.creative_type,
      creative_storage_path: storagePath,
      campaign_name: creativeResult.campaign_name || mapping.campaign_name,
      adset_name: creativeResult.adset_name || mapping.adset_name,
      creative_headline: creativeResult.headline || mapping.creative_headline,
      creative_body: creativeResult.body || mapping.creative_body,
      creative_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    if (creativeResult.ad_name && !mapping.ad_name) {
      patchPayload.ad_name = creativeResult.ad_name
    }

    let { data: updatedMapping, error: updateErr } = await supabase
      .from('property_ad_mappings')
      .update(patchPayload)
      .eq('id', mapping.id)
      .select()
      .single()

    if (updateErr && (updateErr as { code?: string }).code === '42703') {
      const fallbackPayload: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      }
      if (creativeResult.ad_name && !mapping.ad_name) {
        fallbackPayload.ad_name = creativeResult.ad_name
      }
      const retry = await supabase
        .from('property_ad_mappings')
        .update(fallbackPayload)
        .eq('id', mapping.id)
        .select()
        .single()
      updatedMapping = retry.data
      updateErr = retry.error
    }

    if (updateErr) {
      return NextResponse.json({ error: 'Failed to update ad mapping' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      mapping: updatedMapping,
      creative: creativeResult,
    })
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
