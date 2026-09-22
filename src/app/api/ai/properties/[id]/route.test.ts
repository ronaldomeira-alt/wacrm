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

import { DELETE } from './route'

const mockAccountId = 'acc-1'
const mockPropertyId = 'prop-1'

describe('DELETE /api/ai/properties/[id] — media Storage cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Test 17: deleting a property/knowledge must remove every commercial
  // media Storage object (photos AND videos — both live in the same
  // property_images table/property-media bucket, so a video "enters the
  // same lifecycle" as a photo automatically once this fix is in place),
  // not just cascade-delete the DB rows.
  it('removes photo AND video Storage objects before deleting the property, alongside the existing knowledge cleanup', async () => {
    const mediaRows = [
      { storage_path: 'account-1/foto1.jpg' },
      { storage_path: 'account-1/foto2.jpg' },
      { storage_path: 'account-1/lazer.mp4' },
    ]

    const removeSpy = vi.fn().mockResolvedValue({ error: null })
    const deleteCalls: string[] = []

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'property_images') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            then: (resolve: (v: unknown) => void) => resolve({ data: mediaRows, error: null }),
          }
        }
        // ai_knowledge_chunks, ai_knowledge_documents, property_ad_mappings,
        // property_ai_contexts, properties — each does .delete().eq().eq(),
        // awaited directly (no terminal call), so the chain must stay
        // thenable after any number of .eq() calls.
        deleteCalls.push(table)
        const builder: Record<string, unknown> = {
          delete: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        }
        return builder
      }),
      storage: {
        from: vi.fn(() => ({ remove: removeSpy })),
      },
    }

    mocks.requireRole.mockResolvedValue({ supabase, accountId: mockAccountId })

    const res = await DELETE(new Request('http://localhost'), {
      params: Promise.resolve({ id: mockPropertyId }),
    })

    expect(res.status).toBe(200)
    // Every media path was removed from Storage in a single batched call.
    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).toHaveBeenCalledWith([
      'account-1/foto1.jpg',
      'account-1/foto2.jpg',
      'account-1/lazer.mp4',
    ])
    // Existing knowledge cleanup (chunks/documents/ad mappings/context/property) still ran.
    expect(deleteCalls).toContain('ai_knowledge_chunks');
    expect(deleteCalls).toContain('ai_knowledge_documents');
    expect(deleteCalls).toContain('properties');
  })

  it('does not call Storage.remove when the property has no media', async () => {
    const removeSpy = vi.fn().mockResolvedValue({ error: null })

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'property_images') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
          }
        }
        const builder: Record<string, unknown> = {
          delete: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        }
        return builder
      }),
      storage: { from: vi.fn(() => ({ remove: removeSpy })) },
    }

    mocks.requireRole.mockResolvedValue({ supabase, accountId: mockAccountId })

    const res = await DELETE(new Request('http://localhost'), {
      params: Promise.resolve({ id: mockPropertyId }),
    })

    expect(res.status).toBe(200)
    expect(removeSpy).not.toHaveBeenCalled()
  })
})
