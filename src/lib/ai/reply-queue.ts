import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { executeConversationalTurn } from './conversation-engine'
import { acquireConversationLeaseWithHeartbeat, type ConversationLease } from './lease-heartbeat'
import { AiOutboundAmbiguousError, isUnknownSendOutcome } from './outbound-idempotency'
import { resolvePropertyForConversation } from './property-resolution'
import type { AiProvider } from './types'
import { logAiUsage } from './usage'
import { engineSendMedia, engineSendText } from '@/lib/flows/meta-send'
import type { CtwaReferral } from '@/lib/whatsapp/ctwa-referral'
import { getConversationSessionStatus } from '@/lib/whatsapp/session-window'

const BACKOFF_SECONDS = [60, 180, 600, 1800, 3600, 7200]

export function computeNextAttemptAt(attempts: number): string {
  const idx = Math.min(Math.max(0, attempts), BACKOFF_SECONDS.length - 1)
  return new Date(Date.now() + BACKOFF_SECONDS[idx] * 1000).toISOString()
}

/**
 * Persist an unanswered inbound conversation into `ai_reply_queue` when
 * both providers fail (or Meta send fails). Coalesces multiple inbound
 * messages on the same conversation into a single pending recovery job.
 */
export async function enqueueAiReplyRecovery(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    inboundMessageId?: string | null
    errorCode?: string | null
    errorReason?: string | null
  },
): Promise<void> {
  try {
    const { data: existing } = await db
      .from('ai_reply_queue')
      .select('id, attempts')
      .eq('conversation_id', args.conversationId)
      .in('status', ['pending', 'processing'])
      .maybeSingle()

    const now = new Date().toISOString()
    if (existing) {
      await db
        .from('ai_reply_queue')
        .update({
          inbound_message_id: args.inboundMessageId ?? undefined,
          last_error_code: args.errorCode ?? null,
          last_error: args.errorReason ? args.errorReason.slice(0, 500) : null,
          next_attempt_at: computeNextAttemptAt(Number(existing.attempts ?? 0)),
          updated_at: now,
        })
        .eq('id', existing.id)
      return
    }

    await db.from('ai_reply_queue').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      inbound_message_id: args.inboundMessageId ?? null,
      execution_token: crypto.randomUUID(),
      status: 'pending',
      attempts: 0,
      max_attempts: BACKOFF_SECONDS.length,
      next_attempt_at: computeNextAttemptAt(0),
      last_error_code: args.errorCode ?? null,
      last_error: args.errorReason ? args.errorReason.slice(0, 500) : null,
    })
  } catch (err) {
    console.error('[ai reply queue] enqueue failed:', err)
  }
}

export async function cancelPendingReplyRecovery(
  db: SupabaseClient,
  conversationId: string,
  status: 'completed' | 'cancelled_human' | 'cancelled_window' = 'completed',
): Promise<void> {
  try {
    await db
      .from('ai_reply_queue')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .in('status', ['pending', 'processing'])
  } catch (err) {
    console.warn('[ai reply queue] cancel failed:', err)
  }
}

export interface ProcessQueueResult {
  processed: number
  completed: number
  cancelledHuman: number
  cancelledWindow: number
  rescheduled: number
  escalatedToHuman: number
}

/**
 * Process due items in `ai_reply_queue` automatically without requiring a
 * new customer message. Respects:
 * - Human takeover (cancels if an agent replied or disabled AI)
 * - WhatsApp 24h session window
 * - Clara's business hours & max replies
 * - Atomic conversation lock & execution_token exclusive authorization
 */
