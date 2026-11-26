import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchInboundToLeadAnalysis } from '@/lib/ai/lead-analysis'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { sendPushToAccount } from '@/lib/push/send'
import { ensureDealForNewLead } from '@/lib/pipelines/auto-deal'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'
import { captureCtwaReferral, type CtwaReferral } from '@/lib/whatsapp/ctwa-referral'
import { generateDocumentPreview, looksLikePdf } from '@/lib/documents/generate-document-preview'
import { transcribeInboundAudioMessage } from '@/lib/ai/transcribe-audio'
import { logError } from '@/lib/observability/log'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
  /**
   * Present on the message that opened a conversation started by tapping
   * a Click-to-WhatsApp ad (Facebook/Instagram). Identifies which ad
   * creative sent the lead — see `captureCtwaReferral` below, which
   * persists this onto `conversations.ctwa_referral` (migration 055) on
   * first touch only. All fields are optional per Meta's docs; a real
   * payload may carry only a subset.
   */
  referral?: CtwaReferral
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
        errors?: Array<{
          code?: number
          title?: string
          message?: string
          error_data?: { details?: string }
        }>
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Busca as configurações do WhatsApp no banco
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      logError('webhook.verification_config_fetch_failed', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Procura se o verify_token de algum config bate com o que a Meta
    // mandou. Tokens ficam criptografados no banco — decrypt() aqui,
    // nunca comparar a string crua.
    let matchedConfig: { id: string; verify_token: string } | null = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Token malformado / cifrado com outra chave — pula e continua.
      }
    }

    if (matchedConfig) {
      // Upgrade oportunista pra GCM se o token ainda estava no formato
      // legado CBC — fire-and-forget, é no-op se já estiver em GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      return new NextResponse(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    logError('webhook.get_failed', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
/**
 * Raised when durable persistence of an inbound webhook event fails due to a
 * transient infrastructure / database error (e.g., Supabase 402 quota lock,
 * 5xx outage, or network timeout). Returning HTTP 503 tells Meta to retry
 * delivery with exponential backoff instead of silently dropping the message.
 */
class WebhookPersistenceError extends Error {
  readonly causeError: unknown
  constructor(message: string, causeError?: unknown) {
    super(message)
    this.name = 'WebhookPersistenceError'
    this.causeError = causeError
  }
}

/**
 * Optional emergency local JSONL spool for inbound payloads when the primary
 * database is unavailable. Disabled by default; only active when the operator
 * explicitly sets `WHATSAPP_WEBHOOK_EMERGENCY_SPOOL_DIR`.
 */
async function tryWriteEmergencySpool(
  rawBody: string,
  reason: string,
): Promise<boolean> {
  const spoolDir = process.env.WHATSAPP_WEBHOOK_EMERGENCY_SPOOL_DIR?.trim()
  if (!spoolDir) return false
  try {
    await mkdir(spoolDir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    const filePath = path.join(spoolDir, `whatsapp-webhook-${day}.jsonl`)
    const line = JSON.stringify({
      received_at: new Date().toISOString(),
      reason,
      payload: rawBody,
    }) + '\n'
    await appendFile(filePath, line, { encoding: 'utf8' })
    return true
  } catch (err) {
    logError('webhook.emergency_spool_failed', err)
    return false
  }
}

interface DeferredInboundTask {
  message: WhatsAppMessage
  contact: { profile: { name: string }; wa_id: string }
  accountId: string
  configOwnerUserId: string
  accessToken: string
  contactRecord: ContactRow
  contactWasCreated: boolean
  conversation: Record<string, unknown> & { id: string; unread_count?: number | null }
  conversationCreated: boolean
  insertedMessageId: string
  contentType: string
  contentText: string | null
  interactiveReplyId: string | null
  isFirstInboundMessage: boolean
}

interface DeferredAuxiliaryEvent {
  kind: 'template' | 'status'
  field?: string
  value?: unknown
  status?: {
    id: string
    status: string
    timestamp: string
    recipient_id: string
    errors?: Array<{
      code?: number
      title?: string
      message?: string
      error_data?: { details?: string }
    }>
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Phase 1 (SYNCHRONOUS — BEFORE HTTP 200 ACK):
  // Durably persist every inbound customer message (with explicit idempotency
  // on `(conversation_id, message_id)` so Meta retries never duplicate rows or
  // Clara replies). If Supabase is unavailable (e.g., 402 exceed_egress_quota
  // or 5xx outage), return HTTP 503 so Meta retries automatically instead of
  // silently dropping the lead's message.
  let deferredInbound: DeferredInboundTask[] = []
  let deferredAuxiliary: DeferredAuxiliaryEvent[] = []
  try {
    const result = await persistWebhookDurably(body)
    deferredInbound = result.deferredInbound
    deferredAuxiliary = result.deferredAuxiliary
  } catch (error) {
    logError('webhook.durable_persistence_failed', error)
    const spooled = await tryWriteEmergencySpool(
      rawBody,
      error instanceof Error ? error.message : String(error),
    )
    if (spooled) {
      return NextResponse.json(
        { status: 'spooled_for_replay' },
        { status: 200 },
      )
    }
    return NextResponse.json(
      { error: 'Temporary persistence failure; please retry' },
      {
        status: 503,
        headers: { 'Retry-After': '60' },
      },
    )
  }

  // Phase 2 (ASYNC via `after()` — AFTER durable persistence is confirmed):
  // Run heavy / best-effort side effects (PDF preview, audio transcription,
  // Flows, automations, Clara AI auto-reply, lead analysis, outbound webhooks,
  // status & template updates) without risking Meta's ~20s ACK timeout.
  if (deferredInbound.length > 0 || deferredAuxiliary.length > 0) {
    after(async () => {
      try {
        await runDeferredWebhookTasks(deferredInbound, deferredAuxiliary)
      } catch (error) {
        logError('webhook.processing_failed', error)
      }
    })
  }

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function persistWebhookDurably(body: { entry?: WhatsAppWebhookEntry[] }): Promise<{
  deferredInbound: DeferredInboundTask[]
  deferredAuxiliary: DeferredAuxiliaryEvent[]
}> {
  const deferredInbound: DeferredInboundTask[] = []
  const deferredAuxiliary: DeferredAuxiliaryEvent[] = []
  if (!body.entry) return { deferredInbound, deferredAuxiliary }

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — defer them to Phase 2.
      if (isTemplateWebhookField(change.field)) {
        deferredAuxiliary.push({
          kind: 'template',
          field: change.field,
          value: change.value as unknown,
        })
        continue
      }

      const value = change.value

      // Defer status updates to Phase 2
      if (value.statuses) {
        for (const status of value.statuses) {
          deferredAuxiliary.push({ kind: 'status', status })
        }
      }

      // Handle incoming messages synchronously for durability
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId)

      if (configError) {
        throw new WebhookPersistenceError(
          `Failed fetching whatsapp_config for phone_number_id=${phoneNumberId}`,
          configError,
        )
      }

      if (!configRows || configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          configRows.map((r: { account_id: string; user_id: string }) => `${r.account_id} (admin ${r.user_id})`)
        )
        continue
      }

      const config = configRows[0]
      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        const deferred = await persistInboundMessage(
          message,
          contact,
          config.account_id,
          config.user_id,
          decryptedAccessToken,
        )
        if (deferred) {
          deferredInbound.push(deferred)
        }
      }
    }
  }

  return { deferredInbound, deferredAuxiliary }
}

