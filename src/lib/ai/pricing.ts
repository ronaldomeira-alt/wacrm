import { getCachedOpenCodeModelSpec } from './model-catalog'
import type { AiProvider, AiUsage } from './types'

export type ConsumptionType = 'confirmed' | 'estimated' | 'unknown'
export type CostSource = 'provider_confirmed' | 'estimated' | 'unknown'

export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cacheReadPer1M: number
  cacheWritePer1M?: number
  peakMultiplier?: number
  includedInSubscription: boolean
}

const TEN_DECIMALS = 10_000_000_000

function roundPrecision(value: number): number {
  return Math.round(value * TEN_DECIMALS) / TEN_DECIMALS
}

/**
 * Official DeepSeek / OpenCode peak-hour schedule (UTC):
 * Monday–Friday, 01:00–04:00 UTC and 06:00–10:00 UTC (2x rate).
 * Matches `https://opencode.ai/inference/go/v1/models` multipliers and
 * `https://api-docs.deepseek.com/quick_start/pricing`.
 */
export function isDeepSeekPeakUtc(at: Date = new Date()): boolean {
  const day = at.getUTCDay() // 0 = Sun, 1..5 = Mon..Fri, 6 = Sat
  if (day < 1 || day > 5) return false
  const mins = at.getUTCHours() * 60 + at.getUTCMinutes()
  return (mins >= 60 && mins < 240) || (mins >= 360 && mins < 600)
}

