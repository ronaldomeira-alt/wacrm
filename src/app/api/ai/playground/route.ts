import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { executeConversationalTurn } from '@/lib/ai/conversation-engine'
import { AiError, type ChatMessage } from '@/lib/ai/types'

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * exact same path the auto-reply bot uses — knowledge-base retrieval +
 * `auto_reply` system prompt + the configured provider — so what you see
 * here is what a real customer would get. Reads the config even when the
 * master switch is off (requireActive:false) so you can try it before
 * going live. Stateless: the client sends the running transcript each turn.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to test the agent.' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const propertyId =
      typeof body?.property_id === 'string'
        ? body.property_id.trim()
        : typeof body?.propertyId === 'string'
          ? body.propertyId.trim()
          : null

    const contactId =
      typeof body?.contact_id === 'string'
        ? body.contact_id.trim()
        : typeof body?.contactId === 'string'
          ? body.contactId.trim()
          : null

    const simulatedHours = body?.simulated_hours || 'real_time'

    let simulatedLeadContext = null
    if (body?.simulated_lead && typeof body.simulated_lead === 'object') {
      const sl = body.simulated_lead
      const knownFacts: string[] = []
      if (sl.purpose) knownFacts.push(`Finalidade declarada: ${Array.isArray(sl.purpose) ? sl.purpose.join(', ') : sl.purpose}`)
      if (sl.location) knownFacts.push(`Bairros/Localizações de interesse: ${Array.isArray(sl.location) ? sl.location.join(', ') : sl.location}`)
      if (sl.property_type) knownFacts.push(`Tipologia desejada: ${Array.isArray(sl.property_type) ? sl.property_type.join(', ') : sl.property_type}`)
      if (sl.price_max || sl.price_min) {
        const minStr = sl.price_min ? `R$ ${Number(sl.price_min).toLocaleString('pt-BR')}` : ''
        const maxStr = sl.price_max ? `R$ ${Number(sl.price_max).toLocaleString('pt-BR')}` : ''
        knownFacts.push(`Faixa de orçamento informada: ${[minStr && `a partir de ${minStr}`, maxStr && `até ${maxStr}`].filter(Boolean).join(' ')}`)
      }
      if (sl.bedrooms) knownFacts.push(`Quartos desejados: ${Array.isArray(sl.bedrooms) ? sl.bedrooms.join(' ou ') : sl.bedrooms}`)
      if (sl.features) knownFacts.push(`Preferências: ${Array.isArray(sl.features) ? sl.features.join(', ') : sl.features}`)
      if (sl.profile) knownFacts.push(`Perfil: ${Array.isArray(sl.profile) ? sl.profile.join(', ') : sl.profile}`)
      if (sl.intent) knownFacts.push(`Momento / Grau de intenção: ${sl.intent}`)
      if (sl.notes) knownFacts.push(`Notas: ${sl.notes}`)
      if (sl.tags) knownFacts.push(`Tags: ${Array.isArray(sl.tags) ? sl.tags.join(', ') : sl.tags}`)
      if (typeof sl.ai_score === 'number') knownFacts.push(`Score do lead: ${sl.ai_score}/10`)

      const contactName = sl.name || 'Cliente Simulado'
      simulatedLeadContext = {
        contactName,
        aiScore: typeof sl.ai_score === 'number' ? sl.ai_score : null,
        aiScoreReason: sl.ai_score_reason || null,
        summary: {
          purpose: Array.isArray(sl.purpose) ? sl.purpose : sl.purpose ? [sl.purpose] : [],
          property_type: Array.isArray(sl.property_type) ? sl.property_type : sl.property_type ? [sl.property_type] : [],
          location: Array.isArray(sl.location) ? sl.location : sl.location ? [sl.location] : [],
          price_min: typeof sl.price_min === 'number' ? sl.price_min : null,
          price_max: typeof sl.price_max === 'number' ? sl.price_max : null,
          price_flex_max: null,
          bedrooms: Array.isArray(sl.bedrooms) ? sl.bedrooms : sl.bedrooms ? [Number(sl.bedrooms)] : [],
          features: Array.isArray(sl.features) ? sl.features : sl.features ? [sl.features] : [],
          profile: Array.isArray(sl.profile) ? sl.profile : sl.profile ? [sl.profile] : [],
          intent: sl.intent || null,
          stage_signal: null,
          notes: sl.notes || null,
        },
        tags: Array.isArray(sl.tags) ? sl.tags : [],
        promptExcerpts: knownFacts.length > 0
          ? `INFORMAÇÕES JÁ EXTRAÍDAS E CONFIRMADAS SOBRE ESTE CLIENTE (${contactName}):\n- ` +
            knownFacts.join('\n- ') +
            '\n\nIMPORTANTE: O cliente JÁ informou os pontos acima. NÃO pergunte novamente o que já consta nesta lista (como orçamento, finalidade ou localização) a menos que o cliente mude de ideia ou o contexto exija esclarecimento natural.'
          : '',
      }
    }

    const startTime = Date.now()
    const turnResult = await executeConversationalTurn({
      db: supabase,
      accountId,
      config,
      contactId,
      propertyId,
      messages,
      simulatedHours,
      simulatedLeadContext,
      replyCount: messages.filter((m) => m.role === 'assistant').length,
    })
    const latencyMs = Date.now() - startTime

    return NextResponse.json({
      reply: turnResult.responseText || turnResult.decision?.response_text || '',
      handoff: turnResult.handoff,
      decision: turnResult.decision,
      retrievedKnowledgeCount: turnResult.retrievedKnowledgeCount,
      retrievedKnowledge: turnResult.retrievedKnowledge,
      propertyInfo: turnResult.propertyInfo,
      businessHoursContext: turnResult.businessHoursContext,
      leadContext: turnResult.leadContext,
      systemPrompt: turnResult.systemPrompt,
      usage: turnResult.usage,
      latencyMs,
      model: config.model,
      provider: config.provider,
    })
  } catch (err) {
    console.error('[ai/playground POST] error processing turn:', err)
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
