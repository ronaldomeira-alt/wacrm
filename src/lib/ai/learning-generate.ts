import type { SupabaseClient } from '@supabase/supabase-js'

import { loadAiConfig } from './config'
import { logAiUsage } from './usage'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'
import { aiRequestTimeoutMs } from './defaults'
import { buildLearningScanSystemPrompt, buildLearningScanUserPrompt } from './learning-prompt'
import { parseLearningScanResult, type LearningCandidate, type LearningConfidence } from './learning-types'
import {
  LEARNING_INITIAL_WINDOW_DAYS,
  LEARNING_SCAN_MESSAGE_LIMIT,
  meetsLearningConfidenceThreshold,
} from './learning-config'
import { effectiveMessageText } from './message-text'
import {
  AUTO_APPLY_MIN_OCCURRENCES,
  applyPropertySubjectiveLearning,
  meetsAutoApplyThreshold,
} from './property-learning-apply'
import {
  findConversationEvidence,
  recordPropertyLearningEvidence,
  resolvePropertyIdentity,
} from './property-identity'
import type { ChatMessage, AiConfig } from './types'

/** Conversations considered for scanning, biased toward the most
 *  recently active ones — relevance over completeness for a
 *  periodic background job. */
const MAX_CONVERSATIONS_SCANNED = 500
/** Prompt stays bounded regardless of how big the KB/pending queue gets. */
const MAX_KNOWN_TITLES = 100
const TITLE_MAX_LENGTH = 200

