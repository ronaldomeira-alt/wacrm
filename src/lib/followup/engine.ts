import { saoPauloDayKey, saoPauloDayStartIso } from '@/lib/dashboard/date-utils';
import type { LeadSummary } from '@/lib/ai/lead-analysis-types';
import type { AiSuggestion, AiSuggestionStatus } from '@/types';

export const FOLLOWUP_TIMEZONE = 'America/Sao_Paulo';

export type FollowupDateFilter =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | '7d'
  | 'this_month'
  | '30d'
  | 'all'
  | 'custom';

export type FollowupSortBy =
  | 'recent_priority'
  | 'priority_desc'
  | 'maturity_desc'
  | 'ai_score_desc'
  | 'longest_without_contact';

export type FollowupOpportunityType = 'first_contact' | 'resumption';

export type FollowupMaturityBand = 'all' | 'ready' | 'growing' | 'initial';

export type FollowupPriorityTier = 'high' | 'medium' | 'normal';

export interface CompatiblePropertySummary {
  matchId: string;
  propertyId: string;
  title: string;
  code?: string | null;
  neighborhood: string;
  city: string;
  operation: string;
  propertyType?: string | null;
  priceMin: number;
  priceMax: number;
  bedroomsMin?: number | null;
  bedroomsMax?: number | null;
  areaMin?: number | null;
  deliveryStatus?: string | null;
  coverUrl?: string | null;
  publicUrl?: string | null;
  matchScore: number;
  commercialPriority: number;
  matchStatus: string;
  reasons: string[];
}

export interface EnrichedFollowupItem {
  suggestion: AiSuggestion;
  contact: {
    id: string;
    name: string;
    phone: string;
    avatar_url?: string | null;
    ai_score: number;
    ai_score_reason?: string | null;
    has_purchased: boolean;
    is_personal_whatsapp: boolean;
  };
  /** Etapa atual do pipeline (vinda do deal ativo ou do snapshot do payload) */
  stageId: string | null;
  stageName: string | null;
  stageColor: string | null;
  /** Tipo comercial da oportunidade conforme histórico real */
  opportunityType: FollowupOpportunityType;
  /** Maturidade comercial (0–100) calculada pelo motor de maturidade */
  profileMaturity: number;
  /** Score da IA do lead (0–10) persistido em contacts.ai_score */
  aiScore: number;
  /** Confiança da sugestão de Follow-up (0–100) gerada pelo motor de Follow-up em payload.score */
  confidenceScore: number | null;
  /** Prioridade comercial determinística (0–100) para desempate e ordenação */
  commercialPriorityScore: number;
  priorityTier: FollowupPriorityTier;
  /** Separando claramente os 3 conceitos temporais (Seção 6): */
  /** 1. Data de geração da sugestão (ai_suggestions.created_at) */
  suggestionCreatedAt: string;
  suggestionDayKeySp: string;
  /** 2. Data da última atualização comercial significativa (resolved_at ou snoozed_until, se existir) */
  suggestionSignificantUpdatedAt: string | null;
  /** 3. Data da última comunicação efetiva na conversa (conversations.last_message_at) */
  lastCommunicationAt: string | null;
  /** Tempo decorrido em horas desde o último contato (null quando nunca contatado) */
  hoursSinceLastCommunication: number | null;
  /** True quando não há comunicação anterior efetiva registrada */
  neverContacted: boolean;
  /** Explicação e contexto comercial estruturados */
  reason: string;
  approachSummary: string | null;
  interestProperty: string | null;
  primaryNeed: string | null;
  lastMessagePreview: string | null;
  /** Recomendações complementares do motor de Match */
  compatiblePropertiesCount: number;
  compatibleProperties: CompatiblePropertySummary[];
}

/**
 * Adiciona (ou subtrai) dias a uma chave YYYY-MM-DD de calendário puro.
 */
export function addCalendarDays(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Retorna o início da semana (Segunda-feira) para uma chave YYYY-MM-DD no fuso America/Sao_Paulo.
 */
export function getSaoPauloMondayDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const jsDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Dom ... 6 = Sáb
  const mondayOffset = (jsDow + 6) % 7; // 0 = Seg ... 6 = Dom
  return addCalendarDays(dayKey, -mondayOffset);
}

