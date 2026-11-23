import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for the `contact_id` send path (issue #296): sending an approved
// template to a single contact from the Contact detail view. The route must
// find-or-create the contact's conversation server-side, then run the normal
// send + persistence path — no inbound message required to bootstrap a thread.
// ---------------------------------------------------------------------------

// Records of what the route wrote, so we can assert the right rows landed.
const conversationInserts: Array<Record<string, unknown>> = []
const messageInserts: Array<Record<string, unknown>> = []
const propertyShareInserts: Array<Record<string, unknown>> = []
const matchStatusUpdates: Array<Record<string, unknown>> = []

// Toggles for the per-test scenario.
let existingConversation: Record<string, unknown> | null = null
let contactRow: Record<string, unknown> | null = null
let callerRole: string = 'admin'
let createdConversation: Record<string, unknown> | null = null
let latestCustomerMessage: Record<string, unknown> | null = {
  id: 'cust-msg-1',
  sender_type: 'customer',
  created_at: new Date().toISOString(),
}
let templateRowMock: Record<string, unknown> | null = null

const CONTACT = {
  id: 'contact-1',
  account_id: 'acct-1',
  phone: '+15551234567',
}

// Chainable Supabase mock. A fresh builder per `.from()` call tracks whether
// `.insert()` ran so the terminal resolves to the inserted row for creates
// and the canned select row otherwise.
function makeSupabaseMock() {
  function builder(table: string) {
    let didInsert = false

    const selectResult = () => {
      switch (table) {
        case 'profiles':
          return {
            data: { account_id: 'acct-1', account_role: callerRole },
            error: null,
          }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'Acme' }, error: null }
        case 'contacts':
          return { data: contactRow, error: null }
        case 'conversations':
          // Once created this request, a by-id reload returns it (with
          // its contact); otherwise fall back to the canned existing row.
          return { data: createdConversation ?? existingConversation, error: null }
        case 'whatsapp_config':
          return {
            data: {
              id: 'cfg-1',
              account_id: 'acct-1',
              phone_number_id: 'PNID-1',
              access_token: 'enc-token',
            },
            error: null,
          }
        case 'message_templates':
          return { data: templateRowMock, error: null }
        case 'messages':
          return { data: latestCustomerMessage, error: null }
        case 'lead_property_matches':
          return { data: { id: 'match-1', match_score: 94, score_breakdown: {} }, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const insertResult = () => {
      switch (table) {
        case 'conversations':
          return {
            data: {
              id: 'conv-new',
              account_id: 'acct-1',
              contact_id: 'contact-1',
              contact: CONTACT,
            },
            error: null,
          }
        case 'messages':
          return { data: { id: 'msg-1' }, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const terminal = () =>
      Promise.resolve(didInsert ? insertResult() : selectResult())

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'delete']) {
      b[m] = vi.fn(chain)
    }
    b.update = vi.fn((payload: Record<string, unknown>) => {
      if (table === 'lead_property_matches') {
        matchStatusUpdates.push(payload)
      }
      return b
    })
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true
      if (table === 'conversations') {
        conversationInserts.push(payload)
        createdConversation = {
          id: 'conv-new',
          account_id: 'acct-1',
          contact_id: 'contact-1',
          contact: CONTACT,
        }
      }
      if (table === 'messages') messageInserts.push(payload)
      if (table === 'property_shares') propertyShareInserts.push(payload)
      return b
    })
    b.single = vi.fn(terminal)
    b.maybeSingle = vi.fn(terminal)
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(didInsert ? insertResult() : selectResult())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['update', 'eq', 'select']) b[m] = vi.fn(chain)
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null })
      return b
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}))

const { sendTemplateMessage, sendTextMessage } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid-text-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()
  return {
    ...actual,
    sendTemplateMessage,
    sendTextMessage,
    sendMediaMessage: vi.fn(),
  }
})

import { POST } from './route'

