import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// resolveMediaUrlForSend — what send-message.ts and template-header-handle.ts
// call right before Meta needs to fetch a media URL. Covers scenarios 8/9
// from the validation list:
//   8. Meta can fetch public media through the WACRM public-media URL
//      (resolved in-process to a real signed R2 URL, not the redirect route
//      itself — avoids the redirect:'manual' interaction bug).
//   9. Private media still goes out to Meta via a short-TTL signed URL.
// Plus: a legacy https:// value (Supabase URL / pasted external link)
// passes through completely unchanged.
// ---------------------------------------------------------------------------

process.env.NEXT_PUBLIC_SITE_URL = 'https://crmronaldomeira.com'
process.env.R2_ACCOUNT_ID = 'acct'
process.env.R2_ACCESS_KEY_ID = 'key'
process.env.R2_SECRET_ACCESS_KEY = 'secret'
process.env.R2_BUCKET = 'wacrm-media'
process.env.R2_ENDPOINT = 'https://acct.r2.cloudflarestorage.com'

let publicRow: { object_key: string } | null = null

vi.mock('@/lib/storage/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = vi.fn(chain)
      b.eq = vi.fn(chain)
      b.maybeSingle = vi.fn(async () => ({ data: publicRow, error: null }))
      return b
    },
  }),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: { input: { Key: string } }) =>
    `https://fake-r2-endpoint.example/signed/${command.input.Key}`,
  ),
}))

import { resolveMediaUrlForSend } from './resolve-media-for-send'

describe('resolveMediaUrlForSend', () => {
  beforeEach(() => {
    publicRow = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('passes a legacy Supabase / pasted external https:// URL through unchanged', async () => {
    const url = 'https://example.supabase.co/storage/v1/object/public/chat-media/x.png'
    await expect(resolveMediaUrlForSend(url)).resolves.toBe(url)
  })

  it('scenario 8: resolves our own public-media URL in-process to a real signed R2 URL (no HTTP round trip to ourselves)', async () => {
    const key = 'acct-A/image/2026/09/header.png'
    publicRow = { object_key: key }
    const publicUrl = `https://crmronaldomeira.com/api/media/public/${key}`

    const resolved = await resolveMediaUrlForSend(publicUrl)

    expect(resolved).toBe(`https://fake-r2-endpoint.example/signed/${key}`)
    // Never the redirect route itself — Meta (and ensureImageHeaderHandle's
    // redirect:'manual' fetch) gets something directly GET-able.
    expect(resolved).not.toContain('/api/media/public/')
  })

  it('scenario 8 (failure mode): throws if the public key was tampered with or no longer exists', async () => {
    publicRow = null
    const publicUrl = 'https://crmronaldomeira.com/api/media/public/acct-A/image/2026/09/gone.png'
    await expect(resolveMediaUrlForSend(publicUrl)).rejects.toThrow()
  })

  it('scenario 9: resolves a bare private R2 key to a short-TTL signed URL', async () => {
    const key = 'acct-A/document/2026/09/contrato.pdf'
    const resolved = await resolveMediaUrlForSend(key)
    expect(resolved).toBe(`https://fake-r2-endpoint.example/signed/${key}`)
  })

  it('passes the Meta inbound proxy path through unchanged (defensive — never actually reached in practice)', async () => {
    const proxyPath = '/api/whatsapp/media/12345'
    await expect(resolveMediaUrlForSend(proxyPath)).resolves.toBe(proxyPath)
  })
})
