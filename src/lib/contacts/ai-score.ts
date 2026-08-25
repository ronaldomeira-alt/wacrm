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

// Continuous 0→10 gradient for the score bar. Stops are evenly spaced
// across the fixed-width track (not the fill div) so the color at any
// point on the bar always matches that exact score position — the fill
// is a right-side mask that reveals more of this same gradient as the
// score rises, instead of restretching a shorter gradient.
const AI_SCORE_GRADIENT_STOPS = [
  '#64748B',
  '#5B7FA3',
  '#4F8FAF',
  '#4CA6A8',
  '#78A85A',
  '#C5A44A',
  '#D88A3D',
  '#C96B4B',
] as const;

export const AI_SCORE_GRADIENT_CSS = `linear-gradient(90deg, ${AI_SCORE_GRADIENT_STOPS.map(
  (color, i) => `${color} ${((i / (AI_SCORE_GRADIENT_STOPS.length - 1)) * 100).toFixed(2)}%`,
).join(', ')})`;
