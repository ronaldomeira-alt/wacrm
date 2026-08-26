// ============================================================
// Shapes for follow-up candidate scoring (BLOCO 3/4). Same
// strict-JSON-in-prompt approach as lead-analysis-types.ts — no
// provider JSON mode exists in this codebase's adapters.
// ============================================================

export interface FollowupScoreResult {
  should_suggest: boolean;
  /** Motivo — why this lead deserves a follow-up now. */
  reason: string | null;
  /** Sugestão de abordagem — a short angle for the message, not the message itself. */
  approach_summary: string | null;
  /** 0–100. */
  score: number | null;
}

function nullableString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function nullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Never throws — returns null on anything unparseable, which callers
 *  treat as "no evidence, skip this candidate". */
export function parseFollowupScoreResult(raw: string): FollowupScoreResult | null {
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
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;

  const shouldSuggest = o.should_suggest === true;
  if (!shouldSuggest) {
    return { should_suggest: false, reason: null, approach_summary: null, score: null };
  }
  const score = nullableNumber(o.score);
  const reason = nullableString(o.reason);
  if (score === null || !reason) {
    return { should_suggest: false, reason: null, approach_summary: null, score: null };
  }
  return {
    should_suggest: true,
    reason,
    approach_summary: nullableString(o.approach_summary),
    score: Math.max(0, Math.min(100, Math.round(score))),
  };
}

// ============================================================
// Follow-up Inteligente — 2-contact scheduled plan. A plan is an
// approved sequence of up to two pre-filled template sends, queued
// into `scheduled_sends` and dispatched by the same cron tick that
// generates follow-up suggestions (processDueFollowupSends).
// ============================================================

export interface FollowupPlanContact {
  template_id: string;
  template_name: string;
  /** Approved template's language code (e.g. "pt_BR") — carried
   *  through so the actual send uses the template's real language
   *  instead of assuming one. */
  template_language: string;
  body_text: string;
  values: { body: string[]; headerText?: string };
  /** Days after the previous step (or after approval, for contact1)
   *  to send this message. */
  scheduleDays: number;
}

export interface FollowupPlan {
  contact1: FollowupPlanContact | null;
  contact2: FollowupPlanContact | null;
}
