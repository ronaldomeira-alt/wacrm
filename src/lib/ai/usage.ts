import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateInferenceCost, type ConsumptionType } from './pricing'
import type { AiProvider, AiUsage } from './types'

// Single source of truth for `ai_usage_log.mode` — mirrors the DB CHECK
// constraint added across migrations 049/050/052/059/073/20261124140000.
export const AI_USAGE_MODES = [
  'auto_reply',
  'draft',
  'lead_analysis',
  'followup',
  'learning',
  'ctwa_rescue',
  'template_fill',
  'smart_send',
  'playground',
  'test',
  'recovery',
] as const

export type AiUsageMode = (typeof AI_USAGE_MODES)[number]
export type AiUsageStatus = 'completed' | 'failed' | 'timeout' | 'aborted'

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  mode: AiUsageMode
  provider: AiProvider
  model: string
  /** Provider usage; null when unavailable or request failed. */
  usage: AiUsage | null
  latencyMs?: number | null
  status?: AiUsageStatus
  errorCode?: string | null
  errorReason?: string | null
  fallbackUsed?: boolean
  attemptNumber?: number
  consumptionType?: ConsumptionType
  /** When true, persists failed/unknown attempts even if usage is null. */
  logUnknown?: boolean
}

export async function logAiUsage(
  db: SupabaseClient,
  args: LogAiUsageArgs,
): Promise<void> {
  const status: AiUsageStatus = args.status ?? 'completed'
  if (!args.usage && !args.logUnknown && status === 'completed') return

  const cost = calculateInferenceCost(args.provider, args.model, args.usage)
  const consumptionType: ConsumptionType = args.consumptionType ?? cost.consumptionType

  try {
    const { error } = await db.from('ai_usage_log').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      prompt_tokens: args.usage?.promptTokens ?? 0,
      completion_tokens: args.usage?.completionTokens ?? 0,
      total_tokens: args.usage?.totalTokens ?? 0,
      cached_tokens: args.usage?.cachedTokens ?? null,
      reasoning_tokens: args.usage?.reasoningTokens ?? null,
      latency_ms:
        typeof args.latencyMs === 'number' ? Math.max(0, Math.round(args.latencyMs)) : null,
      status,
      error_code: args.errorCode ?? null,
      error_reason: args.errorReason ? args.errorReason.slice(0, 500) : null,
      fallback_used: args.fallbackUsed ?? false,
      attempt_number: args.attemptNumber ?? 1,
      cost_usd: cost.costUsd,
      cost_brl: cost.costBrl,
      usd_brl_rate: cost.usdBrlRate,
      consumption_type: consumptionType,
    })
    if (error) {
      console.error('[ai usage] log insert failed:', error)
    }
  } catch (err) {
    console.error('[ai usage] log insert threw:', err)
  }
}
