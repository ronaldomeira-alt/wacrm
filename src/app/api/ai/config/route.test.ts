import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = {
  existingRow: null as Record<string, unknown> | null,
  getRow: null as Record<string, unknown> | null,
  lastUpdate: null as Record<string, unknown> | null,
  lastInsert: null as Record<string, unknown> | null,
}

function createMockSupabase() {
  return {
    from(table: string) {
      if (table === 'ai_configs') {
        return {
          select(cols: string) {
            return {
              eq() {
                return {
                  maybeSingle: async () => {
                    if (cols.includes('opencode_go_api_key')) {
                      return { data: mockState.getRow, error: null }
                    }
                    return { data: mockState.existingRow, error: null }
                  },
                }
              },
            }
          },
          update(payload: Record<string, unknown>) {
            mockState.lastUpdate = payload
            return {
              eq: async () => ({ error: null }),
            }
          },
          insert(payload: Record<string, unknown>) {
            mockState.lastInsert = payload
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'profiles') {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({ data: { user_id: 'member-1' }, error: null }),
                    }
                  },
                }
              },
            }
          },
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  }
}

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: vi.fn(async () => ({
    supabase: createMockSupabase(),
    accountId: 'acc-1',
    userId: 'user-1',
    role: 'admin',
  })),
  requireRole: vi.fn(async () => ({
    supabase: createMockSupabase(),
    accountId: 'acc-1',
    userId: 'user-1',
    role: 'admin',
  })),
  toErrorResponse: vi.fn((err: unknown) => {
    throw err
  }),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ success: true })),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => v.replace(/^enc:/, '')),
}))

vi.mock('@/lib/ai/validate', () => ({
  validateAiCredentials: vi.fn(async () => undefined),
}))

vi.mock('@/lib/ai/embeddings', () => ({
  embedTexts: vi.fn(async () => [[0.1]]),
}))

import { GET, POST } from './route'

describe('/api/ai/config partial update & credential safety', () => {
  beforeEach(() => {
    mockState.existingRow = {
      id: 'cfg-1',
      provider: 'deepseek',
      model: 'deepseek-flash',
      api_key: 'enc:sk-openai',
      deepseek_api_key: 'enc:sk-deepseek',
    }
    mockState.getRow = null
    mockState.lastUpdate = null
    mockState.lastInsert = null
  })

  it('GET strips all encrypted keys including opencode_go_api_key and returns boolean has_* flags', async () => {
    mockState.getRow = {
      provider: 'opencode_go',
      model: 'glm-5.3-flash',
      api_key: 'enc:secret-openai',
      deepseek_api_key: 'enc:secret-deepseek',
      opencode_go_api_key: 'enc:secret-opencode',
      embeddings_api_key: 'enc:secret-embed',
      is_active: true,
      auto_reply_enabled: true,
      auto_reply_max_per_conversation: 12,
      safety_message_limit: 10,
      system_prompt: 'Legacy context',
    }

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.configured).toBe(true)
    expect(json.has_key).toBe(true)
    expect(json.has_deepseek_key).toBe(true)
    expect(json.has_opencode_go_key).toBe(true)
    expect(json.has_embeddings_key).toBe(true)
    expect(json.api_key).toBeUndefined()
    expect(json.deepseek_api_key).toBeUndefined()
    expect(json.opencode_go_api_key).toBeUndefined()
    expect(json.embeddings_api_key).toBeUndefined()
  })

  it('POST from Behavior panel (omitting system_prompt and auto_reply_max_per_conversation) does NOT wipe or reset them', async () => {
    const req = new Request('http://localhost/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity_name: 'Clara',
        tone_style: 'consultative_warm',
        is_active: true,
        auto_reply_enabled: true,
        safety_message_limit: 12,
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockState.lastUpdate).not.toBeNull()
    expect(mockState.lastUpdate).not.toHaveProperty('system_prompt')
    expect(mockState.lastUpdate).not.toHaveProperty('auto_reply_max_per_conversation')
    expect(mockState.lastUpdate?.safety_message_limit).toBe(12)
    expect(mockState.lastUpdate?.is_active).toBe(true)
    expect(mockState.lastUpdate?.auto_reply_enabled).toBe(true)
  })

  it('POST from Credentials panel (only embeddings_api_key) does NOT flip is_active or auto_reply_enabled to false', async () => {
    const req = new Request('http://localhost/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeddings_api_key: 'sk-embed-new',
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockState.lastUpdate).not.toHaveProperty('is_active')
    expect(mockState.lastUpdate).not.toHaveProperty('auto_reply_enabled')
    expect(mockState.lastUpdate).not.toHaveProperty('system_prompt')
    expect(mockState.lastUpdate).not.toHaveProperty('auto_reply_max_per_conversation')
    expect(mockState.lastUpdate).not.toHaveProperty('safety_message_limit')
    expect(mockState.lastUpdate?.embeddings_api_key).toBe('enc:sk-embed-new')
  })

  it('POST preserves distinct limits: editing auto_reply_max_per_conversation does NOT overwrite safety_message_limit', async () => {
    const req = new Request('http://localhost/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auto_reply_max_per_conversation: 15,
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockState.lastUpdate?.auto_reply_max_per_conversation).toBe(15)
    expect(mockState.lastUpdate).not.toHaveProperty('safety_message_limit')
  })

  it('POST distinguishes omitted vs explicitly cleared system_prompt (null or empty string)', async () => {
    const req = new Request('http://localhost/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_prompt: '',
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockState.lastUpdate).toHaveProperty('system_prompt', null)
  })

  it('POST validates standalone api_key against api_key_provider when active provider is opencode_go', async () => {
    const { validateAiCredentials } = await import('@/lib/ai/validate')
    const validateMock = vi.mocked(validateAiCredentials)
    validateMock.mockClear()

    mockState.existingRow = {
      id: 'cfg-1',
      provider: 'opencode_go',
      model: 'glm-5.3-flash',
      api_key: null,
      deepseek_api_key: null,
    }

    const req = new Request('http://localhost/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: 'sk-openai-fallback',
        api_key_provider: 'openai',
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(validateMock).toHaveBeenCalledTimes(1)
    expect(validateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        apiKey: 'sk-openai-fallback',
      }),
    )
    expect(mockState.lastUpdate?.provider).toBe('opencode_go')
    expect(mockState.lastUpdate?.api_key).toBe('enc:sk-openai-fallback')
    expect(mockState.lastUpdate).not.toHaveProperty('is_active')
  })

  it('POST on initial creation (no existing row) applies standard defaults', async () => {
    mockState.existingRow = null
    const req = new Request('http://localhost/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-5.4-mini',
        api_key: 'sk-test-123',
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockState.lastInsert).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      system_prompt: null,
      is_active: false,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
      safety_message_limit: 8,
    })
  })
})
