import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL } from './defaults'
import { executeAiInference } from './provider-manager'
import type { AiUsageMode } from './usage'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  db?: SupabaseClient | null
  accountId?: string | null
  conversationId?: string | null
  mode?: AiUsageMode
  bypassCircuitBreaker?: boolean
  logUsage?: boolean
}

/**
 * Generate the next reply from the account's configured provider (with
 * automatic fallback when enabled). Dispatches via `executeAiInference`,
 * then parses the handoff sentinel out of the raw text.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const result = await executeAiInference({
    config: args.config,
    db: args.db,
    accountId: args.accountId,
    conversationId: args.conversationId,
    mode: args.mode ?? 'draft',
    systemPrompt: args.systemPrompt,
    messages: args.messages,
    bypassCircuitBreaker: args.bypassCircuitBreaker,
    logUsage: args.logUsage ?? false,
  })

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}
