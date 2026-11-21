import type {
  LeadSearchProfile,
  MatchDecisionSnapshot,
  MatchLifecycleMeta,
  MatchStatus,
  PropertyProjection,
} from './types';

export const MAX_MATERIAL_REOPENS = 2;
export const RECENT_MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

export interface RawMatchRowForLifecycle {
  id?: string;
  match_status?: string | null;
  suppressed?: boolean | null;
  match_score?: number | string | null;
  profile_maturity?: number | null;
  score_breakdown?: Record<string, unknown> | null;
  viewed_at?: string | null;
  ignored_at?: string | null;
  archived_at?: string | null;
  paused_at?: string | null;
  sent_at?: string | null;
  reopened_at?: string | null;
  reopen_reason?: string | null;
  reopen_count?: number | null;
  status_snapshot?: MatchDecisionSnapshot | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ResolvedMatchLifecycle {
  effectiveStatus: MatchStatus;
  isSuppressedOrIgnored: boolean;
  viewedAt: string | null;
  ignoredAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  reopenCount: number;
  snapshot: MatchDecisionSnapshot | null;
  isUnread: boolean;
  isRecent: boolean;
}

/**
 * Resolve o estado efetivo do ciclo de vida do Match combinando colunas nativas
 * (pós-migration 088) e metadados JSONB `_lifecycle` em `score_breakdown`
 * (compatibilidade retroativa sem downtime).
 */
export function resolveMatchLifecycle(
  row: RawMatchRowForLifecycle,
  nowMs: number = Date.now()
): ResolvedMatchLifecycle {
  const breakdown =
    row.score_breakdown && typeof row.score_breakdown === 'object'
      ? row.score_breakdown
      : {};
  const meta = (breakdown._lifecycle || {}) as MatchLifecycleMeta;

  const viewedAt = row.viewed_at ?? meta.viewedAt ?? null;
  const ignoredAt = row.ignored_at ?? meta.ignoredAt ?? null;
  const reopenedAt = row.reopened_at ?? meta.reopenedAt ?? null;
  const reopenReason = row.reopen_reason ?? meta.reopenReason ?? null;
  const reopenCount =
    typeof row.reopen_count === 'number'
      ? row.reopen_count
      : typeof meta.reopenCount === 'number'
      ? meta.reopenCount
      : 0;
  const snapshot = (row.status_snapshot ?? meta.snapshot ?? null) as MatchDecisionSnapshot | null;

  const rawStatus = (row.match_status || 'novo') as MatchStatus;
  let effectiveStatus: MatchStatus = rawStatus;

  if (row.suppressed || rawStatus === 'ignorado' || meta.state === 'ignorado') {
    effectiveStatus = 'ignorado';
  } else if (rawStatus === 'enviado' || rawStatus === 'pausado' || rawStatus === 'arquivado') {
    effectiveStatus = rawStatus;
  } else if (rawStatus === 'em_analise' || meta.state === 'em_analise') {
    effectiveStatus = 'em_analise';
  } else {
    effectiveStatus = 'novo';
  }

  const referenceTimeStr = reopenedAt || row.created_at || row.updated_at || null;
  const referenceMs = referenceTimeStr ? new Date(referenceTimeStr).getTime() : 0;
  const isRecent =
    referenceMs > 0 && !Number.isNaN(referenceMs) && nowMs - referenceMs <= RECENT_MATCH_WINDOW_MS;

  const isUnread = effectiveStatus === 'novo' && !viewedAt;

  return {
    effectiveStatus,
    isSuppressedOrIgnored: effectiveStatus === 'ignorado',
    viewedAt,
    ignoredAt,
    reopenedAt,
    reopenReason,
    reopenCount,
    snapshot,
    isUnread,
    isRecent,
  };
}

/**
 * Embute os metadados de ciclo de vida dentro de `score_breakdown._lifecycle`
 * preservando todos os campos existentes de breakdown.
 */
export function embedLifecycleInBreakdown(
  scoreBreakdown: unknown,
  meta: MatchLifecycleMeta
): Record<string, unknown> {
  const base =
    scoreBreakdown && typeof scoreBreakdown === 'object'
      ? { ...(scoreBreakdown as Record<string, unknown>) }
      : {};
  const existingMeta =
    base._lifecycle && typeof base._lifecycle === 'object'
      ? (base._lifecycle as MatchLifecycleMeta)
      : {};

  base._lifecycle = {
    ...existingMeta,
    ...meta,
  };
  return base;
}

/**
 * Constrói um snapshot objetivo do par (lead, imóvel) no momento em que o corretor
 * decide ignorar ou arquivar a oportunidade.
 */
export function buildDecisionSnapshot(args: {
  decidedStatus: 'ignorado' | 'arquivado';
  matchScore: number;
  property?: Partial<PropertyProjection> | null;
  profile?: Partial<LeadSearchProfile> | null;
  leadMaturity?: number;
  decidedAt?: string;
}): MatchDecisionSnapshot {
  return {
    decidedAt: args.decidedAt || new Date().toISOString(),
    decidedStatus: args.decidedStatus,
    matchScore: Math.round(Number(args.matchScore) || 0),
    propertyPriceMin: Number(args.property?.priceMin ?? 0),
    propertyPriceMax: Number(args.property?.priceMax ?? args.property?.priceMin ?? 0),
    propertyNeighborhood: String(args.property?.neighborhood || ''),
    propertyBedroomsMin: args.property?.bedroomsMin ?? null,
    propertyDeliveryStatus: args.property?.deliveryStatus || 'pronto',
    leadPriceMax: args.profile?.priceMax ?? null,
    leadMaturity: Number(args.leadMaturity ?? 0),
  };
}

export interface MaterialReopenEvaluation {
  shouldReopen: boolean;
  reason: string | null;
  triggerType?: 'price_drop' | 'score_jump' | 'budget_increase' | 'delivery_ready';
}

/**
 * Avalia se um Match que estava `ignorado` (`suppressed = true`) ou `arquivado`
 * sofreu uma mudança material objetiva que justifique sua reabertura como nova oportunidade.
 *
 * Regras de proteção contra reativações repetitivas:
 * 1. Se não houver snapshot gravado na decisão anterior, NÃO reabre automaticamente
 *    (respeita as supressões legadas sem provocar reaberturas falsas).
 * 2. Limita o máximo de reaberturas automáticas por par a `MAX_MATERIAL_REOPENS` (2).
 * 3. Exige que a nova avaliação atinja patamar comercial relevante (score >= 75 e maturidade >= 60).
 * 4. Exige pelo menos 1 dos 4 gatilhos materiais objetivos:
 *    - A. Queda de preço do imóvel >= 8% (e >= R$ 15.000 em venda ou >= R$ 300 em locação)
 *         colocando-o dentro do orçamento do cliente.
 *    - B. Salto de compatibilidade >= +15 pontos percentuais atingindo Match Forte (>= 85%).
 *    - C. Ampliação do orçamento do lead >= +15% passando a cobrir integralmente o preço do imóvel.
 *    - D. Conclusão de obra: imóvel passou de `planta`/`em_construcao` para `pronto` quando o lead busca `pronto`.
 */
export function evaluateMaterialReopen(args: {
  existingRow: RawMatchRowForLifecycle;
  newScore: number;
  newMaturity: number;
  property: PropertyProjection;
  profile: LeadSearchProfile;
}): MaterialReopenEvaluation {
  const lifecycle = resolveMatchLifecycle(args.existingRow);

  if (lifecycle.effectiveStatus !== 'ignorado' && lifecycle.effectiveStatus !== 'arquivado') {
    return { shouldReopen: false, reason: null };
  }

  // Limite anti-loop de reativações
  if (lifecycle.reopenCount >= MAX_MATERIAL_REOPENS) {
    return { shouldReopen: false, reason: null };
  }

  // Sem snapshot anterior (ex.: supressão legada sem baseline), preserva a decisão humana
  const snap = lifecycle.snapshot;
  if (!snap) {
    return { shouldReopen: false, reason: null };
  }

  // Só reabre se a oportunidade resultante for comercialmente relevante
  if (args.newScore < 75 || args.newMaturity < 60) {
    return { shouldReopen: false, reason: null };
  }

  const newPrice = Number(args.property.priceMin || args.property.priceMax || 0);
  const oldPrice = Number(snap.propertyPriceMin || snap.propertyPriceMax || 0);

  // Gatilho A: Redução relevante de preço do imóvel (>= 8%)
  if (oldPrice > 0 && newPrice > 0 && newPrice < oldPrice) {
    const dropAmount = oldPrice - newPrice;
    const dropRatio = dropAmount / oldPrice;
    const minDropCurrency = args.property.operation === 'locacao' ? 300 : 15000;
    const fitsBudget =
      args.profile.priceMax === null ||
      args.profile.priceMax <= 0 ||
      newPrice <= args.profile.priceMax * 1.05;

    if (dropRatio >= 0.08 && dropAmount >= minDropCurrency && fitsBudget) {
      const pct = Math.round(dropRatio * 100);
      return {
        shouldReopen: true,
        triggerType: 'price_drop',
        reason: `Redução relevante de preço (-${pct}%, de R$ ${oldPrice.toLocaleString('pt-BR')} para R$ ${newPrice.toLocaleString('pt-BR')})`,
      };
    }
  }

  // Gatilho B: Salto substancial de compatibilidade (>= +15 pts e atingiu Match Forte >= 85%)
  const oldScore = Number(snap.matchScore ?? args.existingRow.match_score ?? 0);
  const scoreDiff = Math.round(args.newScore - oldScore);
  if (scoreDiff >= 15 && args.newScore >= 85 && args.newMaturity >= 70) {
    return {
      shouldReopen: true,
      triggerType: 'score_jump',
      reason: `Evolução expressiva de compatibilidade (+${scoreDiff} pts, de ${Math.round(oldScore)}% para ${Math.round(args.newScore)}%)`,
    };
  }

  // Gatilho C: Ampliação do orçamento do lead (>= +15%) tornando o imóvel viável
  const oldBudget = snap.leadPriceMax ?? null;
  const newBudget = args.profile.priceMax ?? null;
  if (
    oldBudget !== null &&
    oldBudget > 0 &&
    newBudget !== null &&
    newBudget > oldBudget &&
    newPrice > 0 &&
    oldPrice > oldBudget &&
    newPrice <= newBudget &&
    args.newScore >= 80
  ) {
    const budgetGrowth = (newBudget - oldBudget) / oldBudget;
    if (budgetGrowth >= 0.15) {
      return {
        shouldReopen: true,
        triggerType: 'budget_increase',
        reason: `Orçamento do cliente ampliado para R$ ${newBudget.toLocaleString('pt-BR')}, comportando o valor do imóvel`,
      };
    }
  }

  // Gatilho D: Imóvel ficou pronto para morar e o cliente busca imóvel pronto
  const oldDelivery = snap.propertyDeliveryStatus;
  const newDelivery = args.property.deliveryStatus;
  if (
    oldDelivery &&
    oldDelivery !== 'pronto' &&
    newDelivery === 'pronto' &&
    args.profile.deliveryStatus.includes('pronto') &&
    args.newScore >= 80
  ) {
    return {
      shouldReopen: true,
      triggerType: 'delivery_ready',
      reason: 'Imóvel concluído (passou para Pronto para morar, atendendo à preferência do lead)',
    };
  }

  return { shouldReopen: false, reason: null };
}
