// ============================================================
// Shapes for supervised-learning scanning (BLOCO 4/4 & ETAPA 8). Same
// strict-JSON-in-prompt approach as the rest of this AI surface.
// ============================================================

export type LearningType =
  // Legacy types with their own dedicated destination — never routed
  // through ai_memories (see learning-generate.ts / suggestions/[id]/route.ts):
  // property_subjective → property_ai_contexts (proven, isolated RAG);
  // never_rule/boundary_suggestion → ai_configs.global_never_rules;
  // process_suggestion → recorded as a process note, never recited to a
  // customer; global_knowledge → ai_knowledge_documents (legacy catch-all).
  | 'property_subjective'
  | 'never_rule'
  | 'language_style'
  | 'global_knowledge'
  | 'boundary_suggestion'
  | 'process_suggestion'
  // Scoped types — routed to ai_memories once approved. Scope is always
  // derived from the type itself (see inferScopeFromKnowledgeType in
  // memory.ts), never a separately-trusted field.
  // GLOBAL:
  | 'business_rule'
  | 'company_fact'
  | 'sales_strategy'
  | 'communication_pattern'
  // PROPERTY (beyond property_subjective, which keeps its own pipeline):
  | 'property_fact'
  | 'property_sales_argument'
  | 'property_objection'
  | 'property_market_insight'
  // AD:
  | 'ad_fact'
  | 'ad_strategy'
  // CONVERSATION:
  | 'client_preference'
  | 'conversation_context'
  // Pre-scoped-memory legacy values still sitting in old ai_suggestions
  // rows (Aug 2026) — accepted so parsing/history doesn't choke on them,
  // never produced by the current prompt.
  | 'factual'
  | 'commercial_rule'
  | 'procedure'
  | 'communication_style'
  | 'template_usage'
  | 'followup_pattern'
  | 'other';

export type LearningConfidence = 'low' | 'medium' | 'high';

export interface LearningCandidate {
  type: LearningType;
  /** Explicit target categorization for Stage 8 */
  target?: LearningType;
  /** The knowledge or proposed rule itself, stated as a standalone fact/rule. */
  info: string;
  /** Short context summary. */
  context_summary: string | null;
  /** Proposed application / impact. */
  application: string | null;
  /** Expected impact summary */
  expected_impact?: string | null;
  /** How many times the model observed this pattern in the batch. */
  occurrence_count: number;
  confidence: LearningConfidence;
  /** True = a single, isolated statement or opinion — MUST NOT become a suggestion. */
  is_isolated: boolean;
  /** Optional target property name if specific to a property. */
  property_name?: string | null;
  /** Target property ID resolved by backend. */
  property_id?: string | null;
  /** Ad source_id (conversations.ctwa_referral->>'source_id') this
   *  learning is specific to — only meaningful for AD-scoped types. */
  ad_id?: string | null;
  /** Conversation id this learning is specific to — only meaningful for
   *  CONVERSATION-scoped types (client_preference, conversation_context). */
  conversation_id?: string | null;
  /** Display name of the corretor (e.g. "Ronaldo", "Thatianna") this
   *  language_style/communication_pattern was consistently attributed to
   *  in the transcript — null/omitted means "the team in general", never
   *  "unknown". Resolved to a profiles.user_id by the caller, never
   *  trusted as an id directly. */
  agent_name?: string | null;
}

export type CandidateLearning = LearningCandidate;

export const LEARNING_TYPES: readonly LearningType[] = [
  'property_subjective',
  'never_rule',
  'language_style',
  'global_knowledge',
  'boundary_suggestion',
  'process_suggestion',
  'business_rule',
  'company_fact',
  'sales_strategy',
  'communication_pattern',
  'property_fact',
  'property_sales_argument',
  'property_objection',
  'property_market_insight',
  'ad_fact',
  'ad_strategy',
  'client_preference',
  'conversation_context',
  'factual',
  'commercial_rule',
  'procedure',
  'communication_style',
  'template_usage',
  'followup_pattern',
  'other',
];

