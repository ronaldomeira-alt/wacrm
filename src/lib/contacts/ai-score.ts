// ============================================================
// ai-score.ts — shared presentation helper for `contacts.ai_score`
// (migration 082). One source of truth for the 0–10 → band mapping
// (section 5 of the AGENTS task) so the Inbox sidebar and the
// Contacts detail view can't drift from each other.
// ============================================================

export type AiScoreBand = 'cold' | 'curious' | 'interested' | 'warm' | 'hot' | 'ready';

/** 0–2 Frio · 3–4 Curioso · 5–6 Interessado · 7–8 Aquecido · 9 Muito
 *  quente · 10 Pronto para avançar. Returns a band key, not display
 *  text — callers translate it via `t(\`aiScoreBand.${band}\`)`. */
export function aiScoreBand(score: number): AiScoreBand {
  if (score <= 2) return 'cold';
  if (score <= 4) return 'curious';
  if (score <= 6) return 'interested';
  if (score <= 8) return 'warm';
  if (score === 9) return 'hot';
  return 'ready';
}
