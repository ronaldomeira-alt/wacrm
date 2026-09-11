import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { fetchMetaAdCreative } from '@/lib/whatsapp/meta-ad-creative'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/properties/[id]/ads/validate (viewer+)
 * Validates a Meta CTWA ad identifier before linking and resolves its real creative.
 * 
 * Performs:
 * 1. Syntax/format validation (Meta Ad IDs are 10-24 digits numeric).
 * 2. Uniqueness & conflict check with other properties in the same account.
 * 3. Real Meta Ad Creative inquiry via Meta Graph API.
 * 4. Local inbound CTWA referral history lookup in conversations as secondary fallback.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { id: propertyId } = await params

    const body = await request.json().catch(() => null)
    const adSourceId = typeof body?.ad_source_id === 'string' ? body.ad_source_id.trim() : ''
    const adName = typeof body?.ad_name === 'string' ? body.ad_name.trim() : null

    if (!adSourceId) {
      return NextResponse.json(
        {
          valid: false,
          status: 'invalid_format',
          message: 'O ID do anúncio é obrigatório.',
        },
        { status: 400 },
      )
    }

    // 1. Syntax validation (Meta Ad IDs are numeric, typically 12-20 digits)
    const isNumeric = /^\d{10,24}$/.test(adSourceId)
    if (!isNumeric) {
      return NextResponse.json(
        {
          valid: false,
          status: 'invalid_format',
          message:
            'ID com formato inválido. O ID do anúncio Meta deve conter apenas números (geralmente entre 12 e 20 dígitos, ex: 120215839485010234).',
        },
        { status: 200 },
      )
    }

    // 2. Check conflict with existing property mappings in this account
    const { data: existingMapping } = await supabase
      .from('property_ad_mappings')
      .select('id, property_id, properties(id, name)')
      .eq('account_id', accountId)
      .eq('ad_source_id', adSourceId)
      .maybeSingle()

    let conflictWarning: string | null = null
    if (existingMapping) {
      const mappedProp = Array.isArray(existingMapping.properties)
        ? existingMapping.properties[0]
        : existingMapping.properties

      if (existingMapping.property_id === propertyId) {
        conflictWarning = 'Este anúncio já está vinculado a este empreendimento.'
      } else if (mappedProp?.name) {
        conflictWarning = `Atenção: Este anúncio já está vinculado ao empreendimento "${mappedProp.name}". Salvar aqui transferirá o vínculo.`
      }
    }

    // 3. Query Meta Graph API for real Ad & Creative assets
    let metaCreativeResult: Awaited<ReturnType<typeof fetchMetaAdCreative>> | null = null

    try {
      const { data: wcfg } = await supabase
        .from('whatsapp_config')
        .select('access_token')
        .eq('account_id', accountId)
        .maybeSingle()

      if (wcfg?.access_token) {
        const token = decrypt(wcfg.access_token)
        metaCreativeResult = await fetchMetaAdCreative(adSourceId, token)
      }
    } catch (err) {
      console.warn('[property/ads/validate] Graph API check skipped/failed:', err)
    }

    if (metaCreativeResult && metaCreativeResult.success) {
      return NextResponse.json({
        valid: true,
        confirmed: true,
        source: 'meta_api',
        ad_source_id: adSourceId,
        ad_name: metaCreativeResult.ad_name || adName || null,
        campaign_name: metaCreativeResult.campaign_name || null,
        adset_name: metaCreativeResult.adset_name || null,
        ad_status: metaCreativeResult.ad_status || null,
        creative_id: metaCreativeResult.creative_id || null,
        creative_image_url: metaCreativeResult.creative_image_url || null,
        creative_thumbnail_url: metaCreativeResult.creative_thumbnail_url || null,
        creative_type: metaCreativeResult.creative_type,
        headline: metaCreativeResult.headline || null,
        body: metaCreativeResult.body || null,
        source_url: metaCreativeResult.source_url || null,
        warning: conflictWarning,
        message: 'Anúncio e criativo confirmados com sucesso via Meta Graph API.',
      })
    }

    // 4. Check inbound lead telemetry in local DB (conversations with ctwa_referral)
    try {
      const { data: matchedConvs } = await supabase
        .from('conversations')
        .select('id, ctwa_referral')
        .eq('account_id', accountId)
        .filter('ctwa_referral->>source_id', 'eq', adSourceId)
        .limit(1)

      if (matchedConvs && matchedConvs.length > 0) {
        const ref = (matchedConvs[0].ctwa_referral || {}) as Record<string, unknown>
        const refHeadline = typeof ref.headline === 'string' ? ref.headline : null
        const refBody = typeof ref.body === 'string' ? ref.body : null
        const refImageUrl = typeof ref.image_url === 'string' ? ref.image_url : null
        const refThumbnailUrl = typeof ref.thumbnail_url === 'string' ? ref.thumbnail_url : null

        return NextResponse.json({
          valid: true,
          confirmed: true,
          source: 'inbound_leads',
          ad_source_id: adSourceId,
          ad_name: refHeadline || adName || null,
          campaign_name: null,
          adset_name: null,
          referral_headline: refHeadline,
          referral_body: refBody,
          referral_image_url: refImageUrl,
          creative_image_url: refImageUrl || refThumbnailUrl,
          creative_thumbnail_url: refThumbnailUrl || refImageUrl,
          creative_type: 'image',
          warning: conflictWarning,
          message: 'Anúncio confirmado através de leads CTWA recebidos recentemente.',
        })
      }
    } catch (err) {
      console.warn('[property/ads/validate] Local referral lookup failed:', err)
    }

    // 5. Fallback: Format is strictly valid & ready for deterministic matching
    return NextResponse.json({
      valid: true,
      confirmed: false,
      source: 'syntax_validated',
      ad_source_id: adSourceId,
      ad_name: adName,
      creative_image_url: null,
      creative_type: 'unknown',
      warning: conflictWarning,
      message:
        'Formato do ID validado. Pronto para vincular e resolver automaticamente todos os leads deste anúncio.',
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
