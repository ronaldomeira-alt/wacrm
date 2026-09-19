import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Memory consolidation for Clara — turns repeated observations into
// consolidated knowledge instead of an ever-growing pile of near-duplicate
// rows. Sits ON TOP of the scoped memory system in memory.ts (scopes,
// retrieval, DB isolation) which this file never changes.
//
// Pipeline, for one new observation:
//   1. Load every active/candidate/conflict memory that shares this
//      observation's scope, target id and knowledge_type (never across
//      scopes/targets — a PROPERTY A fact can't merge with PROPERTY B).
//   2. Classify the new content against each: equivalent / conflict /
//      unrelated (classifyRelation — token overlap + numeric tolerance,
//      e.g. "18,94 m²" ~ "19 m²").
//   3. Equivalent to an existing row -> reinforceMemory: append this
//      occurrence's evidence (deduped by evidenceSignature, so 10 mentions
//      in the same conversation count as ONE independent confirmation),
//      recompute status/confidence from the accumulated evidence.
//   4. Conflicts with the ACTIVE row -> never overwrite it outright.
//      Official-source evidence replaces it immediately (history
//      preserved); anything else opens/reinforces a 'conflict'-status row,
//      which only replaces the active row once it independently
//      accumulates CONTRADICTION_MIN_INDEPENDENT_CONFIRMATIONS.
//   5. Neither -> first occurrence of new knowledge: created as
//      'candidate'/low confidence (CONVERSATION scope is the one
//      exception — a client fact is isolated by conversation already, so
//      it's trusted immediately, see evaluateConsolidation).
// ============================================================

import {
  fromDbRow,
  saveMemory,
  SELECT_COLUMNS,
  type MemoryConfidence,
  type MemoryDbRow,
  type MemoryEvidence,
  type MemoryKnowledgeType,
  type MemoryRow,
  type MemoryScope,
  type MemorySourceType,
  type MemoryValueHistoryEntry,
} from './memory'

/** Independent confirmations of the NEW value a 'conflict' row needs
 *  before it's allowed to replace an 'active' row — see spec §7. */
export const CONTRADICTION_MIN_INDEPENDENT_CONFIRMATIONS = 3

// ------------------------------------------------------------
// Evidence — independence rules
// ------------------------------------------------------------

/**
 * The dedup key for one piece of evidence. Any evidence tied to a
 * conversation collapses to that conversation's id REGARDLESS of kind —
 * this is what makes "the client mentioned it 10 times in one
 * conversation" count as exactly one confirmation, not ten (spec §5: "não
 * considerar como independentes: repetição literal da mesma mensagem").
 * 'system' evidence (Clara's own repeated output) is recorded for
 * traceability but its signature is intentionally unique per call
 * (Math.random) so it can never accumulate toward a threshold — see
 * isCountable.
 */
export function evidenceSignature(e: Pick<MemoryEvidence, 'kind' | 'conversationId' | 'messageId' | 'agentId' | 'ref' | 'note'>): string {
  if (e.conversationId) return `conversation:${e.conversationId}`
  if (e.kind === 'official') return `official:${e.note ?? e.ref ?? 'source'}`
  if (e.kind === 'human') return `human:${e.agentId ?? 'team'}:${e.ref ?? e.note ?? 'confirmation'}`
  if (e.messageId) return `message:${e.messageId}`
  return `system:${e.ref ?? e.note ?? Math.random().toString(36)}`
}

function isCountable(e: MemoryEvidence): boolean {
  return e.kind !== 'system'
}

/** Appends `next`, deduping by evidenceSignature — a duplicate signature
 *  is dropped (never re-counted), matching an existing entry is a no-op. */
function dedupEvidence(existing: MemoryEvidence[], next: MemoryEvidence): { merged: MemoryEvidence[]; wasNew: boolean } {
  const seen = new Set(existing.map(evidenceSignature))
  const sig = evidenceSignature(next)
  if (seen.has(sig)) return { merged: existing, wasNew: false }
  return { merged: [...existing, next], wasNew: true }
}

function distinctSignatureCount(evidence: MemoryEvidence[]): number {
  return new Set(evidence.filter(isCountable).map(evidenceSignature)).size
}

function distinctConversationCount(evidence: MemoryEvidence[]): number {
  return new Set(evidence.filter((e) => e.conversationId).map((e) => e.conversationId as string)).size
}

// ------------------------------------------------------------
// Confidence / status policy (spec §2-4)
// ------------------------------------------------------------