export async function processAiReplyQueue(
  db: SupabaseClient,
  opts: { accountId?: string; limit?: number } = {},
): Promise<ProcessQueueResult> {
  const result: ProcessQueueResult = {
    processed: 0,
    completed: 0,
    cancelledHuman: 0,
    cancelledWindow: 0,
    rescheduled: 0,
    escalatedToHuman: 0,
  }

  const nowIso = new Date().toISOString()

  // Recover stale 'processing' jobs left behind by a process crash/restart (> 2 min old)
  const staleCutoff = new Date(Date.now() - 120_000).toISOString()
  await db
    .from('ai_reply_queue')
    .update({ status: 'pending', updated_at: nowIso })
    .eq('status', 'processing')
    .lt('updated_at', staleCutoff)

  let query = db
    .from('ai_reply_queue')
    .select('id, account_id, conversation_id, inbound_message_id, attempts, max_attempts, created_at')
    .eq('status', 'pending')
    .lte('next_attempt_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(opts.limit ?? 20)

  if (opts.accountId) {
    query = query.eq('account_id', opts.accountId)
  }

  const { data: jobs, error } = await query
  if (error || !jobs || jobs.length === 0) return result

  for (const job of jobs) {
    const executionToken = crypto.randomUUID()
    const { data: claimedJob } = await db
      .from('ai_reply_queue')
      .update({
        status: 'processing',
        execution_token: executionToken,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (!claimedJob) continue
    result.processed += 1

    const lockToken = crypto.randomUUID()
    let lease: ConversationLease | null = null

    try {
      const config = await loadAiConfig(db, job.account_id)
      if (!config || !config.autoReplyEnabled) {
        await db
          .from('ai_reply_queue')
          .update({ status: 'cancelled_human', updated_at: new Date().toISOString() })
          .eq('id', job.id)
        result.cancelledHuman += 1
        continue
      }

      const { data: conv } = await db
        .from('conversations')
        .select('id, contact_id, property_id, ctwa_referral, assigned_agent_id, ai_autoreply_disabled, ai_transfer_status, ai_reply_count')
        .eq('id', job.conversation_id)
        .maybeSingle()

      if (
        !conv ||
        conv.assigned_agent_id ||
        conv.ai_autoreply_disabled ||
        conv.ai_transfer_status === 'pending_human' ||
        conv.ai_transfer_status === 'transferred'
      ) {
        await db
          .from('ai_reply_queue')
          .update({ status: 'cancelled_human', updated_at: new Date().toISOString() })
          .eq('id', job.id)
        result.cancelledHuman += 1
        continue
      }

      // Check if a human agent sent a message after this job was queued
      const { data: humanReply } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', job.conversation_id)
        .eq('sender_type', 'agent')
        .gte('created_at', job.created_at)
        .limit(1)

      if (humanReply && humanReply.length > 0) {
        await db
          .from('ai_reply_queue')
          .update({ status: 'cancelled_human', updated_at: new Date().toISOString() })
          .eq('id', job.id)
        result.cancelledHuman += 1
        continue
      }

      // Check WhatsApp 24h session window
      const session = await getConversationSessionStatus(db, job.conversation_id)
      if (session.expired) {
        await db
          .from('ai_reply_queue')
          .update({
            status: 'cancelled_window',
            last_error_code: 'whatsapp_window_expired',
            last_error: 'Janela de 24h do WhatsApp encerrada antes da recuperação.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id)
        result.cancelledWindow += 1
        continue
      }

      lease = await acquireConversationLeaseWithHeartbeat(db, job.conversation_id, lockToken)
      if (!lease) {
        await db
          .from('ai_reply_queue')
          .update({
            status: 'pending',
            next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id)
        result.rescheduled += 1
        continue
      }

      const messages = await buildConversationContext(db, job.conversation_id)
      if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
        await db
          .from('ai_reply_queue')
          .update({ status: 'completed', updated_at: new Date().toISOString() })
          .eq('id', job.id)
        result.completed += 1
        continue
      }

      const allUserMsgs = messages.filter((m) => m.role === 'user').map((m) => m.content)
      const resolution = await resolvePropertyForConversation({
        db,
        accountId: job.account_id,
        conversationId: job.conversation_id,
        currentPropertyId: conv.property_id || null,
        referral: (conv.ctwa_referral as unknown as CtwaReferral) || null,
        firstUserMessage: allUserMsgs[0] ?? '',
        latestUserMessage: allUserMsgs[allUserMsgs.length - 1] ?? '',
        userMessages: allUserMsgs,
      })
      const propertyId = resolution.propertyId ?? conv.property_id ?? null

      const turnResult = await executeConversationalTurn({
        db,
        accountId: job.account_id,
        conversationId: job.conversation_id,
        contactId: conv.contact_id,
        propertyId,
        config,
        messages,
        replyCount: conv.ai_reply_count ?? 0,
        signal: lease.abortController.signal,
      })

      // Exclusive authorization check: ensure execution_token & fencing token still own the job
      if (!(await lease.verify())) {
        continue
      }

      // Exclusive authorization check: ensure execution_token still owns the job and no human intervened
      const { data: stillOwner } = await db
        .from('ai_reply_queue')
        .select('execution_token, status')
        .eq('id', job.id)
        .maybeSingle()

      if (!stillOwner || stillOwner.execution_token !== executionToken || stillOwner.status !== 'processing') {
        continue
      }

      const { data: agentCheck } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', job.conversation_id)
        .eq('sender_type', 'agent')
        .gte('created_at', job.created_at)
        .limit(1)

      if (agentCheck && agentCheck.length > 0) {
        await db
          .from('ai_reply_queue')
          .update({ status: 'cancelled_human', updated_at: new Date().toISOString() })
          .eq('id', job.id)
        result.cancelledHuman += 1
        continue
      }

      const { data: ownerRow } = await db
        .from('account_members')
        .select('user_id')
        .eq('account_id', job.account_id)
        .eq('role', 'owner')
        .limit(1)
        .maybeSingle()
      const userId = ownerRow?.user_id ?? ''

      await logAiUsage(db, {
        accountId: job.account_id,
        conversationId: job.conversation_id,
        mode: 'recovery',
        provider: (turnResult.provider as AiProvider | undefined) ?? config.provider,
        model: turnResult.model ?? config.model,
        usage: turnResult.usage,
        latencyMs: turnResult.latencyMs,
        fallbackUsed: turnResult.fallbackUsed,
        attemptNumber: turnResult.attemptCount,
      })

      const idempotencyBase = job.inbound_message_id
        ? `inbound:${job.inbound_message_id}`
        : `queue:${job.id}`

      if (turnResult.responseText && turnResult.responseText.trim().length > 0) {
        await engineSendText({
          accountId: job.account_id,
          userId,
          conversationId: job.conversation_id,
          contactId: conv.contact_id,
          text: turnResult.responseText,
          aiGenerated: true,
          idempotencyKey: `ai-text:${idempotencyBase}`,
        })
      }

      for (const mediaItem of turnResult.validatedMediaToSend || []) {
        if (!(await lease.verify())) break
        try {
          await engineSendMedia({
            accountId: job.account_id,
            userId,
            conversationId: job.conversation_id,
            contactId: conv.contact_id,
            kind: mediaItem.type,
            link: mediaItem.publicUrl,
            caption: undefined,
            aiGenerated: true,
            idempotencyKey: `ai-media:${idempotencyBase}:${mediaItem.mediaId}`,
          })
        } catch (mediaErr) {
          console.error('[ai reply queue] media send failed:', mediaErr)
        }
      }

      await db.rpc('claim_ai_reply_slot', {
        conversation_id: job.conversation_id,
        max_replies: config.autoReplyMaxPerConversation || 10,
      })

      await db
        .from('conversations')
        .update({ ai_last_turn_processed_at: new Date().toISOString() })
        .eq('id', job.conversation_id)

      await db
        .from('ai_reply_queue')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', job.id)
      result.completed += 1
    } catch (err) {
      const nextAttempts = Number(job.attempts ?? 0) + 1
      const maxAttempts = Number(job.max_attempts ?? BACKOFF_SECONDS.length)
      const errMsg = err instanceof Error ? err.message : String(err)
      const isAmbiguous = err instanceof AiOutboundAmbiguousError || isUnknownSendOutcome(err)

      if (isAmbiguous || nextAttempts >= maxAttempts) {
        await db
          .from('ai_reply_queue')
          .update({
            status: 'needs_human_supervision',
            attempts: nextAttempts,
            last_error: errMsg.slice(0, 500),
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id)

        await db
          .from('conversations')
          .update({
            ai_transfer_status: 'pending_human',
            ai_transfer_reason: isAmbiguous
              ? 'Resultado ambíguo no envio ao WhatsApp (verificação humana)'
              : 'Falha persistente na recuperação automática de IA',
            ai_handoff_summary: isAmbiguous
              ? `[SUPERVISÃO NECESSÁRIA]\nO envio teve resultado ambíguo e foi bloqueado contra duplicidade: ${errMsg.slice(0, 250)}`
              : `[SUPERVISÃO NECESSÁRIA]\nNão foi possível concluir a resposta automática após ${nextAttempts} tentativas. Último erro: ${errMsg.slice(0, 300)}`,
          })
          .eq('id', job.conversation_id)
        result.escalatedToHuman += 1
      } else {
        await db
          .from('ai_reply_queue')
          .update({
            status: 'pending',
            attempts: nextAttempts,
            next_attempt_at: computeNextAttemptAt(nextAttempts),
            last_error: errMsg.slice(0, 500),
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id)
        result.rescheduled += 1
      }
    } finally {
      if (lease) {
        await lease.release()
      }
    }
  }

  return result
}
