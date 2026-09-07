import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

// ---------------------------------------------------------------------------
// GET /api/media/public/[...key] — the unauthenticated redirect route for
// deliberately-public commercial media (WhatsApp template header images).
// Covers the validation scenarios the user asked to be explicitly checked
// before considering Fase 2 done:
//   1. public media resolves without a session
//   2/5. a private key (any account's) never resolves through here
//   3. an unknown key 404s
//   4. a 'pending' object is never served
//   6. no request parameter can select visibility — it's DB-only
//   7. rate limiting engages without blocking normal traffic
// ---------------------------------------------------------------------------

// Rows the mocked `media_objects` table "contains" for a given test.
let rows: Array<{ object_key: string; visibility: string; status: string }> = []

const fromMock = vi.fn((table: string) => {
  if (table !== 'media_objects') throw new Error(`Unexpected table: ${table}`)
  let filters: Record<string, string> = {}
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  builder.select = vi.fn(chain)
  builder.eq = vi.fn((col: string, val: string) => {
    filters = { ...filters, [col]: val }
    return builder
  })
  builder.maybeSingle = vi.fn(async () => {
    const match = rows.find((r) =>
      Object.entries(filters).every(([k, v]) => (r as Record<string, string>)[k] === v),
    )
    return { data: match ?? null, error: null }
  })
  return builder
})

vi.mock('@/lib/storage/admin-client', () => ({
  supabaseAdmin: () => ({ from: fromMock }),
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
  getSignedUrl: vi.fn(async () => 'https://fake-r2-endpoint.example/signed?sig=abc'),
}))

import { GET } from './route'

function request(key: string, ip = '1.2.3.4') {
  return GET(
    new Request(`http://localhost/api/media/public/${key}`, {
      headers: { 'x-forwarded-for': ip },
    }),
    { params: Promise.resolve({ key: key.split('/') }) },
  )
}

describe('GET /api/media/public/[...key]', () => {
  beforeEach(() => {
    rows = []
    __resetRateLimitForTests()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('redirects to a fresh signed URL for a completed public object — no session required', async () => {
    rows = [{ object_key: 'acct-A/image/2026/09/x-header.png', visibility: 'public', status: 'completed' }]

    const res = await request('acct-A/image/2026/09/x-header.png')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://fake-r2-endpoint.example/signed?sig=abc')
  })

  it('404s a private object — never resolvable through the public route, regardless of account', async () => {
    rows = [{ object_key: 'acct-B/image/2026/09/x-private.png', visibility: 'private', status: 'completed' }]

    const res = await request('acct-B/image/2026/09/x-private.png')

    expect(res.status).toBe(404)
  })

  it('404s an unknown key', async () => {
    rows = []
    const res = await request('acct-A/image/2026/09/never-existed.png')
    expect(res.status).toBe(404)
  })

  it('404s a public object still pending confirm-upload', async () => {
    rows = [{ object_key: 'acct-A/image/2026/09/mid-upload.png', visibility: 'public', status: 'pending' }]
    const res = await request('acct-A/image/2026/09/mid-upload.png')
    expect(res.status).toBe(404)
  })

  it('gives the exact same 404 body shape for unknown / private / pending — no oracle', async () => {
    rows = [
      { object_key: 'acct-A/image/2026/09/private.png', visibility: 'private', status: 'completed' },
      { object_key: 'acct-A/image/2026/09/pending.png', visibility: 'public', status: 'pending' },
    ]

    const [unknown, priv, pending] = await Promise.all([
      request('acct-A/image/2026/09/nope.png').then((r) => r.json()),
      request('acct-A/image/2026/09/private.png').then((r) => r.json()),
      request('acct-A/image/2026/09/pending.png').then((r) => r.json()),
    ])

    expect(unknown).toEqual(priv)
    expect(priv).toEqual(pending)
  })

  it('rejects a URL-shaped "key" before ever touching the database', async () => {
    // A catch-all route's segments never carry a literal "//" — the two
    // segments straddling the scheme colon rejoin into a real https://
    // value, which isR2MediaKey must reject outright.
    const res = await GET(
      new Request('http://localhost/api/media/public/https:/evil.example/x.png'),
      { params: Promise.resolve({ key: ['https:', '', 'evil.example', 'x.png'] }) },
    )
    expect(res.status).toBe(404)
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('never accepts a visibility (or any other) request parameter — the route signature takes only a key', async () => {
    // Confirms structurally, not just behaviorally: the only thing this
    // request can vary is the path segments themselves. A query string
    // asking for visibility=public is simply never read by the handler.
    rows = [{ object_key: 'acct-A/image/2026/09/x.png', visibility: 'private', status: 'completed' }]
    const res = await GET(
      new Request('http://localhost/api/media/public/acct-A/image/2026/09/x.png?visibility=public'),
      { params: Promise.resolve({ key: ['acct-A', 'image', '2026', '09', 'x.png'] }) },
    )
    // Still 404 — the query string had zero effect on the DB-only check.
    expect(res.status).toBe(404)
  })

  it('rate-limits a single IP past the per-minute budget, but not below it', async () => {
    rows = [{ object_key: 'acct-A/image/2026/09/x.png', visibility: 'public', status: 'completed' }]

    const results: number[] = []
    // RATE_LIMITS.mediaPublicRedirect is 60/min — 60 should succeed, the
    // 61st should be throttled, all from the same IP.
    for (let i = 0; i < 61; i++) {
      const res = await request('acct-A/image/2026/09/x.png', '9.9.9.9')
      results.push(res.status)
    }
    expect(results.slice(0, 60).every((s) => s === 302)).toBe(true)
    expect(results[60]).toBe(429)
  })

  it('a different IP is unaffected by another IP being rate-limited', async () => {
    rows = [{ object_key: 'acct-A/image/2026/09/x.png', visibility: 'public', status: 'completed' }]
    for (let i = 0; i < 61; i++) {
      await request('acct-A/image/2026/09/x.png', '9.9.9.9')
    }
    const res = await request('acct-A/image/2026/09/x.png', '8.8.8.8')
    expect(res.status).toBe(302)
  })
})
