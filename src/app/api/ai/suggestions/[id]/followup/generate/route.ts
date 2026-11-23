import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import {
  generateFollowupFreeMessage,
  selectFollowupTemplate,
  type FollowupSelectedPropertyContext,
} from '@/lib/ai/followup-message'
import { logAiUsage } from '@/lib/ai/usage'
import { getConversationSessionStatus } from '@/lib/whatsapp/session-window'
import type { FollowupPlan } from '@/lib/ai/followup-types'

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

interface FollowupPayload {
  reason?: string | null
  approach_summary?: string | null
  [key: string]: unknown
}

/**
 * POST /api/ai/suggestions/[id]/followup/generate  (agent+)
 *
 * Drafts (or regenerates — same endpoint, "Regenerar" just calls it
 * again) the follow-up message for one of three modes. Never sends
 * anything — this only produces text/a template selection/a plan for
 * the user to review; persisted into the suggestion's `payload.draft`
 * so it survives a page reload before the user acts on it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`followup-generate:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const mode = body?.mode
    if (mode !== 'free' && mode !== 'template' && mode !== 'plan') {
      return bad('mode must be "free", "template" or "plan"')
    }

    const interestProperty =
      typeof body?.interestProperty === 'string' && body.interestProperty.trim()
        ? body.interestProperty.trim()
        : null
    const primaryNeed =
      typeof body?.primaryNeed === 'string' && body.primaryNeed.trim()
        ? body.primaryNeed.trim()
        : null
    const rawSelectedProp =
      body?.selectedProperty && typeof body.selectedProperty === 'object'
        ? (body.selectedProperty as Record<string, unknown>)
        : null
    const selectedProperty: FollowupSelectedPropertyContext | null =
      rawSelectedProp && typeof rawSelectedProp.propertyId === 'string' && rawSelectedProp.propertyId
        ? {
            propertyId: String(rawSelectedProp.propertyId),
            title: String(rawSelectedProp.title || 'Imóvel compatível'),
            neighborhood:
              typeof rawSelectedProp.neighborhood === 'string' ? rawSelectedProp.neighborhood : null,
            city: typeof rawSelectedProp.city === 'string' ? rawSelectedProp.city : null,
            propertyType:
              typeof rawSelectedProp.propertyType === 'string' ? rawSelectedProp.propertyType : null,
            operation:
              typeof rawSelectedProp.operation === 'string' ? rawSelectedProp.operation : null,
            deliveryStatus:
              typeof rawSelectedProp.deliveryStatus === 'string'
                ? rawSelectedProp.deliveryStatus
                : null,
            priceMin:
              typeof rawSelectedProp.priceMin === 'number' ? rawSelectedProp.priceMin : null,
            bedroomsMin:
              typeof rawSelectedProp.bedroomsMin === 'number' ? rawSelectedProp.bedroomsMin : null,
            areaMin: typeof rawSelectedProp.areaMin === 'number' ? rawSelectedProp.areaMin : null,
            publicUrl:
              typeof rawSelectedProp.publicUrl === 'string' && rawSelectedProp.publicUrl.trim()
                ? rawSelectedProp.publicUrl.trim()
                : null,
          }
        : null

    const { data: suggestion, error: fetchError } = await supabase
      .from('ai_suggestions')
      .select('id, category, contact_id, conversation_id, payload, contact:contacts(name)')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (fetchError) return bad('Failed to load suggestion', 500)
    if (!suggestion) return bad('Not found', 404)
    if (suggestion.category !== 'followup') return bad('Suggestion is not a follow-up')
    if (!suggestion.conversation_id) return bad('Suggestion has no conversation to draft for')

    const config = await loadAiConfig(supabase, accountId)
    if (!config) {
      return bad(
        'AI is not configured/active for this account yet — set it up in Settings > Agentes de IA',
        409,
      )
    }

    const payload = (suggestion.payload ?? {}) as FollowupPayload
    const contactName =
      (suggestion.contact as { name?: string } | null)?.name || 'Lead'
    const sessionStatus = await getConversationSessionStatus(supabase, suggestion.conversation_id)

    if (mode === 'free') {
      const { text, usage } = await generateFollowupFreeMessage({
        db: supabase,
        config,
        conversationId: suggestion.conversation_id,
        contactName,
        reason: payload.reason ?? null,
        approachSummary: payload.approach_summary ?? null,
        interestProperty,
        primaryNeed,
        selectedProperty,
      })
      void logAiUsage(supabase, {
        accountId,
        conversationId: suggestion.conversation_id,
        mode: 'followup',
        provider: config.provider,
        model: config.model,
        usage,
      })

      const draft = { mode: 'free' as const, text }
      await supabase
        .from('ai_suggestions')
        .update({ payload: { ...payload, draft } })
        .eq('id', id)

      return NextResponse.json({
        draft,
        sessionWindowOpen: sessionStatus.windowOpen,
        sessionWindowRemainingMs: sessionStatus.remainingMs,
      })
    }

    if (mode === 'template') {
      const res = await selectFollowupTemplate(supabase, accountId, config, {
        contactName,
        reason: payload.reason ?? null,
        approachSummary: payload.approach_summary ?? null,
        interestProperty,
        primaryNeed,
        selectedProperty,
        allowDeterministicFallback: true,
      })
      void logAiUsage(supabase, {
        accountId,
        conversationId: suggestion.conversation_id,
        mode: 'followup',
        provider: config.provider,
        model: config.model,
        usage: res.usage,
      })

      if (!res.selection) {
        return NextResponse.json({
          draft: null,
          sessionWindowOpen: sessionStatus.windowOpen,
          sessionWindowRemainingMs: sessionStatus.remainingMs,
          failureCode: res.failureCode ?? 'no_compatible_template',
          failureReason:
            res.failureReason ??
            'Não foi encontrado nenhum template aprovado compatível para este atendimento.',
          availableApprovedTemplatesCount: res.availableApprovedTemplatesCount ?? 0,
        })
      }

      const draft = {
        mode: 'template' as const,
        template_id: res.selection.template.id,
        template_name: res.selection.template.name,
        body_text: res.selection.template.body_text,
        values: res.selection.values,
        generated_by: res.selection.generatedBy ?? 'ai',
        supports_public_url: Boolean(res.selection.supportsPublicUrlInTemplate),
      }
      await supabase
        .from('ai_suggestions')
        .update({ payload: { ...payload, draft } })
        .eq('id', id)

      return NextResponse.json({
        draft,
        sessionWindowOpen: sessionStatus.windowOpen,
        sessionWindowRemainingMs: sessionStatus.remainingMs,
      })
    }

    // mode === 'plan' — Follow-up Inteligente: up to two scheduled,
    // pre-filled template sends.
    const res1 = await selectFollowupTemplate(supabase, accountId, config, {
      contactName,
      reason: payload.reason ?? null,
      approachSummary: payload.approach_summary ?? null,
      interestProperty,
      primaryNeed,
      selectedProperty,
      allowDeterministicFallback: true,
    })
    void logAiUsage(supabase, {
      accountId,
      conversationId: suggestion.conversation_id,
      mode: 'followup',
      provider: config.provider,
      model: config.model,
      usage: res1.usage,
    })

    const res2 = await selectFollowupTemplate(supabase, accountId, config, {
      contactName,
      reason: `${payload.reason ?? ''} (segundo contato, após o primeiro não ter sido respondido)`,
      approachSummary: 'Enviar um lembrete gentil e verificar se houve algum problema.',
      interestProperty,
      primaryNeed,
      selectedProperty,
      allowDeterministicFallback: true,
    })
    void logAiUsage(supabase, {
      accountId,
      conversationId: suggestion.conversation_id,
      mode: 'followup',
      provider: config.provider,
      model: config.model,
      usage: res2.usage,
    })

    const selection1 = res1.selection
    const selection2 = res2.selection

    const plan: FollowupPlan = {
      contact1: selection1
        ? {
            template_id: selection1.template.id,
            template_name: selection1.template.name,
            template_language: selection1.template.language ?? 'pt_BR',
            body_text: selection1.template.body_text,
            values: selection1.values,
            scheduleDays: 15,
          }
        : null,
      contact2: selection2
        ? {
            template_id: selection2.template.id,
            template_name: selection2.template.name,
            template_language: selection2.template.language ?? 'pt_BR',
            body_text: selection2.template.body_text,
            values: selection2.values,
            scheduleDays: 10,
          }
        : null,
    }

    if (!plan.contact1 && !plan.contact2) {
      return NextResponse.json({
        draft: null,
        sessionWindowOpen: sessionStatus.windowOpen,
        failureCode: res1.failureCode ?? 'no_compatible_template',
        failureReason:
          res1.failureReason ??
          'Não foi encontrado nenhum template aprovado compatível para montar o plano de follow-up.',
      })
    }

    const draft = { mode: 'plan' as const, plan }
    await supabase
      .from('ai_suggestions')
      .update({ payload: { ...payload, draft } })
      .eq('id', id)

    return NextResponse.json({ draft, sessionWindowOpen: sessionStatus.windowOpen })
  } catch (err) {
    return toErrorResponse(err)
  }
}
