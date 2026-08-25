// ============================================================
// Tunables for lead analysis (BLOCO 2/4) — centralized here per the
// spec's section 8 requirement ("esses limites devem ficar
// configuráveis futuramente e não espalhados pelo código") rather
// than as literals scattered across lead-analysis.ts.
// ============================================================

import type { TagConfidence } from './lead-analysis-types';

/** Minimum seconds between analysis runs for the same contact. Bounds
 *  cost when a customer sends several messages in a burst — the last
 *  one in a burst still gets analyzed once the cooldown clears, since
 *  the next inbound re-triggers `dispatchInboundToLeadAnalysis`. */
export const LEAD_ANALYSIS_COOLDOWN_SECONDS = 90;

/** How many recent text messages to read on the very first analysis
 *  of a contact (no persisted summary yet). */
export const LEAD_ANALYSIS_INITIAL_MESSAGE_LIMIT = 40;

/** Cap on "new since last analysis" messages fed into one incremental
 *  run, so a contact that went quiet for weeks and comes back with a
 *  huge backlog doesn't blow the prompt/cost budget in one call. */
export const LEAD_ANALYSIS_INCREMENTAL_MESSAGE_LIMIT = 20;

/** Below this score, a stage-move suggestion is not created at all
 *  (BLOCO 2/4 section 8: "abaixo de 60: não criar sugestão"). */
export const STAGE_SUGGESTION_MIN_SCORE = 60;

/** Tag confidence below this level is never applied (section 3:
 *  "quando houver baixa confiança, preferir não alterar"). */
export const TAG_CONFIDENCE_MIN: TagConfidence = 'medium';

const CONFIDENCE_RANK: Record<TagConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function meetsTagConfidenceThreshold(confidence: TagConfidence): boolean {
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[TAG_CONFIDENCE_MIN];
}

// ── Pipeline auto-progression rules ─────────────────────────────────────────
// Defines the 3 forward transitions that are executed automatically (without
// human review in the Central de IA) when BOTH conditions are met:
//   1. The AI's stage_suggestion.score (0-100) ≥ STAGE_SUGGESTION_MIN_SCORE
//      — the AI has real behavioral evidence (checked earlier in the flow)
//   2. The lead's ai_score (0-10) ≥ minAiScore below
//      — the lead's warmth/intent level qualifies for the target stage
//
// Stage names are stored lowercase for case-insensitive matching. The Score
// alone never triggers a move; the AI's evidence signal (should_suggest: true
// + score ≥ 60) is always required in addition.
//
// NEVER add backward transitions here. NEVER include Follow-up as a target
// — Follow-up moves remain human-approved suggestions in the Central de IA.

export interface PipelineAutoMoveRule {
  /** Current stage name, lowercase. */
  from: string
  /** Target stage name, lowercase. */
  to: string
  /** Minimum contacts.ai_score (0-10) required to trigger the automatic move. */
  minAiScore: number
}

export const PIPELINE_AUTO_MOVE_RULES: PipelineAutoMoveRule[] = [
  // Novo Lead → Qualificação: client started defining what they're looking for
  { from: 'novo lead', to: 'qualificação', minAiScore: 3 },
  // Novo Lead → Interesse (skip): strong commercial intent signal (simulation,
  // financing, visit, proposal, etc.) plus high warmth
  { from: 'novo lead', to: 'interesse', minAiScore: 7 },
  // Qualificação → Interesse: client clearly moved beyond discovery phase
  { from: 'qualificação', to: 'interesse', minAiScore: 7 },
]

/** Human-readable band for a 0–100 score, for display only (section 8). */
export function scoreConfidenceBand(score: number): 'strong' | 'good' | 'moderate' | 'low' {
  if (score >= 90) return 'strong';
  if (score >= 75) return 'good';
  if (score >= 60) return 'moderate';
  return 'low';
}
