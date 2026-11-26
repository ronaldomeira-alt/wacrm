// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'deepseek' | 'opencode_go'

export const DEEPSEEK_MODELS = ['deepseek-flash'] as const
export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number]

export const OPENCODE_GO_MODELS = ['glm-5.3-flash'] as const
export type OpenCodeGoModel = (typeof OPENCODE_GO_MODELS)[number]

export type CircuitBreakerState =
  | 'operational'
  | 'suspended'
  | 'quota_exhausted'
  | 'auth_failed'
  | 'half_open'
  | 'disabled'

export type AiUsageMode =
  | 'auto_reply'
  | 'draft'
  | 'lead_analysis'
  | 'followup'
  | 'learning'
  | 'ctwa_rescue'
  | 'template_fill'
  | 'smart_send'
  | 'playground'
  | 'test'
  | 'recovery'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  deepseekApiKey?: string | null
  opencodeGoApiKey?: string | null
  fallbackEnabled?: boolean
  secondaryProvider?: AiProvider | null
  secondaryModel?: string | null
  primaryTimeoutMs?: number
  secondaryTimeoutMs?: number
  opencode5hPreventiveEnabled?: boolean
  opencode5hPreventivePct?: number
  opencodeWeeklyPreventiveEnabled?: boolean
  opencodeWeeklyPreventivePct?: number
  opencodeMonthlyPreventiveEnabled?: boolean
  opencodeMonthlyPreventivePct?: number
  circuitFailureThreshold?: number
  circuitCooldownSeconds?: number
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
  identityName?: string | null
  toneStyle?: string | null
  teamPresentation?: string | null
  globalNeverRules?: string | null
  /** Style/formatting guidance (response length, whether to end on a
   *  question, etc.) as discrete instructions — distinct from
   *  globalNeverRules, which is only for hard prohibitions. Each entry is
   *  independently addable/removable from the Playground or Comportamento,
   *  so reversing one doesn't require hand-editing a text blob. */
  responseStyleInstructions?: string[] | null
  businessHoursStart?: string | null
  businessHoursEnd?: string | null
  businessDays?: number[] | null
  offHoursInstructions?: string | null
  safetyMessageLimit?: number | null
}

export type BoundaryType =
  | 'price'
  | 'payment_terms'
  | 'discount_negotiation'
  | 'availability_check'
  | 'visit_request'
  | 'financing_inquiry'
  | 'reservation'
  | 'commercial_decision'
  | 'knowledge_limit'
  | 'incompatible_demand'
  | 'human_requested'
  | 'safety_limit_reached'
  | 'custom_never_rule'
  | null

export interface AiMediaSendAction {
  property_id?: string
  media_id: string
  caption?: string | null
}

export interface PropertyMediaSummary {
  id: string
  type: 'image' | 'video'
  description: string | null
  file_name: string
  is_cover: boolean
  url?: string
}

export const MAX_AI_MEDIA_PER_TURN = 5

export interface AiDecision {
  response_text: string
  transfer_required: boolean
  boundary_type: BoundaryType
  reason: string | null
  context_summary: string | null
  suggested_next_action: string | null
  send_media?: AiMediaSendAction[] | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiProviderCostMeta {
  /** Equivalent USD value at list/official model price (`usage.opencode.list_cost`),
   *  or direct charge when not covered by subscription. */
  listCostUsd?: number
  /** Actual USD charged to balance (`usage.cost`, e.g. `0` when covered by Go). */
  billedCostUsd?: number
  /** Go subscription allowance USD consumed (`usage.opencode.allowance`). */
  allowanceUsd?: number
  /** Billing source reported by OpenCode (`go`, `go-plus`, `balance`, `free`, `byok`). */
  billingSource?: string
  /** True when the provider flagged its reported cost as an estimate. */
  providerEstimated?: boolean
  /** Exact token breakdown reported by `usage.opencode.tokens`. */
  uncachedInputTokens?: number
  cacheReadTokens?: number
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens?: number
  reasoningTokens?: number
  providerCost?: AiProviderCostMeta
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
