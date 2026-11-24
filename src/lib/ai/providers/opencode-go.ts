import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  buildRequestSignal,
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const OPENCODE_GO_URL = 'https://opencode.ai/zen/go/v1/chat/completions'

interface OpenCodeGoResponse {
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
    prompt_tokens_details?: {
      cached_tokens?: number
    }
    completion_tokens_details?: {
      reasoning_tokens?: number
    }
  }
}

/**
 * Call OpenCode Go's OpenAI-compatible Chat Completions endpoint.
 * Default model: 'glm-5.3-flash' (Z.ai GLM 5.3 Flash).
 *
 * Explicitly sets `reasoning_effort: 'low'` so GLM-5.3-Flash does not default
 * to `max` thinking budget and exceed the 45s conversational timeout.
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

  const mergedMessages = mergeConsecutive(messages)
  const requestSignal = buildRequestSignal(timeoutMs, signal)
  const stableSessionId = sessionId?.trim() || 'wacrm-default-session'

  let res: Response
  try {
    res = await fetch(OPENCODE_GO_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
        'x-opencode-session': stableSessionId,
      },
      body: JSON.stringify({
        model: model || 'glm-5.3-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergedMessages,
        ],
        max_tokens: maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        reasoning_effort: reasoningEffort,
        ...(structuredOutputRequired ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: requestSignal,
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenCode Go', res)
  }

  const data = (await res.json().catch(() => null)) as OpenCodeGoResponse | null
  const choice = data?.choices?.[0]?.message
  const text = choice?.content ?? ''

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
    cached: data?.usage?.prompt_tokens_details?.cached_tokens,
    reasoning: data?.usage?.completion_tokens_details?.reasoning_tokens,
  })

  return { text, usage }
}