async function runDeferredWebhookTasks(
  deferredInbound: DeferredInboundTask[],
  deferredAuxiliary: DeferredAuxiliaryEvent[],
) {
  for (const aux of deferredAuxiliary) {
    if (aux.kind === 'template' && aux.field) {
      await handleTemplateWebhookChange(
        { field: aux.field, value: aux.value },
        supabaseAdmin(),
      )
    } else if (aux.kind === 'status' && aux.status) {
      await handleStatusUpdate(aux.status)
    }
  }

  for (const task of deferredInbound) {
    await runPostPersistSideEffects(task)
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

// Monotonic transition guard for `messages.status`: prevents delayed/out-of-order
// Meta webhooks from regressing `read` -> `delivered` -> `sent`, or overwriting
// an already `delivered`/`read` message with `failed`.
const MESSAGE_STATUS_LADDER = ['sending', 'pending', 'sent', 'delivered', 'read'] as const

function isValidMessageStatusTransition(current: string | null | undefined, incoming: string): boolean {
  if (!current) return true
  if (incoming === 'failed') {
    return current === 'sending' || current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false
  }
  const ci = (MESSAGE_STATUS_LADDER as readonly string[]).indexOf(current)
  const ii = (MESSAGE_STATUS_LADDER as readonly string[]).indexOf(incoming)
  if (ii < 0) return false
  if (ci < 0) return true
  return ii > ci
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
  errors?: Array<{
    code?: number
    title?: string
    message?: string
    error_data?: { details?: string }
  }>
}) {
  if (status.status === 'failed' || (status.errors && status.errors.length > 0)) {
    const firstErr = status.errors?.[0]
    logError(
      'webhook.message_status_failed',
      new Error(
        firstErr
          ? `Meta status failed (${firstErr.code ?? 'unknown'}): ${firstErr.title ?? firstErr.message ?? 'unknown'} ${firstErr.error_data?.details ?? ''}`.trim()
          : 'Meta status failed without error payload'
      ),
      {
        whatsappMessageId: status.id,
        status: status.status,
        errorCode: firstErr?.code,
        errorTitle: firstErr?.title,
      }
    )
  }

  // 1) Mirror onto messages with monotonic transition ordering — `message_id`
  //    is not unique across numbers, so query matching rows and only update
  //    those whose current status advances forward.
  const { data: msgRows, error: msgFetchErr } = await supabaseAdmin()
    .from('messages')
    .select('id, status')
    .eq('message_id', status.id)

  if (msgFetchErr) {
    logError('webhook.status_fetch_failed', msgFetchErr)
  } else if (msgRows && msgRows.length > 0) {
    const typedRows = msgRows as Array<{ id: string; status: string | null }>
    const eligibleIds = typedRows
      .filter((row) => isValidMessageStatusTransition(row.status, status.status))
      .map((row) => row.id)

    if (eligibleIds.length > 0) {
      const { error: msgErr } = await supabaseAdmin()
        .from('messages')
        .update({ status: status.status })
        .in('id', eligibleIds)

      if (msgErr) {
        logError('webhook.status_update_failed', msgErr)
      }
    }
  }

  // Webhook fan-out for this status change happens at the END of this
  // handler (after the broadcast mirror below), so a slow subscriber
  // endpoint can't delay the broadcast_recipients update.

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends).
  //    Runs last so a slow subscriber can't delay the mirrors above.
  //    Bounded to one row (message_id isn't unique) purely to resolve
  //    the owning account for delivery.
  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.id)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(
        supabaseAdmin(),
        accountId,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: msgRow.conversation_id,
          status: status.status,
        }
      )
    }
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