function postContactTemplate(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: 'contact-1',
        message_type: 'template',
        template_name: 'order_update',
        template_language: 'en_US',
        template_message_params: { body: ['Acme', '#1234'] },
        template_params: ['Acme', '#1234'],
        ...overrides,
      }),
    }),
  )
}

describe('POST /api/whatsapp/send — contact_id template path', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    existingConversation = null
    createdConversation = null
    contactRow = CONTACT
    callerRole = 'admin'
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a conversation for a contact with none, then sends the template', async () => {
    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.whatsapp_message_id).toBe('wamid-1')

    // A conversation was created for this contact.
    expect(conversationInserts).toHaveLength(1)
    expect(conversationInserts[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
    })

    // The template was sent to the contact's number.
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    const args = (sendTemplateMessage.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    // Meta wants the bare E.164 digits — sanitizePhoneForMeta strips the '+'.
    expect(args.to).toBe('15551234567')
    expect(args.templateName).toBe('order_update')

    // The outbound message was persisted under the new conversation.
    expect(messageInserts).toHaveLength(1)
    expect(messageInserts[0]).toMatchObject({
      conversation_id: 'conv-new',
      content_type: 'template',
      template_name: 'order_update',
      sender_type: 'agent',
    })
  })

  it('reuses an existing conversation instead of creating a duplicate', async () => {
    existingConversation = {
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }

    const res = await postContactTemplate()
    expect(res.status).toBe(200)

    expect(conversationInserts).toHaveLength(0)
    expect(messageInserts[0]).toMatchObject({ conversation_id: 'conv-existing' })
  })

  it('404s when the contact is not in the caller account', async () => {
    contactRow = null

    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('400s when neither conversation_id nor contact_id is provided', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_type: 'template', template_name: 'x' }),
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/whatsapp/send — role enforcement', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    existingConversation = {
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }
    createdConversation = null
    contactRow = CONTACT
    callerRole = 'admin'
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('refuses a viewer with 403 and never reaches Meta', async () => {
    // A viewer is read-only (`canSendMessages`). The route used to resolve
    // account_id straight off the profile with no role check: RLS blocked
    // the message INSERT, but the send core calls Meta first, so the
    // customer still received a real WhatsApp message that RLS could not
    // un-send. The gate has to come before any outbound call.
    callerRole = 'viewer'

    const res = await postContactTemplate()

    expect(res.status).toBe(403)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(messageInserts).toHaveLength(0)
  })

  it('allows an agent through', async () => {
    callerRole = 'agent'

    const res = await postContactTemplate()

    expect(res.status).toBe(200)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/whatsapp/send — match_share_context confirmation', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    propertyShareInserts.length = 0
    matchStatusUpdates.length = 0
    existingConversation = {
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }
    createdConversation = null
    contactRow = CONTACT
    callerRole = 'agent'
    latestCustomerMessage = {
      id: 'cust-msg-1',
      sender_type: 'customer',
      created_at: new Date().toISOString(),
    }
    templateRowMock = null
    supabaseMock = makeSupabaseMock()
    sendTextMessage.mockReset()
    sendTextMessage.mockResolvedValue({ messageId: 'wamid-text-1' })
    sendTemplateMessage.mockReset()
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid-tpl-1' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('records property_shares and marks match enviado ONLY after successful Meta send', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: 'conv-existing',
          message_type: 'text',
          content_text: 'Oi! Veja este imóvel: https://ronaldomeira.com.br/imovel/bessa-1',
          match_share_context: {
            match_id: 'match-1',
            lead_id: 'contact-1',
            property_id: '00000000-0000-0000-0000-000000000101',
          },
        }),
      }),
    )

    expect(res.status).toBe(200)
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
    expect(propertyShareInserts).toHaveLength(1)
    expect(propertyShareInserts[0]).toMatchObject({
      account_id: 'acct-1',
      lead_id: 'contact-1',
      match_id: 'match-1',
      channel: 'whatsapp_inbox',
    })
    expect(matchStatusUpdates.some((u) => u.match_status === 'enviado')).toBe(true)
  })

  it('does not record share or mark enviado when Meta delivery fails', async () => {
    sendTextMessage.mockRejectedValueOnce(new Error('Meta API timeout'))

    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: 'conv-existing',
          message_type: 'text',
          content_text: 'Tentativa com falha',
          match_share_context: {
            match_id: 'match-1',
            lead_id: 'contact-1',
            property_id: '00000000-0000-0000-0000-000000000101',
          },
        }),
      }),
    )

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(propertyShareInserts).toHaveLength(0)
    expect(matchStatusUpdates).toHaveLength(0)
  })

  it('rejects free-text send with 409 when 24h customer window is closed (expired between prep and send or direct API bypass attempt)', async () => {
    latestCustomerMessage = {
      id: 'cust-msg-old',
      sender_type: 'customer',
      created_at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    }

    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: 'conv-existing',
          message_type: 'text',
          content_text: 'Texto livre fora da janela de 24h',
          match_share_context: {
            match_id: 'match-1',
            lead_id: 'contact-1',
            property_id: '00000000-0000-0000-0000-000000000101',
          },
        }),
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toMatch(/janela de atendimento de 24 horas/i)
    expect(sendTextMessage).not.toHaveBeenCalled()
    expect(propertyShareInserts).toHaveLength(0)
    expect(matchStatusUpdates).toHaveLength(0)
  })

  it('allows approved template outside 24h window and records property_shares + marks match enviado after Meta confirms', async () => {
    latestCustomerMessage = {
      id: 'cust-msg-old',
      sender_type: 'customer',
      created_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    }
    templateRowMock = {
      id: 'tpl-1',
      user_id: 'user-1',
      account_id: 'acct-1',
      name: 'oportunidade_alinhada',
      language: 'pt_BR',
      category: 'MARKETING',
      status: 'APPROVED',
      header_type: null,
      header_content: null,
      body_text: 'Oi, {{1}}! Tudo certo? Apareceu algo bem alinhado com {{2}}. Me chama aqui.',
      footer_text: null,
      buttons: [],
      created_at: '2026-01-01T00:00:00Z',
    }

    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: 'conv-existing',
          message_type: 'template',
          template_name: 'oportunidade_alinhada',
          template_language: 'pt_BR',
          template_message_params: {
            body: ['Ana', 'o que você procura no Bessa (apartamento)'],
          },
          template_params: ['Ana', 'o que você procura no Bessa (apartamento)'],
          content_text:
            'Oi, Ana! Tudo certo? Apareceu algo bem alinhado com o que você procura no Bessa (apartamento). Me chama aqui.',
          match_share_context: {
            match_id: 'match-1',
            lead_id: 'contact-1',
            property_id: '00000000-0000-0000-0000-000000000101',
          },
        }),
      }),
    )

    expect(res.status).toBe(200)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(propertyShareInserts).toHaveLength(1)
    expect(matchStatusUpdates.some((u) => u.match_status === 'enviado')).toBe(true)
  })

  it('rejects unapproved (REJECTED / PAUSED) template with 422 and never calls Meta', async () => {
    templateRowMock = {
      id: 'tpl-rejected',
      user_id: 'user-1',
      account_id: 'acct-1',
      name: 'oportunidade_rejeitada',
      language: 'pt_BR',
      category: 'MARKETING',
      status: 'REJECTED',
      header_type: null,
      header_content: null,
      body_text: 'Oi {{1}}, veja {{2}}',
      footer_text: null,
      buttons: [],
      created_at: '2026-01-01T00:00:00Z',
    }

    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: 'conv-existing',
          message_type: 'template',
          template_name: 'oportunidade_rejeitada',
          template_language: 'pt_BR',
          template_message_params: { body: ['Ana', 'apartamento no Bessa'] },
          template_params: ['Ana', 'apartamento no Bessa'],
        }),
      }),
    )
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.error).toMatch(/não está aprovado/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
})
