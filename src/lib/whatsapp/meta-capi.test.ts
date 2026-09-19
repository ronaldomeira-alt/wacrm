import { afterEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from './encryption'
import { sendQualifiedLeadEvent } from './meta-capi'

const ACCOUNT_ID = 'account-1'
const CONVERSATION_ID = 'conversation-1'
const TOKEN = 'fake-system-user-token'
const DATASET_ID = '1121286078371356'
const WABA_ID = '1849275579374951'
const CLID = 'AbCdEf123'

interface FakeDbOptions {
  ctwaReferral?: { ctwa_clid?: string } | null
  whatsappConfig?: { access_token: string | null; waba_id: string | null; meta_capi_dataset_id: string | null } | null
}

function fakeDb(opts: FakeDbOptions) {
  return {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: opts.ctwaReferral !== undefined ? { ctwa_referral: opts.ctwaReferral } : null, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: opts.whatsappConfig ?? null, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table in test: ${table}`)
    },
  }
}

describe('sendQualifiedLeadEvent', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('returns no_ctwa_clid when the conversation has no CTWA referral', async () => {
    const db = fakeDb({ ctwaReferral: null })
    const result = await sendQualifiedLeadEvent(db as never, ACCOUNT_ID, CONVERSATION_ID)
    expect(result).toEqual({ sent: false, reason: 'no_ctwa_clid' })
  })

  it('returns capi_not_configured when the account has no dataset set up', async () => {
    const db = fakeDb({
      ctwaReferral: { ctwa_clid: CLID },
      whatsappConfig: { access_token: encrypt(TOKEN), waba_id: WABA_ID, meta_capi_dataset_id: null },
    })
    const result = await sendQualifiedLeadEvent(db as never, ACCOUNT_ID, CONVERSATION_ID)
    expect(result).toEqual({ sent: false, reason: 'capi_not_configured' })
  })

  it('posts the QualifiedLead event to the right dataset with the decrypted token and ctwa_clid', async () => {
    const db = fakeDb({
      ctwaReferral: { ctwa_clid: CLID },
      whatsappConfig: { access_token: encrypt(TOKEN), waba_id: WABA_ID, meta_capi_dataset_id: DATASET_ID },
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1 }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await sendQualifiedLeadEvent(db as never, ACCOUNT_ID, CONVERSATION_ID)

    expect(result).toEqual({ sent: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://graph.facebook.com/v21.0/${DATASET_ID}/events?access_token=${TOKEN}`)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.data[0]).toMatchObject({
      event_name: 'QualifiedLead',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: WABA_ID, ctwa_clid: CLID },
    })
    expect(typeof body.data[0].event_time).toBe('number')
  })

  it('returns graph_api_error when Meta rejects the event', async () => {
    const db = fakeDb({
      ctwaReferral: { ctwa_clid: CLID },
      whatsappConfig: { access_token: encrypt(TOKEN), waba_id: WABA_ID, meta_capi_dataset_id: DATASET_ID },
    })
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid OAuth access token' } }),
    }) as unknown as typeof fetch

    const result = await sendQualifiedLeadEvent(db as never, ACCOUNT_ID, CONVERSATION_ID)
    expect(result).toEqual({ sent: false, reason: 'graph_api_error', detail: 'Invalid OAuth access token' })
  })
})
