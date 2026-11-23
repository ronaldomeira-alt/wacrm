export type MatchSortBy = 'score_desc' | 'recent_desc' | 'priority_desc' | 'ai_score_desc';

export interface SortableMatchGroup {
  leadId: string;
  profileMaturity: number;
  aiScore: number;
  latestMatchAt?: string | null;
  bestMatch?: {
    match_score?: number | null;
    profile_maturity?: number | null;
    commercial_priority?: number | null;
    created_at?: string | null;
  } | null;
}

/**
 * Hierarquia oficial obrigatória de ordenação comercial de oportunidades do Match:
 * 1º Percentual de Match (match_score do bestMatch exibido no card), decrescente
 * 2º Maturidade comercial do lead (profile_maturity), decrescente
 * 3º Score ou temperatura do lead (ai_score), decrescente
 * 4º Critério técnico de desempate determinístico (latestMatchAt DESC, leadId ASC)
 */
export function compareMatchGroupsByCommercialHierarchy(
  a: SortableMatchGroup,
  b: SortableMatchGroup
): number {
  const scoreA = Number(a.bestMatch?.match_score ?? 0);
  const scoreB = Number(b.bestMatch?.match_score ?? 0);
  if (scoreB !== scoreA) return scoreB - scoreA;

  const maturityA = Number(a.profileMaturity ?? a.bestMatch?.profile_maturity ?? 0);
  const maturityB = Number(b.profileMaturity ?? b.bestMatch?.profile_maturity ?? 0);
  if (maturityB !== maturityA) return maturityB - maturityA;

  const aiScoreA = Number(a.aiScore ?? 0);
  const aiScoreB = Number(b.aiScore ?? 0);
  if (aiScoreB !== aiScoreA) return aiScoreB - aiScoreA;

  const timeA = a.latestMatchAt ? new Date(a.latestMatchAt).getTime() || 0 : 0;
  const timeB = b.latestMatchAt ? new Date(b.latestMatchAt).getTime() || 0 : 0;
  if (timeB !== timeA) return timeB - timeA;

  return String(a.leadId || '').localeCompare(String(b.leadId || ''));
}

export function compareMatchGroups(
  a: SortableMatchGroup,
  b: SortableMatchGroup,
  sortBy: string = 'score_desc'
): number {
  if (sortBy === 'recent_desc') {
    const timeA = a.latestMatchAt ? new Date(a.latestMatchAt).getTime() || 0 : 0;
    const timeB = b.latestMatchAt ? new Date(b.latestMatchAt).getTime() || 0 : 0;
    if (timeB !== timeA) return timeB - timeA;
    return compareMatchGroupsByCommercialHierarchy(a, b);
  }

  if (sortBy === 'priority_desc') {
    const prioA = Number(a.bestMatch?.commercial_priority ?? 0);
    const prioB = Number(b.bestMatch?.commercial_priority ?? 0);
    if (prioB !== prioA) return prioB - prioA;
    return compareMatchGroupsByCommercialHierarchy(a, b);
  }

  if (sortBy === 'ai_score_desc') {
    const aiScoreA = Number(a.aiScore ?? 0);
    const aiScoreB = Number(b.aiScore ?? 0);
    if (aiScoreB !== aiScoreA) return aiScoreB - aiScoreA;
    return compareMatchGroupsByCommercialHierarchy(a, b);
  }

  // Padrão obrigatório ('score_desc')
  return compareMatchGroupsByCommercialHierarchy(a, b);
}