/**
 * Follow-up Inteligente: cancels the contact's active plan (if any)
 * and its still-pending scheduled sends. Never throws — a lookup or
 * update failure here must not block inbound message processing.
 */
async function cancelActiveFollowupPlan(accountId: string, contactId: string) {
  try {
    const admin = supabaseAdmin()
    const { data: activePlan, error: planError } = await admin
      .from('followup_plans')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'active')
      .maybeSingle()
    if (planError) {
      console.error('[webhook] cancelActiveFollowupPlan: fetch failed:', planError.message)
      return
    }
    if (!activePlan) return

    await admin.from('followup_plans').update({ status: 'cancelled' }).eq('id', activePlan.id)
    await admin
      .from('scheduled_sends')
      .update({ status: 'cancelled' })
      .eq('followup_plan_id', activePlan.id)
      .eq('status', 'pending')
  } catch (err) {
    console.error('[webhook] cancelActiveFollowupPlan: unexpected error:', err)
  }
}

/**
 * Phase 1 (SYNCHRONOUS — runs before returning HTTP 200 to Meta):
 * Durably persists contact, conversation, and inbound message (with explicit
 * idempotency on `(conversation_id, message_id)` so Meta retries never create
 * duplicate rows or duplicate Clara AI replies). Throws `WebhookPersistenceError`
 * on any transient DB/infrastructure failure so POST returns HTTP 503.
 */