/**
 * Retorna o instante final (23:59:59.999) de um dia YYYY-MM-DD em America/Sao_Paulo,
 * calculado como 1ms antes do início do dia seguinte em America/Sao_Paulo.
 */
export function saoPauloDayEndIso(dayKey: string): string {
  const nextDayKey = addCalendarDays(dayKey, 1);
  const nextStartMs = new Date(saoPauloDayStartIso(nextDayKey)).getTime();
  return new Date(nextStartMs - 1).toISOString();
}

export interface DateFilterRange {
  startMs: number | null;
  endMs: number | null;
  startDayKeySp: string | null;
  endDayKeySp: string | null;
}

/**
 * Resolve o intervalo exato [startMs, endMs] no fuso America/Sao_Paulo para o filtro selecionado.
 *
 * Regra documentada (Seção 6):
 * - 'today': Hoje (00:00:00.000 até 23:59:59.999 em America/Sao_Paulo)
 * - 'yesterday': Ontem (00:00:00.000 até 23:59:59.999 do dia anterior em America/Sao_Paulo)
 * - 'this_week': Esta semana (desde Segunda-feira 00:00:00.000 em America/Sao_Paulo até o fim de hoje)
 * - '7d': Últimos 7 dias (desde 00:00:00.000 de 6 dias atrás + hoje = 7 dias corridos no calendário SP)
 * - 'this_month': Este mês (desde o dia 01 do mês atual em SP às 00:00:00.000 até o fim de hoje)
 * - '30d': Últimos 30 dias (desde 00:00:00.000 de 29 dias atrás + hoje = 30 dias no calendário SP)
 * - 'custom': Período personalizado entre customFrom e customTo (YYYY-MM-DD em America/Sao_Paulo)
 * - 'all': Todas as datas (sem restrição temporal)
 */
export function resolveFollowupDateFilterRange(
  filter: FollowupDateFilter,
  now: Date = new Date(),
  customFrom?: string | null,
  customTo?: string | null
): DateFilterRange {
  if (filter === 'all') {
    return { startMs: null, endMs: null, startDayKeySp: null, endDayKeySp: null };
  }

  const todayKey = saoPauloDayKey(now);

  if (filter === 'today') {
    return {
      startMs: new Date(saoPauloDayStartIso(todayKey)).getTime(),
      endMs: new Date(saoPauloDayEndIso(todayKey)).getTime(),
      startDayKeySp: todayKey,
      endDayKeySp: todayKey,
    };
  }

  if (filter === 'yesterday') {
    const yesterdayKey = addCalendarDays(todayKey, -1);
    return {
      startMs: new Date(saoPauloDayStartIso(yesterdayKey)).getTime(),
      endMs: new Date(saoPauloDayEndIso(yesterdayKey)).getTime(),
      startDayKeySp: yesterdayKey,
      endDayKeySp: yesterdayKey,
    };
  }

  if (filter === 'this_week') {
    const mondayKey = getSaoPauloMondayDayKey(todayKey);
    return {
      startMs: new Date(saoPauloDayStartIso(mondayKey)).getTime(),
      endMs: new Date(saoPauloDayEndIso(todayKey)).getTime(),
      startDayKeySp: mondayKey,
      endDayKeySp: todayKey,
    };
  }

  if (filter === '7d') {
    const startKey = addCalendarDays(todayKey, -6);
    return {
      startMs: new Date(saoPauloDayStartIso(startKey)).getTime(),
      endMs: new Date(saoPauloDayEndIso(todayKey)).getTime(),
      startDayKeySp: startKey,
      endDayKeySp: todayKey,
    };
  }

  if (filter === 'this_month') {
    const [y, m] = todayKey.split('-');
    const monthStartKey = `${y}-${m}-01`;
    return {
      startMs: new Date(saoPauloDayStartIso(monthStartKey)).getTime(),
      endMs: new Date(saoPauloDayEndIso(todayKey)).getTime(),
      startDayKeySp: monthStartKey,
      endDayKeySp: todayKey,
    };
  }

  if (filter === '30d') {
    const startKey = addCalendarDays(todayKey, -29);
    return {
      startMs: new Date(saoPauloDayStartIso(startKey)).getTime(),
      endMs: new Date(saoPauloDayEndIso(todayKey)).getTime(),
      startDayKeySp: startKey,
      endDayKeySp: todayKey,
    };
  }

  if (filter === 'custom') {
    const validFrom = customFrom && /^\d{4}-\d{2}-\d{2}$/.test(customFrom.trim()) ? customFrom.trim() : null;
    const validTo = customTo && /^\d{4}-\d{2}-\d{2}$/.test(customTo.trim()) ? customTo.trim() : null;
    const startMs = validFrom ? new Date(saoPauloDayStartIso(validFrom)).getTime() : null;
    const endMs = validTo ? new Date(saoPauloDayEndIso(validTo)).getTime() : null;
    return {
      startMs,
      endMs,
      startDayKeySp: validFrom,
      endDayKeySp: validTo,
    };
  }

  return { startMs: null, endMs: null, startDayKeySp: null, endDayKeySp: null };
}

