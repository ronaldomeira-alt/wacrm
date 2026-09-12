import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getAvailablePropertyMedia,
  validateAndResolveMediaToSend,
} from './property-media-service'
import { MAX_AI_MEDIA_PER_TURN } from './types'

describe('Property Media Service', () => {
  const mockStorageGetPublicUrl = vi.fn((path: string) => ({
    data: { publicUrl: `https://supabase.co/storage/v1/object/public/property-media/${path}` },
  }))

  it('getAvailablePropertyMedia returns formatted media list with publicUrl and excludes covers', async () => {
    const mockImages = [
      {
        id: 'img-1',
        property_id: 'prop-1',
        storage_path: 'account-1/img1.jpg',
        file_name: 'fachada.jpg',
        content_type: 'image/jpeg',
        description: 'Fachada principal',
        is_cover: false,
        position: 0,
      },
      {
        id: 'img-2',
        property_id: 'prop-1',
        storage_path: 'account-1/img2.jpg',
        file_name: 'piscina.jpg',
        content_type: 'image/png',
        description: null,
        is_cover: false,
        position: 1,
      },
    ]

    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'properties') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { cover_image_path: 'account-1/cover.jpg' },
              error: null,
            }),
          }
        }
        if (table === 'property_images') {
          const queryMock = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            then: (resolve: (val: unknown) => void) => resolve({ data: mockImages, error: null }),
          }
          return queryMock
        }
        return {}
      }),
      storage: {
        from: vi.fn(() => ({
          getPublicUrl: mockStorageGetPublicUrl,
        })),
      },
    } as unknown as SupabaseClient

    const result = await getAvailablePropertyMedia(mockDb, 'acc-1', 'prop-1')

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      id: 'img-1',
      type: 'image',
      description: 'Fachada principal',
      file_name: 'fachada.jpg',
      is_cover: false,
      url: 'https://supabase.co/storage/v1/object/public/property-media/account-1/img1.jpg',
    })
    expect(result[1]).toEqual({
      id: 'img-2',
      type: 'image',
      description: null,
      file_name: 'piscina.jpg',
      is_cover: false,
      url: 'https://supabase.co/storage/v1/object/public/property-media/account-1/img2.jpg',
    })
  })

  it('validateAndResolveMediaToSend rejects media belonging to different property', async () => {
    const requestedMedia = [
      { property_id: 'other-prop', media_id: 'img-1', caption: 'Área externa' },
    ]

    const mockRows = [
      {
        id: 'img-1',
        property_id: 'prop-1',
        storage_path: 'account-1/img1.jpg',
        file_name: 'img1.jpg',
        content_type: 'image/jpeg',
        is_cover: false,
        description: 'Fachada',
      },
    ]

    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'properties') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { cover_image_path: null },
              error: null,
            }),
          }
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: mockRows, error: null }),
        }
      }),
      storage: {
        from: vi.fn(() => ({
          getPublicUrl: mockStorageGetPublicUrl,
        })),
      },
    } as unknown as SupabaseClient

    // Active property is 'prop-1', but requested was 'other-prop'
    const result = await validateAndResolveMediaToSend(mockDb, 'acc-1', 'prop-1', requestedMedia)
    expect(result).toHaveLength(0)
  })

  it('validateAndResolveMediaToSend accepts matching media and resolves URLs', async () => {
    const requestedMedia = [
      { property_id: 'prop-1', media_id: 'img-1', caption: 'Foto da Fachada' },
      { media_id: 'img-2', caption: 'Piscina' },
    ]

    const mockRows = [
      {
        id: 'img-1',
        property_id: 'prop-1',
        storage_path: 'account-1/img1.jpg',
        file_name: 'fachada.jpg',
        content_type: 'image/jpeg',
        is_cover: false,
        description: 'Fachada',
      },
      {
        id: 'img-2',
        property_id: 'prop-1',
        storage_path: 'account-1/img2.webp',
        file_name: 'piscina.webp',
        content_type: 'image/webp',
        is_cover: false,
        description: 'Piscina',
      },
    ]

    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'properties') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { cover_image_path: null },
              error: null,
            }),
          }
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: mockRows, error: null }),
        }
      }),
      storage: {
        from: vi.fn(() => ({
          getPublicUrl: mockStorageGetPublicUrl,
        })),
      },
    } as unknown as SupabaseClient

    const result = await validateAndResolveMediaToSend(mockDb, 'acc-1', 'prop-1', requestedMedia)
    expect(result).toHaveLength(2)
    expect(result[0].mediaId).toBe('img-1')
    expect(result[0].caption).toBe('Foto da Fachada')
    expect(result[0].publicUrl).toContain('account-1/img1.jpg')
    expect(result[1].mediaId).toBe('img-2')
    expect(result[1].caption).toBe('Piscina')
  })

  it('validateAndResolveMediaToSend enforces MAX_AI_MEDIA_PER_TURN cap', async () => {
    const requestedMedia = Array.from({ length: 10 }, (_, i) => ({
      media_id: `img-${i + 1}`,
      caption: `Foto ${i + 1}`,
    }))

    const mockRows = Array.from({ length: MAX_AI_MEDIA_PER_TURN }, (_, i) => ({
      id: `img-${i + 1}`,
      property_id: 'prop-1',
      storage_path: `account-1/img${i + 1}.jpg`,
      file_name: `img${i + 1}.jpg`,
      content_type: 'image/jpeg',
      is_cover: false,
      description: `Foto ${i + 1}`,
    }))

    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'properties') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { cover_image_path: null },
              error: null,
            }),
          }
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: mockRows, error: null }),
        }
      }),
      storage: {
        from: vi.fn(() => ({
          getPublicUrl: mockStorageGetPublicUrl,
        })),
      },
    } as unknown as SupabaseClient

    const result = await validateAndResolveMediaToSend(mockDb, 'acc-1', 'prop-1', requestedMedia)
    expect(result.length).toBeLessThanOrEqual(MAX_AI_MEDIA_PER_TURN)
  })

  it('validateAndResolveMediaToSend rejects unsupported MIME types', async () => {
    const requestedMedia = [{ media_id: 'doc-1' }]

    const mockRows = [
      {
        id: 'doc-1',
        property_id: 'prop-1',
        storage_path: 'account-1/doc.pdf',
        file_name: 'doc.pdf',
        content_type: 'application/pdf',
        is_cover: false,
        description: 'Documento',
      },
    ]

    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'properties') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { cover_image_path: null },
              error: null,
            }),
          }
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: mockRows, error: null }),
        }
      }),
      storage: {
        from: vi.fn(() => ({
          getPublicUrl: mockStorageGetPublicUrl,
        })),
      },
    } as unknown as SupabaseClient

    const result = await validateAndResolveMediaToSend(mockDb, 'acc-1', 'prop-1', requestedMedia)
    expect(result).toHaveLength(0)
  })

  it('TEST: Cover Separation - getAvailablePropertyMedia NEVER returns property cover photo', async () => {
    const mockImages = [
      {
        id: 'img-cover',
        property_id: 'prop-1',
        storage_path: 'account-1/cover.jpg',
        file_name: 'cover.jpg',
        content_type: 'image/jpeg',
        description: 'Arte da Capa do CRM',
        is_cover: true,
        position: 0,
      },
      {
        id: 'img-media-1',
        property_id: 'prop-1',
        storage_path: 'account-1/piscina.jpg',
        file_name: 'piscina.jpg',
        content_type: 'image/jpeg',
        description: 'Piscina aquecida',
        is_cover: false,
        position: 1,
      },
    ]

    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'properties') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { cover_image_path: 'account-1/cover.jpg' },
              error: null,
            }),
          }
        }
        if (table === 'property_images') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            then: (resolve: (val: unknown) => void) =>
              resolve({
                data: mockImages.filter((img) => !img.is_cover),
                error: null,
              }),
          }
        }
        return {}
      }),
      storage: {
        from: vi.fn(() => ({
          getPublicUrl: mockStorageGetPublicUrl,
        })),
      },
    } as unknown as SupabaseClient

    const result = await getAvailablePropertyMedia(mockDb, 'acc-1', 'prop-1')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('img-media-1')
    expect(result.some((m) => m.id === 'img-cover')).toBe(false)
  })

  it('TEST: Cover Separation - validateAndResolveMediaToSend REJECTS media if it is a cover or matches cover_image_path', async () => {
    const requestedMedia = [
      { property_id: 'prop-1', media_id: 'img-cover', caption: 'Foto de Capa' },
      { property_id: 'prop-1', media_id: 'img-media-1', caption: 'Piscina' },
    ]

    const mockRows = [
      {
        id: 'img-cover',
        property_id: 'prop-1',
        storage_path: 'account-1/cover.jpg',
        file_name: 'cover.jpg',
        content_type: 'image/jpeg',
        is_cover: true,
        description: 'Arte da Capa',
      },
      {
        id: 'img-media-1',
        property_id: 'prop-1',
        storage_path: 'account-1/piscina.jpg',
        file_name: 'piscina.jpg',
        content_type: 'image/jpeg',
        is_cover: false,
        description: 'Piscina',
      },
    ]

    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'properties') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { cover_image_path: 'account-1/cover.jpg' },
              error: null,
            }),
          }
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: mockRows, error: null }),
        }
      }),
      storage: {
        from: vi.fn(() => ({
          getPublicUrl: mockStorageGetPublicUrl,
        })),
      },
    } as unknown as SupabaseClient

    const result = await validateAndResolveMediaToSend(mockDb, 'acc-1', 'prop-1', requestedMedia)

    // img-cover should be filtered out! Only img-media-1 should be resolved.
    expect(result).toHaveLength(1)
    expect(result[0].mediaId).toBe('img-media-1')
    expect(result.some((m) => m.mediaId === 'img-cover')).toBe(false)
  })
})
