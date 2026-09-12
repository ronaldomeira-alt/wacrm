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

import { GET, POST, DELETE } from '@/app/api/ai/properties/[id]/ads/route'
import { encrypt } from '@/lib/whatsapp/encryption'

describe('Obrigatory Test Suite: Meta Ad Creative Isolation & Resolution', () => {
  const mockAccountId = 'acc-avant-123'
  const mockPropertyId = 'prop-avant-home'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // TESTE 1: Ad válido + creative com imagem -> Imagem real da Meta aparece.
  it('TESTE 1: Ad válido + creative com imagem -> Imagem real da Meta aparece', async () => {
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
              data: { access_token: encrypt('valid-meta-token') },
            }),
          }
        }
        if (table === 'property_ad_mappings') {
          return {
            upsert: vi.fn().mockImplementation((payload) => ({
              select: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({
                data: {
                  id: 'map-1',
                  ...payload,
                },
                error: null,
              }),
            })),
          }
        }
        return {}
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ data: { path: 'ad.jpg' }, error: null }),
          getPublicUrl: vi.fn().mockReturnValue({
            data: { publicUrl: 'https://storage.supabase.co/property-media/account-acc/ad.jpg' },
          }),
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
        name: 'Avant Home - Anúncio Piscina',
        campaign: { id: 'c1', name: 'Lançamento Altiplano' },
        adset: { id: 'a1', name: 'Interesse em Imóveis de Luxo' },
        creative: {
          id: 'cr-piscina-real',
          image_url: 'https://fbcdn.net/meta-piscina-creative-real.jpg',
        },
      }),
    }) as unknown as typeof fetch

    try {
      const req = new Request('http://localhost/api/ai/properties/prop-avant-home/ads', {
        method: 'POST',
        body: JSON.stringify({ ad_source_id: '120251178888720493' }),
      })

      const res = await POST(req, { params: Promise.resolve({ id: mockPropertyId }) })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.creative.creative_image_url).toBe('https://fbcdn.net/meta-piscina-creative-real.jpg')
      expect(json.mapping.creative_image_url).toBe('https://fbcdn.net/meta-piscina-creative-real.jpg')
    } finally {
      global.fetch = originalFetch
    }
  })

  // TESTE 2: Ad válido + creative de vídeo -> Thumbnail/preview da Meta aparece.
  it('TESTE 2: Ad válido + creative de vídeo -> Thumbnail/preview da Meta aparece', async () => {
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
              data: { access_token: encrypt('valid-meta-token') },
            }),
          }
        }
        if (table === 'property_ad_mappings') {
          return {
            upsert: vi.fn().mockImplementation((payload) => ({
              select: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({
                data: { id: 'map-2', ...payload },
                error: null,
              }),
            })),
          }
        }
        return {}
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ data: { path: 'ad-video.jpg' }, error: null }),
          getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://storage/ad-video.jpg' } }),
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
        id: '120251178888720494',
        name: 'Avant Home - Tour Vídeo',
        creative: {
          id: 'cr-video',
          video_id: 'vid-12345',
          thumbnail_url: 'https://fbcdn.net/meta-video-thumbnail.jpg',
        },
      }),
    }) as unknown as typeof fetch

    try {
      const req = new Request('http://localhost/api/ai/properties/prop-avant-home/ads', {
        method: 'POST',
        body: JSON.stringify({ ad_source_id: '120251178888720494' }),
      })

      const res = await POST(req, { params: Promise.resolve({ id: mockPropertyId }) })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.creative.creative_type).toBe('video')
      expect(json.creative.creative_thumbnail_url).toBe('https://fbcdn.net/meta-video-thumbnail.jpg')
    } finally {
      global.fetch = originalFetch
    }
  })

  // TESTE 3: Ad válido + carrossel -> Imagem representativa do creative.
  it('TESTE 3: Ad válido + carrossel -> Imagem representativa do creative', async () => {
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
              data: { access_token: encrypt('valid-meta-token') },
            }),
          }
        }
        if (table === 'property_ad_mappings') {
          return {
            upsert: vi.fn().mockImplementation((payload) => ({
              select: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({ data: { id: 'map-3', ...payload }, error: null }),
            })),
          }
        }
        return {}
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ data: { path: 'carrossel.jpg' }, error: null }),
          getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://storage/carrossel.jpg' } }),
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
        id: '120251178888720495',
        name: 'Avant Home - Carrossel de Opções',
        creative: {
          id: 'cr-carousel',
          object_story_spec: {
            link_data: {
              child_attachments: [
                { picture: 'https://fbcdn.net/card-1-living.jpg', name: 'Living Integrado' },
                { picture: 'https://fbcdn.net/card-2-suite.jpg', name: 'Suíte Master' },
              ],
            },
          },
        },
      }),
    }) as unknown as typeof fetch

    try {
      const req = new Request('http://localhost/api/ai/properties/prop-avant-home/ads', {
        method: 'POST',
        body: JSON.stringify({ ad_source_id: '120251178888720495' }),
      })

      const res = await POST(req, { params: Promise.resolve({ id: mockPropertyId }) })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.creative.creative_type).toBe('carousel')
      expect(json.creative.creative_image_url).toBe('https://fbcdn.net/card-1-living.jpg')
    } finally {
      global.fetch = originalFetch
    }
  })

  // TESTE 4: Ad válido + imagem indisponível -> Placeholder, sem usar mídia do empreendimento.
  it('TESTE 4: Ad válido + imagem indisponível -> Placeholder, sem usar mídia do empreendimento', async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'property_ad_mappings') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'map-4',
                  property_id: mockPropertyId,
                  ad_source_id: '120251178888720496',
                  ad_name: 'Anúncio Sem Criativo',
                  creative_id: null,
                  creative_image_url: null,
                  creative_thumbnail_url: null,
                  creative_storage_path: null,
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
        // Even if property_images exists with images, it must never be queried or returned
        if (table === 'property_images') {
          throw new Error('VIOLATION: property_images must NEVER be queried in ads endpoint!')
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

    const req = new Request('http://localhost/api/ai/properties/prop-avant-home/ads', { method: 'GET' })
    const res = await GET(req, { params: Promise.resolve({ id: mockPropertyId }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.mappings).toHaveLength(1)
    expect(json.mappings[0].image_url).toBeNull()
    expect(json.mappings[0].image_origin_label).toBeNull()
  })

  // TESTE 5: Mídia do empreendimento alterada -> Imagem do anúncio não muda.
  it('TESTE 5: Mídia do empreendimento alterada -> Imagem do anúncio não muda (total isolation)', async () => {
    const fixedCreativeUrl = 'https://fbcdn.net/fixed-meta-ad-creative.jpg'

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'property_ad_mappings') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'map-5',
                  property_id: mockPropertyId,
                  ad_source_id: '120251178888720493',
                  creative_image_url: fixedCreativeUrl,
                  creative_type: 'image',
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

    const req = new Request('http://localhost/api/ai/properties/prop-avant-home/ads', { method: 'GET' })
    const res = await GET(req, { params: Promise.resolve({ id: mockPropertyId }) })
    const json = await res.json()
    expect(json.mappings[0].image_url).toBe(fixedCreativeUrl)
  })

  // TESTE 6: Vínculo removido -> Card desaparece conforme comportamento atual.
  it('TESTE 6: Vínculo removido -> Card desaparece conforme comportamento atual', async () => {
    let adDeleted = false
    interface MockDeleteBuilder {
      eq: ReturnType<typeof vi.fn>
      then: (resolve: (val: { error: null }) => void) => void
    }
    const deleteBuilder: MockDeleteBuilder = {
      eq: vi.fn().mockImplementation(() => deleteBuilder),
      then: (resolve) => {
        adDeleted = true
        return resolve({ error: null })
      },
    }

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'property_ad_mappings') {
          return {
            delete: vi.fn().mockReturnValue(deleteBuilder),
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

    const req = new Request('http://localhost/api/ai/properties/prop-avant-home/ads?mappingId=map-to-delete', {
      method: 'DELETE',
    })

    const res = await DELETE(req, { params: Promise.resolve({ id: mockPropertyId }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(adDeleted).toBe(true)
  })

  // TESTE 7: Vínculo recriado -> Creative é buscado novamente.
  it('TESTE 7: Vínculo recriado -> Creative é buscado novamente na Meta', async () => {
    let metaApiCalled = false

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
              data: { access_token: encrypt('valid-meta-token') },
            }),
          }
        }
        if (table === 'property_ad_mappings') {
          return {
            upsert: vi.fn().mockImplementation((payload) => ({
              select: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({ data: { id: 'map-recreated', ...payload }, error: null }),
            })),
          }
        }
        return {}
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ data: { path: 'recreated.jpg' }, error: null }),
          getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://storage/recreated.jpg' } }),
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
    global.fetch = vi.fn().mockImplementation(async () => {
      metaApiCalled = true
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        json: async () => ({
          id: '120251178888720493',
          name: 'Avant Home Recriado',
          creative: {
            id: 'cr-recreated',
            image_url: 'https://fbcdn.net/meta-fresh-creative.jpg',
          },
        }),
      }
    }) as unknown as typeof fetch

    try {
      const req = new Request('http://localhost/api/ai/properties/prop-avant-home/ads', {
        method: 'POST',
        body: JSON.stringify({ ad_source_id: '120251178888720493' }),
      })

      const res = await POST(req, { params: Promise.resolve({ id: mockPropertyId }) })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(metaApiCalled).toBe(true)
      expect(json.creative.creative_image_url).toBe('https://fbcdn.net/meta-fresh-creative.jpg')
    } finally {
      global.fetch = originalFetch
    }
  })
})
