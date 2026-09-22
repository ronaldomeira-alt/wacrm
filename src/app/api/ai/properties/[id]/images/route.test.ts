import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  toErrorResponse: vi.fn((err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 }),
  ),
  supabaseAdmin: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: mocks.toErrorResponse,
}))

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

import { POST } from './route'

const mockAccountId = 'acc-1'
const mockPropertyId = 'prop-1'

/** Chainable query-builder stub covering every shape this route uses:
 *  select().eq().maybeSingle() (properties lookup), select().eq().eq().eq()
 *  awaited directly (countCommercialMediaByType — no terminal call, so the
 *  builder itself must be thenable), and insert().select().single(). */
function makeSupabaseMock(opts: {
  propertyExists?: boolean
  existingMedia?: Array<{ content_type: string | null }>
  insertResult?: { data: unknown; error: unknown }
}) {
  const propertyExists = opts.propertyExists ?? true
  const existingMedia = opts.existingMedia ?? []
  const insertResult = opts.insertResult ?? {
    data: { id: 'new-media-id', account_id: mockAccountId, property_id: mockPropertyId },
    error: null,
  }

  const propertiesBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(
      propertyExists ? { data: { id: mockPropertyId }, error: null } : { data: null, error: null },
    ),
  }

  const propertyImagesBuilder: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(insertResult),
    // countCommercialMediaByType awaits the chain directly (no .single()),
    // so the builder itself must resolve like a real Postgrest query.
    then: (resolve: (v: unknown) => void) => resolve({ data: existingMedia, error: null }),
  }

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'properties') return propertiesBuilder
      if (table === 'property_images') return propertyImagesBuilder
      throw new Error(`unexpected table: ${table}`)
    }),
  }

  return { supabase, propertyImagesBuilder }
}

function makeAdminMock(uploadError: unknown = null) {
  const upload = vi.fn().mockResolvedValue({ error: uploadError })
  const remove = vi.fn().mockResolvedValue({ error: null })
  const admin = { storage: { from: vi.fn(() => ({ upload, remove })) } }
  return { admin, upload, remove }
}

function makeVideoRequest(file: File): Request {
  const formData = new FormData()
  formData.append('file', file)
  return new Request('http://localhost/api/ai/properties/prop-1/images', {
    method: 'POST',
    body: formData,
  })
}

function makeVideoFile(name: string, type: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], name, { type })
}