/**
 * Avalia se a data da sugestão (created_at) pertence ao intervalo do filtro de data em America/Sao_Paulo.
 */
export function matchesFollowupDateFilter(
  suggestionCreatedAt: string,
  range: DateFilterRange
): boolean {
  if (range.startMs === null && range.endMs === null) return true;
  const ts = new Date(suggestionCreatedAt).getTime();
  if (Number.isNaN(ts)) return false;
  if (range.startMs !== null && ts < range.startMs) return false;
  if (range.endMs !== null && ts > range.endMs) return false;
  return true;
}

/**
 * Classifica o tipo da oportunidade ('first_contact' vs 'resumption') e se o lead nunca foi contatado,
 * baseando-se no histórico real da conversa e na etapa do pipeline.
 */
export function classifyFollowupTimingAndType(args: {
  lastMessageAt?: string | null;
  lastMessageText?: string | null;
  aiReplyCount?: number | null;
  payloadHoursSinceContact?: number | null;
  stageName?: string | null;
  nowMs?: number;
}): {
  neverContacted: boolean;
  lastCommunicationAt: string | null;
  hoursSinceLastCommunication: number | null;
  opportunityType: FollowupOpportunityType;
} {
  const {
    lastMessageAt,
    lastMessageText,
    aiReplyCount,
    payloadHoursSinceContact,
    stageName,
    nowMs = Date.now(),
  } = args;

  const parsedLastMsgMs = lastMessageAt ? new Date(lastMessageAt).getTime() : NaN;
  const hasValidLastMessageAt = Number.isFinite(parsedLastMsgMs) && parsedLastMsgMs > 0;

  if (!hasValidLastMessageAt) {
    // Se não há last_message_at na conversa nem texto registrado, o lead nunca teve comunicação efetiva
    const hasLegacyPayloadHours =
      typeof payloadHoursSinceContact === 'number' &&
      Number.isFinite(payloadHoursSinceContact) &&
      payloadHoursSinceContact > 0 &&
      Boolean(lastMessageText?.trim());

    if (!hasLegacyPayloadHours) {
      return {
        neverContacted: true,
        lastCommunicationAt: null,
        hoursSinceLastCommunication: null,
        opportunityType: 'first_contact',
      };
    }

    return {
      neverContacted: false,
      lastCommunicationAt: null,
      hoursSinceLastCommunication: Math.max(0, Math.round(payloadHoursSinceContact!)),
      opportunityType:
        stageName?.trim().toLowerCase() === 'novo lead' && (aiReplyCount ?? 0) === 0
          ? 'first_contact'
          : 'resumption',
    };
  }

  const elapsedHours = Math.max(0, Math.round((nowMs - parsedLastMsgMs) / (1000 * 60 * 60)));
  const isInitialStageWithoutBotReply =
    stageName?.trim().toLowerCase() === 'novo lead' && (aiReplyCount ?? 0) === 0;

  return {
    neverContacted: false,
    lastCommunicationAt: new Date(parsedLastMsgMs).toISOString(),
    hoursSinceLastCommunication: elapsedHours,
    opportunityType: isInitialStageWithoutBotReply ? 'first_contact' : 'resumption',
  };
}