function normalizeTitle(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * Scans one account's recent messages (since the last scan) for
 * recurring, consistent patterns worth remembering, and writes each
 * as a `pending` `ai_suggestions` row (category `learning`) — never
 * applied automatically; a human always approves/edits/rejects (see
 * PATCH /api/ai/suggestions/[id]). Never throws: a failing account
 * must not stop the cron from moving on to the next one.
 */
export async function generateLearningSuggestions(
  db: SupabaseClient,
  accountId: string,
): Promise<{ created: number; touched: number }> {
  const config = await loadAiConfig(db, accountId)
  if (!config) return { created: 0, touched: 0 }

  const { data: configRow } = await db
    .from('ai_configs')
    .select('learning_last_scanned_at')
    .eq('account_id', accountId)
    .maybeSingle()
  const since =
    (configRow?.learning_last_scanned_at as string | null) ??
    new Date(Date.now() - LEARNING_INITIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data: convRows, error: convError } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .order('last_message_at', { ascending: false })
    .limit(MAX_CONVERSATIONS_SCANNED)
  if (convError) {
    console.error('[learning generate] failed to load conversations:', convError)
    return { created: 0, touched: 0 }
  }
  const conversationIds = (convRows ?? []).map((c) => c.id as string)
  if (conversationIds.length === 0) return { created: 0, touched: 0 }

  const { data: msgRows, error: msgError } = await db
    .from('messages')
    .select('conversation_id, sender_type, content_type, content_text, transcript_text, created_at')
    .in('conversation_id', conversationIds)
    .in('content_type', ['text', 'audio'])
    .gt('created_at', since)
    .order('created_at', { ascending: true })
    .limit(LEARNING_SCAN_MESSAGE_LIMIT)
  if (msgError) {
    console.error('[learning generate] failed to load messages:', msgError)
    return { created: 0, touched: 0 }
  }

  const rows = (msgRows ?? []) as {
    conversation_id: string
    sender_type: 'customer' | 'agent' | 'bot'
    content_type: string
    content_text: string | null
    transcript_text: string | null
    created_at: string
  }[]
  const textRows = rows
    .map((m) => ({ m, text: effectiveMessageText(m) }))
    .filter((r): r is { m: (typeof rows)[number]; text: string } => r.text !== null)
  if (textRows.length === 0) {
    // Nothing to learn from, but the window itself was fully checked —
    // advance the cursor so the next run doesn't re-scan empty history.
    await db.from('ai_configs').update({ learning_last_scanned_at: new Date().toISOString() }).eq('account_id', accountId)
    return { created: 0, touched: 0 }
  }
  const messages: ChatMessage[] = textRows.map((r) => ({
    role: r.m.sender_type === 'customer' ? 'user' : 'assistant',
    content: r.text,
  }))

  const [{ data: docRows }, { data: pendingRows }] = await Promise.all([
    db.from('ai_knowledge_documents').select('title').eq('account_id', accountId).limit(MAX_KNOWN_TITLES),
    db
      .from('ai_suggestions')
      .select('id, title, payload')
      .eq('account_id', accountId)
      .eq('category', 'learning')
      .eq('status', 'pending')
      .limit(MAX_KNOWN_TITLES),
  ])
  const knownDocTitles = new Set((docRows ?? []).map((d) => normalizeTitle(d.title as string)))
  const pendingByTitle = new Map(
    ((pendingRows ?? []) as { id: string; title: string; payload: Record<string, unknown> }[]).map(
      (r) => [normalizeTitle(r.title), r],
    ),
  )
  const knownTitles = [
    ...(docRows ?? []).map((d) => d.title as string),
    ...(pendingRows ?? []).map((r) => r.title as string),
  ].slice(0, MAX_KNOWN_TITLES)

  const systemPrompt = buildLearningScanSystemPrompt()
  const userPrompt = buildLearningScanUserPrompt({ messages, knownTitles })
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages: [{ role: 'user' as const, content: userPrompt }],
    timeoutMs: aiRequestTimeoutMs(),
  }

  let candidates: LearningCandidate[] | null = null
  try {
    const { text, usage } =
      config.provider === 'openai' ? await generateOpenAi(providerArgs) : await generateAnthropic(providerArgs)
    void logAiUsage(db, {
      accountId,
      conversationId: null,
      mode: 'learning',
      provider: config.provider,
      model: config.model,
      usage,
    })
    candidates = parseLearningScanResult(text)
  } catch (err) {
    console.error('[learning generate] provider call failed:', err)
    return { created: 0, touched: 0 } // don't advance the cursor — retry this window next run
  }

  if (candidates === null) {
    console.warn('[learning generate] model output was not valid JSON — skipping this run')
    return { created: 0, touched: 0 }
  }

  // Lazily resolved account owner — only needed the first time a
  // property_subjective learning actually crosses the auto-apply
  // threshold and might need to auto-create a provisional property.
  let ownerUserId: string | null | undefined
  async function getOwnerUserId(): Promise<string | null> {
    if (ownerUserId === undefined) {
      const { data } = await db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle()
      ownerUserId = (data?.owner_user_id as string | null) ?? null
    }
    return ownerUserId
  }

  /**
   * A `property_subjective` learning that's high-confidence, non-isolated
   * (guaranteed by the `c.is_isolated` filter above), and recurring enough
   * (>= AUTO_APPLY_MIN_OCCURRENCES) gets applied immediately instead of
   * waiting for manual review — same pipeline as approving it by hand
   * (suggestions/[id]/route.ts), so a subsequent revert works identically
   * either way. Every other learning type keeps requiring approval.
   */
  async function tryAutoApply(
    payload: Record<string, unknown>,
  ): Promise<{ approved: boolean; extra: Record<string, unknown> }> {
    if (payload.type !== 'property_subjective') return { approved: false, extra: {} }
    const candidate = {
      confidence: payload.confidence as LearningConfidence,
      is_isolated: false,
      occurrence_count: (payload.occurrence_count as number) || 0,
    }
    if (!meetsAutoApplyThreshold(candidate)) return { approved: false, extra: {} }

    const owner = await getOwnerUserId()
    if (!owner) return { approved: false, extra: {} }

    try {
      const applied = await applyPropertySubjectiveLearning(db, accountId, config as AiConfig, owner, {
        propertyName: (payload.property_name as string | null) ?? null,
        info: payload.info as string,
      })
      if (!applied) return { approved: false, extra: {} }
      return {
        approved: true,
        extra: {
          applied_target: 'property_subjective',
          applied_property_id: applied.propertyId,
          previous_subjective_knowledge: applied.previousKnowledge,
          auto_applied: true,
          auto_applied_reason: `occurrence_count >= ${AUTO_APPLY_MIN_OCCURRENCES}, confidence high, is_isolated false`,
        },
      }
    } catch (err) {
      console.error('[learning generate] auto-apply failed:', err)
      return { approved: false, extra: {} }
    }
  }

  // Raw scanned messages, grouped by conversation — feeds the
  // conversation-evidence ledger below. Kept separate from `messages`
  // (which only has role/content, no conversation_id, for the model
  // prompt) since evidence must be counted per distinct conversation.
  const evidenceRows = textRows.map((r) => ({ conversationId: r.m.conversation_id, text: r.text }))

  /**
   * Every `property_subjective` candidate with a name accrues
   * conversation evidence toward the "is this a real, recurring
   * empreendimento" bar — regardless of this scan's own is_isolated/
   * confidence verdict, since a name flagged isolated in one batch can
   * still be genuinely recurring once several batches are combined.
   * Skipped entirely once the name already resolves to an existing
   * property (`safe_match`) — nothing left to prove for it — or is
   * `ambiguous` between multiple existing properties, since evidence
   * accumulated under an ambiguous name must never be allowed to spawn
   * a new property; only a genuine `no_match` accrues evidence.
   */
  async function maybeRecordPropertyEvidence(c: LearningCandidate): Promise<void> {
    if (c.type !== 'property_subjective' || !c.property_name) return
    try {
      const resolution = await resolvePropertyIdentity(db, accountId, c.property_name)
      if (resolution.kind !== 'no_match') return
      const { mentioned, withContext } = findConversationEvidence(evidenceRows, c.property_name)
      if (mentioned.size === 0) return
      await recordPropertyLearningEvidence(db, accountId, c.property_name, mentioned, withContext)
    } catch (err) {
      console.error('[learning generate] failed to record property evidence:', err)
    }
  }

  let created = 0
  let touched = 0
  for (const c of candidates) {
    await maybeRecordPropertyEvidence(c)

    if (c.is_isolated) continue
    if (!meetsLearningConfidenceThreshold(c.confidence)) continue

    const title = c.info.slice(0, TITLE_MAX_LENGTH)
    const normalized = normalizeTitle(title)
    if (knownDocTitles.has(normalized)) continue // already in the KB — nothing to suggest

    const existingPending = pendingByTitle.get(normalized)
    if (existingPending) {
      const prevCount =
        typeof existingPending.payload?.occurrence_count === 'number'
          ? (existingPending.payload.occurrence_count as number)
          : 1
      const mergedPayload = {
        ...existingPending.payload,
        occurrence_count: prevCount + c.occurrence_count,
        property_name: existingPending.payload?.property_name ?? c.property_name ?? null,
      }
      const { approved, extra } = await tryAutoApply(mergedPayload)
      const update: Record<string, unknown> = { payload: { ...mergedPayload, ...extra } }
      if (approved) {
        update.status = 'approved'
        update.resolved_at = new Date().toISOString()
        update.resolved_by = null
      }
      await db.from('ai_suggestions').update(update).eq('id', existingPending.id)
      touched++
      continue
    }

    const basePayload = {
      type: c.type,
      info: c.info,
      context_summary: c.context_summary,
      application: c.application,
      occurrence_count: c.occurrence_count,
      confidence: c.confidence,
      property_name: c.property_name ?? null,
      origin: 'Detectado automaticamente em conversas recentes',
    }
    const { approved, extra } = await tryAutoApply(basePayload)

    const { error: insertError } = await db.from('ai_suggestions').insert({
      account_id: accountId,
      category: 'learning',
      title,
      description: c.context_summary,
      payload: { ...basePayload, ...extra },
      status: approved ? 'approved' : 'pending',
      ...(approved ? { resolved_at: new Date().toISOString(), resolved_by: null } : {}),
    })
    if (insertError) {
      console.error('[learning generate] insert failed:', insertError)
      continue
    }
    created++
  }

  await db
    .from('ai_configs')
    .update({ learning_last_scanned_at: new Date().toISOString() })
    .eq('account_id', accountId)

  return { created, touched }
}
