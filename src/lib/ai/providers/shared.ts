import { AiError, type AiUsage, type ChatMessage } from '../types'

// ============================================================
// Bits shared by the OpenAI + Anthropic adapters.
// ============================================================

export interface ProviderArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
  /** Optional external AbortSignal (e.g., global budget or parent cancellation). */
  signal?: AbortSignal
  /** When true, the provider must be constrained to return valid JSON
   *  (the structured handoff-decision format) rather than free text. */
  structuredOutputRequired?: boolean
  /** Overrides defaults.ts's MAX_OUTPUT_TOKENS for this call — for a
   *  response shape (e.g. the learning scan's candidate array) that can
   *  legitimately need more room than a short conversational reply. */
  maxOutputTokens?: number
}

/** Combine an optional parent AbortSignal with a per-request timeoutMs. */
export function buildRequestSignal(timeoutMs: number, parentSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!parentSignal) return timeoutSignal
  return AbortSignal.any([parentSignal, timeoutSignal])
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown
  completion?: unknown
  total?: unknown
  cached?: unknown
  reasoning?: unknown
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const promptTokens = num(raw.prompt)
  const completionTokens = num(raw.completion)
  const total = num(raw.total)
  const cachedTokens = num(raw.cached)
  const reasoningTokens = num(raw.reasoning)
  const totalTokens = total > 0 ? total : promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  }
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new AiError('The AI provider took too long to respond or was aborted.', {
      code: 'timeout',
      status: 504,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  })
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string }
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? body?.message ?? '')
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  const lower = detail.toLowerCase()
  let code: string = 'provider_error'
  if (status === 401 || status === 403) {
    code = 'invalid_key'
  } else if (
    status === 402 ||
    lower.includes('insufficient') ||
    lower.includes('balance') ||
    lower.includes('credit')
  ) {
    code = 'insufficient_balance'
  } else if (status === 429) {
    code =
      lower.includes('quota') || lower.includes('monthly') || lower.includes('weekly') || lower.includes('exhausted')
        ? 'quota_exhausted'
        : 'rate_limited'
  } else if (
    status === 400 &&
    (lower.includes('context_length') || lower.includes('maximum context') || lower.includes('too many tokens'))
  ) {
    code = 'context_length_exceeded'
  } else if (status === 400 || status === 422) {
    code = 'invalid_request'
  }

  const base =
    code === 'invalid_key'
      ? `${provider} rejected the API key`
      : code === 'insufficient_balance'
        ? `${provider} insufficient balance`
        : code === 'quota_exhausted'
          ? `${provider} quota exhausted`
          : code === 'rate_limited'
            ? `${provider} rate limit reached`
            : `${provider} API error (${status})`

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    status: code === 'invalid_key' ? 401 : status === 400 || status === 422 ? 400 : 502,
  })
}

/**
 * Collapse consecutive same-role turns into one (joined with blank
 * lines). Anthropic requires strictly alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}
