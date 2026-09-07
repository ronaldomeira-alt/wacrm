import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

// ---------------------------------------------------------------------------
// POST /api/media/resolve — the session-authed read path for PRIVATE media.
// Covers scenario 5 from the validation list: Account A must never be able
// to turn Account B's private key into a usable signed URL, whether by
// guessing a foreign account_id prefix or by referencing a real key that
// happens to belong to someone else.
// ---------------------------------------------------------------------------

const CALLER_ACCOUNT = 'acct-A'

let completedPrivateRows: Array<{ object_key: string }> = []

const fromMock = vi.fn((table: string) => {
  if (table !== 'media_objects') throw new Error(`Unexpected table: ${table}`)
  let inClause: string[] = []
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  builder.select = vi.fn(chain)
  builder.eq = vi.fn(chain)
  builder.in = vi.fn((_col: string, keys: string[]) => {
    inClause = keys
    return builder
  })
  builder.then = (resolve: (v: unknown) => unknown) =>
    resolve({
      data: completedPrivateRows.filter((r) => inClause.includes(r.object_key)),
      error: null,
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
          data: { account_id: CALLER_ACCOUNT, account_role: 'agent' },
          error: null,
        }))
        return b
      }
      if (table === 'accounts') {
        const b: Record<string, unknown> = {}
        const chain = () => b
        b.select = vi.fn(chain)
        b.eq = vi.fn(chain)
        b.maybeSingle = vi.fn(async () => ({ data: { id: CALLER_ACCOUNT, name: 'Acme' }, error: null }))
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
  getSignedUrl: vi.fn(async () => 'https://fake-r2-endpoint.example/signed?sig=abc'),
}))

import { POST } from './route'

function resolveKeys(keys: string[]) {
  return POST(
    new Request('http://localhost/api/media/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    }),
  )
}

describe('POST /api/media/resolve', () => {
  beforeEach(() => {
    completedPrivateRows = []
    __resetRateLimitForTests()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('resolves the caller account\'s own completed private key', async () => {
    const key = `${CALLER_ACCOUNT}/image/2026/09/mine.png`
    completedPrivateRows = [{ object_key: key }]

    const res = await resolveKeys([key])
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.resolved).toHaveLength(1)
    expect(json.resolved[0].key).toBe(key)
    expect(json.invalid).toEqual([])
  })

  it("rejects another account's key by prefix alone, before any DB round trip", async () => {
    const foreignKey = 'acct-B/image/2026/09/theirs.png'
    // Even if a matching row existed (it doesn't need to for this check to
    // matter), the prefix check alone must reject it — never signs a URL
    // for a key whose leading segment isn't the caller's own account.
    completedPrivateRows = [{ object_key: foreignKey }]

    const res = await resolveKeys([foreignKey])
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.resolved).toEqual([])
    expect(json.invalid).toEqual([foreignKey])
    // The prefix mismatch is caught before the DB is ever asked about it.
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('rejects a key that matches the account prefix but has no completed row (unknown / private-mislabeled / pending)', async () => {
    const key = `${CALLER_ACCOUNT}/image/2026/09/never-uploaded.png`
    completedPrivateRows = []

    const res = await resolveKeys([key])
    const json = await res.json()

    expect(json.resolved).toEqual([])
    expect(json.invalid).toEqual([key])
  })
})
