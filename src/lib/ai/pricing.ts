import type { AiProvider, AiUsage } from './types'

export type ConsumptionType = 'confirmed' | 'estimated' | 'unknown'

export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cacheReadPer1M: number
  includedInSubscription: boolean
}

/**
 * Documented per-1M token USD pricing table.
 * - DeepSeek (`deepseek-flash` / V4.1 Flash 1017): $0.14 input, $0.28 output, $0.014 cache hit.
 * - OpenCode Go (`glm-5.3-flash`): included in monthly Go subscription; standalone equivalent
 *   reference is $0.15 input, $0.50 output, $0.03 cache read (logged as `estimated`).
 * - OpenAI (`gpt-5.4-mini` / `gpt-4o-mini`): $0.15 input, $0.60 output, $0.075 cache read.
 * - Anthropic (`claude-haiku-4-5-20251001`): $0.80 input, $4.00 output, $0.08 cache read.
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  'deepseek:deepseek-flash': {
    inputPer1M: 0.14,
    outputPer1M: 0.28,
    cacheReadPer1M: 0.014,
    includedInSubscription: false,
  },
  'deepseek:deepseek-chat': {
    inputPer1M: 0.14,
    outputPer1M: 0.28,
    cacheReadPer1M: 0.014,
    includedInSubscription: false,
  },
  'opencode_go:glm-5.3-flash': {
    inputPer1M: 0.15,
    outputPer1M: 0.50,
    cacheReadPer1M: 0.03,
    includedInSubscription: true,
  },
  'openai:gpt-5.4-mini': {
    inputPer1M: 0.15,
    outputPer1M: 0.60,
    cacheReadPer1M: 0.075,
    includedInSubscription: false,
  },
  'anthropic:claude-haiku-4-5-20251001': {
    inputPer1M: 0.80,
    outputPer1M: 4.00,
    cacheReadPer1M: 0.08,
    includedInSubscription: false,
  },
}

const PROVIDER_FALLBACK_PRICING: Record<AiProvider, ModelPricing> = {
  deepseek: { inputPer1M: 0.14, outputPer1M: 0.28, cacheReadPer1M: 0.014, includedInSubscription: false },
  opencode_go: { inputPer1M: 0.15, outputPer1M: 0.50, cacheReadPer1M: 0.03, includedInSubscription: true },
  openai: { inputPer1M: 0.15, outputPer1M: 0.60, cacheReadPer1M: 0.075, includedInSubscription: false },
  anthropic: { inputPer1M: 0.80, outputPer1M: 4.00, cacheReadPer1M: 0.08, includedInSubscription: false },
}

export function getUsdBrlRate(): number {
  const envRate = Number(process.env.AI_USD_BRL_RATE)
  return Number.isFinite(envRate) && envRate > 0 ? envRate : 5.8
}

export interface CostEstimate {
  costUsd: number | null
  costBrl: number | null
  usdBrlRate: number
  consumptionType: ConsumptionType
  includedInSubscription: boolean
}

/**
 * Compute USD + BRL cost for a single inference call.
 * - Avoids double-counting cached tokens: `cachedTokens` are billed at `cacheReadPer1M`
 *   and subtracted from `promptTokens` (clamped at 0).
 * - Returns `null` cost and `'unknown'` when `usage` is missing.
 */
export function calculateInferenceCost(
  provider: AiProvider,
  model: string,
  usage: AiUsage | null,
): CostEstimate {
  const usdBrlRate = getUsdBrlRate()
  const pricing =
    MODEL_PRICING[`${provider}:${model}`] ?? PROVIDER_FALLBACK_PRICING[provider]

  if (!usage) {
    return {
      costUsd: null,
      costBrl: null,
      usdBrlRate,
      consumptionType: 'unknown',
      includedInSubscription: pricing.includedInSubscription,
    }
  }

  const cached = Math.min(usage.cachedTokens ?? 0, usage.promptTokens)
  const uncachedPrompt = Math.max(0, usage.promptTokens - cached)
  const costUsd =
    (uncachedPrompt * pricing.inputPer1M +
      cached * pricing.cacheReadPer1M +
      usage.completionTokens * pricing.outputPer1M) /
    1_000_000

  const roundedUsd = Math.round(costUsd * 1_000_000) / 1_000_000
  const roundedBrl = Math.round(roundedUsd * usdBrlRate * 1_000_000) / 1_000_000

  return {
    costUsd: roundedUsd,
    costBrl: roundedBrl,
    usdBrlRate,
    consumptionType: pricing.includedInSubscription ? 'estimated' : 'confirmed',
    includedInSubscription: pricing.includedInSubscription,
  }
}