async function persistInboundMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  accountId: string,
  configOwnerUserId: string,
  accessToken: string,
): Promise<DeferredInboundTask | null> {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  // Find or create contact (throws WebhookPersistenceError on DB outage)
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName,
  )
  const contactRecord = contactOutcome.contact

  // Blocked contact ("Bloquear lead" in the Inbox, migration 083) —
  // recognized before any normal processing: no conversation is
  // opened/reopened, no message is stored, no follow-up plan is
  // touched, no automation/Flow/AI dispatch runs below.
  if (contactRecord.blocked_at) {
    console.log(`[webhook] Ignoring message from blocked contact ${contactRecord.id}`)
    return null
  }

  // Find or create conversation (throws WebhookPersistenceError on DB outage)
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
  )
  const conversation = convResult.conversation

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    if (convResult.created) {
      await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
        conversation_id: conversation.id,
        contact_id: contactRecord.id,
      })
      await ensureDealForNewLead({
        db: supabaseAdmin(),
        accountId,
        userId: configOwnerUserId,
        contactId: contactRecord.id,
        contactName: contactRecord.name || contactName || senderPhone,
        conversationId: conversation.id,
      })
    }
    return null
  }

  // Explicit idempotency guard: `idx_messages_message_id` is non-unique in the
  // schema, so check if this Meta `wamid` was already persisted in this
  // conversation before inserting. Prevents duplicate rows and duplicate Clara
  // replies whenever Meta retries a batch or individual delivery.
  if (message.id) {
    const { data: existingRows, error: dedupeError } = await supabaseAdmin()
      .from('messages')
      .select('id')
      .eq('conversation_id', conversation.id)
      .eq('message_id', message.id)
      .limit(1)

    if (dedupeError) {
      throw new WebhookPersistenceError(
        `Failed idempotency check for message_id=${message.id}`,
        dedupeError,
      )
    }

    if (Array.isArray(existingRows) && existingRows.length > 0) {
      console.log(
        `[webhook] Duplicate message_id=${message.id} already persisted in conversation=${conversation.id}; skipping`,
      )
      return null
    }
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken)

  // Resolve swipe-reply context if present (best-effort)
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id,
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id,
      )
    }
  }

  void mediaType

  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'   // stickers are images
      : 'text'    // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { data: insertedMessage, error: msgError } = await supabaseAdmin()
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: contentType,
      content_text: contentText,
      media_url: mediaUrl,
      message_id: message.id,
      status: 'delivered',
      created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
      reply_to_message_id: replyToInternalId,
      interactive_reply_id: interactiveReplyId,
    })
    .select('id')
    .single()

  if (msgError || !insertedMessage?.id) {
    if (msgError && isUniqueViolation(msgError)) {
      console.log(`[webhook] Concurrent duplicate message_id=${message.id}; skipping`)
      return null
    }
    logError('webhook.insert_message_failed', msgError)
    throw new WebhookPersistenceError(
      `Failed inserting message_id=${message.id}`,
      msgError,
    )
  }

  // Update conversation preview/unread counter (best-effort once message is durable)
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    logError('webhook.conversation_update_failed', convError)
  }

  return {
    message,
    contact,
    accountId,
    configOwnerUserId,
    accessToken,
    contactRecord,
    contactWasCreated: contactOutcome.wasCreated,
    conversation,
    conversationCreated: convResult.created,
    insertedMessageId: insertedMessage.id,
    contentType,
    contentText,
    interactiveReplyId,
    isFirstInboundMessage,
  }
}

