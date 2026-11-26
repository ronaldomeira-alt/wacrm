import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeAiInference } from './provider-manager'
import { calculateInferenceCost } from './pricing'
import {
  checkOpenCodeGoQuotaGate,
  clearOpenCodeQuotaCache,
} from './opencode-quota'
import { isEligibleForFallback, isImmediateTripError } from './circuit-breaker'
import { computeNextAttemptAt } from './reply-queue'
import { AiError, type AiConfig } from './types'
import * as opencodeProvider from './providers/opencode-go'
import * as deepseekProvider from './providers/deepseek'

function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'opencode_go',
    model: 'glm-5.3-flash',
    apiKey: 'oc-key',
    opencodeGoApiKey: 'oc-key',
    deepseekApiKey: 'ds-key',
    fallbackEnabled: true,
    secondaryProvider: 'deepseek',
    secondaryModel: 'deepseek-flash',
    primaryTimeoutMs: 45_000,
    secondaryTimeoutMs: 45_000,
    opencode5hPreventiveEnabled: false,
    opencode5hPreventivePct: 90,
    opencodeWeeklyPreventiveEnabled: true,
    opencodeWeeklyPreventivePct: 90,
    opencodeMonthlyPreventiveEnabled: false,
    opencodeMonthlyPreventivePct: 90,
    circuitFailureThreshold: 3,
    circuitCooldownSeconds: 120,
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 10,
    handoffAgentId: null,
    embeddingsApiKey: 'emb-key-untouched',
    ...overrides,
  }
}

