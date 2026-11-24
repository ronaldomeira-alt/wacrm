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
    opencodeWacrmReservePct: 15,
    opencodeGlobalPreventivePct: 75,
    opencodeMarginPct: 25,
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

  it('blocks OpenCode Go proactively when 5h, weekly, or monthly preventive quota >= 75% and routes to DeepSeek', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rolling5h: { usagePercent: 80, resetInSec: 1200 },
          weekly: { usagePercent: 20 },
          monthly: { usagePercent: 30 },
        }),
        { status: 200 },
      ),
    )
    const ocSpy = vi.spyOn(opencodeProvider, 'generateOpenCodeGo')
    vi.spyOn(deepseekProvider, 'generateDeepSeek').mockResolvedValueOnce({
      text: 'Atendimento contínuo via DeepSeek',
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    })

    const res = await executeAiInference({
      config: makeConfig(),
      mode: 'auto_reply',
      systemPrompt: 'Clara',
      messages: [{ role: 'user', content: 'Olá' }],
    })

    expect(ocSpy).not.toHaveBeenCalled()
    expect(res.provider).toBe('deepseek')
    expect(res.fallbackUsed).toBe(true)
  })

  it('does NOT treat unavailable OpenCode quota endpoint as quota exhaustion (fail-open)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const gate = await checkOpenCodeGoQuotaGate({
      apiKey: 'oc-key',
      globalPreventivePct: 75,
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

    const cost = calculateInferenceCost('deepseek', 'deepseek-flash', {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      cachedTokens: 400,
    })
    expect(cost.consumptionType).toBe('confirmed')
    // 600 uncached * 0.14 + 400 cached * 0.014 + 500 output * 0.28 = 84 + 5.6 + 140 = 229.6 / 1M
    expect(cost.costUsd).toBeCloseTo(0.00023, 5)

    const unknownCost = calculateInferenceCost('deepseek', 'deepseek-flash', null)
    expect(unknownCost.consumptionType).toBe('unknown')
    expect(unknownCost.costUsd).toBeNull()
  })

  it('computes progressive recovery backoff intervals', () => {
    const t0 = new Date(computeNextAttemptAt(0)).getTime() - Date.now()
    const t3 = new Date(computeNextAttemptAt(3)).getTime() - Date.now()
    expect(t0).toBeGreaterThan(50_000)
    expect(t3).toBeGreaterThan(1_700_000)
  })
})