/**
 * Provider-isolated per-1M token USD pricing table.
 * - OpenCode Go models use OpenCode Go's official published tariffs (never mixed with DeepSeek Official).
 * - DeepSeek Official (`deepseek-flash` = DeepSeek-V4.1-Flash-1017) uses DeepSeek's official
 *   off-peak ($0.15 / $0.003 / $0.60) and 2x peak ($0.30 / $0.006 / $1.20) tariffs.
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // DeepSeek Official API
  'deepseek:deepseek-flash': {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    cacheReadPer1M: 0.003,
    peakMultiplier: 2,
    includedInSubscription: false,
  },
  'deepseek:deepseek-chat': {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    cacheReadPer1M: 0.003,
    peakMultiplier: 2,
    includedInSubscription: false,
  },
  'deepseek:deepseek-v4-pro': {
    inputPer1M: 0.66,
    outputPer1M: 1.98,
    cacheReadPer1M: 0.022,
    peakMultiplier: 2,
    includedInSubscription: false,
  },

  // OpenCode Go (subscription equivalent list prices from opencode.ai/inference/go/v1/models)
  'opencode_go:deepseek-v4.1-flash': {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    cacheReadPer1M: 0.003,
    peakMultiplier: 2,
    includedInSubscription: true,
  },
  'opencode_go:deepseek-v4-pro': {
    inputPer1M: 0.66,
    outputPer1M: 1.98,
    cacheReadPer1M: 0.022,
    peakMultiplier: 2,
    includedInSubscription: true,
  },
  'opencode_go:glm-5.3-flash': {
    inputPer1M: 0.15,
    outputPer1M: 0.5,
    cacheReadPer1M: 0.03,
    includedInSubscription: true,
  },
  'opencode_go:mimo-v2.6-flash': {
    inputPer1M: 0.14,
    outputPer1M: 0.28,
    cacheReadPer1M: 0.0028,
    includedInSubscription: true,
  },
  'opencode_go:qwen3.8-flash': {
    inputPer1M: 0.15,
    outputPer1M: 0.47,
    cacheReadPer1M: 0.016,
    cacheWritePer1M: 0.2,
    includedInSubscription: true,
  },

  // OpenAI
  'openai:gpt-5.4-mini': {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    cacheReadPer1M: 0.075,
    includedInSubscription: false,
  },
  'openai:gpt-4o-mini': {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    cacheReadPer1M: 0.075,
    includedInSubscription: false,
  },
  'openai:gpt-4.1-mini': {
    inputPer1M: 0.4,
    outputPer1M: 1.6,
    cacheReadPer1M: 0.1,
    includedInSubscription: false,
  },
  'openai:gpt-4.1': {
    inputPer1M: 2.0,
    outputPer1M: 8.0,
    cacheReadPer1M: 0.5,
    includedInSubscription: false,
  },
  'openai:gpt-4o': {
    inputPer1M: 2.5,
    outputPer1M: 10.0,
    cacheReadPer1M: 1.25,
    includedInSubscription: false,
  },
  'openai:o4-mini': {
    inputPer1M: 1.1,
    outputPer1M: 4.4,
    cacheReadPer1M: 0.275,
    includedInSubscription: false,
  },

  // Anthropic
  'anthropic:claude-haiku-4-5-20251001': {
    inputPer1M: 0.8,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.08,
    includedInSubscription: false,
  },
  'anthropic:claude-3-5-haiku-latest': {
    inputPer1M: 0.8,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.08,
    includedInSubscription: false,
  },
  'anthropic:claude-sonnet-4-5-20250929': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    includedInSubscription: false,
  },
  'anthropic:claude-3-5-sonnet-latest': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    includedInSubscription: false,
  },
}

const DIRECT_PROVIDER_FALLBACK_PRICING: Record<
  Exclude<AiProvider, 'opencode_go'>,
  ModelPricing
> = {
  deepseek: {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    cacheReadPer1M: 0.003,
    peakMultiplier: 2,
    includedInSubscription: false,
  },
  openai: {
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    cacheReadPer1M: 0.075,
    includedInSubscription: false,
  },
  anthropic: {
    inputPer1M: 0.8,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.08,
    includedInSubscription: false,
  },
}

function resolveModelPricing(provider: AiProvider, model: string): ModelPricing | null {
  const exact = MODEL_PRICING[`${provider}:${model}`]
  if (exact) return exact

  if (provider === 'opencode_go') {
    if (model.toLowerCase().endsWith('-free')) {
      return {
        inputPer1M: 0,
        outputPer1M: 0,
        cacheReadPer1M: 0,
        includedInSubscription: true,
      }
    }
    const spec = getCachedOpenCodeModelSpec({ modelId: model })
    if (
      spec?.cost &&
      typeof spec.cost.inputPer1M === 'number' &&
      typeof spec.cost.outputPer1M === 'number'
    ) {
      return {
        inputPer1M: spec.cost.inputPer1M,
        outputPer1M: spec.cost.outputPer1M,
        cacheReadPer1M: spec.cost.cacheReadPer1M ?? 0,
        cacheWritePer1M: spec.cost.cacheWritePer1M,
        peakMultiplier: spec.cost.hasPeakMultiplier ? 2 : undefined,
        includedInSubscription: true,
      }
    }
    // Unknown OpenCode Go model without catalog price — never guess another model's rate
    return null
  }

  return DIRECT_PROVIDER_FALLBACK_PRICING[provider] ?? null
}

export function getUsdBrlRate(): number {
  const envRate = Number(process.env.AI_USD_BRL_RATE)
  return Number.isFinite(envRate) && envRate > 0 ? envRate : 5.8
}

export interface CostEstimate {
  costUsd: number | null
  inputCostUsd: number | null
  cacheCostUsd: number | null
  outputCostUsd: number | null
  billedCostUsd: number | null
  opencodeAllowanceUsd: number | null
  billingSource: string | null
  costBrl: number | null
  usdBrlRate: number
  consumptionType: ConsumptionType
  costSource: CostSource
  includedInSubscription: boolean
}

/**
 * Compute USD + BRL cost breakdown for a single inference call.
 * - Prioritizes provider-reported values (`usage.opencode.list_cost` / `usage.cost`)
 *   when returned by OpenCode Go, preserving component shares (`input`, `cache`, `output`)
 *   without double-counting cached or reasoning tokens.
 * - Falls back to provider- and model-specific official tariffs (including UTC peak-hour
 *   multipliers) when provider-reported cost is unavailable.
 * - Returns `null` costs and `'unknown'` when `usage` is missing or pricing is unknown
 *   (never treats unknown costs as zero).
 */