describe('AI Resilience, Fallback & Quota Guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    clearOpenCodeQuotaCache()
  })

  it('triggers immediate fallback from OpenCode Go to DeepSeek on 429/5xx/401/empty_response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          rolling5h: { usagePercent: 10 },
          weekly: { usagePercent: 20 },
          monthly: { usagePercent: 30 },
        }),
        { status: 200 },
      ),
    )

    for (const code of ['rate_limited', 'provider_error', 'invalid_key', 'empty_response', 'timeout']) {
      vi.spyOn(opencodeProvider, 'generateOpenCodeGo').mockRejectedValueOnce(
        new AiError(`fail ${code}`, { code, status: 502 }),
      )
      vi.spyOn(deepseekProvider, 'generateDeepSeek').mockResolvedValueOnce({
        text: JSON.stringify({ response_text: 'Resposta Clara via DeepSeek', transfer_required: false }),
        usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125, cachedTokens: 40 },
      })

      const res = await executeAiInference({
        config: makeConfig(),
        mode: 'auto_reply',
        systemPrompt: 'Clara',
        messages: [{ role: 'user', content: 'Oi' }],
      })

      expect(res.provider).toBe('deepseek')
      expect(res.fallbackUsed).toBe(true)
      expect(res.attemptCount).toBe(2)
      expect(res.text).toContain('Resposta Clara via DeepSeek')
    }
  })

  it('uses full capacity on disabled windows (5h/monthly at 95%) and triggers fallback at weekly >= 90% or any 100% exhaustion', async () => {
    // 1. 5h and monthly at 95% with preventive disabled, weekly at 50% -> MUST allow OpenCode Go
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rolling5h: { usagePercent: 95, resetInSec: 1200 },
          weekly: { usagePercent: 50 },
          monthly: { usagePercent: 95 },
        }),
        { status: 200 },
      ),
    )
    const ocSpy = vi.spyOn(opencodeProvider, 'generateOpenCodeGo').mockResolvedValueOnce({
      text: 'Resposta normal GLM 5.3',
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    })

    const okRes = await executeAiInference({
      config: makeConfig(),
      mode: 'auto_reply',
      systemPrompt: 'Clara',
      messages: [{ role: 'user', content: 'Olá' }],
    })
    expect(ocSpy).toHaveBeenCalledTimes(1)
    expect(okRes.provider).toBe('opencode_go')

    // 2. Weekly at 92% (>= 90% preventive enabled) -> triggers immediate fallback to DeepSeek
    clearOpenCodeQuotaCache()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rolling5h: { usagePercent: 10 },
          weekly: { usagePercent: 92, resetInSec: 3600 },
          monthly: { usagePercent: 40 },
        }),
        { status: 200 },
      ),
    )
    const dsSpy = vi.spyOn(deepseekProvider, 'generateDeepSeek').mockResolvedValueOnce({
      text: 'Atendimento contínuo via DeepSeek',
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    })

    const fallbackRes = await executeAiInference({
      config: makeConfig(),
      mode: 'auto_reply',
      systemPrompt: 'Clara',
      messages: [{ role: 'user', content: 'Olá' }],
    })
    expect(ocSpy).toHaveBeenCalledTimes(1) // not called a second time
    expect(dsSpy).toHaveBeenCalledTimes(1)
    expect(fallbackRes.provider).toBe('deepseek')
    expect(fallbackRes.fallbackUsed).toBe(true)

    // 3. Real exhaustion (100%) on 5h even with preventive disabled -> triggers immediate fallback
    clearOpenCodeQuotaCache()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rolling5h: { usagePercent: 100, resetInSec: 600 },
          weekly: { usagePercent: 20 },
          monthly: { usagePercent: 20 },
        }),
        { status: 200 },
      ),
    )
    dsSpy.mockResolvedValueOnce({
      text: 'Fallback por esgotamento real de 5h',
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    })
    const exhaustedRes = await executeAiInference({
      config: makeConfig(),
      mode: 'auto_reply',
      systemPrompt: 'Clara',
      messages: [{ role: 'user', content: 'Oi' }],
    })
    expect(exhaustedRes.provider).toBe('deepseek')
    expect(exhaustedRes.fallbackUsed).toBe(true)
  })

  it('does NOT treat unavailable OpenCode quota endpoint as quota exhaustion (fail-open)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const gate = await checkOpenCodeGoQuotaGate({
      apiKey: 'oc-key',
      bypassCache: true,
    })
    expect(gate.allowed).toBe(true)
    expect(gate.quotaExhausted).toBe(false)
    expect(gate.snapshot.status).toBe('unavailable')
  })

  it('supports manual provider priority inversion (DeepSeek primary -> OpenCode Go fallback)', async () => {
    vi.spyOn(deepseekProvider, 'generateDeepSeek').mockRejectedValueOnce(
      new AiError('timeout', { code: 'timeout', status: 504 }),
    )
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rolling5h: { usagePercent: 5 },
          weekly: { usagePercent: 10 },
          monthly: { usagePercent: 15 },
        }),
        { status: 200 },
      ),
    )
    vi.spyOn(opencodeProvider, 'generateOpenCodeGo').mockResolvedValueOnce({
      text: 'Resposta via GLM 5.3 Flash',
      usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
    })

    const res = await executeAiInference({
      config: makeConfig({
        provider: 'deepseek',
        model: 'deepseek-flash',
        secondaryProvider: 'opencode_go',
        secondaryModel: 'glm-5.3-flash',
      }),
      mode: 'auto_reply',
      systemPrompt: 'Clara',
      messages: [{ role: 'user', content: 'Tem apartamento?' }],
    })

    expect(res.provider).toBe('opencode_go')
    expect(res.fallbackUsed).toBe(true)
  })

  it('classifies immediate-trip errors vs transient errors and avoids double-counting cached tokens', () => {
    expect(isImmediateTripError('invalid_key')).toBe(true)
    expect(isImmediateTripError('quota_exhausted')).toBe(true)
    expect(isImmediateTripError('insufficient_balance')).toBe(true)
    expect(isImmediateTripError('timeout')).toBe(false)
    expect(isEligibleForFallback('timeout')).toBe(true)
    expect(isEligibleForFallback('context_length_exceeded')).toBe(false)

    const cost = calculateInferenceCost(
      'deepseek',
      'deepseek-flash',
      {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        cachedTokens: 400,
      },
      { timestamp: new Date('2026-11-25T15:00:00.000Z') }, // off-peak UTC
    )
    expect(cost.consumptionType).toBe('confirmed')
    // 600 uncached * 0.15 + 400 cached * 0.003 + 500 output * 0.60 = 90 + 1.2 + 300 = 391.2 / 1M
    expect(cost.costUsd).toBeCloseTo(0.0003912, 7)

    const unknownCost = calculateInferenceCost('deepseek', 'deepseek-flash', null)
    expect(unknownCost.consumptionType).toBe('unknown')
    expect(unknownCost.costUsd).toBeNull()
  })

  it('parses real OpenCode Go nested usage.rolling/resetsAt schema and sends x-opencode-session header', async () => {
    clearOpenCodeQuotaCache()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          usage: {
            rolling: { status: 'ok', percent: 12, resetsAt: '2026-11-24T21:53:11.000Z' },
            weekly: { status: 'ok', percent: 91, resetsAt: '2026-11-30T00:00:00.000Z' },
            monthly: { status: 'ok', percent: 30, resetsAt: '2026-12-01T00:00:00.000Z' },
          },
        }),
        { status: 200 },
      ),
    )
    const gate = await checkOpenCodeGoQuotaGate({ apiKey: 'oc-key', bypassCache: true })
    expect(gate.allowed).toBe(false)
    expect(gate.quotaExhausted).toBe(true)
    expect(gate.resetAt).toBe('2026-11-30T00:00:00.000Z')
    expect(gate.snapshot.fiveHour?.usagePercent).toBe(12)

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200 },
      ),
    )
    const directRes = await opencodeProvider.generateOpenCodeGo({
      apiKey: 'oc-key',
      model: 'glm-5.3-flash',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'ping' }],
      timeoutMs: 10_000,
      sessionId: 'wacrm-opaque-123',
    })
    expect(directRes.text).toBe('OK')
    const lastCallHeaders = (fetchSpy.mock.calls[1]?.[1]?.headers ?? {}) as Record<string, string>
    expect(lastCallHeaders['x-opencode-session']).toBe('wacrm-opaque-123')
  })

  it('computes progressive recovery backoff intervals', () => {
    const t0 = new Date(computeNextAttemptAt(0)).getTime() - Date.now()
    const t3 = new Date(computeNextAttemptAt(3)).getTime() - Date.now()
    expect(t0).toBeGreaterThan(50_000)
    expect(t3).toBeGreaterThan(1_700_000)
  })
})