export function evaluateConsolidation(
  scope: MemoryScope,
  evidence: MemoryEvidence[],
): { status: 'active' | 'candidate'; confidence: MemoryConfidence } {
  const n = distinctSignatureCount(evidence)

  // CONVERSATION facts are already isolated by conversation_id — no
  // multi-confirmation bar to clear (spec §4).
  if (scope === 'conversation') return { status: 'active', confidence: n >= 2 ? 'high' : 'medium' }

  if (scope === 'global') {
    // Stricter bar: needs evidence across >= 2 distinct conversations,
    // not just 3 same-conversation mentions (spec §4: "seja mais rigoroso").
    if (n >= 3 && distinctConversationCount(evidence) >= 2) return { status: 'active', confidence: 'high' }
    if (n >= 2) return { status: 'candidate', confidence: 'medium' }
    return { status: 'candidate', confidence: 'low' }
  }

  // PROPERTY / AD: 3 independent confirmations related to the same
  // target are sufficient (spec §4).
  if (n >= 3) return { status: 'active', confidence: 'high' }
  if (n === 2) return { status: 'candidate', confidence: 'medium' }
  return { status: 'candidate', confidence: 'low' }
}

// ------------------------------------------------------------
// Semantic-equivalence-lite text classifier (spec §1, §9)
//
// Not an embedding/LLM comparison — a deterministic, testable normalizer
// so "18,94 m²" and "19 m²" fold into one memory instead of two, while
// staying fast and offline. Handles: accents, m²/metros/metro quadrado
// unit synonyms, common connector stopwords, and numeric tolerance.
// ------------------------------------------------------------

