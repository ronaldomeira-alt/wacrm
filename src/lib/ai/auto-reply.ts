import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { executeConversationalTurn } from './conversation-engine'
import { logAiUsage } from './usage'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { sendPushToAccount } from '@/lib/push/send'
import { resolvePropertyForConversation } from './property-resolution'
import type { CtwaReferral } from '@/lib/whatsapp/ctwa-referral'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
  * AI auto-reply for a freshly-arrived inbound message.
  *
  * Invoked from the WhatsApp webhook's `after()` block, only when no
  * deterministic flow consumed the message (flows win). Mirrors the flow
  * runner's contract: it owns its try/catch and NEVER throws — a failing
  * or slow LLM call must not affect the webhook's 200 to Meta.
  *
  * Eligibility gates (any → silent no-op):
  *   1. AI off / auto-reply disabled for the account (Master switch `auto_reply_enabled === false`)
  *   2. Message-level active automations or active Flow run (Flows win)
  *   3. Human agent is assigned (`assigned_agent_id !== null`)
  *   4. Human takeover active / auto-reply disabled for this thread (`ai_autoreply_disabled === true`)
  *   5. Handoff already pending or completed (`ai_transfer_status in ('pending_human', 'transferred')`)
  *   6. Per-conversation safety limit reached (`ai_reply_count >= safetyLimit`)
  *   7. Account-level burst rate limit
  *   8. Just-in-time race condition check immediately before sending to Meta
  */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    // 1. MASTER SWITCH: Must be active and explicitly enabled for auto-reply
    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) {
      return
    }

    // 2. FLOWS & AUTOMATIONS WIN: Check for active automations or running flows
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

    // 3. CONVERSATION STATE GATES
    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('id, assigned_agent_id, ai_autoreply_disabled, ai_reply_count, property_id, ai_transfer_status, ctwa_referral')
      .eq('id', conversationId)
      .maybeSingle()

    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // A human agent owns this thread
    if (conv.ai_autoreply_disabled) return // Human takeover or handed off
    if (conv.ai_transfer_status === 'pending_human' || conv.ai_transfer_status === 'transferred') {
      return // Handoff waiting for human response
    }

    const maxReplies = config.safetyMessageLimit ?? config.autoReplyMaxPerConversation ?? 8
    if ((conv.ai_reply_count ?? 0) >= maxReplies) return // Per-thread safety limit reached

    // 4. TRANSCRIPT / CONTEXT GATES
    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Resolve property via 5-level deterministic cascade
    let effectivePropertyId = conv.property_id || null
    if (!effectivePropertyId) {
      const firstUserMsg = messages.find((m) => m.role === 'user')?.content || null
      const resolution = await resolvePropertyForConversation({
        db,
        accountId,
        conversationId,
        currentPropertyId: null,
        referral: (conv.ctwa_referral as unknown as CtwaReferral) || null,
        firstUserMessage: firstUserMsg,
      })
      if (resolution.propertyId) {
        effectivePropertyId = resolution.propertyId
        // Best-effort persist resolved property onto conversation
        void db
          .from('conversations')
          .update({ property_id: effectivePropertyId })
          .eq('id', conversationId)
      }
    }

    // Record timestamp before LLM call to verify concurrency / race conditions afterward
    const inboundTriggerTimestamp = new Date().toISOString()

    // 5. ACCOUNT RATE LIMIT
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit rate limit — skipping this turn.`,
      )
      return
    }

    // 6. EXECUTE CONVERSATIONAL TURN
    const turnResult = await executeConversationalTurn({
      db,
      accountId,
      config,
      contactId,
      propertyId: effectivePropertyId,
      messages,
      replyCount: conv.ai_reply_count ?? 0,
    })

    // 7. RECORD USAGE
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage: turnResult.usage,
    })

    // 8. JUST-IN-TIME RACE CONDITION & TAKEOVER VERIFICATION
    // Re-fetch conversation state right before sending to Meta
    const { data: freshConv, error: freshConvErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_transfer_status')
      .eq('id', conversationId)
      .maybeSingle()

    if (
      freshConvErr ||
      !freshConv ||
      freshConv.assigned_agent_id ||
      freshConv.ai_autoreply_disabled ||
      freshConv.ai_transfer_status === 'pending_human' ||
      freshConv.ai_transfer_status === 'transferred'
    ) {
      console.log(
        `[ai auto-reply] ABORTING send for conv ${conversationId}: human takeover or assignment occurred during generation.`,
      )
      return
    }

    // Check if any human message was inserted into messages during LLM processing
    const { data: recentHumanMsgs } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'agent')
      .gte('created_at', inboundTriggerTimestamp)
      .limit(1)

    if (recentHumanMsgs && recentHumanMsgs.length > 0) {
      console.log(
        `[ai auto-reply] ABORTING send for conv ${conversationId}: human agent sent a message during generation.`,
      )
      return
    }

    // Re-verify master switch wasn't disabled mid-turn
    const freshConfig = await loadAiConfig(db, accountId)
    if (!freshConfig || !freshConfig.autoReplyEnabled) {
      console.log(
        `[ai auto-reply] ABORTING send for conv ${conversationId}: auto_reply_enabled disabled mid-turn.`,
      )
      return
    }

    // 9. ATOMIC SLOT CLAIM
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: maxReplies,
      },
    )
    if (claimErr) {
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // Lost the slot race

    // 10. SEND TO META CLOUD API
    if (turnResult.responseText && turnResult.responseText.trim().length > 0) {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: turnResult.responseText,
        aiGenerated: true,
      })
    }

    // 11. POST-TURN HANDOFF HANDLING
    if (turnResult.handoff || turnResult.decision?.transfer_required) {
      const boundary = turnResult.decision?.boundary_type || 'comercial'
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
      }

      if (config.handoffAgentId && !freshConv.assigned_agent_id) {
        convUpdate.assigned_agent_id = config.handoffAgentId
      }

      await db.from('conversations').update(convUpdate).eq('id', conversationId)

      // Attention Push Notification for the human team
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
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
