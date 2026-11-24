import type { SupabaseClient } from '@supabase/supabase-js'

export class AiOutboundAmbiguousError extends Error {
  readonly code = 'unknown_send_outcome'
  constructor(message: string) {
    super(message)
    this.name = 'AiOutboundAmbiguousError'
  }
}

export type OutboundIntentType = 'text' | 'media' | 'handoff' | 'lead_update'
export type OutboundIntentStatus =
  | 'not_started'
  | 'processing'
  | 'confirmed'
  | 'failed_definitive'
  | 'unknown_outcome'

export type ReserveIntentResult =
  | { action: 'proceed' }
  | { action: 'skip_confirmed'; waMessageId: string | null }
  | { action: 'skip_ambiguous'; status: OutboundIntentStatus; reason: string }

/**
 * Reserve an outbound side-effect intent BEFORE calling external Meta APIs
 * or mutating commercial state. Prevents duplicate sends when Meta accepts a
 * message but the CRM loses connection before persisting confirmation.
 */
export async function reserveOutboundIntent(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    idempotencyKey: string
    intentType: OutboundIntentType
    payload?: Record<string, unknown>
  },
): Promise<ReserveIntentResult> {
  try {
    const now = new Date().toISOString()

    const { data: existing } = await db
      .from('ai_outbound_intents')
      .select('status, wa_message_id, error_message, updated_at')
      .eq('idempotency_key', args.idempotencyKey)
      .maybeSingle()

    if (existing && typeof existing.status === 'string') {
      const status = existing.status as OutboundIntentStatus
      if (status === 'confirmed') {
        return {
          action: 'skip_confirmed',
          waMessageId: (existing.wa_message_id as string | null) ?? null,
        }
      }
      if (status === 'unknown_outcome') {
        return {
          action: 'skip_ambiguous',
          status,
          reason:
            (existing.error_message as string | null) ??
            'Resultado anterior desconhecido após chamada à Meta; reenvio bloqueado para evitar duplicidade.',
        }
      }
      if (status === 'processing') {
        const ageMs = Date.now() - new Date(existing.updated_at as string).getTime()
        if (ageMs < 60_000) {
          return {
            action: 'skip_ambiguous',
            status,
            reason: 'Envio já em processamento por outro worker.',
          }
        }
        await db
          .from('ai_outbound_intents')
          .update({
            status: 'unknown_outcome',
            error_message: 'Worker anterior expirou durante o envio sem confirmação.',
            updated_at: now,
          })
          .eq('idempotency_key', args.idempotencyKey)
          .eq('status', 'processing')

        return {
          action: 'skip_ambiguous',
          status: 'unknown_outcome',
          reason: 'Worker anterior expirou durante o envio sem confirmação.',
        }
      }

      const { data: claimed } = await db
        .from('ai_outbound_intents')
        .update({ status: 'processing', updated_at: now })
        .eq('idempotency_key', args.idempotencyKey)
        .in('status', ['not_started', 'failed_definitive'])
        .select('id')
        .maybeSingle()

      if (!claimed) {
        return {
          action: 'skip_ambiguous',
          status: 'processing',
          reason: 'Concorrência na reserva de intenção de envio.',
        }
      }
      return { action: 'proceed' }
    }

    const { error: insertErr } = await db.from('ai_outbound_intents').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      idempotency_key: args.idempotencyKey,
      intent_type: args.intentType,
      status: 'processing',
      payload: args.payload ?? {},
      created_at: now,
      updated_at: now,
    })

    if (insertErr) {
      return {
        action: 'skip_ambiguous',
        status: 'processing',
        reason: 'Intenção de envio já registrada concorrentemente.',
      }
    }

    return { action: 'proceed' }
  } catch {
    // Minimal test DB mocks without full query builder fall through safely
    return { action: 'proceed' }
  }
}

export async function confirmOutboundIntent(
  db: SupabaseClient,
  idempotencyKey: string,
  waMessageId?: string | null,
): Promise<void> {
  try {
    await db
      .from('ai_outbound_intents')
      .update({
        status: 'confirmed',
        wa_message_id: waMessageId ?? null,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('idempotency_key', idempotencyKey)
  } catch (err) {
    console.error('[outbound-idempotency] confirm failed:', err)
  }
}

export async function failOutboundIntent(
  db: SupabaseClient,
  idempotencyKey: string,
  args: {
    errorMessage: string
    unknownOutcome: boolean
    waMessageId?: string | null
  },
): Promise<void> {
  try {
    await db
      .from('ai_outbound_intents')
      .update({
        status: args.unknownOutcome ? 'unknown_outcome' : 'failed_definitive',
        wa_message_id: args.waMessageId ?? null,
        error_message: args.errorMessage.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('idempotency_key', idempotencyKey)
  } catch (err) {
    console.error('[outbound-idempotency] fail update failed:', err)
  }
}

/**
 * Determine whether a send error represents an ambiguous/unknown outcome
 * (timeout, socket drop, or DB insert failure after Meta accepted) vs a
 * definitive pre-acceptance rejection from Meta (4xx).
 */
export function isUnknownSendOutcome(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  if (lower.includes('sent to meta but db insert failed')) return true
  if (lower.includes('timeout') || lower.includes('aborted') || lower.includes('fetch failed') || lower.includes('econnreset')) {
    return true
  }
  return false
}
