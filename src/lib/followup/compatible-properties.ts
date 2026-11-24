import { evaluateMatch } from '@/lib/match/engine';
import { resolveValidatedPublicPropertyUrl } from '@/lib/match/smart-send';
import type { DeliveryStatus, LeadSearchProfile, PropertyProjection } from '@/lib/match/types';
import {
  propertyViolatesExplicitRestrictions,
  type CompatiblePropertySummary,
} from '@/lib/followup/engine';

export function resolveCompatiblePropertyPublicUrl(prop: {
  public_url?: unknown;
  cover_url?: unknown;
  code?: unknown;
  property_id?: unknown;
}): string | null {
  const explicitUrl =
    typeof prop.public_url === 'string' && prop.public_url.trim() ? prop.public_url.trim() : null;
  const coverUrl =
    typeof prop.cover_url === 'string' && prop.cover_url.trim() ? prop.cover_url.trim() : null;
  const coverInventoryId = coverUrl?.match(/\/properties\/([^/]+)/)?.[1]?.trim() || null;
  const codeOrId =
    typeof prop.code === 'string' && prop.code.trim()
      ? String(prop.property_id || '').trim() || null
      : null;

  const fallbackPageId = explicitUrl ? null : coverInventoryId || codeOrId;
  const resolved = resolveValidatedPublicPropertyUrl(explicitUrl, fallbackPageId);
  return resolved.url;
}

export function toPropertyProjection(
  prop: Record<string, unknown>,
  accountId: string
): PropertyProjection {
  const rawDelivery = String(prop.delivery_status || 'pronto').trim().toLowerCase();
  const deliveryStatus: DeliveryStatus =
    rawDelivery === 'planta' || rawDelivery === 'em_construcao'
      ? (rawDelivery as DeliveryStatus)
      : 'pronto';
  return {
    propertyId: String(prop.property_id || ''),
    accountId: String(prop.account_id || accountId),
    status: 'ativo',
    operation: String(prop.operation || 'venda').toLowerCase() === 'locacao' ? 'locacao' : 'venda',
    title: String(prop.title || 'Imóvel compatível'),
    code: prop.code ? String(prop.code) : null,
    propertyType: String(prop.property_type || 'apartamento'),
    neighborhood: String(prop.neighborhood || ''),
    city: String(prop.city || 'João Pessoa'),
    priceMin: Number(prop.price_min || 0),
    priceMax: Number(prop.price_max || prop.price_min || 0),
    bedroomsMin: prop.bedrooms_min != null ? Number(prop.bedrooms_min) : null,
    bedroomsMax: prop.bedrooms_max != null ? Number(prop.bedrooms_max) : null,
    areaMin: prop.area_min != null ? Number(prop.area_min) : null,
    areaMax: prop.area_max != null ? Number(prop.area_max) : null,
    deliveryStatus,
    deliveryDeadline: prop.delivery_deadline ? String(prop.delivery_deadline) : null,
    features: Array.isArray(prop.features)
      ? (prop.features as unknown[]).map((f) => String(f))
      : [],
    coverUrl: prop.cover_url ? String(prop.cover_url) : null,
    publicUrl: prop.public_url ? String(prop.public_url) : null,
  };
}

/**
 * Avalia e ordena todos os imóveis ATIVOS e EXCLUSIVAMENTE DE VENDA compatíveis com o lead,
 * combinando matches pré-calculados válidos e projeções do catálogo quando necessário,
 * garantindo reutilização integral por `GET /api/followup` e `GET /api/followup/[id]/properties`.
 */