export function calculateInferenceCost(
  provider: AiProvider,
  model: string,
  usage: AiUsage | null,
  opts: { timestamp?: Date } = {},
): CostEstimate {
  const usdBrlRate = getUsdBrlRate()
  const pricing = resolveModelPricing(provider, model)
  const defaultIncluded = pricing?.includedInSubscription ?? provider === 'opencode_go'

  if (!usage) {
    return {
      costUsd: null,
      inputCostUsd: null,
      cacheCostUsd: null,
      outputCostUsd: null,
      billedCostUsd: null,
      opencodeAllowanceUsd: null,
      billingSource: null,
      costBrl: null,
      usdBrlRate,
      consumptionType: 'unknown',
      costSource: 'unknown',
      includedInSubscription: defaultIncluded,
    }
  }

  const meta = usage.providerCost
  const at = opts.timestamp ?? new Date()
  const factor =
    pricing?.peakMultiplier && pricing.peakMultiplier > 1 && isDeepSeekPeakUtc(at)
      ? pricing.peakMultiplier
      : 1

  // Use explicit OpenCode token breakdown when present; otherwise use normalized usage.
  // Output (`completionTokens`) already includes `reasoningTokens` — never add reasoning separately.
  const cached =
    meta?.cacheReadTokens !== undefined
      ? meta.cacheReadTokens
      : Math.min(usage.cachedTokens ?? 0, usage.promptTokens)
  const uncachedPrompt =
    meta?.uncachedInputTokens !== undefined
      ? meta.uncachedInputTokens
      : Math.max(0, usage.promptTokens - cached)
  const cacheWriteTokens = (meta?.cacheWrite5mTokens ?? 0) + (meta?.cacheWrite1hTokens ?? 0)
  const outputTokens = meta?.outputTokens !== undefined ? meta.outputTokens : usage.completionTokens

  const rawInput = pricing ? (uncachedPrompt * pricing.inputPer1M * factor) / 1_000_000 : 0
  const rawCache = pricing
    ? ((cached * pricing.cacheReadPer1M +
        cacheWriteTokens * (pricing.cacheWritePer1M ?? pricing.inputPer1M)) *
        factor) /
      1_000_000
    : 0
  const rawOutput = pricing ? (outputTokens * pricing.outputPer1M * factor) / 1_000_000 : 0
  const rawTotal = rawInput + rawCache + rawOutput

  const providerListCost =
    typeof meta?.listCostUsd === 'number' && Number.isFinite(meta.listCostUsd)
      ? meta.listCostUsd
      : typeof meta?.billedCostUsd === 'number' &&
          Number.isFinite(meta.billedCostUsd) &&
          meta.billingSource === 'balance'
        ? meta.billedCostUsd
        : undefined

  let totalUsd: number
  let inputUsd: number
  let cacheUsd: number
  let outputUsd: number
  let costSource: CostSource

  if (providerListCost !== undefined) {
    totalUsd = providerListCost
    if (providerListCost === 0) {
      inputUsd = 0
      cacheUsd = 0
      outputUsd = 0
    } else if (rawTotal > 0) {
      const scale = providerListCost / rawTotal
      inputUsd = rawInput * scale
      cacheUsd = rawCache * scale
      outputUsd = rawOutput * scale
    } else {
      const tokenSum = uncachedPrompt + cached + outputTokens
      if (tokenSum > 0) {
        inputUsd = providerListCost * (uncachedPrompt / tokenSum)
        cacheUsd = providerListCost * (cached / tokenSum)
        outputUsd = providerListCost * (outputTokens / tokenSum)
      } else {
        inputUsd = providerListCost
        cacheUsd = 0
        outputUsd = 0
      }
    }
    costSource = meta?.providerEstimated ? 'estimated' : 'provider_confirmed'
  } else if (pricing) {
    inputUsd = rawInput
    cacheUsd = rawCache
    outputUsd = rawOutput
    totalUsd = rawTotal
    costSource = 'estimated'
  } else {
    return {
      costUsd: null,
      inputCostUsd: null,
      cacheCostUsd: null,
      outputCostUsd: null,
      billedCostUsd:
        typeof meta?.billedCostUsd === 'number' ? roundPrecision(meta.billedCostUsd) : null,
      opencodeAllowanceUsd:
        typeof meta?.allowanceUsd === 'number' ? roundPrecision(meta.allowanceUsd) : null,
      billingSource: meta?.billingSource ?? null,
      costBrl: null,
      usdBrlRate,
      consumptionType: 'unknown',
      costSource: 'unknown',
      includedInSubscription: defaultIncluded,
    }
  }

  const roundedTotal = roundPrecision(totalUsd)
  const roundedInput = roundPrecision(inputUsd)
  const roundedCache = roundPrecision(cacheUsd)
  const roundedOutput = roundPrecision(outputUsd)
  const roundedBrl = roundPrecision(roundedTotal * usdBrlRate)

  const billingSource =
    meta?.billingSource ?? (provider === 'opencode_go' ? 'go' : 'direct_api')
  const isSubscriptionCovered =
    provider === 'opencode_go' &&
    billingSource !== 'balance' &&
    billingSource !== 'byok'
  const billedCostUsd =
    typeof meta?.billedCostUsd === 'number'
      ? roundPrecision(meta.billedCostUsd)
      : isSubscriptionCovered
        ? 0
        : roundedTotal
  const opencodeAllowanceUsd =
    typeof meta?.allowanceUsd === 'number' ? roundPrecision(meta.allowanceUsd) : null

  return {
    costUsd: roundedTotal,
    inputCostUsd: roundedInput,
    cacheCostUsd: roundedCache,
    outputCostUsd: roundedOutput,
    billedCostUsd,
    opencodeAllowanceUsd,
    billingSource,
    costBrl: roundedBrl,
    usdBrlRate,
    consumptionType: isSubscriptionCovered ? 'estimated' : 'confirmed',
    costSource,
    includedInSubscription: isSubscriptionCovered,
  }
}
