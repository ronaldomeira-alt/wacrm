import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import { getCachedOpenCodeModelSpec, type CatalogModel } from '../model-catalog'
import {
  buildRequestSignal,
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go/v1'

interface OpenCodeChatResponse {
  choices?: {
    message?: {
      content?: string | null
      reasoning_content?: string | null
    }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
    completion_tokens_details?: {
      reasoning_tokens?: number
    }
  }
}

interface OpenCodeMessagesResponse {
  content?: { type?: string; text?: string }[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
  }
}

interface OpenCodeResponsesApiResponse {
  output_text?: string
  output?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string }>
  }>
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

function pickReasoningEffort(
  spec: CatalogModel | null,
  preferred: 'low' | 'high' | 'max' = 'low',
): string | undefined {
  if (!spec) return preferred
  if (!spec.capabilities.reasoningSupported) return undefined
  const efforts = spec.capabilities.reasoningEfforts
  if (!efforts || efforts.length === 0) return undefined
  if (efforts.includes(preferred)) return preferred
  const priority = ['low', 'minimal', 'none', 'medium', 'high', 'xhigh', 'max']
  return priority.find((e) => efforts.includes(e)) ?? efforts[0]
}

/**
 * Call OpenCode Go using the model's recommended API protocol (`chat-completions`,
 * `messages`, or `responses`) and capability metadata from `/zen/go/v1/models`.
 */
export async function generateOpenCodeGo(
  args: ProviderArgs & { reasoningEffort?: 'low' | 'high' | 'max' },
): Promise<ProviderResult> {
  const {
    apiKey,
    model,
    systemPrompt,
    messages,
    timeoutMs,
    signal,
    sessionId,
    structuredOutputRequired,
    maxOutputTokens,
    reasoningEffort = 'low',
  } = args

  if (!apiKey || !apiKey.trim()) {
    throw new AiError('OpenCode Go API key is required.', {
      code: 'missing_key',
      status: 400,
    })
  }

  const resolvedModel = model?.trim() || 'glm-5.3-flash'
  const spec = getCachedOpenCodeModelSpec({
    modelId: resolvedModel,
    apiKey,
  })

  const apiKind = spec?.recommendedApi || 'chat-completions'
  const mergedMessages = mergeConsecutive(messages)
  const requestSignal = buildRequestSignal(timeoutMs, signal)
  const stableSessionId = sessionId?.trim() || 'wacrm-default-session'
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey.trim()}`,
    'Content-Type': 'application/json',
    'x-opencode-session': stableSessionId,
  }

  const effectiveMaxTokens = Math.min(
    maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    spec?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
  )

  if (apiKind === 'messages') {
    // Anthropic-compatible Messages API on OpenCode Go
    const normalized = [...mergedMessages]
    while (normalized.length > 0 && normalized[0].role === 'assistant') {
      normalized.shift()
    }
    const apiMessages =
      normalized.length > 0
        ? normalized
        : [{ role: 'user' as const, content: '(The customer has not sent a message yet.)' }]
    const prefillMessages = structuredOutputRequired
      ? [...apiMessages, { role: 'assistant' as const, content: '{' }]
      : apiMessages

    let res: Response
    try {
      res = await fetch(`${OPENCODE_GO_BASE}/messages`, {
        method: 'POST',
        headers: {
          ...headers,
          'x-api-key': apiKey.trim(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: resolvedModel,
          system: systemPrompt,
          max_tokens: effectiveMaxTokens,
          messages: prefillMessages,
        }),
        signal: requestSignal,
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) {
      throw await providerHttpError('OpenCode Go', res)
    }
    const data = (await res.json().catch(() => null)) as OpenCodeMessagesResponse | null
    let text = data?.content
      ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()
    if (!text) {
      throw new AiError('OpenCode Go returned an empty response.', {
        code: 'empty_response',
        status: 502,
      })
    }
    if (structuredOutputRequired && !text.startsWith('{')) {
      text = '{' + text
    }
    const usage = normalizeUsage({
      prompt: data?.usage?.input_tokens,
      completion: data?.usage?.output_tokens,
      cached: data?.usage?.cache_read_input_tokens,
    })
    return { text, usage }
  }

  if (apiKind === 'responses') {
    const effort = pickReasoningEffort(spec, reasoningEffort)
    const supportsStructured = spec ? spec.capabilities.structuredOutput : true

    let res: Response
    try {
      res = await fetch(`${OPENCODE_GO_BASE}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: resolvedModel,
          instructions: systemPrompt,
          input: mergedMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          max_output_tokens: effectiveMaxTokens,
          ...(effort ? { reasoning: { effort } } : {}),
          ...(structuredOutputRequired && supportsStructured
            ? { text: { format: { type: 'json_object' } } }
            : {}),
        }),
        signal: requestSignal,
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) {
      throw await providerHttpError('OpenCode Go', res)
    }
    const data = (await res.json().catch(() => null)) as OpenCodeResponsesApiResponse | null
    const text =
      (typeof data?.output_text === 'string' && data.output_text.trim()) ||
      (data?.output ?? [])
        .flatMap((item) => item.content ?? [])
        .filter((c) => c.type === 'output_text' || typeof c.text === 'string')
        .map((c) => c.text ?? '')
        .join('')
        .trim()

    if (!text) {
      throw new AiError('OpenCode Go returned an empty response.', {
        code: 'empty_response',
        status: 502,
      })
    }
    const usage = normalizeUsage({
      prompt: data?.usage?.input_tokens,
      completion: data?.usage?.output_tokens,
      total: data?.usage?.total_tokens,
      cached: data?.usage?.input_tokens_details?.cached_tokens,
      reasoning: data?.usage?.output_tokens_details?.reasoning_tokens,
    })
    return { text, usage }
  }

  // Default: OpenAI-compatible Chat Completions (`/zen/go/v1/chat/completions`)
  const effort = pickReasoningEffort(spec, reasoningEffort)
  const supportsStructured = spec ? spec.capabilities.structuredOutput : true

  let res: Response
  try {
    res = await fetch(`${OPENCODE_GO_BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: resolvedModel,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergedMessages,
        ],
        max_tokens: effectiveMaxTokens,
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(structuredOutputRequired && supportsStructured
          ? { response_format: { type: 'json_object' } }
          : {}),
      }),
      signal: requestSignal,
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenCode Go', res)
  }

  const data = (await res.json().catch(() => null)) as OpenCodeChatResponse | null
  const choice = data?.choices?.[0]?.message
  const text = structuredOutputRequired
    ? (choice?.content ?? '')
    : (choice?.content || choice?.reasoning_content || '')

  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenCode Go returned an empty response.', {
      code: 'empty_response',
      status: 502,
    })
  }

  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
    cached:
      data?.usage?.prompt_tokens_details?.cached_tokens ??
      data?.usage?.prompt_cache_hit_tokens,
    reasoning: data?.usage?.completion_tokens_details?.reasoning_tokens,
  })

  return { text, usage }
}
