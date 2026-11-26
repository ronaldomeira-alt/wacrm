import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pendingAfter: [] as Promise<unknown>[],
  dispatchInboundToAiReply: vi.fn(async () => {}),
  dispatchInboundToLeadAnalysis: vi.fn(async () => {}),
  transcribeInboundAudioMessage: vi.fn<() => Promise<string | null>>(async () => null),
  getMediaUrl: vi.fn(async () => ({ url: 'https://lookaside.fbsbx.com/audio/123', mime_type: 'audio/ogg' })),
  downloadMedia: vi.fn(async () => ({ buffer: Buffer.from('fake-ogg'), mimeType: 'audio/ogg' })),
}))

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return {
    ...actual,
    after: (cb: () => unknown) => {
      h.pendingAfter.push(Promise.resolve().then(() => cb()))
    },
  }
})

vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (value: string) => value,
  encrypt: (value: string) => value,
  isLegacyFormat: () => false,
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: h.getMediaUrl,
  downloadMedia: h.downloadMedia,
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    account_id: 'acct-1',
    phone: '+5583999998888',
    name: 'Lead Áudio',
    blocked_at: null,
  })),
  isUniqueViolation: () => false,
}))

vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async () => {}),
}))

vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))

vi.mock('@/lib/ai/lead-analysis', () => ({
  dispatchInboundToLeadAnalysis: h.dispatchInboundToLeadAnalysis,
}))

vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn(async () => {}),
}))

vi.mock('@/lib/push/send', () => ({
  sendPushToAccount: vi.fn(async () => {}),
}))

vi.mock('@/lib/pipelines/auto-deal', () => ({
  ensureDealForNewLead: vi.fn(async () => {}),
}))

vi.mock('@/lib/whatsapp/ctwa-referral', () => ({
  captureCtwaReferral: vi.fn(async () => {}),
}))

vi.mock('@/lib/documents/generate-document-preview', () => ({
  generateDocumentPreview: vi.fn(async () => {}),
  looksLikePdf: () => false,
}))

vi.mock('@/lib/ai/transcribe-audio', () => ({
  transcribeInboundAudioMessage: h.transcribeInboundAudioMessage,
}))

vi.mock('@/lib/observability/log', () => ({
  logError: vi.fn(),
}))

function createSupabaseAdminMock() {
  return {
    from: (table: string) => {
      let mode: 'select' | 'insert' | 'update' = 'select'
      let headCount = false

      const resolveQuery = () => {
        if (table === 'whatsapp_config' && mode === 'select') {
          return {
            data: [
              {
                id: 'cfg-1',
                account_id: 'acct-1',
                user_id: 'user-1',
                phone_number_id: 'PNID-1',
                access_token: 'token-plain',
              },
            ],
            error: null,
          }
        }
        if (table === 'conversations' && mode === 'select') {
          return {
            data: [{ id: 'conv-1', account_id: 'acct-1', contact_id: 'contact-1' }],
            error: null,
          }
        }
        if (table === 'messages' && mode === 'select' && headCount) {
          return { count: 1, error: null }
        }
        if (table === 'messages' && mode === 'insert') {
          return { data: { id: 'msg-audio-1' }, error: null }
        }
        return { data: null, error: null }
      }

      const chain: Record<string, unknown> = {
        select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) headCount = true
          return chain
        },
        insert: () => {
          mode = 'insert'
          return chain
        },
        update: () => {
          mode = 'update'
          return chain
        },
        upsert: () => chain,
        delete: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve(resolveQuery()),
        maybeSingle: () =>
          Promise.resolve(
            table === 'followup_plans' ? { data: null, error: null } : resolveQuery(),
          ),
        then: (
          onFulfilled?: (v: unknown) => unknown,
          onRejected?: (r: unknown) => unknown,
        ) => Promise.resolve(resolveQuery()).then(onFulfilled, onRejected),
      }
      return chain
    },
  }
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => createSupabaseAdminMock(),
}))

import { POST } from './route'

function makeAudioWebhookRequest() {
  const payload = {
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '5583988100000',
                phone_number_id: 'PNID-1',
              },
              contacts: [
                {
                  profile: { name: 'Lead Áudio' },
                  wa_id: '5583999998888',
                },
              ],
              messages: [
                {
                  id: 'wamid.audio.1',
                  from: '5583999998888',
                  timestamp: '1763218800',
                  type: 'audio',
                  audio: { id: 'media-audio-1', mime_type: 'audio/ogg; codecs=opus' },
                },
              ],
            },
          },
        ],
      },
    ],
  }

  return new Request('https://example.test/api/whatsapp/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=mock',
    },
    body: JSON.stringify(payload),
  })
}

describe('WhatsApp webhook inbound audio auto-reply gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.pendingAfter = []
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  })

  it('dispatches AI auto-reply when an audio message has a non-empty transcription', async () => {
    h.transcribeInboundAudioMessage.mockResolvedValueOnce(
      'Olá Clara, qual o valor do flat em Intermares?',
    )

    const res = await POST(makeAudioWebhookRequest())
    expect(res.status).toBe(200)
    await Promise.all(h.pendingAfter)

    expect(h.dispatchInboundToAiReply).toHaveBeenCalledTimes(1)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      configOwnerUserId: 'user-1',
      inboundMessageId: 'msg-audio-1',
    })
  })

  it('does NOT dispatch AI auto-reply when audio transcription returns whitespace', async () => {
    h.transcribeInboundAudioMessage.mockResolvedValueOnce('   ')

    const res = await POST(makeAudioWebhookRequest())
    expect(res.status).toBe(200)
    await Promise.all(h.pendingAfter)

    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('does NOT dispatch AI auto-reply or lead analysis when audio transcription returns null', async () => {
    h.transcribeInboundAudioMessage.mockResolvedValueOnce(null)

    const res = await POST(makeAudioWebhookRequest())
    expect(res.status).toBe(200)
    await Promise.all(h.pendingAfter)

    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.dispatchInboundToLeadAnalysis).not.toHaveBeenCalled()
  })

  it('logs Meta status.errors details when an outbound message fails asynchronously via webhook', async () => {
    const { logError } = await import('@/lib/observability/log')
    const payload = {
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '5583988100000', phone_number_id: 'PNID-1' },
                statuses: [
                  {
                    id: 'wamid.failed.audio.1',
                    status: 'failed',
                    timestamp: '1763218805',
                    recipient_id: '5583999998888',
                    errors: [
                      {
                        code: 131053,
                        title: 'Media upload error',
                        error_data: { details: 'Unsupported audio MIME/container' },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const res = await POST(
      new Request('https://example.test/api/whatsapp/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=mock',
        },
        body: JSON.stringify(payload),
      }),
    )
    expect(res.status).toBe(200)
    await Promise.all(h.pendingAfter)

    expect(logError).toHaveBeenCalledWith(
      'webhook.message_status_failed',
      expect.any(Error),
      expect.objectContaining({
        whatsappMessageId: 'wamid.failed.audio.1',
        status: 'failed',
        errorCode: 131053,
        errorTitle: 'Media upload error',
      }),
    )
  })
})