describe('POST /api/ai/properties/[id]/images — video support', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Test 1: a valid, already-normalized MP4 (as prepare-property-video.ts
  // would hand off) is accepted, uploaded to the SAME property-media
  // bucket, and stored with its real video content_type — no `sharp`
  // normalization is attempted (that path is image-only and never runs
  // here).
  it('accepts a valid video/mp4 upload and stores it with the correct content_type', async () => {
    const { supabase } = makeSupabaseMock({ existingMedia: [] })
    const { admin, upload } = makeAdminMock()
    mocks.requireRole.mockResolvedValue({ supabase, accountId: mockAccountId })
    mocks.supabaseAdmin.mockReturnValue(admin)

    const file = makeVideoFile('lazer.mp4', 'video/mp4', 4 * 1024 * 1024)
    const res = await POST(makeVideoRequest(file), { params: Promise.resolve({ id: mockPropertyId }) })

    expect(res.status).toBe(201)
    expect(upload).toHaveBeenCalledTimes(1)
    const uploadOptions = upload.mock.calls[0][2] as { contentType: string }
    expect(uploadOptions.contentType).toBe('video/mp4')
  })

  // Rejects a container the WhatsApp Cloud API doesn't accept, instead of
  // trying to normalize it server-side (no second transcoder here).
  it('rejects an unsupported video container (e.g. video/x-matroska / .mkv)', async () => {
    const { supabase } = makeSupabaseMock({ existingMedia: [] })
    const { admin, upload } = makeAdminMock()
    mocks.requireRole.mockResolvedValue({ supabase, accountId: mockAccountId })
    mocks.supabaseAdmin.mockReturnValue(admin)

    const file = makeVideoFile('clip.mkv', 'video/x-matroska', 4 * 1024 * 1024)
    const res = await POST(makeVideoRequest(file), { params: Promise.resolve({ id: mockPropertyId }) })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/formato de vídeo/i)
    expect(upload).not.toHaveBeenCalled()
  })

  // Server-side backstop for the 16 MB ceiling — belt-and-suspenders on
  // top of the client-side check in prepare-property-video.ts.
  it('rejects a video over the 16 MB ceiling', async () => {
    const { supabase } = makeSupabaseMock({ existingMedia: [] })
    const { admin, upload } = makeAdminMock()
    mocks.requireRole.mockResolvedValue({ supabase, accountId: mockAccountId })
    mocks.supabaseAdmin.mockReturnValue(admin)

    const file = makeVideoFile('too-big.mp4', 'video/mp4', 17 * 1024 * 1024)
    const res = await POST(makeVideoRequest(file), { params: Promise.resolve({ id: mockPropertyId }) })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/16 MB/)
    expect(upload).not.toHaveBeenCalled()
  })

  // 5 videos already registered — the 6th must be rejected, independent
  // of how many photos exist.
  it('enforces the 5-video limit independently of photos', async () => {
    const existingMedia = Array.from({ length: 5 }, () => ({ content_type: 'video/mp4' }))
    const { supabase } = makeSupabaseMock({ existingMedia })
    const { admin, upload } = makeAdminMock()
    mocks.requireRole.mockResolvedValue({ supabase, accountId: mockAccountId })
    mocks.supabaseAdmin.mockReturnValue(admin)

    const file = makeVideoFile('sixth.mp4', 'video/mp4', 2 * 1024 * 1024)
    const res = await POST(makeVideoRequest(file), { params: Promise.resolve({ id: mockPropertyId }) })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/5 vídeos/)
    expect(upload).not.toHaveBeenCalled()
  })

  // 5 PHOTOS already registered, 0 videos — a video upload must still
  // succeed: the two caps are independent, not a shared "5 mídias" pool.
  it('allows a video upload even when the 5-photo cap is already reached', async () => {
    const existingMedia = Array.from({ length: 5 }, () => ({ content_type: 'image/jpeg' }))
    const { supabase } = makeSupabaseMock({ existingMedia })
    const { admin, upload } = makeAdminMock()
    mocks.requireRole.mockResolvedValue({ supabase, accountId: mockAccountId })
    mocks.supabaseAdmin.mockReturnValue(admin)

    const file = makeVideoFile('lazer.mp4', 'video/mp4', 2 * 1024 * 1024)
    const res = await POST(makeVideoRequest(file), { params: Promise.resolve({ id: mockPropertyId }) })

    expect(res.status).toBe(201)
    expect(upload).toHaveBeenCalledTimes(1)
  })

  // Inverse: 5 VIDEOS already registered, 0 photos — a photo upload
  // (JSON-body / already-uploaded-file path) must still succeed.
  it('allows a photo metadata insert even when the 5-video cap is already reached', async () => {
    const existingMedia = Array.from({ length: 5 }, () => ({ content_type: 'video/mp4' }))
    const { supabase } = makeSupabaseMock({
      existingMedia,
      insertResult: {
        data: { id: 'new-photo-id', content_type: 'image/jpeg' },
        error: null,
      },
    })
    mocks.requireRole.mockResolvedValue({ supabase, accountId: mockAccountId })

    const req = new Request('http://localhost/api/ai/properties/prop-1/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storage_path: 'account-1/foto.jpg',
        file_name: 'foto.jpg',
        file_size: 100_000,
        content_type: 'image/jpeg',
      }),
    })

    const res = await POST(req, { params: Promise.resolve({ id: mockPropertyId }) })
    expect(res.status).toBe(201)
  })
})
