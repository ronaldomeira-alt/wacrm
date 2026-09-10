import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  toErrorResponse: vi.fn((err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 }),
  ),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: mocks.toErrorResponse,
}))

import { POST } from './route'

describe('POST /api/ai/properties/[id]/ads/validate', () => {
  const mockAccountId = 'acc-123'
  const mockPropertyId = 'prop-456'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects empty ad_source_id with 400', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: {},
      accountId: mockAccountId,
      user: { id: 'user-1' },
      role: 'agent',
    })

    const req = new Request('http://localhost/api/ai/properties/prop-456/ads/validate', {
      method: 'POST',
      body: JSON.stringify({ ad_source_id: '   ' }),
    })

    const res = await POST(req, { params: Promise.resolve({ id: mockPropertyId }) })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.valid).toBe(false)
    expect(json.message).toContain('obrigatório')
  })

  it('returns valid: false for non-numeric or too short ad IDs', async () => {
    mocks.requireRole.mockResolvedValue({
      supabase: {},
      accountId: mockAccountId,
      user: { id: 'user-1' },
      role: 'agent',
    })

    const req = new Request('http://localhost/api/ai/properties/prop-456/ads/validate', {
      method: 'POST',
      body: JSON.stringify({ ad_source_id: 'abc-invalid-123' }),
    })

    const res = await POST(req, { params: Promise.resolve({ id: mockPropertyId }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.valid).toBe(false)
    expect(json.status).toBe('invalid_format')
    expect(json.message).toContain('apenas números')
  })

  it('validates a valid numeric Meta Ad ID format and checks conflicts', async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'property_ad_mappings') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'map-1',
                property_id: 'other-prop-789',
                properties: { id: 'other-prop-789', name: 'Reserva Altiplano' },
              },
            }),
          }
        }
        if (table === 'whatsapp_config') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
          }
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            filter: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
          }
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        }
      }),
    }

    mocks.requireRole.mockResolvedValue({
      supabase: mockSupabase,
      accountId: mockAccountId,
      user: { id: 'user-1' },
      role: 'agent',
    })

    const req = new Request('http://localhost/api/ai/properties/prop-456/ads/validate', {
      method: 'POST',
      body: JSON.stringify({ ad_source_id: '120250622441180493', ad_name: 'Campanha Teste' }),
    })

    const res = await POST(req, { params: Promise.resolve({ id: mockPropertyId }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.valid).toBe(true)
    expect(json.ad_source_id).toBe('120250622441180493')
    expect(json.warning).toContain('Reserva Altiplano')
  })

  it('matches inbound lead history in local DB if lead already arrived with that ad ID', async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'property_ad_mappings') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
          }
        }
        if (table === 'whatsapp_config') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
          }
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            filter: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'conv-123',
                  ctwa_referral: {
                    headline: 'wa.me - Live Park',
                    body: 'Studios a 1 quadra da praia',
                    image_url: 'https://fbcdn.net/ad.jpg',
                  },
                },
              ],
            }),
          }
        }
        return {}
      }),
    }

    mocks.requireRole.mockResolvedValue({
      supabase: mockSupabase,
      accountId: mockAccountId,
      user: { id: 'user-1' },
      role: 'agent',
    })

    const req = new Request('http://localhost/api/ai/properties/prop-456/ads/validate', {
      method: 'POST',
      body: JSON.stringify({ ad_source_id: '120250622441180493' }),
    })

    const res = await POST(req, { params: Promise.resolve({ id: mockPropertyId }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.valid).toBe(true)
    expect(json.confirmed).toBe(true)
    expect(json.source).toBe('inbound_leads')
    expect(json.referral_headline).toBe('wa.me - Live Park')
    expect(json.referral_body).toBe('Studios a 1 quadra da praia')
  })
})
