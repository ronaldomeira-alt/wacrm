import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { executeConversationalTurn } from './conversation-engine'
import { logAiUsage } from './usage'
import { cancelPendingReplyRecovery, enqueueAiReplyRecovery } from './reply-queue'
import { acquireConversationLeaseWithHeartbeat, type ConversationLease } from './lease-heartbeat'
import { AiOutboundAmbiguousError, isUnknownSendOutcome, reserveOutboundIntent } from './outbound-idempotency'
import type { AiProvider } from './types'
import { engineSendMedia, engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { sendPushToAccount } from '@/lib/push/send'
import { resolvePropertyForConversation } from './property-resolution'
import type { CtwaReferral } from '@/lib/whatsapp/ctwa-referral'

export interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Optional ID of the specific inbound message that triggered this dispatch. */
  inboundMessageId?: string
  /** Debounce delay in ms before executing turn (defaults to 2500ms). Can be set to 0 in tests. */
  debounceMs?: number
}

/**
 * AI auto-reply for inbound WhatsApp messages with structural debounce,
 * per-conversation processing lock, turn aggregation, and race-condition safety.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId, inboundMessageId } = args
  const debounceDelay = args.debounceMs ?? 2500

  try {
    const db = supabaseAdmin()

    // 1. FAST MASTER SWITCH & FLOWS CHECK: Must be active and explicitly enabled
    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) {
      return
    }

    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: activeFlowRuns } = await db
      .from('flow_runs')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'active')
      .limit(1)
    if (activeFlowRuns && activeFlowRuns.length > 0) return

    // 2. FAST CONVERSATION STATE GATES
    const { data: initialConv, error: convErr } = await db
      .from('conversations')
      .select('id, assigned_agent_id, ai_autoreply_disabled, ai_reply_count, property_id, ai_transfer_status, ctwa_referral, ai_reactivation_status')
      .eq('id', conversationId)
      .maybeSingle()

    if (convErr || !initialConv) return
    if (initialConv.assigned_agent_id) return // A human agent owns this thread
    if (initialConv.ai_autoreply_disabled) return // Human takeover or handed off
    if (initialConv.ai_transfer_status === 'pending_human' || initialConv.ai_transfer_status === 'transferred') {
      return // Handoff waiting for human response
    }

    const limitA = typeof config.safetyMessageLimit === 'number' && config.safetyMessageLimit > 0 ? config.safetyMessageLimit : Infinity
    const limitB = typeof config.autoReplyMaxPerConversation === 'number' && config.autoReplyMaxPerConversation > 0 ? config.autoReplyMaxPerConversation : Infinity
    const effectiveLimit = Math.min(limitA, limitB)
    const maxReplies = Number.isFinite(effectiveLimit) ? effectiveLimit : 8
    if ((initialConv.ai_reply_count ?? 0) >= maxReplies) return

    const inboundArrivedAt = new Date().toISOString()
    const convUpdatePayload: Record<string, unknown> = { ai_last_inbound_at: inboundArrivedAt }
    if ((initialConv as Record<string, unknown>).ai_reactivation_status === 'scheduled') {
      convUpdatePayload.ai_reactivation_status = 'cancelled'
    }
    await db
      .from('conversations')
      .update(convUpdatePayload)
      .eq('id', conversationId)

    // 3. DEBOUNCE / TURN AGGREGATION WINDOW
    // If the customer is typing multiple sequential messages (e.g. "Mais informações", "Fotos", "Preço?"),
    // wait a short window so all messages can arrive and be answered in ONE single consolidated turn.
    if (debounceDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, debounceDelay))

      // Check if a newer customer message arrived in this conversation during the wait window
      const { data: newerCustomerMsgs } = await db
        .from('messages')
        .select('id, created_at')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .gt('created_at', inboundArrivedAt)
        .order('created_at', { ascending: false })
        .limit(1)

      if (newerCustomerMsgs && newerCustomerMsgs.length > 0) {
        console.log(
          `[ai auto-reply] Debounced: newer customer message (${newerCustomerMsgs[0].id}) arrived in conv ${conversationId}. Yielding to the newest message's execution.`,
        )
        return
      }
    }

    // 4. ATOMIC CONVERSATION LEASE WITH HEARTBEAT & FENCING TOKEN
    const lockToken = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `lock-${Date.now()}-${Math.random()}`
    let lease: ConversationLease | null = null

    for (let attempt = 0; attempt < 3; attempt++) {
      lease = await acquireConversationLeaseWithHeartbeat(db, conversationId, lockToken)
      if (lease) break
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    if (!lease) {
      console.log(`[ai auto-reply] Conversation ${conversationId} is currently locked by another active run. Skipping.`)
      return
    }

    try {
      // 5. FRESH CONVERSATION STATE & CONTEXT GATES (Inside Lock)
      const { data: conv, error: freshErr } = await db
        .from('conversations')
        .select('id, assigned_agent_id, ai_autoreply_disabled, ai_reply_count, property_id, ai_transfer_status, ctwa_referral')
        .eq('id', conversationId)
        .maybeSingle()

      if (
        freshErr ||
        !conv ||
        conv.assigned_agent_id ||
        conv.ai_autoreply_disabled ||
        conv.ai_transfer_status === 'pending_human' ||
        conv.ai_transfer_status === 'transferred' ||
        (conv.ai_reply_count ?? 0) >= maxReplies
      ) {
        return
      }

      let messages = await buildConversationContext(db, conversationId)
      if (messages.length === 0) return

      // The last message in the thread MUST be from the user; if it's already answered, skip.
      const lastMessage = messages[messages.length - 1]
      if (!lastMessage || lastMessage.role !== 'user') {
        console.log(`[ai auto-reply] Last message in conv ${conversationId} is not from user. Already answered.`)
        return
      }

      // 6. PROPERTY RESOLUTION & STICKINESS
      const firstUserMsg = messages.find((m) => m.role === 'user')?.content || null
      const latestUserMsg = lastMessage.content || null
      const allUserMsgs = messages.filter((m) => m.role === 'user').map((m) => m.content)

      const resolution = await resolvePropertyForConversation({
        db,
        accountId,
        conversationId,
        currentPropertyId: conv.property_id || null,
        referral: (conv.ctwa_referral as unknown as CtwaReferral) || null,
        firstUserMessage: firstUserMsg,
        latestUserMessage: latestUserMsg,
        userMessages: allUserMsgs,
      })

      let effectivePropertyId = conv.property_id || null
      if (resolution.propertyId && resolution.propertyId !== conv.property_id) {
        effectivePropertyId = resolution.propertyId
        await db
          .from('conversations')
          .update({ property_id: effectivePropertyId })
          .eq('id', conversationId)
      } else if (!effectivePropertyId && resolution.propertyId) {
        effectivePropertyId = resolution.propertyId
        await db
          .from('conversations')
          .update({ property_id: effectivePropertyId })
          .eq('id', conversationId)
      }

      // 7. ACCOUNT RATE LIMIT
      const acctLimit = checkRateLimit(
        `ai-autoreply:${accountId}`,
        RATE_LIMITS.aiAutoReplyAccount,
      )
      if (!acctLimit.success) {
        console.warn(`[ai auto-reply] account ${accountId} hit rate limit — skipping this turn.`)
        return
      }

      // 8. EXECUTE CONVERSATIONAL TURN
      const executionStartTimestamp = new Date().toISOString()
      console.log(
        `[ai auto-reply] Starting turn: conv=${conversationId}, msgs=${messages.length}, prop=${effectivePropertyId || 'none'}, inboundMsg=${inboundMessageId || 'none'}`,
      )

      let turnResult = await executeConversationalTurn({
        db,
        accountId,
        config,
        conversationId,
        contactId,
        propertyId: effectivePropertyId,
        messages,
        replyCount: conv.ai_reply_count ?? 0,
        signal: lease.abortController.signal,
      })

      // 9. JUST-IN-TIME RACE CONDITION & RECENT MESSAGES CHECK
      // Check if human agent took over or sent a message during LLM generation
      const { data: recentHumanMsgs } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'agent')
        .gte('created_at', executionStartTimestamp)
        .limit(1)

      if (recentHumanMsgs && recentHumanMsgs.length > 0) {
        console.log(
          `[ai auto-reply] ABORTING send for conv ${conversationId}: human agent sent a message during generation.`,
        )
        return
      }

      // Check if the customer sent additional messages WHILE the LLM was generating
      const { data: midGenerationCustomerMsgs } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .gt('created_at', executionStartTimestamp)
        .limit(1)

      if (midGenerationCustomerMsgs && midGenerationCustomerMsgs.length > 0) {
        console.log(
          `[ai auto-reply] Customer sent additional message during generation in conv ${conversationId}. Re-evaluating turn with updated messages.`,
        )
        messages = await buildConversationContext(db, conversationId)
        turnResult = await executeConversationalTurn({
          db,
          accountId,
          config,
          conversationId,
          contactId,
          propertyId: effectivePropertyId,
          messages,
          replyCount: conv.ai_reply_count ?? 0,
          signal: lease.abortController.signal,
        })
      }

      // Re-verify conversation state and config before sending to Meta
      const { data: postConv } = await db
        .from('conversations')
        .select('assigned_agent_id, ai_autoreply_disabled, ai_transfer_status')
        .eq('id', conversationId)
        .maybeSingle()

      if (
        !postConv ||
        postConv.assigned_agent_id ||
        postConv.ai_autoreply_disabled ||
        postConv.ai_transfer_status === 'pending_human' ||
        postConv.ai_transfer_status === 'transferred'
      ) {
        console.log(`[ai auto-reply] ABORTING send for conv ${conversationId}: state changed during turn.`)
        return
      }

      const freshConfig = await loadAiConfig(db, accountId)
      if (!freshConfig || !freshConfig.autoReplyEnabled) {
        return
      }

      // 10. RECORD USAGE
      await logAiUsage(db, {
        accountId,
        conversationId,
        mode: 'auto_reply',
        provider: (turnResult.provider as AiProvider | undefined) ?? config.provider,
        model: turnResult.model ?? config.model,
        usage: turnResult.usage,
        latencyMs: turnResult.latencyMs,
        fallbackUsed: turnResult.fallbackUsed,
        attemptNumber: turnResult.attemptCount,
      })

      // 10.5 VERIFY FENCING TOKEN STILL OWNS LEASE BEFORE ANY SIDE EFFECT
      if (!(await lease.verify())) {
        console.warn(`[ai auto-reply] Lease/fencing token lost for conv ${conversationId} — aborting before send.`)
        return
      }

      const turnIdempotencyBase = inboundMessageId
        ? `inbound:${inboundMessageId}`
        : `conv:${conversationId}:${executionStartTimestamp.slice(0, 16)}`

      // 11. SEND TEXT & MEDIA TO META CLOUD API WITH IDEMPOTENCY RESERVATION
      if (turnResult.responseText && turnResult.responseText.trim().length > 0) {
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text: turnResult.responseText,
          aiGenerated: true,
          idempotencyKey: `ai-text:${turnIdempotencyBase}`,
        })
      }

      // 12. ATOMIC SLOT CLAIM AFTER TEXT SEND SUCCEEDED
      const { data: claimed, error: claimErr } = await db.rpc(
        'claim_ai_reply_slot',
        {
          conversation_id: conversationId,
          max_replies: maxReplies,
        },
      )
      if (claimErr || claimed !== true) {
        console.warn(`[ai auto-reply] Could not claim reply slot for conv ${conversationId}`)
      }

      await cancelPendingReplyRecovery(db, conversationId, 'completed')

      const mediaItems = turnResult.validatedMediaToSend || []
      if (mediaItems.length > 0) {
        for (const mediaItem of mediaItems) {
          if (!(await lease.verify())) break
          try {
            await engineSendMedia({
              accountId,
              userId: configOwnerUserId,
              conversationId,
              contactId,
              kind: mediaItem.type,
              link: mediaItem.publicUrl,
              // Fotos enviadas pela Clara nunca levam legenda/nome, permitindo que o WhatsApp as agrupe naturalmente em álbum
              caption: undefined,
              aiGenerated: true,
              idempotencyKey: `ai-media:${turnIdempotencyBase}:${mediaItem.mediaId}`,
            })
          } catch (mediaSendErr) {
            console.error(`[ai auto-reply] Failed to send media ${mediaItem.mediaId}:`, mediaSendErr)
          }
        }
      }

      // 13. POST-TURN HANDOFF HANDLING
      if (turnResult.handoff || turnResult.decision?.transfer_required) {
        const handoffReservation = await reserveOutboundIntent(db, {
          accountId,
          conversationId,
          idempotencyKey: `ai-handoff:${turnIdempotencyBase}`,
          intentType: 'handoff',
        })
        if (handoffReservation.action === 'proceed') {
        const boundary = turnResult.decision?.boundary_type || 'commercial_decision'
        const reason = turnResult.decision?.reason || 'Fronteira atingida'
        const summary = turnResult.decision?.context_summary || 'Atendimento transferido'
        const action = turnResult.decision?.suggested_next_action || 'Dar continuidade ao atendimento'

        const note = [
          `[TRANSFERÊNCIA PELA IA]`,
          `Fronteira: ${boundary}`,
          `Motivo: ${reason}`,
          `Resumo: ${summary}`,
          `Próxima Ação Sugerida: ${action}`,
        ].join('\n')

        const convUpdate: Record<string, unknown> = {
          ai_autoreply_disabled: true,
          ai_transfer_status: 'pending_human',
          ai_transfer_reason: reason,
          ai_transfer_boundary_type: boundary,
          ai_transfer_at: new Date().toISOString(),
          ai_handoff_summary: note,
          ai_last_turn_processed_at: new Date().toISOString(),
        }

        if (config.handoffAgentId && !conv.assigned_agent_id) {
          convUpdate.assigned_agent_id = config.handoffAgentId
        }

        await db.from('conversations').update(convUpdate).eq('id', conversationId)

        const { data: contact } = await db
          .from('contacts')
          .select('name')
          .eq('id', contactId)
          .maybeSingle()

        const contactName = contact?.name || 'Novo Lead'
        void sendPushToAccount(accountId, {
          title: `🚨 Lead precisa da sua atenção: ${contactName}`,
          body: `${reason}. Resumo: ${summary}`,
          url: `/inbox?conversationId=${conversationId}`,
          tag: `ai-handoff-${conversationId}`,
        }).catch((err) => {
          console.error('[ai auto-reply] push notification failed:', err)
        })
        }
      } else {
        await db
          .from('conversations')
          .update({ ai_last_turn_processed_at: new Date().toISOString() })
          .eq('id', conversationId)
      }

      console.log(
        `[ai auto-reply] Turn completed successfully: conv=${conversationId}, textLen=${turnResult.responseText?.length || 0}, mediaCount=${mediaItems.length}, handoff=${turnResult.handoff}`,
      )
    } finally {
      // 14. ALWAYS RELEASE CONVERSATION LEASE & HEARTBEAT
      await lease.release()
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
    const errCode =
      typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'auto_reply_failed'
    const errMsg = err instanceof Error ? err.message : String(err)

    if (err instanceof AiOutboundAmbiguousError || isUnknownSendOutcome(err)) {
      // Ambiguous Meta send outcome: do NOT blindly re-send; escalate to human supervision
      await supabaseAdmin()
        .from('conversations')
        .update({
          ai_transfer_status: 'pending_human',
          ai_transfer_reason: 'Resultado ambíguo no envio ao WhatsApp (verificação humana)',
          ai_handoff_summary: `[ATENÇÃO] O envio da resposta automática teve resultado ambíguo (${errMsg.slice(0, 250)}). Verifique se a mensagem foi entregue antes de reenviar.`,
        })
        .eq('id', conversationId)
      return
    }

    await enqueueAiReplyRecovery(supabaseAdmin(), {
      accountId,
      conversationId,
      inboundMessageId,
      errorCode: errCode,
      errorReason: errMsg,
    })
  }
}