export const CONFIDENCES: readonly LearningConfidence[] = ['low', 'medium', 'high'];

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Best-effort recovery for a response truncated mid-array by an output
 * token limit (see LEARNING_SCAN_MAX_OUTPUT_TOKENS) — e.g. the model was
 * cut off partway through `{"learnings": [{...}, {...}, {"type": "prop`.
 * Walks back to the last `},` that closed a complete object at the top
 * level of the array, drops everything after it (the truncated tail),
 * and closes the array/object. Salvages every complete candidate the
 * model produced before running out of budget instead of discarding the
 * whole batch. Returns null when there's no complete object to recover
 * (e.g. the very first candidate was already cut off).
 */
function tryRepairTruncatedLearnings(text: string): unknown[] | null {
  const arrayStart = text.indexOf('[');
  if (arrayStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastCompleteObjectEnd = -1;

  for (let i = arrayStart; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      // depth returning to 0 means we just closed a `{...}` that isn't
      // nested inside anything else — i.e. a complete top-level element
      // of the `learnings` array (each candidate is a flat object, no
      // nested objects of its own, so 0 is always "between elements").
      if (depth === 0) lastCompleteObjectEnd = i;
    }
  }

  if (lastCompleteObjectEnd === -1) return null;
  const salvaged = `${text.slice(arrayStart, lastCompleteObjectEnd + 1)}]`;
  try {
    const parsed = JSON.parse(salvaged);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Never throws — unparseable/malformed entries are dropped rather
 *  than surfaced as broken suggestions. Returns `null` only when the
 *  whole response isn't JSON at all, even after (1) stripping markdown
 *  fences, (2) trimming any prose the model added before/after the JSON
 *  object, and (3) attempting to salvage a truncated `learnings` array —
 *  three independent, increasingly-lenient recovery attempts, since a
 *  large-model response wrapping strict JSON in commentary or getting cut
 *  off by the output token budget is common enough to guard against
 *  rather than silently stall the caller's cursor (see learning-generate.ts). */
export function parseLearningScanResult(raw: string): LearningCandidate[] | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Attempt 2: trim leading/trailing prose around the JSON object.
    const firstBrace = stripped.indexOf('{');
    const lastBrace = stripped.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        parsed = JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
      } catch {
        // Attempt 3: salvage a truncated learnings array.
        const salvaged = tryRepairTruncatedLearnings(stripped);
        if (salvaged === null) return null;
        parsed = { learnings: salvaged };
      }
    } else {
      return null;
    }
  }

  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { learnings?: unknown })?.learnings)
      ? (parsed as { learnings: unknown[] }).learnings
      : null;
  if (!arr) return null;

  const out: LearningCandidate[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const info = str(o.info);
    if (!info) continue;

    // Reject price/discount boundary tampering attempts
    const normText = `${info} ${str(o.application) ?? ''}`.toLowerCase();
    const isPriceTampering =
      /(informar|passar|dizer|fornecer|praticar).*(preço|preco|valor|tabela|desconto|m2|metro quadrado)/i.test(normText) ||
      /(conceder|dar|oferecer).*(desconto|abatimento|vantagem comercial)/i.test(normText) ||
      /(negociar|negociação|negociacao).*(preço|preco|valor|condição|condicao)/i.test(normText);

    if (isPriceTampering) {
      // Dynamic commercial info cannot become an AI rule
      continue;
    }

    const type = LEARNING_TYPES.includes(o.type as LearningType) ? (o.type as LearningType) : 'other';
    const target = LEARNING_TYPES.includes(o.target as LearningType)
      ? (o.target as LearningType)
      : type;
    const confidence = CONFIDENCES.includes(o.confidence as LearningConfidence)
      ? (o.confidence as LearningConfidence)
      : 'low';
    const occurrence = typeof o.occurrence_count === 'number' && o.occurrence_count > 0
      ? Math.floor(o.occurrence_count)
      : 1;

    out.push({
      type,
      target,
      info,
      context_summary: str(o.context_summary),
      application: str(o.application),
      expected_impact: str(o.expected_impact) ?? str(o.application),
      occurrence_count: occurrence,
      confidence,
      is_isolated: o.is_isolated !== false,
      property_name: str(o.property_name),
      property_id: str(o.property_id),
      ad_id: str(o.ad_id),
      conversation_id: str(o.conversation_id),
      agent_name: str(o.agent_name),
    });
  }
  return out;
}
