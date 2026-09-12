// ============================================================
// Types for Clara's Contextual Reactivation of Interrupted Conversations
// ============================================================

export type ReactivationType = 'specific' | 'global' | 'none'

export interface ReactivationDecision {
  should_reactivate: boolean
  reactivation_type: ReactivationType
  detected_need_or_clue: string | null
  reason: string
  message_text: string
}

export type ReactivationOutcome =
  | 'sent'
  | 'scheduled_for_business_hours'
  | 'cancelled_customer_replied'
  | 'cancelled_human_assigned'
  | 'cancelled_explicit_opt_out'
  | 'skipped_not_appropriate'
  | 'skipped_spam_guard'
  | 'skipped_not_eligible'
  | 'failed'

export interface ReactivationCandidate {
  id: string
  accountId: string
  contactId: string
  propertyId: string | null
  lastMessageAt: string
  aiReactivationStatus: 'scheduled' | 'sent' | 'cancelled' | 'skipped' | 'failed' | null
  aiReactivationScheduledFor: string | null
  aiReactivationSentAt: string | null
  aiReactivationLastMessageAt: string | null
  aiReactivationCount: number
  contact: {
    id: string
    name: string | null
    phone: string | null
  } | null
  property?: {
    id: string
    name: string
    stage?: string | null
  } | null
}

export interface ReactivationEvaluationResult {
  outcome: ReactivationOutcome
  conversationId: string
  messageText?: string
  decision?: ReactivationDecision
  error?: string
}

export interface ReactivationRunResult {
  candidates: number
  evaluated: number
  sent: number
  scheduled: number
  cancelled: number
  skipped: number
  failed: number
}
