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

// Test 7: this route was NOT modified for video support — it was already
// generic (fetches storage_path, deletes the row, then removes that path
// from Storage, regardless of content_type). This proves it keeps working
// unchanged for a video row, exactly like it already does for photos.
describe('DELETE /api/ai/properties/[id]/images/[imageId] — works for video rows too (unchanged route)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deletes a video row and removes its Storage object', async () => {
    const removeSpy = vi.fn().mockResolvedValue({ error: null })

    // One object literal per `.from()` call serves both chains this route
    // uses: `select().eq().eq().maybeSingle()` (explicit terminal) and
    // `delete().eq().eq()` (awaited directly — no terminal call, so the
    // builder itself must be thenable).
    const makeBuilder = () => {
      const builder: Record<string, unknown> = {
        select: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { id: 'vid-1', storage_path: 'account-1/lazer.mp4' },
          error: null,
        }),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      }
      return builder
    }

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'property_images') return makeBuilder()
        throw new Error(`unexpected table: ${table}`)
      }),
      storage: { from: vi.fn(() => ({ remove: removeSpy })) },
    }

    mocks.requireRole.mockResolvedValue({ supabase, accountId: mockAccountId })

    const res = await DELETE(new Request('http://localhost'), {
      params: Promise.resolve({ id: mockPropertyId, imageId: 'vid-1' }),
    })

    expect(res.status).toBe(200)
    expect(removeSpy).toHaveBeenCalledWith(['account-1/lazer.mp4'])
  })
})
