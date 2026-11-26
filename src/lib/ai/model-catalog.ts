import { createHash } from 'crypto'
import type { AiProvider } from './types'

export type OpenCodeRecommendedApi =
  | 'chat-completions'
  | 'messages'
  | 'responses'
  | 'interactions'
  | string

export interface CatalogModelCapabilities {
  reasoningSupported: boolean
  reasoningEfforts: string[]
  reasoningToggle: boolean
  structuredOutput: boolean
  reasoningField?: string
}

export interface CatalogModel {
  id: string
  name: string
  provider: AiProvider
  type: 'chat'
  recommendedApi: OpenCodeRecommendedApi
  apis: string[]
  baseUrl?: string
  capabilities: CatalogModelCapabilities
  maxOutputTokens?: number
  contextWindow?: number
  featured?: boolean
  description?: string
  cost?: {
    inputPer1M?: number
    outputPer1M?: number
    cacheReadPer1M?: number
    cacheWritePer1M?: number
    hasPeakMultiplier?: boolean
  }
}

export interface ProviderCatalogResult {
  provider: AiProvider
  models: CatalogModel[]
  source: 'live' | 'cache' | 'fallback' | 'static'
  cachedAt: string | null
  error?: string
}

const OPENCODE_GO_MODEL_ENDPOINTS = [
  'https://opencode.ai/zen/go/v1/models',
  'https://opencode.ai/inference/go/v1/models',
]

const CATALOG_TTL_MS = 15 * 60 * 1000 // 15 minutes

interface CacheEntry {
  models: CatalogModel[]
  cachedAt: string
  expiresAt: number
}

const catalogCache = new Map<string, CacheEntry>()

function keyFingerprint(apiKey?: string | null): string {
  if (!apiKey || !apiKey.trim()) return 'anon'
  return createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 12)
}

export function clearModelCatalogCache(): void {
  catalogCache.clear()
}

const STATIC_CATALOGS: Record<Exclude<AiProvider, 'opencode_go'>, CatalogModel[]> = {
  deepseek: [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek V4.1 Flash 1017',
      provider: 'deepseek',
      type: 'chat',
      recommendedApi: 'chat-completions',
      apis: ['chat-completions'],
      capabilities: {
        reasoningSupported: true,
        reasoningEfforts: ['low', 'high', 'max'],
        reasoningToggle: false,
        structuredOutput: true,
        reasoningField: 'reasoning_content',
      },
      featured: true,
    },
    {
      id: 'deepseek-chat',
      name: 'DeepSeek Chat',
      provider: 'deepseek',
      type: 'chat',
      recommendedApi: 'chat-completions',
      apis: ['chat-completions'],
      capabilities: {
        reasoningSupported: false,
        reasoningEfforts: [],
        reasoningToggle: false,
        structuredOutput: true,
      },
    },
    {
      id: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner',
      provider: 'deepseek',
      type: 'chat',
      recommendedApi: 'chat-completions',
      apis: ['chat-completions'],
      capabilities: {
        reasoningSupported: true,
        reasoningEfforts: ['high', 'max'],
        reasoningToggle: false,
        structuredOutput: true,
        reasoningField: 'reasoning_content',
      },
    },
  ],
  openai: [
    {
      id: 'gpt-5.4-mini',
      name: 'GPT-5.4 Mini',
      provider: 'openai',
      type: 'chat',
      recommendedApi: 'chat-completions',
      apis: ['chat-completions'],
      capabilities: {
        reasoningSupported: true,
        reasoningEfforts: ['low', 'medium', 'high'],
        reasoningToggle: false,
        structuredOutput: true,
      },
      featured: true,
    },
    {
      id: 'gpt-4.1-mini',
      name: 'GPT-4.1 Mini',
      provider: 'openai',
      type: 'chat',
      recommendedApi: 'chat-completions',
      apis: ['chat-completions'],
      capabilities: {
        reasoningSupported: false,
        reasoningEfforts: [],
        reasoningToggle: false,
        structuredOutput: true,
      },
    },
    {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      provider: 'openai',
      type: 'chat',
      recommendedApi: 'chat-completions',
      apis: ['chat-completions'],
      capabilities: {
        reasoningSupported: false,
        reasoningEfforts: [],
        reasoningToggle: false,
        structuredOutput: true,
      },
    },
    {
      id: 'gpt-4o-mini',
      name: 'GPT-4o Mini',
      provider: 'openai',
      type: 'chat',
      recommendedApi: 'chat-completions',
      apis: ['chat-completions'],
      capabilities: {
        reasoningSupported: false,
        reasoningEfforts: [],
        reasoningToggle: false,
        structuredOutput: true,
      },
    },
    {
      id: 'gpt-4o',
      name: 'GPT-4o',
      provider: 'openai',
      type: 'chat',
      recommendedApi: 'chat-completions',
      apis: ['chat-completions'],
      capabilities: {
        reasoningSupported: false,
        reasoningEfforts: [],
        reasoningToggle: false,
        structuredOutput: true,
      },
    },
    {
      id: 'o4-mini',
      name: 'o4-mini',
      provider: 'openai',
      type: 'chat',
      recommendedApi: 'chat-completions',
      apis: ['chat-completions'],
      capabilities: {
        reasoningSupported: true,
        reasoningEfforts: ['low', 'medium', 'high'],
        reasoningToggle: false,
        structuredOutput: true,
      },
    },
  ],
  anthropic: [
    {
      id: 'claude-haiku-4-5-20251001',
      name: 'Claude Haiku 4.5',
      provider: 'anthropic',
      type: 'chat',
      recommendedApi: 'messages',
      apis: ['messages'],
      capabilities: {
        reasoningSupported: true,
        reasoningEfforts: ['low', 'medium', 'high'],
        reasoningToggle: true,
        structuredOutput: true,
      },
      featured: true,
    },
    {
      id: 'claude-3-5-haiku-latest',
      name: 'Claude 3.5 Haiku',
      provider: 'anthropic',
      type: 'chat',
      recommendedApi: 'messages',
      apis: ['messages'],
      capabilities: {
        reasoningSupported: false,
        reasoningEfforts: [],
        reasoningToggle: false,
        structuredOutput: true,
      },
    },
    {
      id: 'claude-sonnet-4-5-20250929',
      name: 'Claude Sonnet 4.5',
      provider: 'anthropic',
      type: 'chat',
      recommendedApi: 'messages',
      apis: ['messages'],
      capabilities: {
        reasoningSupported: true,
        reasoningEfforts: ['low', 'medium', 'high'],
        reasoningToggle: true,
        structuredOutput: true,
      },
    },
    {
      id: 'claude-3-5-sonnet-latest',
      name: 'Claude 3.5 Sonnet',
      provider: 'anthropic',
      type: 'chat',
      recommendedApi: 'messages',
      apis: ['messages'],
      capabilities: {
        reasoningSupported: false,
        reasoningEfforts: [],
        reasoningToggle: false,
        structuredOutput: true,
      },
    },
  ],
}

