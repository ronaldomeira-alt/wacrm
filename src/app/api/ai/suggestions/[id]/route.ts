import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { AI_SUGGESTION_STATUSES } from '@/lib/ai-suggestion-status'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import type { AiSuggestionStatus } from '@/types'

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

interface PipelineMovePayload {
  deal_id?: unknown
  to_stage_id?: unknown
}

interface LearningPayload {
  type?: unknown
  info?: unknown
  context_summary?: unknown
  application?: unknown
  property_id?: unknown
  property_name?: unknown
  applied_target?: unknown
  applied_property_id?: unknown
  previous_subjective_knowledge?: unknown
  previous_never_rules?: unknown
  previous_team_presentation?: unknown
  knowledge_document_id?: unknown
  [key: string]: unknown
}

/**
 * PATCH /api/ai/suggestions/[id]  (agent+)
 *
 * Moves a suggestion through its status lifecycle (pending → approved/rejected/ignored/done).
 * For 'learning' category:
 *   - 'property_subjective': Appends to property_ai_contexts.subjective_knowledge
 *   - 'never_rule': Appends to ai_configs.global_never_rules
 *   - 'language_style': Updates ai_configs.team_presentation
 *   - 'global_knowledge': Inserts into ai_knowledge_documents
 * Supports 'action: revert' for full rollback of approved learning suggestions.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId, userId, role } = await requireRole('agent')

    const limit = checkRateLimit(`ai-suggestions-patch:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const isRevertAction = body.action === 'revert'
    const status = (body.status as AiSuggestionStatus) || (isRevertAction ? 'ignored' : 'pending')
    if (!isRevertAction && !AI_SUGGESTION_STATUSES.includes(status)) {
      return bad(`status must be one of: ${AI_SUGGESTION_STATUSES.join(', ')}`)
    }

    const snoozeProvided = 'snoozed_until' in body
    let snoozedUntil: string | null = null
    if (snoozeProvided && body.snoozed_until !== null) {
      const parsed = new Date(body.snoozed_until as string)
      if (Number.isNaN(parsed.getTime())) return bad('snoozed_until must be a valid date or null')
      snoozedUntil = parsed.toISOString()
    }
    if (status !== 'pending') snoozedUntil = null

    const { data: existing, error: fetchError } = await supabase
      .from('ai_suggestions')
      .select('id, category, title, payload, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (fetchError) {
      console.error('[ai/suggestions PATCH] fetch error:', fetchError)
      return NextResponse.json({ error: 'Failed to load AI suggestion' }, { status: 500 })
    }
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    let payload = (existing.payload ?? {}) as LearningPayload

    // ============================================================
    // ROLLBACK / REVERT ACTION FOR APPROVED LEARNING SUGGESTIONS
    // ============================================================
    if (isRevertAction || (existing.status === 'approved' && (status === 'rejected' || status === 'ignored'))) {
      if (!hasMinRole(role, 'admin')) {
        return bad('Reverting an approved suggestion requires an account admin', 403)
      }

      const appliedTarget = payload.applied_target
      if (appliedTarget === 'property_subjective' && payload.applied_property_id) {
        await supabase
          .from('property_ai_contexts')
          .update({
            subjective_knowledge: payload.previous_subjective_knowledge ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('property_id', payload.applied_property_id)
          .eq('account_id', accountId)
      } else if (appliedTarget === 'never_rule') {
        await supabase
          .from('ai_configs')
          .update({
            global_never_rules: payload.previous_never_rules ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('account_id', accountId)
      } else if (appliedTarget === 'language_style') {
        await supabase
          .from('ai_configs')
          .update({
            team_presentation: payload.previous_team_presentation ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('account_id', accountId)
      } else if (appliedTarget === 'global_knowledge' && payload.knowledge_document_id) {
        await supabase
          .from('ai_knowledge_chunks')
          .delete()
          .eq('document_id', payload.knowledge_document_id)
          .eq('account_id', accountId)

        await supabase
          .from('ai_knowledge_documents')
          .delete()
          .eq('id', payload.knowledge_document_id)
          .eq('account_id', accountId)
      }

      payload = {
        ...payload,
        applied_target: null,
        reverted_at: new Date().toISOString(),
        reverted_by: userId,
      }
    }

    // ============================================================
    // EDIT LEARNING SUGGESTION
    // ============================================================
    if (
      existing.category === 'learning' &&
      body.learning_edit &&
      typeof body.learning_edit === 'object'
    ) {
      const edit = body.learning_edit as Record<string, unknown>
      payload = {
        ...payload,
        ...(typeof edit.info === 'string' && edit.info.trim() ? { info: edit.info.trim() } : {}),
        ...(typeof edit.context_summary === 'string'
          ? { context_summary: edit.context_summary.trim() || null }
          : {}),
        ...(typeof edit.application === 'string'
          ? { application: edit.application.trim() || null }
          : {}),
      }
      const { error: editError } = await supabase
        .from('ai_suggestions')
        .update({ payload })
        .eq('id', id)
        .eq('account_id', accountId)
      if (editError) {
        console.error('[ai/suggestions PATCH] learning edit error:', editError)
        return bad('Failed to save the edit', 500)
      }
    }

    // ============================================================
    // APPROVE LEARNING SUGGESTION (SUPERVISED EVOLUTION)
    // ============================================================
    if (status === 'approved' && existing.category === 'learning' && existing.status !== 'approved') {
      if (!hasMinRole(role, 'admin')) {
        return bad('Approving a learning requires an account admin', 403)
      }

      const info = typeof payload.info === 'string' && payload.info.trim() ? payload.info.trim() : existing.title
      const learningType = String(payload.type || '').trim()

      if (learningType === 'property_subjective') {
        // Resolve property
        let propId = typeof payload.property_id === 'string' ? payload.property_id : null
        if (!propId && typeof payload.property_name === 'string') {
          const { data: foundProp } = await supabase
            .from('properties')
            .select('id')
            .eq('account_id', accountId)
            .ilike('name', `%${payload.property_name}%`)
            .maybeSingle()
          if (foundProp) propId = foundProp.id
        }

        if (propId) {
          const { data: currentCtx } = await supabase
            .from('property_ai_contexts')
            .select('subjective_knowledge')
            .eq('property_id', propId)
            .eq('account_id', accountId)
            .maybeSingle()

          const prevKnowledge = currentCtx?.subjective_knowledge || null
          const updatedKnowledge = prevKnowledge ? `${prevKnowledge}\n\n• ${info}` : `• ${info}`

          await supabase
            .from('property_ai_contexts')
            .upsert({
              property_id: propId,
              account_id: accountId,
              subjective_knowledge: updatedKnowledge,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'property_id' })

          payload = {
            ...payload,
            applied_target: 'property_subjective',
            applied_property_id: propId,
            previous_subjective_knowledge: prevKnowledge,
          }
        }
      } else if (learningType === 'never_rule') {
        const { data: currentConfig } = await supabase
          .from('ai_configs')
          .select('global_never_rules')
          .eq('account_id', accountId)
          .maybeSingle()

        const prevRules = currentConfig?.global_never_rules || null
        const updatedRules = prevRules ? `${prevRules}\n• ${info}` : `• ${info}`

        await supabase
          .from('ai_configs')
          .update({
            global_never_rules: updatedRules,
            updated_at: new Date().toISOString(),
          })
          .eq('account_id', accountId)

        payload = {
          ...payload,
          applied_target: 'never_rule',
          previous_never_rules: prevRules,
        }
      } else if (learningType === 'language_style') {
        const { data: currentConfig } = await supabase
          .from('ai_configs')
          .select('team_presentation')
          .eq('account_id', accountId)
          .maybeSingle()

        const prevPres = currentConfig?.team_presentation || null
        const updatedPres = prevPres ? `${prevPres}\n\n[Estilo]: ${info}` : info

        await supabase
          .from('ai_configs')
          .update({
            team_presentation: updatedPres,
            updated_at: new Date().toISOString(),
          })
          .eq('account_id', accountId)

        payload = {
          ...payload,
          applied_target: 'language_style',
          previous_team_presentation: prevPres,
        }
      } else if (learningType === 'boundary_suggestion') {
        // A recurring situation where a human consistently takes over is,
        // functionally, a transfer rule — apply it the same way as
        // never_rule (appended to global_never_rules, which the prompt
        // reads as instructions on when to hand off), instead of letting
        // it fall through to global_knowledge where the AI could recite it
        // as an institutional fact rather than act on it.
        const { data: currentConfig } = await supabase
          .from('ai_configs')
          .select('global_never_rules')
          .eq('account_id', accountId)
          .maybeSingle()

        const prevRules = currentConfig?.global_never_rules || null
        const updatedRules = prevRules
          ? `${prevRules}\n• Transferir para humano quando: ${info}`
          : `• Transferir para humano quando: ${info}`

        await supabase
          .from('ai_configs')
          .update({
            global_never_rules: updatedRules,
            updated_at: new Date().toISOString(),
          })
          .eq('account_id', accountId)

        payload = {
          ...payload,
          applied_target: 'boundary_suggestion',
          previous_never_rules: prevRules,
        }
      } else if (learningType === 'process_suggestion') {
        // Operational feedback for the human team (e.g. "confirm the unit
        // number before the agent's first reply") — it isn't AI behavior
        // to change, so approving it just records the decision. It must
        // NOT fall through to global_knowledge: that would let the bot
        // recite an internal process note to a customer as if it were a
        // fact about the property.
        payload = {
          ...payload,
          applied_target: 'process_note',
        }
      } else {
        // Default / global_knowledge
        const contextSummary = typeof payload.context_summary === 'string' ? payload.context_summary : null
        const application = typeof payload.application === 'string' ? payload.application : null
        const content = [
          info,
          contextSummary ? `Contexto: ${contextSummary}` : null,
          application ? `Aplicação sugerida: ${application}` : null,
        ]
          .filter(Boolean)
          .join('\n\n')

        const { data: doc, error: docError } = await supabase
          .from('ai_knowledge_documents')
          .insert({ account_id: accountId, created_by: userId, title: info.slice(0, 200), content })
          .select('id')
          .single()

        if (docError || !doc) {
          console.error('[ai/suggestions PATCH] knowledge insert error:', docError)
          return bad('Failed to save learning to global knowledge base', 500)
        }

        try {
          const { key: embeddingsApiKey } = await loadEmbeddingsKey(supabase, accountId)
          await ingestDocument(supabase, accountId, { embeddingsApiKey }, doc.id, content)
        } catch (err) {
          console.error('[ai/suggestions PATCH] knowledge ingest error:', err)
        }

        payload = {
          ...payload,
          applied_target: 'global_knowledge',
          knowledge_document_id: doc.id,
        }
      }
    }

    if (status === 'approved' && existing.category === 'pipeline_move') {
      const payload = (existing.payload ?? {}) as PipelineMovePayload
      const dealId = typeof payload.deal_id === 'string' ? payload.deal_id : null
      const toStageId = typeof payload.to_stage_id === 'string' ? payload.to_stage_id : null
      if (!dealId || !toStageId) {
        return bad('Suggestion is missing deal/stage information and cannot be accepted')
      }
      const { data: movedDeal, error: moveError } = await supabase
        .from('deals')
        .update({ stage_id: toStageId })
        .eq('id', dealId)
        .eq('account_id', accountId)
        .select('id')
        .maybeSingle()
      if (moveError) {
        console.error('[ai/suggestions PATCH] deal move error:', moveError)
        return NextResponse.json(
          { error: 'Failed to move the deal to the suggested stage' },
          { status: 500 },
        )
      }
      if (!movedDeal) {
        return bad('The deal behind this suggestion no longer exists')
      }
    }

    const resolved = status !== 'pending'
    const update: Record<string, unknown> = {
      status,
      payload,
      resolved_by: resolved ? userId : null,
      resolved_at: resolved ? new Date().toISOString() : null,
    }
    if (resolved || snoozeProvided) update.snoozed_until = snoozedUntil

    const { data, error } = await supabase
      .from('ai_suggestions')
      .update(update)
      .eq('id', id)
      .eq('account_id', accountId)
      .select('*, contact:contacts(id, name, avatar_url)')
      .maybeSingle()

    if (error) {
      console.error('[ai/suggestions PATCH] update error:', error)
      return NextResponse.json({ error: 'Failed to update AI suggestion' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json({ suggestion: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/suggestions/[id]  (admin+)
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId } = await requireRole('admin')

    const { error } = await supabase
      .from('ai_suggestions')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)

    if (error) {
      console.error('[ai/suggestions DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete AI suggestion' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
