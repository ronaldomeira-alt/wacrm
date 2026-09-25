import type { LeadSearchProfile, InfoProvenance } from './types';

export const MATURITY_AUTOMATIC_THRESHOLD = 70;

interface DimensionWeight {
  key: string;
  baseWeight: number;
  isApplicable: (profile: LeadSearchProfile) => boolean;
  score: (profile: LeadSearchProfile) => { hasValue: boolean; specificity: number; provenance: InfoProvenance };
}

/**
 * Definição das 8 dimensões de maturidade do perfil do lead com seus pesos base:
 * 1. Operação (compra/aluguel): 10
 * 2. Tipologia: 15
 * 3. Faixa de preço: 20
 * 4. Localização: 15
 * 5. Finalidade (moradia/investimento): 10
 * 6. Configuração / quartos: 15
 * 7. Pronto / planta / prazo: 10
 * 8. Características adicionais: 5
 * TOTAL = 100
 */
const MATURITY_DIMENSIONS: DimensionWeight[] = [
  // 1. Operação (compra/aluguel) — Peso 10
  {
    key: 'operation',
    baseWeight: 10,
    isApplicable: () => true,
    score: (profile) => {
      const hasValue = !!profile.operation;
      return {
        hasValue,
        specificity: 1.0,
        provenance: profile.provenance.operation || 'conversation',
      };
    },
  },
  // 2. Tipologia — Peso 15
  {
    key: 'propertyTypes',
    baseWeight: 15,
    isApplicable: () => true,
    score: (profile) => {
      const count = profile.propertyTypes?.length || 0;
      return {
        hasValue: count > 0,
        specificity: count === 1 ? 1.0 : count <= 2 ? 0.9 : 0.7,
        provenance: profile.provenance.propertyTypes || 'conversation',
      };
    },
  },
  // 3. Faixa de preço — Peso 20
  {
    key: 'price',
    baseWeight: 20,
    isApplicable: () => true,
    score: (profile) => {
      const hasPrice = profile.priceMax !== null || profile.priceMin !== null;
      let specificity = 0.5;
      if (profile.priceMax !== null && profile.priceMax > 0) {
        specificity = profile.priceMin !== null ? 1.0 : 0.95;
      }
      return {
        hasValue: hasPrice,
        specificity,
        provenance: profile.provenance.price || 'conversation',
      };
    },
  },
  // 4. Localização — Peso 15
  {
    key: 'locations',
    baseWeight: 15,
    isApplicable: () => true,
    score: (profile) => {
      const count = profile.locations?.length || 0;
      let specificity = 1.0;
      if (profile.locationSpecificity === 'city') specificity = 0.4;
      else if (profile.locationSpecificity === 'region') specificity = 0.7;
      else if (profile.locationSpecificity === 'neighborhood') specificity = 1.0;

      return {
        hasValue: count > 0,
        specificity,
        provenance: profile.provenance.locations || 'conversation',
      };
    },
  },
  // 5. Finalidade (moradia/investimento) — Peso 10
  {
    key: 'purpose',
    baseWeight: 10,
    isApplicable: () => true,
    score: (profile) => {
      const count = profile.purpose?.length || 0;
      return {
        hasValue: count > 0,
        specificity: 1.0,
        provenance: profile.provenance.purpose || 'conversation',
      };
    },
  },
  // 6. Configuração / Quartos — Peso 15 (Adaptativo: não se aplica a 'terreno' ou 'comercial')
  {
    key: 'bedrooms',
    baseWeight: 15,
    isApplicable: (profile) => {
      const onlyNonResidential =
        profile.propertyTypes.length > 0 &&
        profile.propertyTypes.every((t) => ['terreno', 'lote', 'comercial', 'sala'].includes(t.toLowerCase()));
      return !onlyNonResidential;
    },
    score: (profile) => {
      const count = profile.bedrooms?.length || 0;
      return {
        hasValue: count > 0,
        specificity: count === 1 ? 1.0 : 0.85,
        provenance: profile.provenance.bedrooms || 'conversation',
      };
    },
  },
  // 7. Pronto / Planta / Prazo — Peso 10
  {
    key: 'delivery',
    baseWeight: 10,
    isApplicable: () => true,
    score: (profile) => {
      const hasValue = (profile.deliveryStatus?.length || 0) > 0 || profile.maxDeliveryYear != null;
      return {
        hasValue,
        specificity: 1.0,
        provenance: profile.provenance.delivery || 'conversation',
      };
    },
  },
  // 8. Características adicionais relevantes — Peso 5
  {
    key: 'features',
    baseWeight: 5,
    isApplicable: () => true,
    score: (profile) => {
      const count = (profile.requiredFeatures?.length || 0) + (profile.preferredFeatures?.length || 0);
      return {
        hasValue: count > 0,
        specificity: Math.min(1.0, count * 0.5),
        provenance: profile.provenance.features || 'conversation',
      };
    },
  },
];

/**
 * Multiplicador de confiança por proveniência:
 * - CTWA = 35% do peso daquela informação (0.35)
 * - Conversa / Manual = 100% do peso (1.0)
 */
export function getProvenanceMultiplier(provenance: InfoProvenance): number {
  return provenance === 'ctwa' ? 0.35 : 1.0;
}

export interface MaturityEvaluation {
  maturity: number;          // 0–100%
  meetsThreshold: boolean;   // true se >= 70%
  applicableWeightsSum: number;
  earnedPointsSum: number;
  dimensions: Record<string, {
    baseWeight: number;
    normalizedWeight: number;
    earnedPoints: number;
    provenance: InfoProvenance;
    hasValue: boolean;
  }>;
}

/**
 * Calcula a maturidade adaptativa do perfil do lead (0–100%).
 * Normaliza os pesos restantes caso dimensões não se apliquem à tipologia.
 */
export function calculateProfileMaturity(profile: LeadSearchProfile): MaturityEvaluation {
  const applicableDimensions = MATURITY_DIMENSIONS.filter((dim) => dim.isApplicable(profile));
  const totalApplicableBaseWeight = applicableDimensions.reduce((sum, dim) => sum + dim.baseWeight, 0);

  if (totalApplicableBaseWeight === 0) {
    return {
      maturity: 0,
      meetsThreshold: false,
      applicableWeightsSum: 0,
      earnedPointsSum: 0,
      dimensions: {},
    };
  }

  // Fator de escala para normalizar a soma dos pesos aplicáveis para 100%
  const scale = 100 / totalApplicableBaseWeight;
  let earnedPointsSum = 0;
  const dimensionResults: MaturityEvaluation['dimensions'] = {};

  for (const dim of applicableDimensions) {
    const normalizedWeight = dim.baseWeight * scale;
    const { hasValue, specificity, provenance } = dim.score(profile);

    let earned = 0;
    if (hasValue) {
      const provMultiplier = getProvenanceMultiplier(provenance);
      earned = normalizedWeight * specificity * provMultiplier;
    }

    earnedPointsSum += earned;
    dimensionResults[dim.key] = {
      baseWeight: dim.baseWeight,
      normalizedWeight: Math.round(normalizedWeight * 10) / 10,
      earnedPoints: Math.round(earned * 10) / 10,
      provenance,
      hasValue,
    };
  }

  const finalMaturity = Math.min(100, Math.max(0, Math.round(earnedPointsSum)));

  return {
    maturity: finalMaturity,
    meetsThreshold: finalMaturity >= MATURITY_AUTOMATIC_THRESHOLD,
    applicableWeightsSum: totalApplicableBaseWeight,
    earnedPointsSum: Math.round(earnedPointsSum * 10) / 10,
    dimensions: dimensionResults,
  };
}
