import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearModelCatalogCache,
  fetchOpenCodeGoCatalog,
  parseOpenCodeModelsPayload,
} from './model-catalog'
import { executeAiInference } from './provider-manager'
import * as opencodeProvider from './providers/opencode-go'
import * as deepseekProvider from './providers/deepseek'

describe('model-catalog', () => {
  afterEach(() => {
    clearModelCatalogCache()
    vi.restoreAllMocks()
  })

  it('filters chat-compatible models, excludes embeddings/decisions, and preserves capabilities', () => {
    const models = parseOpenCodeModelsPayload({
      data: [
        {
          id: 'deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash 1017',
          type: 'chat',
          recommended_api: 'chat-completions',
          capabilities: {
            reasoning: { supported: true, effort: ['low', 'high', 'max'] },
            structured_output: true,
          },
          limit: { context: 1000000, output: 384000 },
          api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/go/openai/v1' } },
          go: { featured: true },
        },
        {
          id: 'mimo-v2.6-flash',
          name: 'MiMo-V2.6-Flash',
          type: 'chat',
          recommended_api: 'chat-completions',
          capabilities: {
            reasoning: { supported: true },
          },
          limit: { context: 131072, output: 131072 },
          api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/go/openai/v1' } },
        },
        {
          id: 'text-embedding-3-small',
          name: 'text-embedding-3-small',
          type: 'embedding',
          recommended_api: 'embeddings',
          api: { embeddings: {} },
        },
        {
          id: 'jev-1.14',
          name: 'Jev 1.14',
          type: 'decision',
          recommended_api: 'systemone',
          api: { systemone: {} },
        },
      ],
    })

    expect(models.map((m) => m.id)).toEqual(['deepseek-v4.1-flash', 'mimo-v2.6-flash'])
    expect(models[0].capabilities.structuredOutput).toBe(true)
    expect(models[0].capabilities.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(models[1].capabilities.structuredOutput).toBe(false)
    expect(models[1].capabilities.reasoningEfforts).toEqual([])
  })

  it('caches live catalog and supports manual forceRefresh', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'glm-5.3-flash',
                name: 'GLM-5.3-Flash',
                type: 'chat',
                recommended_api: 'chat-completions',
                api: { 'chat-completions': {} },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )

    const first = await fetchOpenCodeGoCatalog({ apiKey: 'oc-test-key' })
    expect(first.source).toBe('live')
    expect(first.models).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const second = await fetchOpenCodeGoCatalog({ apiKey: 'oc-test-key' })
    expect(second.source).toBe('cache')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const refreshed = await fetchOpenCodeGoCatalog({
      apiKey: 'oc-test-key',
      forceRefresh: true,
    })
    expect(refreshed.source).toBe('live')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('supports DeepSeek V4.1 Flash on OpenCode Go with DeepSeek official API fallback without conflict', async () => {
    vi.spyOn(opencodeProvider, 'generateOpenCodeGo').mockRejectedValueOnce(
      Object.assign(new Error('OpenCode timeout'), {
        name: 'AiError',
        code: 'timeout',
        status: 504,
      }),
    )
    vi.spyOn(deepseekProvider, 'generateDeepSeek').mockResolvedValueOnce({
      text: '{"response_text":"Oi! Tudo bem?","transfer_required":false}',
      usage: {
        promptTokens: 120,
        completionTokens: 25,
        totalTokens: 145,
        cachedTokens: 60,
        reasoningTokens: 0,
      },
    })

    const res = await executeAiInference({
      config: {
        provider: 'opencode_go',
        model: 'deepseek-v4.1-flash',
        apiKey: 'oc-key',
        opencodeGoApiKey: 'oc-key',
        deepseekApiKey: 'ds-key',
        fallbackEnabled: true,
        secondaryProvider: 'deepseek',
        secondaryModel: 'deepseek-flash',
        primaryTimeoutMs: 45_000,
        secondaryTimeoutMs: 45_000,
      },
      mode: 'playground',
      systemPrompt: 'Responda em json.',
      messages: [{ role: 'user', content: 'Olá' }],
      structuredOutputRequired: true,
      bypassCircuitBreaker: true,
      logUsage: false,
    })

    expect(res.provider).toBe('deepseek')
    expect(res.model).toBe('deepseek-flash')
    expect(res.fallbackUsed).toBe(true)
    expect(res.attemptCount).toBe(2)
  })
})
