import { describe, it, expect, vi, beforeEach } from 'vitest'
import { calculateInferenceCost, isDeepSeekPeakUtc } from './pricing'
import { generateOpenCodeGo } from './providers/opencode-go'

describe('AI USD pricing & OpenCode Go financial accounting', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('detects official UTC peak hours (Mon-Fri 01:00-04:00 & 06:00-10:00 UTC)', () => {
    expect(isDeepSeekPeakUtc(new Date('2026-11-25T02:30:00Z'))).toBe(true) // Wed 02:30 UTC
    expect(isDeepSeekPeakUtc(new Date('2026-11-25T07:00:00Z'))).toBe(true) // Wed 07:00 UTC
    expect(isDeepSeekPeakUtc(new Date('2026-11-25T05:00:00Z'))).toBe(false) // Wed 05:00 UTC gap
    expect(isDeepSeekPeakUtc(new Date('2026-11-25T15:00:00Z'))).toBe(false) // Wed 15:00 UTC
    expect(isDeepSeekPeakUtc(new Date('2026-11-22T02:30:00Z'))).toBe(false) // Sun weekend
  })

  it('prioritizes OpenCode Go usage.opencode.list_cost and preserves component breakdown without reasoning double-counting', () => {
    const est = calculateInferenceCost(
      'opencode_go',
      'deepseek-v4.1-flash',
      {
        promptTokens: 34,
        completionTokens: 12,
        totalTokens: 46,
        cachedTokens: 0,
        reasoningTokens: 9,
        providerCost: {
          listCostUsd: 0.0000123,
          billedCostUsd: 0,
          allowanceUsd: 0.00000738,
          billingSource: 'go',
          providerEstimated: false,
          uncachedInputTokens: 34,
          cacheReadTokens: 0,
          outputTokens: 12,
          reasoningTokens: 9,
        },
      },
      { timestamp: new Date('2026-11-26T00:31:57Z') },
    )

    expect(est.costSource).toBe('provider_confirmed')
    expect(est.consumptionType).toBe('estimated')
    expect(est.includedInSubscription).toBe(true)
    expect(est.costUsd).toBe(0.0000123)
    expect(est.billedCostUsd).toBe(0)
    expect(est.opencodeAllowanceUsd).toBe(0.00000738)
    expect(est.billingSource).toBe('go')
    expect(est.inputCostUsd).toBeCloseTo(0.0000051, 10)
    expect(est.cacheCostUsd).toBe(0)
    expect(est.outputCostUsd).toBeCloseTo(0.0000072, 10)
    expect((est.inputCostUsd ?? 0) + (est.cacheCostUsd ?? 0) + (est.outputCostUsd ?? 0)).toBeCloseTo(
      est.costUsd!,
      10,
    )
  })

  it('computes OpenCode Go DeepSeek V4.1 Flash peak vs off-peak rates when list_cost is absent', () => {
    const offPeak = calculateInferenceCost(
      'opencode_go',
      'deepseek-v4.1-flash',
      {
        promptTokens: 1_500_000,
        completionTokens: 1_000_000,
        totalTokens: 2_500_000,
        cachedTokens: 500_000,
      },
      { timestamp: new Date('2026-11-25T15:00:00Z') },
    )
    // 1M uncached * 0.15 + 0.5M cache * 0.003 + 1M out * 0.60 = 0.15 + 0.0015 + 0.60 = 0.7515
    expect(offPeak.costSource).toBe('estimated')
    expect(offPeak.consumptionType).toBe('estimated')
    expect(offPeak.billedCostUsd).toBe(0)
    expect(offPeak.inputCostUsd).toBe(0.15)
    expect(offPeak.cacheCostUsd).toBe(0.0015)
    expect(offPeak.outputCostUsd).toBe(0.6)
    expect(offPeak.costUsd).toBe(0.7515)

    const peak = calculateInferenceCost(
      'opencode_go',
      'deepseek-v4.1-flash',
      {
        promptTokens: 1_500_000,
        completionTokens: 1_000_000,
        totalTokens: 2_500_000,
        cachedTokens: 500_000,
      },
      { timestamp: new Date('2026-11-25T02:00:00Z') },
    )
    // 1M uncached * 0.30 + 0.5M cache * 0.006 + 1M out * 1.20 = 0.30 + 0.003 + 1.20 = 1.503
    expect(peak.inputCostUsd).toBe(0.3)
    expect(peak.cacheCostUsd).toBe(0.003)
    expect(peak.outputCostUsd).toBe(1.2)
    expect(peak.costUsd).toBe(1.503)
  })

  it('never treats unknown OpenCode Go models or missing usage as zero', () => {
    const missingUsage = calculateInferenceCost('opencode_go', 'deepseek-v4.1-flash', null)
    expect(missingUsage.costUsd).toBeNull()
    expect(missingUsage.inputCostUsd).toBeNull()
    expect(missingUsage.costSource).toBe('unknown')
    expect(missingUsage.consumptionType).toBe('unknown')

    const unknownModel = calculateInferenceCost('opencode_go', 'unlisted-custom-model', {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    })
    expect(unknownModel.costUsd).toBeNull()
    expect(unknownModel.costSource).toBe('unknown')
    expect(unknownModel.consumptionType).toBe('unknown')
  })

  it('extracts usage.opencode.list_cost, allowance, and tokens from OpenCode Go chat-completions response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Olá!' } }],
          usage: {
            prompt_tokens: 134,
            completion_tokens: 12,
            total_tokens: 146,
            prompt_tokens_details: { cached_tokens: 100 },
            completion_tokens_details: { reasoning_tokens: 9 },
            cost: 0,
            opencode: {
              billing_source: 'go',
              list_cost: 0.0000126,
              allowance: 0.00000756,
              tokens: {
                input: 34,
                output: 12,
                reasoning: 9,
                cache_read: 100,
                cache_write_5m: 0,
                cache_write_1h: 0,
              },
            },
          },
        }),
        { status: 200 },
      ),
    )

    const res = await generateOpenCodeGo({
      apiKey: 'oc-key',
      model: 'deepseek-v4.1-flash',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'oi' }],
      timeoutMs: 10_000,
    })

    expect(res.usage?.promptTokens).toBe(134)
    expect(res.usage?.cachedTokens).toBe(100)
    expect(res.usage?.completionTokens).toBe(12)
    expect(res.usage?.providerCost?.listCostUsd).toBe(0.0000126)
    expect(res.usage?.providerCost?.allowanceUsd).toBe(0.00000756)
    expect(res.usage?.providerCost?.billedCostUsd).toBe(0)
    expect(res.usage?.providerCost?.billingSource).toBe('go')
  })
})