/**
 * Phase 2 (ASYNC via `after()` — runs AFTER durable persistence & HTTP 200 ACK):
 * Executes all best-effort side effects: follow-up cancellation, CTWA attribution,
 * new-conversation deal creation, PDF preview, audio transcription, push,
 * broadcast reply flag, Flows, automations, Clara AI auto-reply, lead analysis,
 * and outbound `message.received` webhooks.
 */
async function runPostPersistSideEffects(task: DeferredInboundTask) {
  const {
    message,
    contact,
    accountId,
    configOwnerUserId,
    accessToken,
    contactRecord,
    contactWasCreated,
    conversation,
    conversationCreated,
    insertedMessageId,
    contentType,
    contentText,
    interactiveReplyId,
    isFirstInboundMessage,
  } = task

  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  // Follow-up Inteligente: cancel active plan on customer reply
  await cancelActiveFollowupPlan(accountId, contactRecord.id)

  // Click-to-WhatsApp Ads (CTWA): first-touch attribution
  if (message.referral) {
    await captureCtwaReferral(supabaseAdmin(), conversation, message.referral)
  }

  if (conversationCreated) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
    await ensureDealForNewLead({
      db: supabaseAdmin(),
      accountId,
      userId: configOwnerUserId,
      contactId: contactRecord.id,
      contactName: contactRecord.name || contactName || senderPhone,
      conversationId: conversation.id,
    })
  }

  // WhatsApp-style PDF preview (thumbnail + page count + size)
  if (
    contentType === 'document' &&
    message.document?.id &&
    looksLikePdf(message.document.mime_type ?? null, message.document.filename ?? null)
  ) {
    try {
      const mediaInfo = await getMediaUrl({ mediaId: message.document!.id, accessToken })
      const { buffer } = await downloadMedia({ downloadUrl: mediaInfo.url, accessToken })
      await generateDocumentPreview({
        messageId: insertedMessageId,
        accountId,
        pdfBuffer: buffer,
      })
    } catch (err) {
      logError('webhook.document_preview_failed', err)
    }
  }

  // Voice-note transcription — customer audio only
  let audioTranscript: string | null = null
  if (contentType === 'audio' && message.audio?.id) {
    try {
      const mediaInfo = await getMediaUrl({ mediaId: message.audio.id, accessToken })
      const { buffer } = await downloadMedia({ downloadUrl: mediaInfo.url, accessToken })
      audioTranscript = await transcribeInboundAudioMessage(
        supabaseAdmin(),
        accountId,
        insertedMessageId,
        buffer,
      )
    } catch (err) {
      logError('webhook.audio_transcription_failed', err)
    }
  }

  // Mobile push notification (fire-and-forget)
  void sendPushToAccount(accountId, {
    title: contactName || senderPhone,
    body: contentText || `[${message.type}]`,
    url: `/inbox?conversation=${conversation.id}`,
    tag: `wacrm-conversation-${conversation.id}`,
  })

  // Broadcast reply tracking
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // Flow runner dispatch
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text?.body ?? '',
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactWasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => logError('webhook.automation_dispatch_failed', err))
  }

  // AI auto-reply (Clara)
  if (!flowConsumed && !interactiveReplyId && (inboundText.trim() || audioTranscript?.trim())) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
      inboundMessageId: insertedMessageId,
    })
  }

  // Lead intelligence (tags + pipeline-stage proposal)
  if (!interactiveReplyId && (inboundText.trim() || audioTranscript)) {
    await dispatchInboundToLeadAnalysis({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
    })
  }

  // message.received webhook (public API)
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  const verifyAndBuildUrl = async (
    mediaId: string
  ): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set.
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    // Update name if it changed (best-effort)
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    logError('webhook.create_contact_failed', createError)
    throw new WebhookPersistenceError('Failed creating contact', createError)
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
): Promise<{ conversation: Record<string, unknown> & { id: string; unread_count?: number | null }; created: boolean }> {
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    logError('webhook.find_conversation_failed', findError)
    throw new WebhookPersistenceError('Failed finding conversation', findError)
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    logError('webhook.create_conversation_failed', createError)
    throw new WebhookPersistenceError('Failed creating conversation', createError)
  }

  return { conversation: newConv, created: true }
}