const OPENCODE_GO_FALLBACK: CatalogModel[] = [
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    provider: 'opencode_go',
    type: 'chat',
    recommendedApi: 'chat-completions',
    apis: ['chat-completions'],
    capabilities: {
      reasoningSupported: true,
      reasoningEfforts: ['low', 'high', 'max'],
      reasoningToggle: false,
      structuredOutput: true,
      reasoningField: 'reasoning_content',
    },
    maxOutputTokens: 131072,
    featured: true,
  },
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash 1017',
    provider: 'opencode_go',
    type: 'chat',
    recommendedApi: 'chat-completions',
    apis: ['chat-completions'],
    capabilities: {
      reasoningSupported: true,
      reasoningEfforts: ['low', 'high', 'max'],
      reasoningToggle: false,
      structuredOutput: true,
      reasoningField: 'reasoning_content',
    },
    maxOutputTokens: 384000,
    featured: true,
  },
]

interface RawOpenCodeModel {
  id?: string
  name?: string
  type?: string
  description?: string
  recommended_api?: string
  limit?: { context?: number; output?: number }
  capabilities?: {
    reasoning?: {
      supported?: boolean
      effort?: string[]
      toggle?: boolean
    }
    structured_output?: boolean
  }
  cost?: {
    text?: {
      input?: { price?: number; cache?: { read?: number; write?: number } }
      output?: { price?: number }
    }
    multipliers?: Array<{ factor?: number }>
  }
  api?: Record<
    string,
    {
      base_url?: string
      compatibility?: { reasoning_field?: string }
    }
  >
  go?: { featured?: boolean }
}

const SUPPORTED_OPENCODE_APIS = new Set(['chat-completions', 'messages', 'responses'])