// 'ate'/'partir' ("até 22m²" vs "a partir de 22m²") and
// 'aproximadamente'/'cerca' are deliberately NOT stopwords — they carry the
// upper-bound/lower-bound/approximate qualifier that distinguishes an
// otherwise numerically-identical claim (e.g. "até 22m²" is a maximum,
// "a partir de 22m²" is a minimum; stripping both to bare "22m²" would
// silently fold two different claims into one memory).
const STOPWORDS = new Set([
  'de', 'da', 'do', 'a', 'o', 'as', 'os', 'em', 'no', 'na', 'com', 'para',
  'por', 'tem', 'sao', 'ser', 'e',
])

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function normalizeForCompare(raw: string): string {
  const s = stripAccents(raw.toLowerCase())
    .replace(/\bmetros?\s+quadrados?\b/g, ' m2 ')
    .replace(/m²/g, ' m2 ')
    .replace(/\bmetros?\b/g, ' m2 ')
    .replace(/[^a-z0-9,.\s]/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

function tokenize(raw: string): Set<string> {
  return new Set(
    normalizeForCompare(raw)
      .split(' ')
      .filter((t) => t.length > 0 && !STOPWORDS.has(t) && !/^\d+([.,]\d+)?$/.test(t)),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const x of a) if (b.has(x)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

// Matches, in order of preference: a full Brazilian thousands-grouped
// number with an optional decimal ("270.000,00", "1.234.567"), a
// comma-decimal ("18,94"), a dot-decimal ("22.5"), or a bare integer.
const NUMBER_PATTERN = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+|\d+\.\d+|\d+/g

/**
 * Parses one matched number token using Brazilian conventions ('.' as
 * thousands separator, ',' as decimal separator) instead of assuming
 * English formatting. "R$ 270.000,00" must parse as 270000, not 270 — the
 * previous comma->dot blanket replacement turned "270.000,00" into
 * "270.000.00" and then only read the first "270.000" as 270.
 */
function parseBrazilianNumber(token: string): number {
  const hasComma = token.includes(',')
  const hasDot = token.includes('.')
  if (hasComma && hasDot) return Number(token.replace(/\./g, '').replace(',', '.'))
  if (hasComma) return Number(token.replace(',', '.'))
  if (hasDot) {
    const parts = token.split('.')
    const isThousandsGrouping = parts.length > 2 || parts[parts.length - 1].length === 3
    return isThousandsGrouping ? Number(token.replace(/\./g, '')) : Number(token)
  }
  return Number(token)
}

function extractNumbers(raw: string): number[] {
  const matches = raw.match(NUMBER_PATTERN)
  return matches ? matches.map(parseBrazilianNumber) : []
}

function numbersClose(a: number, b: number): boolean {
  const diff = Math.abs(a - b)
  // Relative tolerance (handles "18,94 m²" ~ "19 m²"), but capped at an
  // absolute ceiling — an 8% relative band on a price in the hundreds of
  // thousands would swallow a real repricing (R$270k -> R$274k) as if it
  // were rounding noise. The cap keeps large-magnitude values (prices)
  // strict while staying lenient on small ones (areas, unit counts).
  const tolerance = Math.min(3, Math.max(0.5, 0.08 * Math.max(a, b)))
  return diff <= tolerance
}

const EQUIVALENCE_TOKEN_THRESHOLD = 0.4

export type TextRelation = 'equivalent' | 'conflict' | 'unrelated'

/**
 * 'equivalent': same claim, same value (or no value involved) — should
 *   fold into one memory.
 * 'conflict': same claim, DIFFERENT value (e.g. same attribute, m²/price
 *   disagree beyond tolerance) — must NOT silently overwrite.
 * 'unrelated': different claim entirely — a genuinely new memory.
 */
export function classifyRelation(a: string, b: string): TextRelation {
  const similarity = jaccard(tokenize(a), tokenize(b))
  if (similarity < EQUIVALENCE_TOKEN_THRESHOLD) return 'unrelated'

  const numbersA = extractNumbers(a)
  const numbersB = extractNumbers(b)
  if (numbersA.length > 0 && numbersB.length > 0) {
    return numbersClose(numbersA[0], numbersB[0]) ? 'equivalent' : 'conflict'
  }
  // Exactly one side states a number the other doesn't ("unidades a partir
  // de 18,94 m²" vs bare "unidades") — high token overlap alone must NOT
  // fold these into one memory: that would silently discard the specific
  // value. Spec §1: "informação nova cria nova memória".
  if (numbersA.length !== numbersB.length) return 'unrelated'
  return 'equivalent'
}

// ------------------------------------------------------------
// Low-signal filter (spec §11) — corretor slang/interjections never
// become memories, lexical or otherwise.
// ------------------------------------------------------------

const LOW_SIGNAL_PHRASES = new Set([
  'joia', 'joiaaaa', 'show de bola', 'maravilha', 'bom demais', 'massa',
  'legal', 'beleza', 'valeu', 'otimo', 'perfeito', 'tranquilo', 'de boa', 'show',
])

export function isLowSignalContent(content: string): boolean {
  const normalized = normalizeForCompare(content).replace(/[!?.]+/g, '').trim()
  if (LOW_SIGNAL_PHRASES.has(normalized)) return true
  const tokens = normalized.split(' ').filter(Boolean)
  return tokens.length <= 3 && tokens.every((t) => LOW_SIGNAL_PHRASES.has(t))
}

// ------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------

export interface ConsolidateMemoryArgs {
  accountId: string
  scope: MemoryScope
  knowledgeType: MemoryKnowledgeType
  title: string
  content: string
  propertyId?: string | null
  adId?: string | null
  conversationId?: string | null
  contactId?: string | null
  agentId?: string | null
  sourceType: MemorySourceType
  sourceMessageId?: string | null
  /** This occurrence's evidence — one call = one observation. */
  evidence: Omit<MemoryEvidence, 'recordedAt'> & { recordedAt?: string }
  metadata?: Record<string, unknown>
}

export type ConsolidateAction =
  | 'skipped_low_signal'
  | 'created_candidate'
  | 'created_active'
  | 'reinforced'
  | 'consolidated'
  | 'conflict_recorded'
  | 'conflict_reinforced'
  | 'replaced_by_official'
  | 'contradiction_resolved'

export interface ConsolidateResult {
  action: ConsolidateAction
  memory: MemoryRow | null
}

export async function consolidateMemory(
  db: SupabaseClient,
  args: ConsolidateMemoryArgs,
): Promise<ConsolidateResult> {
  if (isLowSignalContent(args.content)) return { action: 'skipped_low_signal', memory: null }

  const evidence: MemoryEvidence = {
    kind: args.evidence.kind,
    conversationId: args.evidence.conversationId ?? null,
    messageId: args.evidence.messageId ?? null,
    agentId: args.evidence.agentId ?? null,
    ref: args.evidence.ref ?? null,
    note: args.evidence.note ?? null,
    recordedAt: args.evidence.recordedAt ?? new Date().toISOString(),
  }

  const group = await loadConsolidationGroup(db, args)
  const active = group.filter((m) => m.status === 'active')
  const candidates = group.filter((m) => m.status === 'candidate')
  const conflicts = group.filter((m) => m.status === 'conflict')

  // 1. Equivalent to something already known (active or still-candidate)?
  for (const existing of [...active, ...candidates]) {
    if (classifyRelation(existing.content, args.content) === 'equivalent') {
      return reinforceMemory(db, args, existing, evidence)
    }
  }

  // 2. Conflicts with the currently-trusted ACTIVE fact?
  const conflictingActive = active.find((existing) => classifyRelation(existing.content, args.content) === 'conflict')
  if (conflictingActive) {
    if (evidence.kind === 'official') {
      return replaceWithOfficialSource(db, args, conflictingActive, evidence)
    }

    const existingConflict = conflicts.find(
      (c) =>
        (c.metadata?.conflictsWithId as string | undefined) === conflictingActive.id &&
        classifyRelation(c.content, args.content) === 'equivalent',
    )
    if (existingConflict) {
      const reinforced = await reinforceMemory(db, args, existingConflict, evidence)
      if (!reinforced.memory) return reinforced
      return maybePromoteConflict(db, args, reinforced.memory, conflictingActive)
    }
    return createConflictCandidate(db, args, conflictingActive, evidence)
  }

  // 3. Genuinely new knowledge.
  return createFreshMemory(db, args, evidence)
}

// ------------------------------------------------------------
// Internals
// ------------------------------------------------------------

async function loadConsolidationGroup(db: SupabaseClient, args: ConsolidateMemoryArgs): Promise<MemoryRow[]> {
  let q = db
    .from('ai_memories')
    .select(SELECT_COLUMNS)
    .eq('account_id', args.accountId)
    .eq('scope', args.scope)
    .eq('knowledge_type', args.knowledgeType)
    .in('status', ['active', 'candidate', 'conflict'])

  if (args.scope === 'property') q = q.eq('property_id', args.propertyId ?? '')
  if (args.scope === 'ad') q = q.eq('ad_id', args.adId ?? '')
  if (args.scope === 'conversation') q = q.eq('conversation_id', args.conversationId ?? '')
  // Style/pattern memories are attributed per-corretor — a Ronaldo-specific
  // pattern must never merge with Thatianna's or the team's unattributed one.
  q = args.agentId ? q.eq('agent_id', args.agentId) : q.is('agent_id', null)

  const { data, error } = await q.limit(100)
  if (error || !data) return []
  return (data as MemoryDbRow[]).map(fromDbRow)
}

async function reinforceMemory(
  db: SupabaseClient,
  args: ConsolidateMemoryArgs,
  existing: MemoryRow,
  evidence: MemoryEvidence,
): Promise<ConsolidateResult> {
  const { merged } = dedupEvidence(existing.evidence, evidence)
  const wasCandidate = existing.status === 'candidate'
  // A 'conflict' row never graduates to 'active'/'candidate' through this
  // generic path — it only ever becomes the active memory via
  // maybePromoteConflict, which also has to move its content into the
  // ORIGINAL active row and historize what it replaces. Here it just
  // accumulates evidence while staying a 'conflict' row.
  const { status, confidence } =
    existing.status === 'conflict'
      ? { status: 'conflict' as const, confidence: existing.confidence }
      : evaluateConsolidation(args.scope, merged)

  const { data, error } = await db
    .from('ai_memories')
    .update({
      status,
      confidence,
      occurrence_count: existing.occurrenceCount + 1,
      evidence: merged,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .eq('account_id', args.accountId)
    .select(SELECT_COLUMNS)
    .single()
  if (error || !data) throw error || new Error('reinforceMemory: update returned no row')

  const memory = fromDbRow(data as MemoryDbRow)
  const action: ConsolidateAction = wasCandidate && status === 'active' ? 'consolidated' : 'reinforced'
  return { action, memory }
}

async function createFreshMemory(
  db: SupabaseClient,
  args: ConsolidateMemoryArgs,
  evidence: MemoryEvidence,
): Promise<ConsolidateResult> {
  const immediate = args.scope === 'conversation'
  const memory = await saveMemory(db, {
    accountId: args.accountId,
    scope: args.scope,
    knowledgeType: args.knowledgeType,
    title: args.title,
    content: args.content,
    propertyId: args.propertyId,
    adId: args.adId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    agentId: args.agentId,
    sourceType: args.sourceType,
    sourceMessageId: args.sourceMessageId,
    confidence: immediate ? 'medium' : 'low',
    occurrenceCount: 1,
    status: immediate ? 'active' : 'candidate',
    evidence: [evidence],
    metadata: args.metadata,
  })
  return { action: immediate ? 'created_active' : 'created_candidate', memory }
}

async function createConflictCandidate(
  db: SupabaseClient,
  args: ConsolidateMemoryArgs,
  conflictingActive: MemoryRow,
  evidence: MemoryEvidence,
): Promise<ConsolidateResult> {
  const memory = await saveMemory(db, {
    accountId: args.accountId,
    scope: args.scope,
    knowledgeType: args.knowledgeType,
    title: args.title,
    content: args.content,
    propertyId: args.propertyId,
    adId: args.adId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    agentId: args.agentId,
    sourceType: args.sourceType,
    sourceMessageId: args.sourceMessageId,
    confidence: 'low',
    occurrenceCount: 1,
    status: 'conflict',
    evidence: [evidence],
    metadata: { ...(args.metadata ?? {}), conflictsWithId: conflictingActive.id },
  })
  return { action: 'conflict_recorded', memory }
}

/** Promotes a 'conflict' row to replace the 'active' row it contests, once
 *  it has independently accumulated CONTRADICTION_MIN_INDEPENDENT_CONFIRMATIONS
 *  (spec §7) — otherwise leaves both rows exactly as reinforceMemory left them. */
async function maybePromoteConflict(
  db: SupabaseClient,
  args: ConsolidateMemoryArgs,
  conflictMemory: MemoryRow,
  activeMemory: MemoryRow,
): Promise<ConsolidateResult> {
  if (distinctSignatureCount(conflictMemory.evidence) < CONTRADICTION_MIN_INDEPENDENT_CONFIRMATIONS) {
    return { action: 'conflict_reinforced', memory: conflictMemory }
  }

  const historyEntry: MemoryValueHistoryEntry = {
    value: activeMemory.content,
    replacedAt: new Date().toISOString(),
    reason: 'contradiction_resolved',
  }
  const { merged: mergedEvidence } = mergeEvidenceLists(activeMemory.evidence, conflictMemory.evidence)

  const { data, error } = await db
    .from('ai_memories')
    .update({
      content: conflictMemory.content,
      title: conflictMemory.title,
      confidence: 'high',
      status: 'active',
      evidence: mergedEvidence,
      value_history: [...activeMemory.valueHistory, historyEntry],
      occurrence_count: activeMemory.occurrenceCount + conflictMemory.occurrenceCount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', activeMemory.id)
    .eq('account_id', args.accountId)
    .select(SELECT_COLUMNS)
    .single()
  if (error || !data) throw error || new Error('maybePromoteConflict: update returned no row')

  await db
    .from('ai_memories')
    .update({
      status: 'archived',
      metadata: { ...(conflictMemory.metadata ?? {}), mergedIntoId: activeMemory.id },
      updated_at: new Date().toISOString(),
    })
    .eq('id', conflictMemory.id)
    .eq('account_id', args.accountId)

  return { action: 'contradiction_resolved', memory: fromDbRow(data as MemoryDbRow) }
}

/** An official-source contradiction replaces the active memory immediately
 *  (spec §7's exception) — the previous value is preserved in value_history,
 *  never silently lost (spec §8). */
async function replaceWithOfficialSource(
  db: SupabaseClient,
  args: ConsolidateMemoryArgs,
  activeMemory: MemoryRow,
  evidence: MemoryEvidence,
): Promise<ConsolidateResult> {
  const historyEntry: MemoryValueHistoryEntry = {
    value: activeMemory.content,
    replacedAt: new Date().toISOString(),
    reason: 'official_source',
  }
  const { merged: mergedEvidence } = dedupEvidence(activeMemory.evidence, evidence)

  const { data, error } = await db
    .from('ai_memories')
    .update({
      content: args.content,
      title: args.title,
      confidence: 'high',
      status: 'active',
      evidence: mergedEvidence,
      value_history: [...activeMemory.valueHistory, historyEntry],
      occurrence_count: activeMemory.occurrenceCount + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', activeMemory.id)
    .eq('account_id', args.accountId)
    .select(SELECT_COLUMNS)
    .single()
  if (error || !data) throw error || new Error('replaceWithOfficialSource: update returned no row')

  return { action: 'replaced_by_official', memory: fromDbRow(data as MemoryDbRow) }
}

function mergeEvidenceLists(a: MemoryEvidence[], b: MemoryEvidence[]): { merged: MemoryEvidence[] } {
  let merged = a
  for (const e of b) merged = dedupEvidence(merged, e).merged
  return { merged }
}
