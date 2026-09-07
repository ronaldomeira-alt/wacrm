import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

// ---------------------------------------------------------------------------
// POST /api/media/presign-upload — covers scenario 6 from the validation
// list for the WRITE side: `visibility` must come exclusively from the
// server's purpose→rule mapping (media-purpose.ts), never from anything the
// client sends, even if the request body tries to smuggle a `visibility`
// field alongside a legitimate `purpose`. Also covers the role gate (a
// 'chat-attachment' upload only needs 'agent'; 'template-header' needs
// 'admin', matching /api/whatsapp/templates/submit).
// ---------------------------------------------------------------------------

let callerRole = 'admin'
const insertedRows: Array<Record<string, unknown>> = []

const fromMock = vi.fn((table: string) => {
  if (table !== 'media_objects') throw new Error(`Unexpected table: ${table}`)
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  builder.select = vi.fn(chain)
  builder.eq = vi.fn(chain)
  builder.maybeSingle = vi.fn(async () => ({ data: null, error: null })) // no dedup hit
  builder.insert = vi.fn((row: Record<string, unknown>) => {
    insertedRows.push(row)
    return { then: (resolve: (v: unknown) => unknown) => resolve({ error: null }) }
  })
  return builder
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        const b: Record<string, unknown> = {}
        const chain = () => b
        b.select = vi.fn(chain)
        b.eq = vi.fn(chain)
        b.maybeSingle = vi.fn(async () => ({
          data: { account_id: 'acct-A', account_role: callerRole },
          error: null,
        }))
        return b
      }
      if (table === 'accounts') {
        const b: Record<string, unknown> = {}
        const chain = () => b
        b.select = vi.fn(chain)
        b.eq = vi.fn(chain)
        b.maybeSingle = vi.fn(async () => ({ data: { id: 'acct-A', name: 'Acme' }, error: null }))
        return b
      }
      return fromMock(table)
    }),
  })),
}))

vi.mock('@/lib/storage/r2-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/r2-client')>()
  return {
    ...actual,
    getR2Client: vi.fn(() => ({}) as unknown),
    getR2Bucket: vi.fn(() => 'wacrm-media'),
  }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://fake-r2-endpoint.example/put?sig=abc'),
}))

import { POST } from './route'

const SHA = 'a'.repeat(64)

function presign(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/media/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'image',
        filename: 'photo.png',
        contentType: 'image/png',
        sizeBytes: 1000,
        sha256: SHA,
        ...body,
      }),
    }),
  )
}

describe('POST /api/media/presign-upload — visibility is server-derived only', () => {
  beforeEach(() => {
    insertedRows.length = 0
    callerRole = 'admin'
    __resetRateLimitForTests()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('chat-attachment always inserts visibility=private, even if the body also sends visibility=public', async () => {
    const res = await presign({ purpose: 'chat-attachment', visibility: 'public' })
    expect(res.status).toBe(200)
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0].visibility).toBe('private')
  })

  it('template-header always inserts visibility=public, even if the body sends visibility=private', async () => {
    const res = await presign({ purpose: 'template-header', visibility: 'private' })
    expect(res.status).toBe(200)
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0].visibility).toBe('public')
  })

  it('rejects an unknown purpose outright', async () => {
    const res = await presign({ purpose: 'anything-else' })
    expect(res.status).toBe(400)
    expect(insertedRows).toHaveLength(0)
  })

  it('an agent can upload a chat-attachment', async () => {
    callerRole = 'agent'
    const res = await presign({ purpose: 'chat-attachment' })
    expect(res.status).toBe(200)
  })

  it('an agent (not admin) is refused for template-header', async () => {
    callerRole = 'agent'
    const res = await presign({ purpose: 'template-header' })
    expect(res.status).toBe(403)
    expect(insertedRows).toHaveLength(0)
  })

  it('an admin can upload a template-header', async () => {
    callerRole = 'admin'
    const res = await presign({ purpose: 'template-header' })
    expect(res.status).toBe(200)
  })
})
