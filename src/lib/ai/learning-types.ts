// ============================================================
// Shapes for supervised-learning scanning (BLOCO 4/4 & ETAPA 8). Same
// strict-JSON-in-prompt approach as the rest of this AI surface.
// ============================================================

export type LearningType =
  | 'property_subjective'
  | 'never_rule'
  | 'language_style'
  | 'global_knowledge'
  | 'boundary_suggestion'
  | 'process_suggestion'
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
}

export type CandidateLearning = LearningCandidate;

export const LEARNING_TYPES: readonly LearningType[] = [
  'property_subjective',
  'never_rule',
  'language_style',
  'global_knowledge',
  'boundary_suggestion',
  'process_suggestion',
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

/** Never throws — unparseable/malformed entries are dropped rather
 *  than surfaced as broken suggestions. Returns `null` only when the
 *  whole response isn't JSON at all. */
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
    return null;
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
    });
  }
  return out;
}