/**
 * Extrai a principal necessidade identificada do lead a partir do resumo estruturado da IA e das tags,
 * sem disparar nenhuma nova chamada de LLM.
 */
export function extractLeadPrimaryNeed(args: {
  summary?: Partial<LeadSummary> | Record<string, unknown> | null;
  tagByCategory?: Record<string, string[]>;
}): string | null {
  const { summary, tagByCategory = {} } = args;
  const parts: string[] = [];

  const toStrArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
      : [];

  const types = toStrArray(summary?.property_type);
  const typeList = types.length > 0 ? types : tagByCategory['Tipo de imóvel'] || [];
  if (typeList.length > 0) {
    parts.push(typeList.slice(0, 2).join('/'));
  }

  const bedrooms = Array.isArray(summary?.bedrooms)
    ? (summary.bedrooms as unknown[])
        .map((b) => Number(b))
        .filter((b) => Number.isFinite(b) && b > 0)
    : [];
  if (bedrooms.length > 0) {
    parts.push(`${bedrooms.join(' ou ')} ${bedrooms.length === 1 && bedrooms[0] === 1 ? 'quarto' : 'quartos'}`);
  } else if ((tagByCategory['Quartos'] || []).length > 0) {
    parts.push(tagByCategory['Quartos'][0]);
  }

  const locations = toStrArray(summary?.location);
  const locList = locations.length > 0 ? locations : tagByCategory['Bairro'] || [];
  if (locList.length > 0) {
    parts.push(`em ${locList.slice(0, 2).join(', ')}`);
  }

  const purposes = toStrArray(summary?.purpose);
  const purposeList = purposes.length > 0 ? purposes : tagByCategory['Finalidade'] || [];
  if (purposeList.length > 0) {
    parts.push(`(${purposeList.slice(0, 2).join(' / ')})`);
  }

  if (parts.length === 0) {
    const intent = typeof summary?.intent === 'string' ? summary.intent.trim() : '';
    if (intent) return intent;
    return null;
  }

  return parts.join(' ');
}

/**
 * Identifica o empreendimento de interesse do lead quando conhecido (via tag 'Empreendimento',
 * origem CTWA ou menção direta verificada no catálogo).
 */
export function extractInterestProperty(args: {
  tagByCategory?: Record<string, string[]>;
  ctwaHeadline?: string | null;
  reasonText?: string | null;
  knownPropertyNames?: string[];
}): string | null {
  const { tagByCategory = {}, ctwaHeadline, reasonText, knownPropertyNames = [] } = args;

  const empTags = tagByCategory['Empreendimento'] || [];
  if (empTags.length > 0 && empTags[0]?.trim()) {
    return empTags[0].trim();
  }

  if (knownPropertyNames.length > 0) {
    const haystacks = [reasonText || '', ctwaHeadline || '']
      .map((s) => s.trim())
      .filter(Boolean);
    for (const hay of haystacks) {
      const hayLower = hay.toLowerCase();
      for (const propName of knownPropertyNames) {
        const cleanProp = propName.trim();
        if (cleanProp.length >= 3 && hayLower.includes(cleanProp.toLowerCase())) {
          return cleanProp;
        }
      }
    }
  }

  if (ctwaHeadline && ctwaHeadline.trim().length > 0 && ctwaHeadline.trim().length <= 60) {
    return ctwaHeadline.trim();
  }

  return null;
}

/**
 * Calcula a prioridade comercial determinística (0–100) reutilizando exclusivamente
 * indicadores confiáveis já existentes no CRM:
 * - Confiança da sugestão da Clara (`payload.score`, 0–100) — peso 35%
 * - Score comercial da IA (`contacts.ai_score`, 0–10) — peso 30%
 * - Maturidade do perfil (`profileMaturity`, 0–100) — peso 20%
 * - Interesse demonstrado (empreendimento identificado, necessidade clara ou etapa avançada) — peso 15%
 */
