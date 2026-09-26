// ============================================================
// Tipos centrais do subsistema de Match e Túnel WACRM ↔ Meus Imóveis
// Conforme especificado em docs/match-contract-v1.md
// ============================================================

export type InfoProvenance = 'ctwa' | 'conversation' | 'manual';

export type MatchStatus = 'novo' | 'enviado' | 'pausado' | 'arquivado';
export type MatchOrigin = 'match_automatico' | 'envio_manual' | 'origem_ctwa';

export type DeliveryStatus = 'pronto' | 'planta' | 'em_construcao';
export type PropertyOperation = 'venda' | 'locacao';

/**
 * Perfil estruturado de busca do lead para cálculo de Maturidade e Match.
 */
export interface LeadSearchProfile {
  accountId: string;
  leadId: string;
  name: string;
  phone: string;
  aiScore: number;                 // 0–10 (temperatura comercial)
  isPaused: boolean;
  isArchived: boolean;
  
  // Preferências e requisitos
  operation: PropertyOperation;
  purpose: string[];               // ['moradia', 'investimento']
  propertyTypes: string[];         // ['apartamento', 'flat', 'casa', 'terreno']
  propertyTypeStrict: boolean;     // true = "somente casa", false = "prefiro casa"
  
  locations: string[];             // ['Bessa', 'Manaíra']
  locationStrict: boolean;         // true = "somente Bessa"
  locationSpecificity: 'city' | 'region' | 'neighborhood';
  
  priceMin: number | null;
  priceMax: number | null;         // Preço teto desejado
  priceStrictMax: boolean;         // true = "limite absoluto / não posso passar de X"
  priceFlexMax: number | null;     // Limite flexível para oportunidade excelente
  
  bedrooms: number[];              // [2, 3]
  bedroomsStrict: boolean;         // true = "preciso de 3 quartos", false = "prefiro 3 quartos"
  
  deliveryStatus: DeliveryStatus[];
  deliveryStrict: boolean;         // true = "só quero pronto", false = "prefiro pronto"
  maxDeliveryYear?: number | null;
  
  requiredFeatures: string[];      // ['elevador', 'acessibilidade']
  preferredFeatures: string[];     // ['piscina', 'varanda gourmet']
  
  isShortStayOnly: boolean;        // Se busca exclusivamente aluguel por temporada
  
  // Proveniência de cada dimensão
  provenance: {
    operation?: InfoProvenance;
    purpose?: InfoProvenance;
    propertyTypes?: InfoProvenance;
    locations?: InfoProvenance;
    price?: InfoProvenance;
    bedrooms?: InfoProvenance;
    delivery?: InfoProvenance;
    features?: InfoProvenance;
  };
}

/**
 * Projeção de dados de um imóvel do catálogo Meus Imóveis.
 */
export interface PropertyProjection {
  id?: string;
  propertyId: string;
  accountId: string;
  code?: string | null;
  title: string;
  operation: PropertyOperation;
  propertyType: string;
  neighborhood: string;
  city: string;
  priceMin: number;
  priceMax: number;
  areaMin?: number | null;
  areaMax?: number | null;
  bedroomsMin?: number | null;
  bedroomsMax?: number | null;
  deliveryStatus: DeliveryStatus;
  deliveryDeadline?: string | null;
  features: string[];
  coverUrl?: string | null;
  publicUrl?: string | null;
  status: 'ativo' | 'inativo' | 'arquivado';
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Breakdown detalhado da pontuação de Match.
 */
export interface MatchScoreBreakdown {
  price: number;          // 0–25
  location: number;       // 0–20
  propertyType: number;   // 0–15
  bedrooms: number;       // 0–15
  purpose: number;        // 0–10
  delivery: number;       // 0–10
  area: number;           // 0–5
  penalties: string[];
  reasons: string[];
}

/**
 * Resultado da execução do motor de Match para um par Lead + Imóvel.
 */
export interface MatchEvaluationResult {
  eligible: boolean;
  eliminatedReason?: string | null;
  matchScore: number;       // 0–100%
  scoreBreakdown: MatchScoreBreakdown;
  commercialPriority: number;
  isStrongMatch: boolean;   // >= 85%
  isGoodMatch: boolean;     // 70–84%
  isManualOnly: boolean;    // < 70% ou capped em 69%
}

/**
 * Registro de Match persistido no banco de dados.
 */
export interface MatchRecord {
  id: string;
  accountId: string;
  leadId: string;
  propertyId: string;
  matchScore: number;
  scoreBreakdown: MatchScoreBreakdown;
  profileMaturity: number;
  commercialPriority: number;
  matchStatus: MatchStatus;
  suppressed: boolean;
  origin: MatchOrigin;
  sentAt?: string | null;
  pausedAt?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  
  // Relações opcionais para visualização
  lead?: {
    id: string;
    name: string;
    phone: string;
    aiScore: number;
    pausedAt?: string | null;
    archivedAt?: string | null;
  };
  property?: PropertyProjection;
  shares?: PropertyShareRecord[];
}

/**
 * Registro de envio individual com token criptográfico de rastreamento.
 */
export interface PropertyShareRecord {
  id: string;
  accountId: string;
  leadId: string;
  propertyId: string;
  matchId?: string | null;
  trackingToken: string;
  channel: 'whatsapp_pessoal';
  messageText?: string | null;
  sentAt: string;
  firstOpenedAt?: string | null;
  lastOpenedAt?: string | null;
  openCount: number;
  isInterested: boolean;
  interestedAt?: string | null;
  revokedAt?: string | null;
}

/**
 * Grupo de Matches agregado por Lead para visualização na Central Match (1 Card = 1 Lead).
 */
export interface LeadMatchGroup {
  leadId: string;
  lead: {
    id: string;
    name: string | null;
    phone: string;
    ai_score?: number | null;
    aiScore?: number;
    paused_at?: string | null;
    archived_at?: string | null;
    has_purchased?: boolean;
    is_personal_whatsapp?: boolean;
  };
  profileMaturity: number;
  aiScore: number;
  bestMatch: MatchRecord;
  totalMatches: number;
  statusMatchesCount: number;
  matches: MatchRecord[];
}
