import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fetchMetaAdCreative,
  cacheAdCreativeImage,
} from './meta-ad-creative'

describe('meta-ad-creative service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects invalid or non-numeric ad IDs gracefully', async () => {
    const res = await fetchMetaAdCreative('invalid_id_abc', 'token-123')
    expect(res.success).toBe(false)
    expect(res.creative_image_url).toBeNull()
    expect(res.creative_type).toBe('unknown')
  })

  it('resolves static image ad creative correctly', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '120251178888720493',
        name: 'Avant Home - Fachada',
        status: 'ACTIVE',
        campaign: { id: 'c1', name: 'Avant Home Lançamento' },
        adset: { id: 'a1', name: 'Público Geral Imóveis' },
        creative: {
          id: 'cr1',
          name: 'Foto Fachada Arte',
          title: 'Últimas unidades Avant Home',
          body: 'More no melhor do Altiplano',
          image_url: 'https://fbcdn.net/creative-fachada.jpg',
        },
      }),
    }) as unknown as typeof fetch

    try {
      const res = await fetchMetaAdCreative('120251178888720493', 'valid-token')
      expect(res.success).toBe(true)
      expect(res.ad_name).toBe('Avant Home - Fachada')
      expect(res.campaign_name).toBe('Avant Home Lançamento')
      expect(res.adset_name).toBe('Público Geral Imóveis')
      expect(res.creative_id).toBe('cr1')
      expect(res.creative_image_url).toBe('https://fbcdn.net/creative-fachada.jpg')
      expect(res.creative_type).toBe('image')
      expect(res.headline).toBe('Últimas unidades Avant Home')
      expect(res.body).toBe('More no melhor do Altiplano')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('resolves video ad creative and extracts thumbnail/preview correctly', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '120251178888720494',
        name: 'Avant Home - Tour Vídeo',
        status: 'ACTIVE',
        campaign: { id: 'c1', name: 'Avant Home Lançamento' },
        adset: { id: 'a1', name: 'Público Vídeo' },
        creative: {
          id: 'cr2',
          name: 'Vídeo Tour',
          video_id: 'vid-999',
          thumbnail_url: 'https://fbcdn.net/video-thumb.jpg',
          object_story_spec: {
            video_data: {
              image_url: 'https://fbcdn.net/video-thumb.jpg',
              title: 'Conheça o Decorado',
              message: 'Assista ao tour completo.',
            },
          },
        },
      }),
    }) as unknown as typeof fetch

    try {
      const res = await fetchMetaAdCreative('120251178888720494', 'valid-token')
      expect(res.success).toBe(true)
      expect(res.creative_type).toBe('video')
      expect(res.creative_image_url).toBe('https://fbcdn.net/video-thumb.jpg')
      expect(res.creative_thumbnail_url).toBe('https://fbcdn.net/video-thumb.jpg')
      expect(res.headline).toBe('Conheça o Decorado')
      expect(res.body).toBe('Assista ao tour completo.')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('resolves carousel ad creative and extracts first representative picture', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '120251178888720495',
        name: 'Avant Home - Carrossel Plantas',
        status: 'ACTIVE',
        creative: {
          id: 'cr3',
          object_story_spec: {
            link_data: {
              child_attachments: [
                { picture: 'https://fbcdn.net/planta-2q.jpg', name: 'Planta 2 Quartos', link: 'https://wa.me/1' },
                { picture: 'https://fbcdn.net/planta-3q.jpg', name: 'Planta 3 Quartos', link: 'https://wa.me/2' },
              ],
            },
          },
        },
      }),
    }) as unknown as typeof fetch

    try {
      const res = await fetchMetaAdCreative('120251178888720495', 'valid-token')
      expect(res.success).toBe(true)
      expect(res.creative_type).toBe('carousel')
      expect(res.creative_image_url).toBe('https://fbcdn.net/planta-2q.jpg')
      expect(res.headline).toBe('Planta 2 Quartos')
      expect(res.source_url).toBe('https://wa.me/1')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('resolves dynamic creative (Advantage+) correctly', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '120251178888720496',
        name: 'Avant Home - Dynamic Creative',
        status: 'ACTIVE',
        creative: {
          id: 'cr4',
          asset_feed_spec: {
            images: [{ url: 'https://fbcdn.net/dyn-img-1.jpg' }],
            titles: [{ text: 'Oportunidade Única' }],
            bodies: [{ text: 'Cadastre-se para condições exclusivas' }],
          },
        },
      }),
    }) as unknown as typeof fetch

    try {
      const res = await fetchMetaAdCreative('120251178888720496', 'valid-token')
      expect(res.success).toBe(true)
      expect(res.creative_type).toBe('dynamic')
      expect(res.creative_image_url).toBe('https://fbcdn.net/dyn-img-1.jpg')
      expect(res.headline).toBe('Oportunidade Única')
      expect(res.body).toBe('Cadastre-se para condições exclusivas')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('resolves dark post via effective_object_story_id when image is nested in post', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('post_123456')) {
        return {
          ok: true,
          json: async () => ({
            id: 'post_123456',
            full_picture: 'https://fbcdn.net/post-full-picture.jpg',
          }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          id: '120251178888720497',
          name: 'Post Promovido',
          creative: {
            id: 'cr5',
            effective_object_story_id: 'post_123456',
          },
        }),
      }
    }) as unknown as typeof fetch

    try {
      const res = await fetchMetaAdCreative('120251178888720497', 'valid-token')
      expect(res.success).toBe(true)
      expect(res.creative_image_url).toBe('https://fbcdn.net/post-full-picture.jpg')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('caches remote creative image into Supabase storage', async () => {
    const mockSupabase = {
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ data: { path: 'ad.jpg' }, error: null }),
          getPublicUrl: vi.fn().mockReturnValue({
            data: { publicUrl: 'https://supabase.co/storage/v1/object/public/property-media/account-acc/ad.jpg' },
          }),
        }),
      },
    }

    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }) as unknown as typeof fetch

    try {
      const result = await cacheAdCreativeImage({
        supabase: mockSupabase as any,
        accountId: 'acc-123',
        adSourceId: '120251178888720493',
        remoteUrl: 'https://fbcdn.net/creative.jpg',
      })

      expect(result).not.toBeNull()
      expect(result?.publicUrl).toContain('property-media')
      expect(mockSupabase.storage.from).toHaveBeenCalledWith('property-media')
    } finally {
      global.fetch = originalFetch
    }
  })
})