export function calculateFollowupCommercialPriority(args: {
  confidenceScore: number | null;
  aiScore: number;
  profileMaturity: number;
  hasInterestProperty: boolean;
  hasPrimaryNeed: boolean;
  stageName?: string | null;
}): { score: number; tier: FollowupPriorityTier } {
  const {
    confidenceScore,
    aiScore,
    profileMaturity,
    hasInterestProperty,
    hasPrimaryNeed,
    stageName,
  } = args;

  const confComp = Math.min(100, Math.max(0, confidenceScore ?? 55)) * 0.35;
  const aiComp = Math.min(10, Math.max(0, aiScore)) * 3.0; // 0 a 30
  const matComp = Math.min(100, Math.max(0, profileMaturity)) * 0.20; // 0 a 20

  let interestComp = 0;
  if (hasInterestProperty) interestComp += 6;
  if (hasPrimaryNeed) interestComp += 5;
  const normStage = (stageName || '').trim().toLowerCase();
  if (
    normStage === 'interesse' ||
    normStage === 'visita' ||
    normStage === 'proposta' ||
    normStage === 'negociação' ||
    normStage === 'negociacao'
  ) {
    interestComp += 4;
  }

  const raw = confComp + aiComp + matComp + Math.min(15, interestComp);
  const score = Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;

  let tier: FollowupPriorityTier = 'normal';
  if (score >= 72 || (aiScore >= 7 && (confidenceScore ?? 0) >= 75)) {
    tier = 'high';
  } else if (score >= 52 || aiScore >= 5) {
    tier = 'medium';
  }

  return { score, tier };
}

/**
 * Comparador secundário de prioridade comercial entre duas sugestões de Follow-up.
 * Determinístico e estável.
 */
export function compareByCommercialPriority(
  a: EnrichedFollowupItem,
  b: EnrichedFollowupItem
): number {
  if (b.commercialPriorityScore !== a.commercialPriorityScore) {
    return b.commercialPriorityScore - a.commercialPriorityScore;
  }
  const confA = a.confidenceScore ?? 0;
  const confB = b.confidenceScore ?? 0;
  if (confB !== confA) return confB - confA;

  if (b.aiScore !== a.aiScore) return b.aiScore - a.aiScore;
  if (b.profileMaturity !== a.profileMaturity) return b.profileMaturity - a.profileMaturity;

  const createdA = new Date(a.suggestionCreatedAt).getTime() || 0;
  const createdB = new Date(b.suggestionCreatedAt).getTime() || 0;
  if (createdB !== createdA) return createdB - createdA;

  return a.suggestion.id.localeCompare(b.suggestion.id);
}

/**
 * Ordenação oficial do módulo Follow-up (Seção 7):
 * - 'recent_priority' (padrão):
 *     1º Recência: agrupamento temporal por dia da sugestão em America/Sao_Paulo (suggestionDayKeySp DESC)
 *     2º Prioridade comercial dentro do mesmo agrupamento temporal (compareByCommercialPriority)
 * - 'priority_desc': Maior prioridade comercial geral -> recência -> id
 * - 'maturity_desc': Maior maturidade do perfil -> prioridade comercial -> id
 * - 'ai_score_desc': Maior score da IA -> prioridade comercial -> id
 * - 'longest_without_contact': Mais tempo sem contato (leads com histórico real de último contato
 *     vêm primeiro do maior para o menor tempo sem contato; leads nunca contatados são tratados
 *     separadamente ao final, ordenados por prioridade comercial).
 */
