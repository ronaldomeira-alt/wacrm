import type {
  LeadSearchProfile,
  PropertyProjection,
  MatchEvaluationResult,
  MatchScoreBreakdown,
} from './types';

export const MIN_MATCH_SCORE_THRESHOLD = 90;

export const SEASIDE_NEIGHBORHOODS = [
  'bessa',
  'jardim oceania',
  'manaira',
  'tambau',
  'cabo branco',
  'altiplano',
  'camboinha',
  'intermares',
  'ponta de campina',
  'formosa',
  'seixas',
];

function normalizeString(val: string): string {
  return val
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Motor determinístico de Match entre Lead e Imóvel.
 * Baseado puramente em regras de negócio e dados estruturados.
 */
export function evaluateMatch(
  profile: LeadSearchProfile,
  property: PropertyProjection
): MatchEvaluationResult {
  const breakdown: MatchScoreBreakdown = {
    price: 0,
    location: 0,
    propertyType: 0,
    bedrooms: 0,
    purpose: 0,
    delivery: 0,
    area: 0,
    penalties: [],
    reasons: [],
  };

  // ------------------------------------------------------------
  // 1. CRITÉRIOS ELIMINATÓRIOS INEQUÍVOCOS
  // ------------------------------------------------------------

  // 1.1 Modalidade comercial (estoque do Match é exclusivo de VENDA)
  if (profile.isShortStayOnly) {
    return eliminated('Cliente busca exclusivamente hospedagem/temporada — incompatível com estoque comum', breakdown);
  }
  if (profile.isSellerOrOutOfArea) {
    return eliminated('Contato não é comprador ativo na praça atendida (captação ou fora do estado)', breakdown);
  }

  const profOp = normalizeString(profile.operation || '');
  const propOp = normalizeString(property.operation || '');
  const isProfRent = profOp === 'aluguel' || profOp === 'locacao';
  const isPropRent = propOp === 'aluguel' || propOp === 'locacao';
  const isProfSale = profOp === 'compra' || profOp === 'venda';
  const isPropSale = propOp === 'compra' || propOp === 'venda';

  if (isPropRent || !isPropSale) {
    return eliminated('Catálogo do Match é exclusivo para imóveis à venda — imóvel de locação inelegível', breakdown);
  }
  if (isProfRent) {
    return eliminated('Cliente procura locação/aluguel e imóvel é somente para venda', breakdown);
  }
  if (!isProfSale) {
    return eliminated('Intenção comercial de compra ainda não confirmada para o cliente', breakdown);
  }

  // 1.2 Restrições explícitas de tipologia e incompatibilidade estrutural de formato
  const propTypeNorm = normalizeString(property.propertyType || '');
  const propTitleNormEarly = normalizeString(property.title || '');
  const isLand = ['terreno', 'lote', 'loteamento', 'area'].some(
    (t) => propTypeNorm.includes(t) || t.includes(propTypeNorm)
  );
  const isCommercial = ['comercial', 'sala', 'sala comercial', 'loja', 'predio comercial', 'galpao', 'escritorio'].some(
    (t) => propTypeNorm.includes(t) || t.includes(propTypeNorm)
  );
  const isResidential = !isLand && !isCommercial;

  if (profile.excludedPropertyTypes && profile.excludedPropertyTypes.length > 0) {
    for (const excluded of profile.excludedPropertyTypes) {
      const exNorm = normalizeString(excluded);
      const matchesExcluded =
        propTypeNorm.includes(exNorm) ||
        (exNorm === 'studio' &&
          (propTypeNorm.includes('studio') ||
            propTypeNorm.includes('estudio') ||
            /\b(studios?|estudios?)\b/.test(propTitleNormEarly))) ||
        (exNorm === 'flat' &&
          (propTypeNorm.includes('flat') || /\bflats?\b/.test(propTitleNormEarly)));
      if (matchesExcluded) {
        return eliminated(
          `Cliente rejeitou explicitamente a tipologia ${excluded} e o imóvel é ${property.propertyType} (${property.title})`,
          breakdown
        );
      }
    }
  }

  if (profile.propertyTypes.length > 0) {
    const acceptedTypes = profile.propertyTypes.map(normalizeString);
    const leadWantsResidential = acceptedTypes.some((t) =>
      ['apartamento', 'casa', 'cobertura', 'duplex', 'triplex', 'flat', 'studio', 'loft', 'condominio', 'village', 'sobrado'].some((res) => t.includes(res) || res.includes(t))
    );
    const leadWantsLand = acceptedTypes.some((t) =>
      ['terreno', 'lote', 'loteamento', 'area'].some((lnd) => t.includes(lnd) || lnd.includes(t))
    );
    const leadWantsCommercial = acceptedTypes.some((t) =>
      ['comercial', 'sala', 'sala comercial', 'loja', 'predio', 'galpao', 'escritorio', 'consultorio'].some((com) => t.includes(com) || com.includes(t))
    );

    // Rejeição cruzada definitiva
    if (leadWantsResidential && !leadWantsLand && isLand) {
      return eliminated(
        `Cliente procura imóvel residencial e o imóvel é terreno/lote (${property.propertyType})`,
        breakdown
      );
    }
    if (leadWantsResidential && !leadWantsCommercial && isCommercial) {
      return eliminated(
        `Cliente procura imóvel residencial e o imóvel é comercial (${property.propertyType})`,
        breakdown
      );
    }
    if (leadWantsLand && !leadWantsResidential && isResidential) {
      return eliminated(
        `Cliente procura terreno/lote e o imóvel é residencial (${property.propertyType})`,
        breakdown
      );
    }
    if (leadWantsCommercial && !leadWantsResidential && isResidential) {
      return eliminated(
        `Cliente procura imóvel comercial e o imóvel é residencial (${property.propertyType})`,
        breakdown
      );
    }

    if (profile.propertyTypeStrict) {
      if (!acceptedTypes.some((t) => propTypeNorm.includes(t) || t.includes(propTypeNorm))) {
        return eliminated(
          `Cliente exige restritamente ${profile.propertyTypes.join(', ')} e imóvel é ${property.propertyType}`,
          breakdown
        );
      }
    }
  }

  // 1.3 Localização e Cidade: descarte de cidades fora da praça de interesse
  const propCityNorm = normalizeString(property.city || 'joao pessoa');
  const propNeighborhoodNorm = normalizeString(property.neighborhood || '');
  if (profile.locations.length > 0) {
    const acceptedLocs = profile.locations.map(normalizeString);
    const PRIMARY_METRO_AREAS = [
      'joao pessoa',
      'cabedelo',
      'bessa',
      'intermares',
      'manaira',
      'tambau',
      'cabo branco',
      'altiplano',
      'bancarios',
      'aeroclube',
      'miramar',
      'jardim oceania',
      'camboinha',
      'ponta de campina',
    ];
    const leadWantsPrimaryMetro = acceptedLocs.some((l) =>
      PRIMARY_METRO_AREAS.some((area) => l.includes(area) || area.includes(l))
    );
    const isPropInPrimaryMetro =
      propCityNorm.includes('joao pessoa') ||
      propCityNorm.includes('cabedelo') ||
      PRIMARY_METRO_AREAS.some((area) => propNeighborhoodNorm.includes(area) || area.includes(propNeighborhoodNorm));

    // Se o cliente busca na Grande João Pessoa e o imóvel fica em outra comarca distante (ex: Bananeiras, Campina Grande)
    if (leadWantsPrimaryMetro && !isPropInPrimaryMetro) {
      const leadSpecifiedOtherCity = acceptedLocs.some((l) => propCityNorm.includes(l) || l.includes(propCityNorm));
      if (!leadSpecifiedOtherCity) {
        return eliminated(
          `Imóvel fica em ${property.city} (${property.neighborhood}), fora da praça metropolitana de interesse do lead`,
          breakdown
        );
      }
    }

    if (profile.locationStrict) {
      if (!acceptedLocs.some((l) => propNeighborhoodNorm.includes(l) || l.includes(propNeighborhoodNorm))) {
        return eliminated(
          `Cliente exige restritamente localização em ${profile.locations.join(', ')} e imóvel fica no ${property.neighborhood}`,
          breakdown
        );
      }
    }
  }

  // 1.4 Pronto vs Planta Obrigatório ("Só quero pronto")
  const propDelivery = property.deliveryStatus;
  if (profile.deliveryStrict && profile.deliveryStatus.length > 0) {
    if (!profile.deliveryStatus.includes(propDelivery)) {
      return eliminated(
        `Cliente exige entrega ${profile.deliveryStatus.join(', ')} e imóvel está ${property.deliveryStatus}`,
        breakdown
      );
    }
  }

  // 1.5 Prazo de Entrega Impossível
  if (profile.maxDeliveryYear && property.deliveryDeadline) {
    const deadlineYear = new Date(property.deliveryDeadline).getFullYear();
    if (!isNaN(deadlineYear) && deadlineYear > profile.maxDeliveryYear) {
      return eliminated(
        `Previsão de entrega (${deadlineYear}) excede o prazo limite do cliente (${profile.maxDeliveryYear})`,
        breakdown
      );
    }
  }

  // 1.6 Quartos: incompatibilidade eliminatória e descarte de discrepâncias graves
  const propMinAreaVal =
    property.areaMin != null && Number(property.areaMin) > 0 ? Number(property.areaMin) : null;
  const propMaxAreaVal =
    property.areaMax != null && Number(property.areaMax) > 0
      ? Number(property.areaMax)
      : propMinAreaVal;

  const hasPropBedroomInfo = property.bedroomsMin != null || property.bedroomsMax != null;
  if (isResidential && profile.bedrooms.length > 0 && hasPropBedroomInfo) {
    const minRequiredBedrooms = Math.min(...profile.bedrooms);
    const propMinBedrooms = property.bedroomsMin ?? property.bedroomsMax ?? 0;
    const propMaxBedrooms = property.bedroomsMax ?? property.bedroomsMin ?? 0;

    if (profile.bedroomsStrict && propMaxBedrooms < minRequiredBedrooms) {
      return eliminated(
        `Cliente exige no mínimo ${minRequiredBedrooms} quarto(s) e imóvel possui no máximo ${propMaxBedrooms}`,
        breakdown
      );
    }

    // Se o cliente busca 3+ quartos, imóveis de 1 quarto ou sem quarto são descartados sumariamente
    if (minRequiredBedrooms >= 3 && propMaxBedrooms <= 1) {
      return eliminated(
        `Cliente busca imóvel espaçoso (${minRequiredBedrooms} quartos) e imóvel é compacto com apenas ${propMaxBedrooms} quarto(s)`,
        breakdown
      );
    }

    // Se o cliente busca 2+ quartos, estúdios/flats de 0 ou 1 quarto são descartados
    if (minRequiredBedrooms >= 2 && propMaxBedrooms < 2) {
      return eliminated(
        `Cliente busca ${minRequiredBedrooms} quartos e imóvel possui no máximo ${propMaxBedrooms} quarto(s)`,
        breakdown
      );
    }

    // Se o cliente busca 2+ quartos, mas o imóvel tem planta inicial de 0/1 quarto (< 38 m²) com preço único da unidade menor:
    // não usar preço de studio de 19–22 m² para representar apartamento de 2 quartos (Seção 6)
    if (
      minRequiredBedrooms >= 2 &&
      propMinBedrooms <= 1 &&
      propMinAreaVal !== null &&
      propMinAreaVal < 38 &&
      property.priceMin > 0 &&
      property.priceMin === property.priceMax
    ) {
      return eliminated(
        `Imóvel misto cujo preço cadastrado (R$ ${property.priceMin.toLocaleString('pt-BR')}) refere-se à unidade compacta de ${propMinAreaVal} m², sem valor confirmado para a planta de ${minRequiredBedrooms} quartos`,
        breakdown
      );
    }
  }

  // 1.6b Metragem, necessidade de espaço e compatibilidade por planta/unidade (Seções 4 e 6)
  const targetAreaMin =
    profile.areaMin != null && profile.areaMin > 0
      ? profile.areaMin
      : profile.prefersLargerPlans
        ? 48
        : null;

  if (isResidential && targetAreaMin !== null) {
    // Se o imóvel não informa nenhuma metragem quando o cliente exige planta maior, não é possível confirmar a planta
    if (propMaxAreaVal === null || propMaxAreaVal <= 0) {
      return eliminated(
        `Cliente busca planta maior (a partir de ~${targetAreaMin} m²) e o cadastro do imóvel não possui metragem confirmada`,
        breakdown
      );
    }

    const minAcceptableArea = profile.areaStrict ? targetAreaMin : targetAreaMin * 0.92;
    if (propMaxAreaVal < minAcceptableArea) {
      return eliminated(
        `Cliente busca plantas maiores (~${targetAreaMin} m²+) e o imóvel oferece no máximo ${propMaxAreaVal} m²`,
        breakdown
      );
    }

    // Regra de ouro de planta vs. preço (Seção 6):
    // Quando o cliente busca plantas maiores, não recomendar empreendimentos cuja menor unidade (areaMin)
    // esteja abaixo da metragem buscada (< targetAreaMin * 0.95) quando houver apenas um preço único cadastrado
    // (pois esse preço único refere-se à unidade menor, e não à planta maior!).
    if (
      propMinAreaVal !== null &&
      propMinAreaVal < targetAreaMin * 0.95 &&
      property.priceMin > 0 &&
      property.priceMin === property.priceMax
    ) {
      return eliminated(
        `O preço cadastrado (R$ ${property.priceMin.toLocaleString('pt-BR')}) corresponde à unidade menor de ${propMinAreaVal} m², sem valor confirmado para a planta de ${targetAreaMin} m²+`,
        breakdown
      );
    }

    // Se o cliente busca plantas maiores (>= 45 m²), descartar tipologias estritamente de flat/studio compacto
    if (
      targetAreaMin >= 45 &&
      (propTypeNorm === 'flat' || propTypeNorm === 'studio' || /\b(studios?|flats?)\b/.test(propTitleNormEarly)) &&
      (propMinAreaVal === null || propMinAreaVal < 42)
    ) {
      return eliminated(
        `Cliente busca plantas maiores (~${targetAreaMin} m²+) e o imóvel é um ${property.propertyType} compacto`,
        breakdown
      );
    }
  }

  // 1.7 Características Obrigatórias (Elevador, Acessibilidade, etc.)
  if (profile.requiredFeatures && profile.requiredFeatures.length > 0) {
    const propFeaturesNorm = property.features.map(normalizeString);
    for (const reqFeat of profile.requiredFeatures) {
      const reqNorm = normalizeString(reqFeat);
      const hasFeat = propFeaturesNorm.some((pf) => pf.includes(reqNorm) || reqNorm.includes(pf));
      if (!hasFeat) {
        return eliminated(
          `Imóvel não possui a característica obrigatória: ${reqFeat}`,
          breakdown
        );
      }
    }
  }

  // 1.8 Preço e Orçamento (distinguindo limite inegociável de orçamento flexível de anúncio — Seção 5)
  const entryPrice = property.priceMin > 0 ? property.priceMin : property.priceMax;
  if (profile.priceMax !== null && profile.priceMax > 0 && entryPrice > 0) {
    const clientBudget = profile.priceMax;
    // Se o cliente definiu teto absoluto inegociável
    if (profile.priceStrictMax) {
      if (entryPrice > clientBudget) {
        return eliminated(
          `Preço de entrada (R$ ${entryPrice.toLocaleString('pt-BR')}) excede o limite financeiro inegociável de R$ ${clientBudget.toLocaleString('pt-BR')}`,
          breakdown
        );
      }
    } else {
      // Se o orçamento inicial veio de anúncio barato mas o cliente busca planta maior (budgetIsFlexibleFromAd),
      // utiliza priceFlexMax antes de eliminar; caso contrário usa tolerância padrão de +10%.
      const effectiveCeiling =
        profile.budgetIsFlexibleFromAd && profile.priceFlexMax && profile.priceFlexMax > clientBudget
          ? profile.priceFlexMax
          : clientBudget * 1.1;
      if (entryPrice > effectiveCeiling) {
        return eliminated(
          `Preço de entrada (R$ ${entryPrice.toLocaleString('pt-BR')}) excede a faixa máxima de R$ ${effectiveCeiling.toLocaleString('pt-BR')}`,
          breakdown
        );
      }
    }
  }

  // ------------------------------------------------------------
  // 2. PESOS E NORMALIZAÇÃO ADAPTATIVA
  // ------------------------------------------------------------
  // Pesos Base:
  // Preço: 25, Localização: 20, Tipologia: 15, Quartos: 15, Finalidade: 10, Prazo: 10, Metragem: 5 (Soma = 100)
  const isApplicableBedrooms = isResidential;
  const isApplicableArea = isResidential;

  let totalAvailableWeights = 100;
  if (!isApplicableBedrooms) totalAvailableWeights -= 15;
  if (!isApplicableArea) totalAvailableWeights -= 5;

  const scale = 100 / totalAvailableWeights;
  const weightPrice = 25 * scale;
  const weightLocation = 20 * scale;
  const weightType = 15 * scale;
  const weightBedrooms = isApplicableBedrooms ? 15 * scale : 0;
  const weightPurpose = 10 * scale;
  const weightDelivery = 10 * scale;
  const weightArea = isApplicableArea ? 5 * scale : 0;

  // ------------------------------------------------------------
  // 3. PONTUAÇÃO POR CRITÉRIO
  // ------------------------------------------------------------

  // 3.1 Preço (Base 25%)
  if (profile.priceMax === null || profile.priceMax <= 0 || entryPrice <= 0) {
    // Sem restrição de preço declarada pelo cliente: pontuação neutra proporcional
    breakdown.price = Math.round(weightPrice * 0.8 * 10) / 10;
    breakdown.reasons.push('Preço compatível (sem restrição financeira estrita informada)');
  } else {
    const clientBudget = profile.priceMax;
    if (entryPrice <= clientBudget) {
      breakdown.price = Math.round(weightPrice * 10) / 10;
      breakdown.reasons.push(
        `Preço dentro do orçamento do cliente (R$ ${entryPrice.toLocaleString('pt-BR')} <= R$ ${clientBudget.toLocaleString('pt-BR')})`
      );
    } else if (profile.budgetIsFlexibleFromAd && profile.priceFlexMax && entryPrice <= profile.priceFlexMax) {
      // Cliente veio de anúncio mais barato, mas busca planta maior: mantém boa pontuação estrutural indicando a diferença
      breakdown.price = Math.round(weightPrice * 0.82 * 10) / 10;
      const diff = entryPrice - clientBudget;
      breakdown.reasons.push(
        `Planta maior compatível (valor R$ ${diff.toLocaleString('pt-BR')} acima da referência inicial do anúncio)`
      );
    } else {
      // Entre clientBudget e clientBudget * 1.1: perde pontos progressivamente
      const overRatio = (entryPrice - clientBudget) / (clientBudget * 0.1); // 0 a 1
      const fraction = Math.max(0, 1 - overRatio);
      breakdown.price = Math.round(weightPrice * fraction * 10) / 10;
      breakdown.penalties.push(`Preço ligeiramente acima do orçamento (+${Math.round(overRatio * 10)}% da margem)`);
    }
  }

  // 3.2 Localização (Base 20%)
  const propTitleNorm = normalizeString(property.title || '');

  let locationNeverMentioned = false;
  if (profile.locations.length === 0) {
    // Cliente não citou bairros
    breakdown.location = Math.round(weightLocation * 0.7 * 10) / 10;
    breakdown.reasons.push(`Localização em ${property.neighborhood}, ${property.city}`);
  } else {
    const acceptedLocs = profile.locations.map(normalizeString);
    const exactNeighborhoodMatch = acceptedLocs.find(
      (l) =>
        l !== 'joao pessoa' &&
        (propNeighborhoodNorm.includes(l) ||
          l.includes(propNeighborhoodNorm) ||
          propTitleNorm.includes(l))
    );

    const cityOrRegionMatch = acceptedLocs.find((l) => {
      if (l.includes('joao pessoa') && propCityNorm.includes('joao pessoa')) return true;
      if (l.includes('cabedelo') && (propCityNorm.includes('cabedelo') || propNeighborhoodNorm.includes('camboinha') || propNeighborhoodNorm.includes('intermares'))) return true;
      if (
        (l.includes('praia') || l.includes('orla') || l.includes('mar')) &&
        SEASIDE_NEIGHBORHOODS.some((sn) => propNeighborhoodNorm.includes(sn))
      ) {
        return true;
      }
      return false;
    });

    if (exactNeighborhoodMatch) {
      breakdown.location = Math.round(weightLocation * 10) / 10;
      breakdown.reasons.push(`Bairro desejado pelo cliente: ${property.neighborhood}`);
    } else if (cityOrRegionMatch) {
      breakdown.location = Math.round(weightLocation * 0.85 * 10) / 10;
      breakdown.reasons.push(`Região/Cidade compatível: ${property.neighborhood}, ${property.city}`);
    } else {
      locationNeverMentioned = true;
      breakdown.location = Math.round(weightLocation * 0.3 * 10) / 10;
      breakdown.penalties.push(`Bairro (${property.neighborhood}) não foi mencionado pelo cliente`);
    }
  }

  // 3.3 Tipologia (Base 15%)
  let hasStructuralMismatch = false;
  if (profile.propertyTypes.length === 0) {
    breakdown.propertyType = Math.round(weightType * 0.8 * 10) / 10;
  } else {
    const acceptedTypes = profile.propertyTypes.map(normalizeString);
    const isCompactProperty =
      (property.bedroomsMin != null && property.bedroomsMin <= 1 && (propMaxAreaVal === null || propMaxAreaVal <= 40)) ||
      propTitleNorm.includes('flat') ||
      propTitleNorm.includes('studio') ||
      propTitleNorm.includes('loft') ||
      propTitleNorm.includes('compacto');

    const matchedType = acceptedTypes.find((t) => {
      // Se o cliente busca 'apartamento' com 2+ quartos ou plantas maiores (>= 45m²),
      // um studio/flat compacto NÃO bate como 'apartamento'
      if (
        t === 'apartamento' &&
        (targetAreaMin !== null && targetAreaMin >= 45 || profile.bedrooms.some((b) => b >= 2)) &&
        isCompactProperty
      ) {
        return false;
      }
      if (propTypeNorm.includes(t) || t.includes(propTypeNorm) || propTitleNorm.includes(t)) {
        return true;
      }
      // Equivalência de mercado: Flats/Studios cadastrados como 'apartamento' compacto (apenas quando o cliente não busca planta maior)
      if (
        ['flat', 'studio', 'loft', 'kitnet'].includes(t) &&
        propTypeNorm.includes('apartamento') &&
        isCompactProperty &&
        !profile.prefersLargerPlans
      ) {
        return true;
      }
      return false;
    });

    if (matchedType) {
      breakdown.propertyType = Math.round(weightType * 10) / 10;
      breakdown.reasons.push(`Tipologia compatível: ${property.propertyType}`);
    } else {
      hasStructuralMismatch = true;
      breakdown.propertyType = Math.round(weightType * 0.3 * 10) / 10;
      breakdown.penalties.push(`Tipologia ${property.propertyType} diverge da preferência do cliente`);
    }
  }

  // 3.4 Quartos / Configuração (Base 15%)
  if (isApplicableBedrooms) {
    if (profile.bedrooms.length === 0) {
      // Se o cliente busca plantas maiores (>= 45 m²), imóveis com 0 quartos (studios) perdem pontos e sofrem trava estrutural
      if (targetAreaMin !== null && targetAreaMin >= 45 && property.bedroomsMax === 0) {
        hasStructuralMismatch = true;
        breakdown.bedrooms = 0;
        breakdown.penalties.push('Unidade sem quarto privativo (0 quartos) incompatível com busca por planta maior');
      } else if (targetAreaMin !== null && targetAreaMin >= 45 && (property.bedroomsMin ?? 0) >= 2) {
        breakdown.bedrooms = Math.round(weightBedrooms * 10) / 10;
        breakdown.reasons.push(`Configuração de ${property.bedroomsMin} quartos adequada para planta maior`);
      } else {
        breakdown.bedrooms = Math.round(weightBedrooms * 0.8 * 10) / 10;
      }
    } else if (!hasPropBedroomInfo) {
      breakdown.bedrooms = Math.round(weightBedrooms * 0.8 * 10) / 10;
    } else {
      const propMinBed = property.bedroomsMin ?? property.bedroomsMax ?? 1;
      const propMaxBed = property.bedroomsMax ?? propMinBed;
      const hasIntersection = profile.bedrooms.some((b) => b >= propMinBed && b <= propMaxBed);

      if (hasIntersection) {
        breakdown.bedrooms = Math.round(weightBedrooms * 10) / 10;
        breakdown.reasons.push(`Configuração de quartos compatível (${propMinBed === propMaxBed ? propMinBed : `${propMinBed} a ${propMaxBed}`} quartos)`);
      } else {
        hasStructuralMismatch = true;
        const closestDiff = Math.min(...profile.bedrooms.map((b) => Math.min(Math.abs(b - propMinBed), Math.abs(b - propMaxBed))));
        const factor = closestDiff === 1 ? 0.4 : 0.1;
        breakdown.bedrooms = Math.round(weightBedrooms * factor * 10) / 10;
        breakdown.penalties.push(`Quantidade de quartos diferente da necessidade do cliente`);
      }
    }
  }

  // 3.5 Finalidade (Base 10%)
  if (profile.purpose.length === 0) {
    breakdown.purpose = Math.round(weightPurpose * 0.8 * 10) / 10;
  } else {
    breakdown.purpose = Math.round(weightPurpose * 10) / 10;
    breakdown.reasons.push(`Finalidade adequada (${profile.purpose.join(', ')})`);
  }

  // 3.6 Pronto / Planta / Prazo (Base 10%)
  if (profile.deliveryStatus.length === 0) {
    breakdown.delivery = Math.round(weightDelivery * 0.8 * 10) / 10;
  } else {
    if (profile.deliveryStatus.includes(property.deliveryStatus)) {
      breakdown.delivery = Math.round(weightDelivery * 10) / 10;
      breakdown.reasons.push(`Momento da obra compatível: ${property.deliveryStatus}`);
    } else {
      breakdown.delivery = Math.round(weightDelivery * 0.4 * 10) / 10;
      breakdown.penalties.push(`Estágio da obra (${property.deliveryStatus}) difere da preferência`);
    }
  }

  // 3.7 Metragem e Espaço (Base 5%)
  if (isApplicableArea) {
    if (targetAreaMin !== null && propMinAreaVal !== null) {
      if (propMinAreaVal >= targetAreaMin) {
        breakdown.area = Math.round(weightArea * 10) / 10;
        breakdown.reasons.push(`Metragem compatível (${Math.round(propMinAreaVal)} m²)`);
      } else if (propMaxAreaVal !== null && propMaxAreaVal >= targetAreaMin) {
        breakdown.area = Math.round(weightArea * 0.8 * 10) / 10;
        breakdown.reasons.push(`Possui plantas de até ${Math.round(propMaxAreaVal)} m²`);
      } else {
        hasStructuralMismatch = true;
        breakdown.area = 0;
        breakdown.penalties.push(`Metragem abaixo da necessidade de espaço (~${targetAreaMin} m²)`);
      }
    } else {
      breakdown.area = Math.round(weightArea * 10) / 10;
    }
  }

  // Soma bruta de compatibilidade
  let rawScore =
    breakdown.price +
    breakdown.location +
    breakdown.propertyType +
    breakdown.bedrooms +
    breakdown.purpose +
    breakdown.delivery +
    breakdown.area;

  rawScore = Math.min(100, Math.max(0, Math.round(rawScore)));

  // TRAVA ANTI-COMPENSAÇÃO ESTRUTURAL (Seção 4):
  // Pontuação elevada em preço ou localização nunca pode compensar incompatibilidade estrutural
  // de tipologia, quartos ou metragem.
  if (hasStructuralMismatch && rawScore > 59) {
    rawScore = 59;
    breakdown.penalties.push(
      'Pontuação limitada a 59% por incompatibilidade estrutural (tipologia, quartos ou metragem)'
    );
  }

  // REGRA DE LOCALIZAÇÃO (FASE 7):
  // Se o imóvel estiver em bairro que o cliente nunca mencionou,
  // o Match TOTAL fica limitado a no máximo 69% (não pode virar Bom Match ou Match Forte).
  if (locationNeverMentioned && rawScore > 69) {
    rawScore = 69;
    breakdown.penalties.push('Pontuação limitada a 69% por estar em localização não mencionada pelo lead');
  }

  const isStrong = rawScore >= 90;
  const isGood = rawScore >= 80 && rawScore < 90;
  const meetsCommercialThreshold = rawScore >= MIN_MATCH_SCORE_THRESHOLD;

  if (!meetsCommercialThreshold) {
    breakdown.penalties.push(
      `Compatibilidade (${rawScore}%) abaixo da nota de corte comercial mínima (${MIN_MATCH_SCORE_THRESHOLD}%)`
    );
  }

  return {
    eligible: true,
    matchScore: rawScore,
    scoreBreakdown: breakdown,
    commercialPriority: 0, // Será calculado em priority.ts
    isStrongMatch: isStrong,
    isGoodMatch: isGood,
    isManualOnly: !isStrong,
  };
}

function eliminated(reason: string, breakdown: MatchScoreBreakdown, score = 0): MatchEvaluationResult {
  breakdown.penalties.push(reason);
  return {
    eligible: false,
    eliminatedReason: reason,
    matchScore: score,
    scoreBreakdown: breakdown,
    commercialPriority: 0,
    isStrongMatch: false,
    isGoodMatch: false,
    isManualOnly: true,
  };
}
