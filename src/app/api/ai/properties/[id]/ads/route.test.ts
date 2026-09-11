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

import { GET, POST, PATCH, DELETE } from './route'
import { encrypt } from '@/lib/whatsapp/encryption'

describe('Ads API Route: /api/ai/properties/[id]/ads', () => {
  const mockAccountId = 'acc-123'
  const mockPropertyId = 'prop-456'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GET returns mapped ads with their genuine Meta creative images (never property media)', async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'property_ad_mappings') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'map-1',
                  property_id: mockPropertyId,
                  ad_source_id: '120251178888720493',
                  ad_name: 'Avant Home - Anúncio Piscina Real',
                  creative_id: 'cr-1',
                  creative_image_url: 'https://fbcdn.net/creative-real.jpg',
                  creative_type: 'image',
                  campaign_name: 'Campanha Avant Home',
                  adset_name: 'Conjunto Altiplano',
                  created_at: '2026-09-10T12:00:00Z',
                },
                {
                  id: 'map-2',
                  property_id: mockPropertyId,
                  ad_source_id: '120251178888720494',
                  ad_name: 'Avant Home - Sem Imagem',
                  creative_id: null,
                  creative_image_url: null,
                  creative_type: 'unknown',
                  campaign_name: null,
                  adset_name: null,
                  created_at: '2026-09-09T12:00:00Z',
                },
              ],
              error: null,
            }),
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
        return {}
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: '' } }),
        }),
      },
    }

    mocks.requireRole.mockResolvedValue({
      supabase: mockSupabase,
      accountId: mockAccountId,
      user: { id: 'user-1' },
      role: 'viewer',
    })

    const req = new Request('http://localhost/api/ai/properties/prop-456/ads', { method: 'GET' })
    const res = await GET(req, { params: Promise.resolve({ id: mockPropertyId }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.mappings).toHaveLength(2)

    // First ad has real creative
    expect(json.mappings[0].image_url).toBe('https://fbcdn.net/creative-real.jpg')
    expect(json.mappings[0].campaign_name).toBe('Campanha Avant Home')
    expect(json.mappings[0].image_origin_label).toBe('Criativo Meta')

    // Second ad has no image (placeholder state, not property gallery)
    expect(json.mappings[1].image_url).toBeNull()
  })

  it('POST links an ad and queries Meta Graph API for the creative', async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'properties') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: mockPropertyId }, error: null }),
          }
        }
        if (table === 'whatsapp_config') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { access_token: encrypt('meta-token') },
            }),
          }
        }
        if (table === 'property_ad_mappings') {
          return {
            upsert: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'map-new',
                ad_source_id: '120251178888720493',
                creative_image_url: 'https://fbcdn.net/creative-real.jpg',
                creative_type: 'image',
              },
              error: null,
            }),
          }
        }
        return {}
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ data: { path: 'ad.jpg' }, error: null }),
          getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://storage/ad.jpg' } }),
        }),
      },
    }

    mocks.requireRole.mockResolvedValue({
      supabase: mockSupabase,
      accountId: mockAccountId,
      user: { id: 'user-1' },
      role: 'agent',
    })

    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      json: async () => ({
        id: '120251178888720493',
        name: 'Avant Home Anúncio',
        creative: {
          id: 'cr-1',
          image_url: 'https://fbcdn.net/creative-real.jpg',
        },
      }),
    }) as unknown as typeof fetch

    try {
      const req = new Request('http://localhost/api/ai/properties/prop-456/ads', {
        method: 'POST',
        body: JSON.stringify({ ad_source_id: '120251178888720493' }),
      })

      const res = await POST(req, { params: Promise.resolve({ id: mockPropertyId }) })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.mapping).toBeDefined()
      expect(json.creative.creative_image_url).toBe('https://fbcdn.net/creative-real.jpg')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('PATCH syncs on-demand a fresh creative from Meta Graph API', async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'property_ad_mappings') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'map-1',
                ad_source_id: '120251178888720493',
                creative_image_url: 'https://fbcdn.net/old-img.jpg',
              },
              error: null,
            }),
            update: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'map-1',
                creative_image_url: 'https://fbcdn.net/new-fresh-img.jpg',
              },
              error: null,
            }),
          }
        }
        if (table === 'whatsapp_config') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { access_token: encrypt('meta-token') },
            }),
          }
        }
        return {}
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ data: { path: 'ad.jpg' }, error: null }),
          getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://storage/ad.jpg' } }),
        }),
      },
    }

    mocks.requireRole.mockResolvedValue({
      supabase: mockSupabase,
      accountId: mockAccountId,
      user: { id: 'user-1' },
      role: 'agent',
    })

    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      json: async () => ({
        id: '120251178888720493',
        name: 'Avant Home Atualizado',
        creative: {
          id: 'cr-new',
          image_url: 'https://fbcdn.net/new-fresh-img.jpg',
        },
      }),
    }) as unknown as typeof fetch

    try {
      const req = new Request('http://localhost/api/ai/properties/prop-456/ads', {
        method: 'PATCH',
        body: JSON.stringify({ mapping_id: 'map-1' }),
      })

      const res = await PATCH(req, { params: Promise.resolve({ id: mockPropertyId }) })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.success).toBe(true)
      expect(json.creative.creative_image_url).toBe('https://fbcdn.net/new-fresh-img.jpg')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('DELETE unlinks an ad mapping', async () => {
    const mockSupabase = {
      from: vi.fn(() => ({
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
      })),
    }

    mocks.requireRole.mockResolvedValue({
      supabase: mockSupabase,
      accountId: mockAccountId,
      user: { id: 'user-1' },
      role: 'agent',
    })

    const req = new Request('http://localhost/api/ai/properties/prop-456/ads?mappingId=map-1', {
      method: 'DELETE',
    })

    const res = await DELETE(req, { params: Promise.resolve({ id: mockPropertyId }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
  })
})
