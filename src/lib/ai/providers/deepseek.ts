import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const JSON_RETRY_ENFORCEMENT =
  '[INSTRUÇÃO ESTRUTURAL DE SISTEMA: Responda EXCLUSIVAMENTE com um objeto JSON válido contendo as chaves response_text, transfer_required, boundary_type, reason, context_summary, suggested_next_action e send_media, iniciando com { e terminando com }, sem blocos markdown e sem texto fora do JSON.]'

interface DeepSeekResponse {
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
    prompt_cache_miss_tokens?: number
  }
}

/**
 * Call DeepSeek's OpenAI-compatible Chat Completions endpoint with the caller's key.
 * Commercial model: DeepSeek-V4.1-Flash-1017
 * Official API model identifier: 'deepseek-flash'
 * Endpoint: https://api.deepseek.com/chat/completions
 *
 * Supports structured outputs (response_format: { type: 'json_object' }) and reasoning modes
 * (extracting content with reasoning_content fallback).
 * Parses prompt caching statistics (prompt_cache_hit_tokens) and token usage.
 */
export async function generateDeepSeek(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, structuredOutputRequired, maxOutputTokens } = args

  if (!apiKey || !apiKey.trim()) {
    throw new AiError('DeepSeek API key is required.', {
      code: 'missing_key',
      status: 400,
    })
  }

  const mergedMessages = mergeConsecutive(messages)
  const headers = {
    Authorization: `Bearer ${apiKey.trim()}`,
    'Content-Type': 'application/json',
  }

  let res: Response
  try {
    res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'deepseek-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergedMessages,
        ],
        max_tokens: maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        ...(structuredOutputRequired ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('DeepSeek', res)
  }

  let data = (await res.json().catch(() => null)) as DeepSeekResponse | null
  const choice = data?.choices?.[0]?.message
  let text = structuredOutputRequired
    ? (choice?.content ?? '')
    : (choice?.content || choice?.reasoning_content || '')

  if (structuredOutputRequired && (!text || typeof text !== 'string' || !text.trim())) {
    console.warn(
      '[deepseek] Empty content with json_object response_format; retrying without response_format and with strict JSON enforcement.',
    )
    const retryMessages = mergedMessages.map((m) => ({ ...m }))
    const lastIdx = retryMessages.length - 1
    if (lastIdx >= 0 && retryMessages[lastIdx].role === 'user') {
      retryMessages[lastIdx].content = `${retryMessages[lastIdx].content}\n\n${JSON_RETRY_ENFORCEMENT}`
    } else {
      retryMessages.push({ role: 'user', content: JSON_RETRY_ENFORCEMENT })
    }

    let retryRes: Response
    try {
      retryRes = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model || 'deepseek-flash',
          messages: [
            { role: 'system', content: systemPrompt },
            ...retryMessages,
          ],
          max_tokens: maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }

    if (!retryRes.ok) {
      throw await providerHttpError('DeepSeek', retryRes)
    }

    const retryData = (await retryRes.json().catch(() => null)) as DeepSeekResponse | null
    data = retryData
    text = retryData?.choices?.[0]?.message?.content ?? ''
  }

  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('DeepSeek returned an empty response.', {
      code: 'empty_response',
    })
  }

  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
    cached: data?.usage?.prompt_cache_hit_tokens,
  })

  return { text, usage }
}