export function parseOpenCodeModelsPayload(payload: unknown): CatalogModel[] {
  const rawList =
    payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data as RawOpenCodeModel[])
      : []

  const parsed: CatalogModel[] = []
  for (const item of rawList) {
    if (!item || typeof item.id !== 'string' || !item.id.trim()) continue
    // Only conversational chat models are selectable in Providers / Playground
    if (item.type && item.type !== 'chat') continue

    const apis = item.api ? Object.keys(item.api) : []
    const recommendedApi = item.recommended_api || apis[0] || 'chat-completions'

    // Skip models that only expose unsupported non-standard APIs (e.g., interactions-only)
    const hasSupportedApi =
      SUPPORTED_OPENCODE_APIS.has(recommendedApi) ||
      apis.some((a) => SUPPORTED_OPENCODE_APIS.has(a))
    if (!hasSupportedApi) continue

    const effectiveApi = SUPPORTED_OPENCODE_APIS.has(recommendedApi)
      ? recommendedApi
      : apis.find((a) => SUPPORTED_OPENCODE_APIS.has(a)) || 'chat-completions'

    const apiMeta = item.api?.[effectiveApi]
    const reasoning = item.capabilities?.reasoning

    parsed.push({
      id: item.id.trim(),
      name: (typeof item.name === 'string' && item.name.trim()) || item.id.trim(),
      provider: 'opencode_go',
      type: 'chat',
      recommendedApi: effectiveApi,
      apis,
      baseUrl: apiMeta?.base_url,
      capabilities: {
        reasoningSupported: Boolean(reasoning?.supported),
        reasoningEfforts: Array.isArray(reasoning?.effort) ? reasoning.effort : [],
        reasoningToggle: Boolean(reasoning?.toggle),
        structuredOutput: item.capabilities?.structured_output === true,
        reasoningField: apiMeta?.compatibility?.reasoning_field,
      },
      maxOutputTokens:
        typeof item.limit?.output === 'number' && item.limit.output > 0
          ? item.limit.output
          : undefined,
      contextWindow:
        typeof item.limit?.context === 'number' && item.limit.context > 0
          ? item.limit.context
          : undefined,
      featured: Boolean(item.go?.featured),
      description: typeof item.description === 'string' ? item.description : undefined,
      cost: item.cost?.text
        ? {
            inputPer1M: item.cost.text.input?.price,
            outputPer1M: item.cost.text.output?.price,
            cacheReadPer1M: item.cost.text.input?.cache?.read,
            cacheWritePer1M: item.cost.text.input?.cache?.write,
            hasPeakMultiplier: Array.isArray(item.cost.multipliers) && item.cost.multipliers.some((m) => m.factor === 2),
          }
        : undefined,
    })
  }

  // Sort featured first, then alphabetically by friendly name
  return parsed.sort((a, b) => {
    if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1
    return a.name.localeCompare(b.name, 'pt-BR')
  })
}

export async function fetchOpenCodeGoCatalog(args?: {
  apiKey?: string | null
  forceRefresh?: boolean
}): Promise<ProviderCatalogResult> {
  const apiKey = args?.apiKey?.trim() || ''
  const cacheKey = `opencode_go:${keyFingerprint(apiKey)}`
  const now = Date.now()

  if (!args?.forceRefresh) {
    const hit = catalogCache.get(cacheKey)
    if (hit && hit.expiresAt > now) {
      return {
        provider: 'opencode_go',
        models: hit.models,
        source: 'cache',
        cachedAt: hit.cachedAt,
      }
    }
  }

  let lastError = 'Falha ao consultar catálogo OpenCode Go'
  for (const endpoint of OPENCODE_GO_MODEL_ENDPOINTS) {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`
      }
      const res = await fetch(endpoint, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        lastError = `HTTP ${res.status} em ${endpoint}`
        continue
      }
      const json = await res.json().catch(() => null)
      const models = parseOpenCodeModelsPayload(json)
      if (models.length === 0) {
        lastError = `Catálogo vazio retornado por ${endpoint}`
        continue
      }
      const cachedAt = new Date().toISOString()
      catalogCache.set(cacheKey, {
        models,
        cachedAt,
        expiresAt: Date.now() + CATALOG_TTL_MS,
      })
      return {
        provider: 'opencode_go',
        models,
        source: 'live',
        cachedAt,
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  // Fallback to stale cache if available, otherwise curated minimal fallback
  const stale = catalogCache.get(cacheKey)
  if (stale && stale.models.length > 0) {
    return {
      provider: 'opencode_go',
      models: stale.models,
      source: 'cache',
      cachedAt: stale.cachedAt,
      error: lastError,
    }
  }

  return {
    provider: 'opencode_go',
    models: OPENCODE_GO_FALLBACK,
    source: 'fallback',
    cachedAt: null,
    error: lastError,
  }
}

export async function getProviderModelCatalog(args: {
  provider: AiProvider
  apiKey?: string | null
  forceRefresh?: boolean
}): Promise<ProviderCatalogResult> {
  if (args.provider === 'opencode_go') {
    return fetchOpenCodeGoCatalog({
      apiKey: args.apiKey,
      forceRefresh: args.forceRefresh,
    })
  }

  return {
    provider: args.provider,
    models: STATIC_CATALOGS[args.provider] ?? [],
    source: 'static',
    cachedAt: null,
  }
}

export function getCachedOpenCodeModelSpec(args: {
  modelId: string
  apiKey?: string | null
}): CatalogModel | null {
  const apiKey = args.apiKey?.trim() || ''
  const exact = catalogCache.get(`opencode_go:${keyFingerprint(apiKey)}`)
  if (exact) {
    const found = exact.models.find((m) => m.id === args.modelId)
    if (found) return found
  }
  for (const entry of catalogCache.values()) {
    const found = entry.models.find((m) => m.id === args.modelId)
    if (found) return found
  }
  return OPENCODE_GO_FALLBACK.find((m) => m.id === args.modelId) ?? null
}

export async function getOpenCodeModelSpec(args: {
  modelId: string
  apiKey?: string | null
}): Promise<CatalogModel | null> {
  const cached = getCachedOpenCodeModelSpec(args)
  if (cached) return cached
  const catalog = await fetchOpenCodeGoCatalog({ apiKey: args.apiKey })
  return catalog.models.find((m) => m.id === args.modelId) ?? null
}
