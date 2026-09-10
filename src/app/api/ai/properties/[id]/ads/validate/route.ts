import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/properties/[id]/ads/validate (viewer+)
 * Validates a Meta CTWA ad identifier before linking.
 * 
 * Performs:
 * 1. Syntax/format validation (Meta Ad IDs are 10-24 digits numeric).
 * 2. Uniqueness & conflict check with other properties in the same account.
 * 3. Meta Graph API inquiry (if WhatsApp/Meta token is available and has permissions).
 * 4. Local inbound CTWA referral history lookup in conversations.
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

    // 3. Attempt Meta Graph API verification if access_token is configured
    let metaConfirmed = false
    let metaDetails: {
      id?: string
      name?: string
      status?: string
      campaign_name?: string
    } | null = null

    try {
      const { data: wcfg } = await supabase
        .from('whatsapp_config')
        .select('access_token')
        .eq('account_id', accountId)
        .maybeSingle()

      if (wcfg?.access_token) {
        const token = decrypt(wcfg.access_token)
        const graphRes = await fetch(
          `https://graph.facebook.com/v21.0/${adSourceId}?fields=id,name,status,campaign{id,name}&access_token=${encodeURIComponent(
            token,
          )}`,
          { method: 'GET', headers: { 'Content-Type': 'application/json' } },
        )

        if (graphRes.ok) {
          const graphData = await graphRes.json()
          if (graphData && graphData.id) {
            metaConfirmed = true
            metaDetails = {
              id: graphData.id,
              name: graphData.name || null,
              status: graphData.status || null,
              campaign_name: graphData.campaign?.name || null,
            }
          }
        }
      }
    } catch (err) {
      console.warn('[property/ads/validate] Graph API check skipped/failed:', err)
    }

    if (metaConfirmed && metaDetails) {
      return NextResponse.json({
        valid: true,
        confirmed: true,
        source: 'meta_api',
        ad_source_id: adSourceId,
        ad_name: adName || metaDetails.name || null,
        campaign_name: metaDetails.campaign_name || null,
        warning: conflictWarning,
        message: 'Anúncio confirmado com sucesso via Meta Graph API.',
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

        return NextResponse.json({
          valid: true,
          confirmed: true,
          source: 'inbound_leads',
          ad_source_id: adSourceId,
          ad_name: adName || refHeadline || null,
          referral_headline: refHeadline,
          referral_body: refBody,
          referral_image_url: refImageUrl,
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
      warning: conflictWarning,
      message:
        'Formato do ID validado. Pronto para vincular e resolver automaticamente todos os leads deste anúncio.',
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