export function buildCompatibleSalePropertiesForLead(args: {
  accountId: string;
  contactId: string;
  profile: LeadSearchProfile | null;
  rawMatches: Array<Record<string, unknown>>;
  projectionsMap: Map<string, Record<string, unknown>>;
  sharedPropertyIds: Set<string>;
  extraExcludedTypes?: string[];
  /** Quando true (ex.: expansão "Ver mais imóveis"), avalia todas as projeções ativas elegíveis */
  includeCatalogExpansion?: boolean;
}): CompatiblePropertySummary[] {
  const {
    accountId,
    contactId,
    profile,
    rawMatches,
    projectionsMap,
    sharedPropertyIds,
    extraExcludedTypes = [],
    includeCatalogExpansion = true,
  } = args;

  const allExcludedTypes = Array.from(
    new Set([...(profile?.excludedPropertyTypes ?? []), ...extraExcludedTypes])
  );
  const compatibleList: CompatiblePropertySummary[] = [];
  const seenPropIds = new Set<string>();
  const seenPublicUrls = new Set<string>();

  for (const m of rawMatches) {
    const propId = String(m.property_id || '');
    if (!propId || seenPropIds.has(propId)) continue;
    const prop = projectionsMap.get(propId);
    if (!prop) continue;

    const propStatus = String(prop.status || 'ativo').trim().toLowerCase();
    if (propStatus !== 'ativo') continue;

    const propOperation = String(prop.operation || '').trim().toLowerCase();
    if (propOperation !== 'venda') continue;

    const propTitle = String(prop.title || 'Imóvel compatível');
    const propType = prop.property_type ? String(prop.property_type) : null;

    if (
      propertyViolatesExplicitRestrictions(
        { propertyType: propType, title: propTitle },
        allExcludedTypes
      )
    ) {
      continue;
    }

    const resolvedPublicUrl = resolveCompatiblePropertyPublicUrl(prop);
    if (!resolvedPublicUrl || seenPublicUrls.has(resolvedPublicUrl)) continue;

    let effectiveMatchScore = Math.round(Number(m.match_score || 0));
    const effectivePriority = Number(m.commercial_priority || 0);
    let effectiveConfidence: number | null = profile?.profileConfidence ?? null;
    const breakdown =
      m.score_breakdown && typeof m.score_breakdown === 'object'
        ? (m.score_breakdown as Record<string, unknown>)
        : {};
    let effectiveReasons = Array.isArray(breakdown.reasons)
      ? (breakdown.reasons as unknown[]).map((r) => String(r)).filter(Boolean)
      : [];

    if (profile) {
      const liveEval = evaluateMatch(profile, toPropertyProjection(prop, accountId));
      if (!liveEval.eligible || liveEval.matchScore < 70) {
        continue;
      }
      effectiveMatchScore = liveEval.matchScore;
      effectiveConfidence = liveEval.evaluationConfidence ?? effectiveConfidence;
      if (
        effectiveReasons.length === 0 ||
        profile.prefersLargerPlans ||
        profile.budgetIsFlexibleFromAd ||
        profile.largerPlansSource === 'team_suggested'
      ) {
        effectiveReasons = liveEval.scoreBreakdown?.reasons ?? effectiveReasons;
      }
    }

    seenPropIds.add(propId);
    seenPublicUrls.add(resolvedPublicUrl);
    compatibleList.push({
      matchId: String(m.id || ''),
      propertyId: propId,
      title: propTitle,
      code: prop.code ? String(prop.code) : null,
      neighborhood: String(prop.neighborhood || ''),
      city: String(prop.city || 'João Pessoa'),
      operation: 'venda',
      propertyType: propType,
      priceMin: Number(prop.price_min || 0),
      priceMax: Number(prop.price_max || 0),
      bedroomsMin: prop.bedrooms_min != null ? Number(prop.bedrooms_min) : null,
      bedroomsMax: prop.bedrooms_max != null ? Number(prop.bedrooms_max) : null,
      areaMin: prop.area_min != null ? Number(prop.area_min) : null,
      areaMax: prop.area_max != null ? Number(prop.area_max) : null,
      deliveryStatus: prop.delivery_status ? String(prop.delivery_status) : null,
      coverUrl: prop.cover_url ? String(prop.cover_url) : null,
      publicUrl: resolvedPublicUrl,
      matchScore: effectiveMatchScore,
      evaluationConfidence: effectiveConfidence,
      commercialPriority: effectivePriority,
      matchStatus: String(m.match_status || 'novo'),
      reasons: effectiveReasons,
      alreadyShared: sharedPropertyIds.has(propId) || String(m.match_status || '') === 'enviado',
    });
  }

  // Avaliação do catálogo ativo em tempo real (permite encontrar todas as opções elegíveis, ex.: 15 para Sirleida)
  if (
    includeCatalogExpansion &&
    profile &&
    profile.operation === 'venda' &&
    !profile.isShortStayOnly &&
    !profile.isSellerOrOutOfArea
  ) {
    for (const [propId, prop] of projectionsMap.entries()) {
      if (seenPropIds.has(propId)) continue;
      const propStatus = String(prop.status || 'ativo').trim().toLowerCase();
      if (propStatus !== 'ativo') continue;
      const propOperation = String(prop.operation || '').trim().toLowerCase();
      if (propOperation !== 'venda') continue;

      const propTitle = String(prop.title || 'Imóvel compatível');
      const propType = prop.property_type ? String(prop.property_type) : null;
      if (
        propertyViolatesExplicitRestrictions(
          { propertyType: propType, title: propTitle },
          allExcludedTypes
        )
      ) {
        continue;
      }

      const resolvedPublicUrl = resolveCompatiblePropertyPublicUrl(prop);
      if (!resolvedPublicUrl || seenPublicUrls.has(resolvedPublicUrl)) continue;

      const liveEval = evaluateMatch(profile, toPropertyProjection(prop, accountId));
      if (!liveEval.eligible || liveEval.matchScore < 70) continue;

      seenPropIds.add(propId);
      seenPublicUrls.add(resolvedPublicUrl);
      compatibleList.push({
        matchId: `live-${contactId}-${propId}`,
        propertyId: propId,
        title: propTitle,
        code: prop.code ? String(prop.code) : null,
        neighborhood: String(prop.neighborhood || ''),
        city: String(prop.city || 'João Pessoa'),
        operation: 'venda',
        propertyType: propType,
        priceMin: Number(prop.price_min || 0),
        priceMax: Number(prop.price_max || 0),
        bedroomsMin: prop.bedrooms_min != null ? Number(prop.bedrooms_min) : null,
        bedroomsMax: prop.bedrooms_max != null ? Number(prop.bedrooms_max) : null,
        areaMin: prop.area_min != null ? Number(prop.area_min) : null,
        areaMax: prop.area_max != null ? Number(prop.area_max) : null,
        deliveryStatus: prop.delivery_status ? String(prop.delivery_status) : null,
        coverUrl: prop.cover_url ? String(prop.cover_url) : null,
        publicUrl: resolvedPublicUrl,
        matchScore: liveEval.matchScore,
        evaluationConfidence: liveEval.evaluationConfidence ?? profile.profileConfidence ?? null,
        commercialPriority: liveEval.matchScore,
        matchStatus: 'novo',
        reasons: liveEval.scoreBreakdown?.reasons ?? [],
        alreadyShared: sharedPropertyIds.has(propId),
      });
    }
  }

  // Prioriza opções ainda não apresentadas quando houver empate próximo de compatibilidade
  compatibleList.sort((a, b) => {
    if (Boolean(a.alreadyShared) !== Boolean(b.alreadyShared)) {
      return a.alreadyShared ? 1 : -1;
    }
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    if (b.commercialPriority !== a.commercialPriority) {
      return b.commercialPriority - a.commercialPriority;
    }
    return a.title.localeCompare(b.title);
  });

  return compatibleList;
}