export function compareFollowupItems(
  a: EnrichedFollowupItem,
  b: EnrichedFollowupItem,
  sortBy: FollowupSortBy = 'recent_priority'
): number {
  if (sortBy === 'recent_priority') {
    if (b.suggestionDayKeySp !== a.suggestionDayKeySp) {
      return b.suggestionDayKeySp.localeCompare(a.suggestionDayKeySp);
    }
    return compareByCommercialPriority(a, b);
  }

  if (sortBy === 'priority_desc') {
    return compareByCommercialPriority(a, b);
  }

  if (sortBy === 'maturity_desc') {
    if (b.profileMaturity !== a.profileMaturity) {
      return b.profileMaturity - a.profileMaturity;
    }
    return compareByCommercialPriority(a, b);
  }

  if (sortBy === 'ai_score_desc') {
    if (b.aiScore !== a.aiScore) {
      return b.aiScore - a.aiScore;
    }
    return compareByCommercialPriority(a, b);
  }

  if (sortBy === 'longest_without_contact') {
    // Trata separadamente os leads nunca contatados dos leads com histórico real de comunicação
    if (a.neverContacted !== b.neverContacted) {
      return a.neverContacted ? 1 : -1;
    }
    if (!a.neverContacted && !b.neverContacted) {
      const hoursA = a.hoursSinceLastCommunication ?? 0;
      const hoursB = b.hoursSinceLastCommunication ?? 0;
      if (hoursB !== hoursA) return hoursB - hoursA;
    }
    return compareByCommercialPriority(a, b);
  }

  return compareByCommercialPriority(a, b);
}

/**
 * Verifica se o item atende à faixa de maturidade selecionada.
 */
export function matchesMaturityBand(maturity: number, band: FollowupMaturityBand): boolean {
  if (band === 'all') return true;
  if (band === 'ready') return maturity >= 70;
  if (band === 'growing') return maturity >= 40 && maturity < 70;
  if (band === 'initial') return maturity < 40;
  return true;
}

export interface FollowupFilterCriteria {
  status?: AiSuggestionStatus;
  dateFilter?: FollowupDateFilter;
  customFrom?: string | null;
  customTo?: string | null;
  search?: string;
  stage?: string;
  maturityBand?: FollowupMaturityBand;
  minAiScore?: number;
  opportunityType?: 'all' | FollowupOpportunityType;
  contactId?: string | null;
  now?: Date;
}

/**
 * Filtra uma lista de itens de Follow-up combinando todos os critérios ativos (Seção 8).
 */
export function filterFollowupItems(
  items: EnrichedFollowupItem[],
  criteria: FollowupFilterCriteria
): EnrichedFollowupItem[] {
  const {
    status,
    dateFilter = '7d',
    customFrom,
    customTo,
    search = '',
    stage = 'all',
    maturityBand = 'all',
    minAiScore = 0,
    opportunityType = 'all',
    contactId = null,
    now = new Date(),
  } = criteria;

  const dateRange = resolveFollowupDateFilterRange(dateFilter, now, customFrom, customTo);
  const normSearch = search.trim().toLowerCase();
  const normSearchDigits = search.replace(/\D/g, '');
  const normStage = stage.trim().toLowerCase();

  return items.filter((item) => {
    if (status && item.suggestion.status !== status) return false;
    if (contactId && item.contact.id !== contactId) return false;

    if (!matchesFollowupDateFilter(item.suggestionCreatedAt, dateRange)) {
      return false;
    }

    if (normSearch) {
      const nameMatch = item.contact.name.toLowerCase().includes(normSearch);
      const phoneRawMatch = item.contact.phone.toLowerCase().includes(normSearch);
      const phoneDigitsMatch =
        normSearchDigits.length > 0 &&
        item.contact.phone.replace(/\D/g, '').includes(normSearchDigits);
      if (!nameMatch && !phoneRawMatch && !phoneDigitsMatch) {
        return false;
      }
    }

    if (normStage && normStage !== 'all') {
      const itemStage = (item.stageName || '').trim().toLowerCase();
      if (normStage === '__none__') {
        if (itemStage !== '') return false;
      } else if (itemStage !== normStage) {
        return false;
      }
    }

    if (!matchesMaturityBand(item.profileMaturity, maturityBand)) {
      return false;
    }

    if (minAiScore > 0 && item.aiScore < minAiScore) {
      return false;
    }

    if (opportunityType !== 'all' && item.opportunityType !== opportunityType) {
      return false;
    }

    return true;
  });
}
