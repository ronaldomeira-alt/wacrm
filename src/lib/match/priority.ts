/**
 * FASE 9 & FASE 19: Prioridade Comercial e Fadiga de Envio
 *
 * A temperatura/score de aquecimento (0–10) e o histórico de engajamento
 * NÃO alteram o percentual do Match (que é estritamente baseado no imóvel e perfil).
 *
 * Em vez disso, compõem a `commercial_priority`, usada internamente para
 * ordenar inteligentemente os cards e listas do CRM.
 */

export interface CommercialPriorityInput {
  matchScore: number;           // 0–100
  aiScore: number;              // 0–10 (contacts.ai_score)
  profileMaturity: number;      // 0–100
  recentInteractionDays?: number | null; // Dias desde a última mensagem do lead
  sharesCount?: number;         // Total de imóveis já enviados a este lead
  sharesOpenedCount?: number;   // Total de imóveis abertos pelo lead
  hasInterestClick?: boolean;   // Se já clicou em "Tenho interesse" em algum imóvel
}

export function calculateCommercialPriority(input: CommercialPriorityInput): number {
  const {
    matchScore,
    aiScore,
    profileMaturity,
    recentInteractionDays = 0,
    sharesCount = 0,
    sharesOpenedCount = 0,
    hasInterestClick = false,
  } = input;

  // 1. Componente de Match (Peso 35% — 0 a 35 pontos)
  const matchComponent = Math.min(100, Math.max(0, matchScore)) * 0.35;

  // 2. Componente de Temperatura / Warmth (0 a 10 escalado para 0 a 25 — Peso 25%)
  const warmthComponent = Math.min(10, Math.max(0, aiScore)) * 2.5;

  // 3. Componente de Maturidade (0 a 100 escalado para 0 a 15 — Peso 15%)
  const maturityComponent = Math.min(100, Math.max(0, profileMaturity)) * 0.15;

  // 4. Recência da Interação (Peso 15% — 0 a 15 pontos)
  // Converte a curva existente (máx 10) proporcionalmente para máx 15 (fator 1.5)
  let rawRecency = 0;
  if (recentInteractionDays !== null && recentInteractionDays !== undefined) {
    if (recentInteractionDays <= 1) rawRecency = 10;
    else if (recentInteractionDays <= 3) rawRecency = 7;
    else if (recentInteractionDays <= 7) rawRecency = 4;
    else if (recentInteractionDays <= 14) rawRecency = 2;
    else rawRecency = 0;
  }
  const recencyComponent = rawRecency * 1.5;

  // 5. Engajamento Histórico com Envios (Peso 10% — 0 a 10 pontos)
  // Converte a curva existente (máx 15) proporcionalmente para máx 10 (fator 10 / 15)
  let rawEngagement = 0;
  if (hasInterestClick) {
    rawEngagement += 8;
  }
  if (sharesOpenedCount > 0) {
    rawEngagement += Math.min(7, sharesOpenedCount * 2);
  }
  const engagementComponent = (rawEngagement * 10) / 15;

  // 6. Fadiga de Envio (Penalidade por envios sem reciprocidade/abertura)
  let fatiguePenalty = 0;
  const unreciprocatedShares = Math.max(0, sharesCount - sharesOpenedCount);
  if (unreciprocatedShares >= 5) {
    fatiguePenalty = 15;
  } else if (unreciprocatedShares >= 3) {
    fatiguePenalty = 8;
  } else if (unreciprocatedShares >= 2) {
    fatiguePenalty = 4;
  }

  const priorityScore =
    matchComponent +
    warmthComponent +
    maturityComponent +
    recencyComponent +
    engagementComponent -
    fatiguePenalty;

  return Math.round(Math.max(0, priorityScore) * 10) / 10;
}
