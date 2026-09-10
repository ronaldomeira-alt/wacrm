import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiProvider, AiUsage } from './types'

// Single source of truth for `ai_usage_log.mode` — mirrors the DB CHECK
// constraint added across migrations 049/050/052/059/073. Any consumer
// that needs to enumerate all modes (e.g. GET /api/ai/usage's per-mode
// breakdown) should derive from this array instead of hardcoding a
// shorter list, which previously drifted and threw a TypeError for any
// row with a mode added after the initial five.
export const AI_USAGE_MODES = [
  'auto_reply',
  'draft',
  'lead_analysis',
  'followup',
  'learning',
  'ctwa_rescue',
  'template_fill',
] as const

export type AiUsageMode = (typeof AI_USAGE_MODES)[number]

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  mode: AiUsageMode
  provider: AiProvider
  model: string
  /** Provider usage; a no-op when null (nothing worth recording). */
  usage: AiUsage | null
}

/**
 * Best-effort append to `ai_usage_log` — one row per LLM call, for cost
 * visibility on the account's BYO key. NEVER throws: usage accounting
 * must not fail a reply the customer is waiting on, so any DB error is
 * logged and swallowed. Skips entirely when the provider didn't report
 * usage (we'd only be writing zeros).
 *
 * Pass the service-role admin client from the webhook, or the RLS-scoped
 * SSR client from a route — writes land either way (there's no
 * `authenticated` INSERT policy, so an SSR write relies on the service
 * role; callers that must persist from a route should pass the admin
 * client).
 */
export async function logAiUsage(
  db: SupabaseClient,
  args: LogAiUsageArgs,
): Promise<void> {
  if (!args.usage) return
  try {
    const { error } = await db.from('ai_usage_log').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      prompt_tokens: args.usage.promptTokens,
      completion_tokens: args.usage.completionTokens,
      total_tokens: args.usage.totalTokens,
    })
    if (error) {
      console.error('[ai usage] log insert failed:', error)
    }
  } catch (err) {
    console.error('[ai usage] log insert threw:', err)
  }
}
