import { saoPauloDayKey, saoPauloDayStartIso } from '@/lib/dashboard/date-utils';
import type { LeadSummary } from '@/lib/ai/lead-analysis-types';
import type { LeadCommercialOperation, LeadSearchProfile } from '@/lib/match/types';
import { WHATSAPP_SESSION_WINDOW_MS } from '@/lib/whatsapp/session-window';
import type { AiSuggestion, AiSuggestionStatus } from '@/types';

export const FOLLOWUP_TIMEZONE = 'America/Sao_Paulo';
export const FOLLOWUP_WINDOW_CLOSING_SOON_MS = 6 * 60 * 60 * 1000; // 6h ou menos restantes na janela de 24h
export const FOLLOWUP_REQUIRED_TEMPLATE_NAME = 'match_imovel_personalizado';
export const FOLLOWUP_MAX_RECOMMENDED_PROPERTIES = 3;

export type FollowupDateFilter =
  | 'today'
  | 'yesterday'
  | 'day_before_yesterday'
  | '3d'
  | 'this_week'
  | '7d'
  | 'this_month'
  | '30d'
  | 'all'
  | 'custom';

export type FollowupSortBy =
  | 'recent_priority'
  | 'window_closing_soon'
  | 'priority_desc'
  | 'maturity_desc'
  | 'ai_score_desc'
  | 'longest_without_contact';

export type FollowupOpportunityType = 'first_contact' | 'resumption';

export type FollowupContactState =
  | 'first_contact'
  | 'awaiting_business_reply'
  | 'resumption'
  | 'recent_business_contact'
  | 'planned_followup';

export type FollowupMaturityBand = 'all' | 'ready' | 'growing' | 'initial';

export type FollowupPriorityTier = 'high' | 'medium' | 'normal';

export type FollowupWindowStatus = 'open' | 'closing_soon' | 'expired' | 'unknown';

export type FollowupWindowFilter = 'all' | 'open' | 'closing_soon' | 'expired';

export interface FollowupSessionWindowInfo {
  status: FollowupWindowStatus;
  windowOpen: boolean;
  closingSoon: boolean;
  templateRequired: boolean;
  remainingMs: number;
  remainingLabel: string | null;
  isCtwaLead: boolean;
  ctwaFreeBenefitActive: boolean;
  ctwaFreeBenefitExpiresAt: string | null;
  ctwaFreeBenefitRemainingLabel: string | null;
}

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
  areaMax?: number | null;
  deliveryStatus?: string | null;
  coverUrl?: string | null;
  publicUrl?: string | null;
  matchScore: number;
  commercialPriority: number;
  matchStatus: string;
  reasons: string[];
  /** True quando este imóvel já foi enviado anteriormente para o cliente */
  alreadyShared?: boolean;
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
  /** Estado detalhado do relacionamento comercial */
  contactState?: FollowupContactState;
  /** True quando a última mensagem válida partiu do cliente e ainda aguarda retorno */
  awaitingBusinessReply?: boolean;
  /** Maturidade comercial (0–100) calculada pelo motor de maturidade */
  profileMaturity: number;
  /** Score da IA do lead (0–10) persistido em contacts.ai_score */
  aiScore: number;
  /** Confiança da sugestão de Follow-up (0–100) gerada pelo motor de Follow-up em payload.score */
  confidenceScore: number | null;
  /** Prioridade comercial determinística (0–100) para desempate e ordenação */
  commercialPriorityScore: number;
  priorityTier: FollowupPriorityTier;
  /**
   * 4 conceitos temporais estritamente separados (Seção 1):
   * 1. lastCustomerMessageAt: última mensagem efetivamente recebida do cliente (referência principal de filtro!)
   * 2. lastBusinessMessageAt: última mensagem comercial enviada pela equipe, Clara ou automação
   * 3. lastInteractionAt: última interação válida da conversa, independentemente da direção
   * 4. suggestionCreatedAt: data de geração da recomendação pela IA (auditoria/secundária)
   */
  lastCustomerMessageAt?: string | null;
  customerDayKeySp?: string | null;
  lastBusinessMessageAt?: string | null;
  lastAgentMessageAt?: string | null;
  lastInteractionAt?: string | null;
  suggestionCreatedAt: string;
  suggestionDayKeySp: string;
  suggestionSignificantUpdatedAt: string | null;
  /** Mantido para compatibilidade com cards/testes existentes (aponta para lastCustomerMessageAt ?? lastInteractionAt) */
  lastCommunicationAt: string | null;
  /** Tempo decorrido em horas desde a última comunicação (null quando nunca houve interação) */
  hoursSinceLastCommunication: number | null;
  /** Tempo decorrido em horas desde a última mensagem recebida do cliente */
  hoursSinceLastCustomerMessage?: number | null;
  /** True quando não há comunicação anterior efetiva registrada */
  neverContacted: boolean;
  /** Estado real da janela de atendimento de 24h do WhatsApp e benefício CTWA 72h */
  sessionWindow?: FollowupSessionWindowInfo;
  /** Explicação e contexto comercial estruturados */
  reason: string;
  approachSummary: string | null;
  interestProperty: string | null;
  primaryNeed: string | null;
  lastMessagePreview: string | null;
  lastCustomerMessagePreview?: string | null;
  lastBusinessMessagePreview?: string | null;
  /** Recomendações complementares do motor de Match */
  compatiblePropertiesCount: number;
  compatibleProperties: CompatiblePropertySummary[];
  /** Operação comercial validada (exclusivamente 'venda' na fila ativa) */
  commercialOperation?: LeadCommercialOperation;
  /** True quando há promessa/compromisso pendente da equipe identificado na conversa */
  hasPendingCommitment?: boolean;
  /** Tipologias explicitamente rejeitadas pelo cliente (ex.: ['flat', 'studio']) */
  excludedPropertyTypes?: string[];
  /** Faixa de recência estrutural (0 = <=24h, 1 = <=72h, 2 = <=7d, 3 = <=14d, 4 = <=30d, 5 = >30d) */
  recencyTier?: number;
}

export interface RawConversationMessageRow {
  conversation_id?: string | null;
  sender_type?: string | null;
  content_type?: string | null;
  content_text?: string | null;
  transcript_text?: string | null;
  media_url?: string | null;
  template_name?: string | null;
  created_at?: string | null;
  private?: boolean | null;
  event?: boolean | string | null;
}

export interface ConversationMessageStats {
  lastCustomerMessageAt: string | null;
  lastBusinessMessageAt: string | null;
  lastAgentMessageAt: string | null;
  lastBotMessageAt: string | null;
  lastInteractionAt: string | null;
  customerMessageCount: number;
  businessMessageCount: number;
  agentMessageCount: number;
  lastCustomerText: string | null;
  lastBusinessText: string | null;
}

const TECHNICAL_PLACEHOLDER_RE = /^\[(?:unsupported message type|reaction|system|ephemeral|protocol)\b/i;
const AUTOMATED_INSTAGRAM_INVITE_RE = /instagram\.com\/ronaldomeiracorretor/i;

/**
 * Determina se um registro de `messages` representa comunicação real entre cliente e empresa,
 * excluindo eventos técnicos, notificações internas (`private`), linhas de sistema e placeholders vazios.
 */
export function isRealCommunicationMessage(msg: RawConversationMessageRow): boolean {
  if (!msg || msg.private === true) return false;
  const sender = String(msg.sender_type || '').trim().toLowerCase();
  if (sender !== 'customer' && sender !== 'agent' && sender !== 'bot') return false;

  const contentType = String(msg.content_type || '').trim().toLowerCase();
  if (contentType === 'system' || contentType === 'reaction' || contentType === 'protocol') {
    return false;
  }
  if (msg.event && String(msg.event).trim() !== '') {
    return false;
  }

  const rawText =
    typeof msg.content_text === 'string' && msg.content_text.trim()
      ? msg.content_text.trim()
      : typeof msg.transcript_text === 'string'
        ? msg.transcript_text.trim()
        : '';
  const text = rawText;
  const hasMedia = Boolean(typeof msg.media_url === 'string' && msg.media_url.trim());
  const hasTemplate = Boolean(typeof msg.template_name === 'string' && msg.template_name.trim());

  if (text && TECHNICAL_PLACEHOLDER_RE.test(text) && !hasMedia && !hasTemplate) {
    return false;
  }

  if (!text && !hasMedia && !hasTemplate && contentType === 'unsupported') {
    return false;
  }

  const ts = msg.created_at ? new Date(msg.created_at).getTime() : NaN;
  return Number.isFinite(ts) && ts > 0;
}

/**
 * Verifica se uma mensagem de saída é apenas o convite automático de seguir no Instagram
 * (que não deve ser confundido com um atendimento ou follow-up comercial de Ronaldo, Tatiana ou Clara).
 */
export function isAutomatedInstagramInviteMessage(msg: RawConversationMessageRow): boolean {
  const text = typeof msg.content_text === 'string' ? msg.content_text : '';
  return AUTOMATED_INSTAGRAM_INVITE_RE.test(text);
}

/**
 * Agrega o histórico real de mensagens de uma conversa separando rigorosamente:
 * - Mensagens recebidas do cliente (`customer`)
 * - Mensagens comerciais enviadas pela empresa (`agent` / `bot`, ignorando o disparo automático do Instagram)
 */
export function summarizeConversationMessages(
  messages: RawConversationMessageRow[]
): ConversationMessageStats {
  let lastCustomerMs = -1;
  let lastCustomerMessageAt: string | null = null;
  let lastCustomerText: string | null = null;

  let lastBusinessMs = -1;
  let lastBusinessMessageAt: string | null = null;
  let lastBusinessText: string | null = null;

  let lastAgentMs = -1;
  let lastAgentMessageAt: string | null = null;

  let lastBotMs = -1;
  let lastBotMessageAt: string | null = null;

  let customerMessageCount = 0;
  let businessMessageCount = 0;
  let agentMessageCount = 0;

  for (const msg of messages) {
    if (!isRealCommunicationMessage(msg)) continue;
    const sender = String(msg.sender_type || '').trim().toLowerCase();
    const ts = new Date(msg.created_at as string).getTime();
    const iso = new Date(ts).toISOString();
    const text =
      typeof msg.content_text === 'string' && msg.content_text.trim()
        ? msg.content_text.trim()
        : typeof msg.transcript_text === 'string'
          ? msg.transcript_text.trim()
          : '';

    if (sender === 'customer') {
      customerMessageCount += 1;
      if (ts > lastCustomerMs) {
        lastCustomerMs = ts;
        lastCustomerMessageAt = iso;
        if (text && !TECHNICAL_PLACEHOLDER_RE.test(text)) {
          lastCustomerText = text;
        }
      } else if (!lastCustomerText && text && !TECHNICAL_PLACEHOLDER_RE.test(text)) {
        lastCustomerText = text;
      }
      continue;
    }

    // Ignora convite automático de Instagram para fins de avaliação comercial de atendimento
    if (isAutomatedInstagramInviteMessage(msg)) {
      continue;
    }

    businessMessageCount += 1;
    if (ts > lastBusinessMs) {
      lastBusinessMs = ts;
      lastBusinessMessageAt = iso;
      if (text) lastBusinessText = text;
    } else if (!lastBusinessText && text) {
      lastBusinessText = text;
    }

    if (sender === 'agent') {
      agentMessageCount += 1;
      if (ts > lastAgentMs) {
        lastAgentMs = ts;
        lastAgentMessageAt = iso;
      }
    } else if (sender === 'bot') {
      if (ts > lastBotMs) {
        lastBotMs = ts;
        lastBotMessageAt = iso;
      }
    }
  }

  let lastInteractionAt: string | null = null;
  if (lastCustomerMs > 0 && lastBusinessMs > 0) {
    lastInteractionAt = new Date(Math.max(lastCustomerMs, lastBusinessMs)).toISOString();
  } else if (lastCustomerMs > 0) {
    lastInteractionAt = lastCustomerMessageAt;
  } else if (lastBusinessMs > 0) {
    lastInteractionAt = lastBusinessMessageAt;
  }

  return {
    lastCustomerMessageAt,
    lastBusinessMessageAt,
    lastAgentMessageAt,
    lastBotMessageAt,
    lastInteractionAt,
    customerMessageCount,
    businessMessageCount,
    agentMessageCount,
    lastCustomerText,
    lastBusinessText,
  };
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
 * Opções suportadas:
 * - 'today': Hoje (00:00:00.000 até 23:59:59.999 em America/Sao_Paulo)
 * - 'yesterday': Ontem (00:00:00.000 até 23:59:59.999 do dia-calendário anterior em America/Sao_Paulo — PADRÃO)
 * - 'day_before_yesterday': Anteontem (00:00:00.000 até 23:59:59.999 de 2 dias atrás em America/Sao_Paulo)
 * - '3d': Últimos 3 dias (desde 00:00:00.000 de 2 dias atrás até o fim de hoje em America/Sao_Paulo)
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

  if (filter === 'day_before_yesterday') {
    const dayBeforeKey = addCalendarDays(todayKey, -2);
    return {
      startMs: new Date(saoPauloDayStartIso(dayBeforeKey)).getTime(),
      endMs: new Date(saoPauloDayEndIso(dayBeforeKey)).getTime(),
      startDayKeySp: dayBeforeKey,
      endDayKeySp: dayBeforeKey,
    };
  }

  if (filter === '3d') {
    const startKey = addCalendarDays(todayKey, -2);
    return {
      startMs: new Date(saoPauloDayStartIso(startKey)).getTime(),
      endMs: new Date(saoPauloDayEndIso(todayKey)).getTime(),
      startDayKeySp: startKey,
      endDayKeySp: todayKey,
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
    const validFrom =
      customFrom && /^\d{4}-\d{2}-\d{2}$/.test(customFrom.trim()) ? customFrom.trim() : null;
    const validTo =
      customTo && /^\d{4}-\d{2}-\d{2}$/.test(customTo.trim()) ? customTo.trim() : null;
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
 * Avalia se a data de referência comercial (por padrão `lastCustomerMessageAt`) pertence ao
 * intervalo do filtro de data em America/Sao_Paulo.
 *
 * Quando `range` é aberto (`all`), retorna `true` mesmo para registros históricos sem data de mensagem.
 * Para filtros de período específico (`yesterday`, `today`, `7d`, etc.), exige timestamp válido dentro do intervalo.
 */
export function matchesFollowupDateFilter(
  referenceIsoDate: string | null | undefined,
  range: DateFilterRange
): boolean {
  if (range.startMs === null && range.endMs === null) return true;
  if (!referenceIsoDate) return false;
  const ts = new Date(referenceIsoDate).getTime();
  if (Number.isNaN(ts)) return false;
  if (range.startMs !== null && ts < range.startMs) return false;
  if (range.endMs !== null && ts > range.endMs) return false;
  return true;
}

function formatRemainingDurationPtBr(remainingMs: number): string {
  const totalMinutes = Math.max(1, Math.floor(remainingMs / (60 * 1000)));
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours >= 1) {
    return mins > 0 && hours < 6 ? `${hours}h ${mins}min restantes` : `${hours}h restantes`;
  }
  return `${totalMinutes}min restantes`;
}

/**
 * Formata o tempo decorrido desde o último contato de forma natural (Seção 8):
 * - Menos de 24 horas: em minutos ou horas ("Há 45 minutos", "Há 2 horas").
 * - 24 horas ou mais: em dias completos ("Há 1 dia", "Há 3 dias", "Há 12 dias").
 * NUNCA exibe valores em horas acumuladas acima de 23h como "há 86 horas".
 */
export function formatNaturalElapsedContactPtBr(
  input:
    | {
        hours?: number | null;
        lastContactAt?: string | null;
        neverContacted?: boolean;
        nowMs?: number;
      }
    | number
    | null
    | undefined
): string {
  if (input === null || input === undefined) {
    return 'Sem mensagem registrada';
  }

  if (typeof input === 'object') {
    if (input.neverContacted) {
      return 'Sem mensagem registrada';
    }
    if (input.lastContactAt) {
      const contactMs = new Date(input.lastContactAt).getTime();
      const nowMs = input.nowMs ?? Date.now();
      if (Number.isFinite(contactMs) && contactMs > 0) {
        const elapsedMs = Math.max(0, nowMs - contactMs);
        const totalMinutes = Math.max(1, Math.floor(elapsedMs / (60 * 1000)));
        const totalHours = Math.floor(totalMinutes / 60);
        if (totalHours < 1) {
          return totalMinutes === 1 ? 'Há 1 minuto' : `Há ${totalMinutes} minutos`;
        }
        if (totalHours < 24) {
          return totalHours === 1 ? 'Há 1 hora' : `Há ${totalHours} horas`;
        }
        const days = Math.max(1, Math.floor(totalHours / 24));
        return days === 1 ? 'Há 1 dia' : `Há ${days} dias`;
      }
    }
    return formatNaturalElapsedContactPtBr(input.hours);
  }

  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    return 'Sem mensagem registrada';
  }

  if (input === 0) {
    return 'Há menos de 1 hora';
  }

  if (input < 1) {
    const mins = Math.max(1, Math.round(input * 60));
    return mins === 1 ? 'Há 1 minuto' : `Há ${mins} minutos`;
  }

  if (input < 24) {
    const h = Math.max(1, Math.floor(input));
    return h === 1 ? 'Há 1 hora' : `Há ${h} horas`;
  }

  const days = Math.max(1, Math.floor(input / 24));
  return days === 1 ? 'Há 1 dia' : `Há ${days} dias`;
}

/**
 * Avalia o estado real da janela de atendimento de 24 horas do WhatsApp Cloud API
 * e do benefício gratuito CTWA de 72 horas (Free Entry Point), mantendo-os estritamente distintos:
 * - A janela de 24h (`lastCustomerMessageAt + 24h`) é a ÚNICA que autoriza envio de texto livre.
 * - O benefício CTWA de 72h (`ctwaFepExpiresAt`) garante gratuidade da conversa iniciada por anúncio,
 *   mas NÃO autoriza texto livre quando a janela de 24h já expirou (exige template aprovado).
 */
export function evaluateFollowupSessionWindow(args: {
  lastCustomerMessageAt?: string | null;
  isCtwaLead?: boolean;
  ctwaFepExpiresAt?: string | null;
  nowMs?: number;
}): FollowupSessionWindowInfo {
  const {
    lastCustomerMessageAt,
    isCtwaLead = false,
    ctwaFepExpiresAt = null,
    nowMs = Date.now(),
  } = args;

  let ctwaFreeBenefitActive = false;
  let ctwaFreeBenefitRemainingLabel: string | null = null;
  if (isCtwaLead && ctwaFepExpiresAt) {
    const fepMs = new Date(ctwaFepExpiresAt).getTime();
    if (Number.isFinite(fepMs) && fepMs > nowMs) {
      ctwaFreeBenefitActive = true;
      ctwaFreeBenefitRemainingLabel = `CTWA gratuito: ${formatRemainingDurationPtBr(fepMs - nowMs)}`;
    }
  }

  if (!lastCustomerMessageAt) {
    return {
      status: 'unknown',
      windowOpen: false,
      closingSoon: false,
      templateRequired: true,
      remainingMs: 0,
      remainingLabel: null,
      isCtwaLead,
      ctwaFreeBenefitActive,
      ctwaFreeBenefitExpiresAt: ctwaFepExpiresAt,
      ctwaFreeBenefitRemainingLabel,
    };
  }

  const lastCustomerMs = new Date(lastCustomerMessageAt).getTime();
  if (!Number.isFinite(lastCustomerMs) || lastCustomerMs <= 0) {
    return {
      status: 'unknown',
      windowOpen: false,
      closingSoon: false,
      templateRequired: true,
      remainingMs: 0,
      remainingLabel: null,
      isCtwaLead,
      ctwaFreeBenefitActive,
      ctwaFreeBenefitExpiresAt: ctwaFepExpiresAt,
      ctwaFreeBenefitRemainingLabel,
    };
  }

  const elapsedMs = Math.max(0, nowMs - lastCustomerMs);
  const windowOpen = elapsedMs < WHATSAPP_SESSION_WINDOW_MS;
  const remainingMs = windowOpen ? Math.max(0, WHATSAPP_SESSION_WINDOW_MS - elapsedMs) : 0;
  const closingSoon = windowOpen && remainingMs <= FOLLOWUP_WINDOW_CLOSING_SOON_MS;

  const status: FollowupWindowStatus = !windowOpen
    ? 'expired'
    : closingSoon
      ? 'closing_soon'
      : 'open';

  return {
    status,
    windowOpen,
    closingSoon,
    templateRequired: !windowOpen,
    remainingMs,
    remainingLabel: windowOpen ? formatRemainingDurationPtBr(remainingMs) : null,
    isCtwaLead,
    ctwaFreeBenefitActive,
    ctwaFreeBenefitExpiresAt: ctwaFepExpiresAt,
    ctwaFreeBenefitRemainingLabel,
  };
}

/**
 * Classifica o tipo comercial da oportunidade ('first_contact' vs 'resumption'), o estado do
 * atendimento e as datas separadas de cliente e empresa com base no histórico real de mensagens.
 *
 * Regra crítica (Seção 8):
 * - Um lead que escreveu para a empresa (`lastCustomerMessageAt` presente), mas NUNCA recebeu resposta
 *   da empresa (`businessMessageCount === 0` e sem `lastBusinessMessageAt`), possui histórico de mensagem
 *   recebida (`neverContacted = false`), mas sua abordagem comercial é classificada como
 *   `opportunityType = 'first_contact'` (primeiro atendimento), NUNCA como retomada de um relacionamento
 *   que ainda não começou.
 */
export function classifyFollowupTimingAndType(args: {
  lastCustomerMessageAt?: string | null;
  lastBusinessMessageAt?: string | null;
  lastAgentMessageAt?: string | null;
  customerMessageCount?: number | null;
  businessMessageCount?: number | null;
  lastMessageAt?: string | null;
  lastMessageText?: string | null;
  aiReplyCount?: number | null;
  payloadHoursSinceContact?: number | null;
  stageName?: string | null;
  hasActivePlan?: boolean;
  nowMs?: number;
}): {
  neverContacted: boolean;
  lastCustomerMessageAt: string | null;
  lastBusinessMessageAt: string | null;
  lastInteractionAt: string | null;
  lastCommunicationAt: string | null;
  hoursSinceLastCommunication: number | null;
  hoursSinceLastCustomerMessage: number | null;
  opportunityType: FollowupOpportunityType;
  contactState: FollowupContactState;
  awaitingBusinessReply: boolean;
} {
  const {
    lastCustomerMessageAt: rawCustomerAt,
    lastBusinessMessageAt: rawBusinessAt,
    lastAgentMessageAt: rawAgentAt,
    customerMessageCount,
    businessMessageCount,
    lastMessageAt,
    lastMessageText,
    aiReplyCount,
    payloadHoursSinceContact,
    stageName,
    hasActivePlan = false,
    nowMs = Date.now(),
  } = args;

  const parseValidMs = (iso?: string | null): number | null => {
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  };

  const customerMs = parseValidMs(rawCustomerAt);
  const businessMs = parseValidMs(rawBusinessAt);
  const agentMs = parseValidMs(rawAgentAt);
  const convLastMs = parseValidMs(lastMessageAt);

  const hasExplicitMessageCounts =
    typeof customerMessageCount === 'number' || typeof businessMessageCount === 'number';

  // Quando a tabela `messages` forneceu contagens/timestamps reais:
  if (hasExplicitMessageCounts || customerMs !== null || businessMs !== null) {
    const effCustomerCount = customerMessageCount ?? (customerMs !== null ? 1 : 0);
    const effBusinessCount =
      businessMessageCount ?? (businessMs !== null ? 1 : (aiReplyCount ?? 0) > 0 ? 1 : 0);

    const lastCustomerIso = customerMs !== null ? new Date(customerMs).toISOString() : null;
    const lastBusinessIso = businessMs !== null ? new Date(businessMs).toISOString() : null;
    const interactionMs =
      customerMs !== null && businessMs !== null
        ? Math.max(customerMs, businessMs)
        : (customerMs ?? businessMs ?? convLastMs);
    const lastInteractionIso =
      interactionMs !== null ? new Date(interactionMs).toISOString() : null;

    if (effCustomerCount === 0 && effBusinessCount === 0 && interactionMs === null) {
      return {
        neverContacted: true,
        lastCustomerMessageAt: null,
        lastBusinessMessageAt: null,
        lastInteractionAt: null,
        lastCommunicationAt: null,
        hoursSinceLastCommunication: null,
        hoursSinceLastCustomerMessage: null,
        opportunityType: 'first_contact',
        contactState: 'first_contact',
        awaitingBusinessReply: false,
      };
    }

    const hoursSinceCustomer =
      customerMs !== null ? Math.max(0, Math.round((nowMs - customerMs) / (1000 * 60 * 60))) : null;
    const hoursSinceInteraction =
      interactionMs !== null
        ? Math.max(0, Math.round((nowMs - interactionMs) / (1000 * 60 * 60)))
        : null;

    // Cliente enviou mensagem, mas a empresa NUNCA respondeu -> Primeiro atendimento!
    const businessNeverReplied = effBusinessCount === 0 && businessMs === null;
    const opportunityType: FollowupOpportunityType = businessNeverReplied
      ? 'first_contact'
      : 'resumption';

    const awaitingBusinessReply =
      customerMs !== null && (businessMs === null || customerMs > businessMs);

    const recentAgentContact =
      agentMs !== null &&
      (customerMs === null || agentMs >= customerMs) &&
      nowMs - agentMs <= 6 * 60 * 60 * 1000;

    let contactState: FollowupContactState = 'resumption';
    if (hasActivePlan) {
      contactState = 'planned_followup';
    } else if (businessNeverReplied) {
      contactState = 'first_contact';
    } else if (awaitingBusinessReply) {
      contactState = 'awaiting_business_reply';
    } else if (recentAgentContact) {
      contactState = 'recent_business_contact';
    }

    return {
      neverContacted: false,
      lastCustomerMessageAt: lastCustomerIso,
      lastBusinessMessageAt: lastBusinessIso,
      lastInteractionAt: lastInteractionIso,
      lastCommunicationAt: lastCustomerIso ?? lastInteractionIso,
      hoursSinceLastCommunication: hoursSinceCustomer ?? hoursSinceInteraction,
      hoursSinceLastCustomerMessage: hoursSinceCustomer,
      opportunityType,
      contactState,
      awaitingBusinessReply,
    };
  }

  // Fallback para fixtures/mocks legados onde apenas `conversations.last_message_at` foi fornecido
  if (convLastMs === null) {
    const hasLegacyPayloadHours =
      typeof payloadHoursSinceContact === 'number' &&
      Number.isFinite(payloadHoursSinceContact) &&
      payloadHoursSinceContact > 0 &&
      Boolean(lastMessageText?.trim());

    if (!hasLegacyPayloadHours) {
      return {
        neverContacted: true,
        lastCustomerMessageAt: null,
        lastBusinessMessageAt: null,
        lastInteractionAt: null,
        lastCommunicationAt: null,
        hoursSinceLastCommunication: null,
        hoursSinceLastCustomerMessage: null,
        opportunityType: 'first_contact',
        contactState: 'first_contact',
        awaitingBusinessReply: false,
      };
    }

    const isFirst =
      stageName?.trim().toLowerCase() === 'novo lead' && (aiReplyCount ?? 0) === 0;
    const hours = Math.max(0, Math.round(payloadHoursSinceContact!));
    return {
      neverContacted: false,
      lastCustomerMessageAt: null,
      lastBusinessMessageAt: null,
      lastInteractionAt: null,
      lastCommunicationAt: null,
      hoursSinceLastCommunication: hours,
      hoursSinceLastCustomerMessage: hours,
      opportunityType: isFirst ? 'first_contact' : 'resumption',
      contactState: isFirst ? 'first_contact' : 'resumption',
      awaitingBusinessReply: isFirst,
    };
  }

  const elapsedHours = Math.max(0, Math.round((nowMs - convLastMs) / (1000 * 60 * 60)));
  const isInitialStageWithoutBotReply =
    stageName?.trim().toLowerCase() === 'novo lead' && (aiReplyCount ?? 0) === 0;
  const iso = new Date(convLastMs).toISOString();

  return {
    neverContacted: false,
    lastCustomerMessageAt: iso,
    lastBusinessMessageAt: isInitialStageWithoutBotReply ? null : iso,
    lastInteractionAt: iso,
    lastCommunicationAt: iso,
    hoursSinceLastCommunication: elapsedHours,
    hoursSinceLastCustomerMessage: elapsedHours,
    opportunityType: isInitialStageWithoutBotReply ? 'first_contact' : 'resumption',
    contactState: isInitialStageWithoutBotReply ? 'first_contact' : 'resumption',
    awaitingBusinessReply: isInitialStageWithoutBotReply,
  };
}

const CONTRADICTORY_NEVER_CONTACTED_RE =
  /\b(nunca\s+contatad[oa]|sem\s+(?:nenhuma\s+)?tentativa\s+de\s+contato|sem\s+primeiro\s+contato|nunca\s+recebeu\s+(?:uma\s+)?primeira\s+abordagem)\b/i;

const GENERIC_BUREAUCRATIC_REASON_RE =
  /\b(em\s+op[çc][õo]es\s+do\s+portf[óo]lio|oportunidade\s+comercial\s+identificada\s+para\s+acompanhamento|o\s+cliente\s+demonstrou\s+interesse|o\s+cliente\s+entrou\s+em\s+contato|retomar\s+contato\s+oferecendo|ap[óo]s\s+receber\s+as\s+informa[çc][õo]es\s+enviadas\s+no\s+atendimento|lead\s+demonstrou\s+interesse\s+inicial|pr[óo]ximo\s+passo\s+pendente|necessidade\s+principal\s+identificada|aus[êe]ncia\s+de\s+registro\s+de\s+desinteresse)\b/i;

const DISCARDED_STAGE_NAMES_RE =
  /\b(perdid[oa]|descartad[oa]|ganh[oa]|fechad[oa]|vendid[oa]|loca[çc][aã]o|aluguel|sem\s+interesse|inativ[oa]|arquivad[oa]|cancelad[oa])\b/i;

const DISINTEREST_CUSTOMER_RE =
  /\b(j[aá]\s+comprei|j[aá]\s+fechei|n[aã]o\s+tenho\s+mais\s+interesse|pode\s+encerrar|desisti\s+da\s+compra|n[aã]o\s+quero\s+mais|pare\s+de\s+mandar|n[aã]o\s+precisa\s+mais|obrigad[oa],?\s+mas\s+n[aã]o\s+tenho\s+interesse|somente\s+aluguel|s[oó]\s+aluguel|apenas\s+aluguel|s[oó]\s+loca[çc][aã]o)\b/i;

const TEAM_PROMISE_RE =
  /\b(vou\s+(?:te\s+)?(?:enviar|mandar|separar|passar|encaminhar|buscar|levantar|ver|verificar)|j[aá]\s+(?:te\s+)?(?:envio|mando|passo)|te\s+(?:envio|mando|passo|retorno)\s+(?:algumas|umas|op[çc][õo]es|as\s+op[çc][õo]es|ainda\s+hoje|j[aá]|em\s+seguida|logo)|fiquei\s+de\s+(?:te\s+)?(?:enviar|mandar)|combinado,?\s+(?:te\s+)?(?:envio|mando))\b/i;

const PROMOTIONAL_HEADLINE_RE =
  /(r\$\s*\d|\b\d+\s*(mil|k|reais)\b|\bentrada\b|\bparcela|\ba\s+partir\s+de\b|\bcondi[çc][aã]o\b|\boportunidade\b|\brooftop\b|\brua\s+do\s+mar\b|\brentabilizar\b|\baluguel\b|\bloca[çc][aã]o\b|\bmensal\b|\b[úu]ltimas\s+unidades\b|\bdesconto\b|\bchama\s+no\s+whatsapp\b|\bsaiba\s+mais\b|\bconfira\b|\binvestir\b|\blucrar\b|\bflats?\s+em\s+constru|\bapartamentos?\s+em\s+constru|\bapenas\s+uma\s+rua\b|%)/i;

function normalizeForMatch(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function getClientFirstName(fullName?: string | null): string {
  const cleaned = String(fullName || '').trim();
  if (!cleaned) return '';
  const first = cleaned.split(/\s+/)[0] || '';
  if (!first || first.toLowerCase() === 'lead' || /^\+?\d+$/.test(first)) return '';
  return first;
}

/**
 * Identifica se um texto parece uma chamada publicitária / título promocional
 * (ex.: "Entrada apenas R$ 30 mil", "O maior rooftop de João Pessoa") e portanto
 * NUNCA pode ser exibido como nome de empreendimento.
 */
export function isPromotionalAdHeadline(text?: string | null): boolean {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean) return true;
  if (clean.length > 55) return true;
  if (PROMOTIONAL_HEADLINE_RE.test(clean)) return true;
  if (/[!?·|]/.test(clean) && clean.split(/\s+/).length >= 4) return true;
  return false;
}

/**
 * Extrai restrições explícitas de tipologia declaradas pelo cliente
 * (ex.: "não quer flat nem estúdio", "sem studio", "não quero casa").
 */
export function extractExplicitPropertyRestrictions(args: {
  summary?: Partial<LeadSummary> | Record<string, unknown> | null;
  messagesText?: string | null;
  lastCustomerText?: string | null;
}): { excludedTypes: string[]; labels: string[] } {
  const summaryNotes =
    args.summary && typeof (args.summary as Record<string, unknown>).notes === 'string'
      ? String((args.summary as Record<string, unknown>).notes)
      : '';
  const summaryReqs =
    args.summary &&
    typeof (args.summary as Record<string, unknown>).requirements === 'object' &&
    (args.summary as Record<string, unknown>).requirements !== null
      ? JSON.stringify((args.summary as Record<string, unknown>).requirements)
      : '';

  const combined = normalizeForMatch(
    [summaryNotes, summaryReqs, args.messagesText || '', args.lastCustomerText || '']
      .filter(Boolean)
      .join(' ')
  );

  if (!combined) return { excludedTypes: [], labels: [] };

  const negationWindowRe =
    /(?:nao\s+(?:quer\w*|gost\w*|aceit\w*|tem\s+interesse\s+em|desej\w*|pode\s+ser)|sem|dispensa|rejeita|exceto|evita|menos|nem)\s+[^.;!\n]{0,60}/g;

  const excludedSet = new Set<string>();
  const labelMap: Record<string, string> = {
    flat: 'flat',
    studio: 'estúdio',
    apartamento: 'apartamento',
    casa: 'casa',
    cobertura: 'cobertura',
    terreno: 'terreno',
    comercial: 'comercial',
    garden: 'garden',
  };

  const typePatterns: Array<{ key: string; re: RegExp }> = [
    { key: 'flat', re: /\bflats?\b/ },
    { key: 'studio', re: /\b(?:studios?|estudios?)\b/ },
    { key: 'apartamento', re: /\b(?:apartamentos?|aptos?)\b/ },
    { key: 'casa', re: /\bcasas?\b/ },
    { key: 'cobertura', re: /\bcoberturas?\b/ },
    { key: 'terreno', re: /\b(?:terrenos?|lotes?)\b/ },
    { key: 'comercial', re: /\b(?:salas?\s+comerciais?|comercial)\b/ },
    { key: 'garden', re: /\bgardens?\b/ },
  ];

  let m: RegExpExecArray | null;
  while ((m = negationWindowRe.exec(combined)) !== null) {
    const clause = m[0];
    for (const tp of typePatterns) {
      if (tp.re.test(clause)) {
        excludedSet.add(tp.key);
      }
    }
  }

  const excludedTypes = Array.from(excludedSet);
  const labels = excludedTypes.map((k) => labelMap[k] || k);
  return { excludedTypes, labels };
}

/**
 * Verifica se um imóvel viola alguma restrição explícita de tipologia declarada pelo cliente.
 */
export function propertyViolatesExplicitRestrictions(
  prop: { propertyType?: string | null; title?: string | null },
  excludedTypes: string[]
): boolean {
  if (!excludedTypes || excludedTypes.length === 0) return false;
  const normType = normalizeForMatch(String(prop.propertyType || ''));
  const normTitle = normalizeForMatch(String(prop.title || ''));

  for (const excluded of excludedTypes) {
    if (excluded === 'studio') {
      if (normType.includes('studio') || normType.includes('estudio') || /\b(studio|estudio)\b/.test(normTitle)) {
        return true;
      }
    } else if (excluded === 'flat') {
      if (normType.includes('flat') || /\bflat\b/.test(normTitle)) {
        return true;
      }
    } else if (normType.includes(excluded)) {
      return true;
    }
  }
  return false;
}

/**
 * Detecta se a equipe assumiu um compromisso de envio/retorno ainda não cumprido.
 * Só retorna true quando há evidência textual concreta na conversa (nunca inventa).
 */
export function detectPendingTeamCommitment(args: {
  lastBusinessText?: string | null;
  lastCustomerMessageAt?: string | null;
  lastBusinessMessageAt?: string | null;
  hasSharedPropertiesAfterLastBusiness?: boolean;
}): { hasPendingCommitment: boolean; commitmentText: string | null } {
  const businessText = typeof args.lastBusinessText === 'string' ? args.lastBusinessText.trim() : '';
  if (!businessText) return { hasPendingCommitment: false, commitmentText: null };

  // Se a última mensagem comercial já contém link de imóvel enviado, o envio já foi realizado
  if (/https?:\/\/\S+\/imovel\//i.test(businessText)) {
    return { hasPendingCommitment: false, commitmentText: null };
  }
  if (args.hasSharedPropertiesAfterLastBusiness) {
    return { hasPendingCommitment: false, commitmentText: null };
  }

  if (TEAM_PROMISE_RE.test(businessText)) {
    return {
      hasPendingCommitment: true,
      commitmentText: businessText,
    };
  }

  return { hasPendingCommitment: false, commitmentText: null };
}

export interface FollowupEligibilityResult {
  eligible: boolean;
  reasons: string[];
  operation: LeadCommercialOperation;
}

/**
 * Regra central de elegibilidade comercial do Follow-up (Seções 1, 2 e 8):
 * - Exclusivamente VENDA (bloqueia locação, temporada e operação indefinida).
 * - Bloqueia contatos comprados, arquivados, pausados, em etapas descartadas ou com desinteresse explícito.
 * - Bloqueia atendimento humano recente concorrente (exceto se houver compromisso pendente não cumprido).
 * - Bloqueia se houver plano de follow-up agendado ativo ou adiamento vigente.
 * - Exige pelo menos 1 imóvel compatível de venda disponível com link válido para fila executável.
 */
export function evaluateFollowupCommercialEligibility(args: {
  profile: Pick<
    LeadSearchProfile,
    'operation' | 'isShortStayOnly' | 'isArchived' | 'isPaused' | 'isSellerOrOutOfArea'
  > | null;
  hasPurchased?: boolean;
  stageName?: string | null;
  lastCustomerText?: string | null;
  lastCustomerMessageAt?: string | null;
  lastAgentMessageAt?: string | null;
  hasPendingCommitment?: boolean;
  hasActiveFollowupPlan?: boolean;
  isSnoozedFuture?: boolean;
  compatibleSalePropertiesCount: number;
  profileMaturity?: number;
  aiScore?: number;
  interestProperty?: string | null;
  awaitingBusinessReply?: boolean;
  teamCooldownHours?: number;
  liveChatQuietHours?: number;
  nowMs?: number;
  /** Quando true (ex.: abas históricas done/ignored/approved), não exige imóvel ativo nem bloqueia por cooldown */
  isHistoricalView?: boolean;
}): FollowupEligibilityResult {
  const {
    profile,
    hasPurchased = false,
    stageName,
    lastCustomerText,
    lastCustomerMessageAt,
    lastAgentMessageAt,
    hasPendingCommitment = false,
    hasActiveFollowupPlan = false,
    isSnoozedFuture = false,
    compatibleSalePropertiesCount,
    profileMaturity = 0,
    aiScore = 0,
    interestProperty = null,
    awaitingBusinessReply = false,
    teamCooldownHours = 48,
    liveChatQuietHours = 2,
    nowMs = Date.now(),
    isHistoricalView = false,
  } = args;

  const reasons: string[] = [];
  const operation: LeadCommercialOperation = profile?.operation ?? 'indefinido';

  // 1. Regra de ouro: exclusivamente vendas (vale tanto para fila ativa quanto para bloqueio de locação)
  if (profile?.isShortStayOnly || operation === 'locacao') {
    reasons.push('rental_only');
  } else if (operation !== 'venda') {
    reasons.push('operation_unknown');
  }
  if (profile?.isSellerOrOutOfArea) {
    reasons.push('seller_or_out_of_area');
  }

  if (isHistoricalView) {
    return {
      eligible: reasons.length === 0,
      reasons,
      operation,
    };
  }

  // 2. Estado do contato / pipeline / impedimentos
  if (hasPurchased) reasons.push('already_purchased');
  if (profile?.isArchived) reasons.push('contact_archived');
  if (profile?.isPaused) reasons.push('contact_paused');
  if (isSnoozedFuture) reasons.push('snoozed');
  if (hasActiveFollowupPlan) reasons.push('scheduled_followup_plan');

  if (stageName && DISCARDED_STAGE_NAMES_RE.test(stageName)) {
    reasons.push('discarded_or_closed_stage');
  }

  if (lastCustomerText && DISINTEREST_CUSTOMER_RE.test(lastCustomerText)) {
    reasons.push('customer_disinterest');
  }

  // 3. Atendimento ao vivo ou acompanhamento humano recente concorrente
  const custMs = lastCustomerMessageAt ? new Date(lastCustomerMessageAt).getTime() : NaN;
  const agentMs = lastAgentMessageAt ? new Date(lastAgentMessageAt).getTime() : NaN;

  if (Number.isFinite(custMs) && nowMs - custMs < liveChatQuietHours * 60 * 60 * 1000 && !hasPendingCommitment) {
    reasons.push('live_conversation_in_progress');
  }

  if (
    Number.isFinite(agentMs) &&
    (!Number.isFinite(custMs) || agentMs >= custMs) &&
    nowMs - agentMs < teamCooldownHours * 60 * 60 * 1000 &&
    !hasPendingCommitment
  ) {
    reasons.push('active_human_attendance');
  }

  // 4. Exigência de imóveis reais compatíveis de venda com link válido (Seção 8)
  if (compatibleSalePropertiesCount <= 0) {
    reasons.push('no_compatible_sale_properties');
  }

  // 5. Necessidade comercial concreta (não sugerir apenas por existir na base)
  const hasConcreteSignal =
    hasPendingCommitment ||
    awaitingBusinessReply ||
    profileMaturity >= 35 ||
    aiScore >= 4 ||
    Boolean(interestProperty);
  if (!hasConcreteSignal) {
    reasons.push('no_concrete_opportunity');
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    operation,
  };
}

function formatBudgetShortPtBr(priceMin?: number | null, priceMax?: number | null): string | null {
  const fmt = (v: number): string => {
    if (v >= 1_000_000) {
      const m = v / 1_000_000;
      return `R$ ${Number.isInteger(m) ? m : m.toFixed(1).replace('.', ',')} mi`;
    }
    if (v >= 1_000) {
      return `R$ ${Math.round(v / 1_000)} mil`;
    }
    return `R$ ${v}`;
  };
  if (priceMin && priceMax && priceMax > priceMin) {
    return `entre ${fmt(priceMin)} e ${fmt(priceMax)}`;
  }
  if (priceMax && priceMax > 0) {
    return `até ${fmt(priceMax)}`;
  }
  if (priceMin && priceMin > 0) {
    return `a partir de ${fmt(priceMin)}`;
  }
  return null;
}

function formatCountWordsPtBr(n: number): string {
  if (n === 1) return 'uma opção compatível';
  if (n === 2) return 'duas opções compatíveis';
  if (n === 3) return 'três opções compatíveis';
  return `${n} opções compatíveis`;
}

/**
 * Constrói o motivo comercial personalizado, natural e informal (Seção 7),
 * como um assistente comercial explicando ao corretor por que vale a pena retomar
 * aquela conversa — fiel estritamente aos fatos conhecidos, sem inventar dados.
 */
export function buildPersonalizedCommercialReason(args: {
  contactName?: string | null;
  stageName?: string | null;
  interestProperty?: string | null;
  profile?: Partial<LeadSearchProfile> | null;
  excludedTypeLabels?: string[];
  hasPendingCommitment?: boolean;
  opportunityType?: FollowupOpportunityType;
  contactState?: FollowupContactState;
  lastCustomerText?: string | null;
  compatiblePropertiesCount?: number;
  isCtwaOrigin?: boolean;
}): string {
  const firstName = getClientFirstName(args.contactName) || 'O cliente';
  const profile = args.profile ?? null;
  const sentences: string[] = [];

  // 1. O que o cliente procura / como chegou
  const types = (profile?.propertyTypes ?? []).filter(Boolean);
  const bedrooms = (profile?.bedrooms ?? []).filter((b) => Number.isFinite(b) && b > 0);
  const locations = (profile?.locations ?? []).filter(Boolean);
  const purposes = (profile?.purpose ?? []).filter(Boolean).map((p) => p.toLowerCase());
  const budgetText = formatBudgetShortPtBr(profile?.priceMin, profile?.priceMax);
  const excludedLabels = (args.excludedTypeLabels ?? []).filter(Boolean);
  const prefersLargerPlans = Boolean(profile?.prefersLargerPlans);
  const areaMin = typeof profile?.areaMin === 'number' && profile.areaMin > 0 ? Math.round(profile.areaMin) : null;
  const areaMax = typeof profile?.areaMax === 'number' && profile.areaMax > 0 ? Math.round(profile.areaMax) : null;

  let areaClause = '';
  if (prefersLargerPlans) {
    if (areaMin && areaMax && areaMax > areaMin) {
      areaClause = `plantas maiores (${areaMin} a ${areaMax} m²)`;
    } else if (areaMin) {
      areaClause = `plantas maiores (a partir de ${areaMin} m²)`;
    } else {
      areaClause = 'plantas maiores';
    }
  } else if (areaMin) {
    areaClause = `a partir de ${areaMin} m²`;
  }

  let purposeClause = '';
  if (purposes.includes('moradia') && purposes.includes('investimento')) {
    purposeClause = 'para moradia e investimento';
  } else if (purposes.includes('moradia')) {
    purposeClause = 'para moradia';
  } else if (purposes.includes('investimento')) {
    purposeClause = 'para investimento';
  }

  const searchParts: string[] = [];
  if (types.length > 0) {
    const firstType = types[0].toLowerCase();
    searchParts.push(firstType === 'apartamento' ? 'um apartamento' : firstType);
  }
  if (bedrooms.length > 0) {
    const bedStr =
      bedrooms.length === 1
        ? `${bedrooms[0]} ${bedrooms[0] === 1 ? 'quarto' : 'quartos'}`
        : `${bedrooms.slice(0, 2).join(' ou ')} quartos`;
    searchParts.push(searchParts.length > 0 ? `de ${bedStr}` : `imóvel de ${bedStr}`);
  }
  if (areaClause) {
    if (prefersLargerPlans) {
      searchParts.push(searchParts.length > 0 ? `com ${areaClause}` : areaClause);
    } else {
      searchParts.push(`(${areaClause})`);
    }
  }
  if (locations.length > 0) {
    const loc = locations.slice(0, 2).join(' ou ');
    searchParts.push(`em ${loc}`);
  }
  if (purposeClause) {
    searchParts.push(purposeClause);
  }

  const searchPhrase = searchParts.join(' ');
  const restrictionClause =
    excludedLabels.length > 0
      ? ` e não quer ${excludedLabels.join(' nem ')}`
      : '';

  if (args.interestProperty && args.isCtwaOrigin) {
    const custLower = (args.lastCustomerText || '').toLowerCase();
    const detailClause = /\b(valor|pre[çc]o|tabela|entrada|parcela|quanto)\b/.test(custLower)
      ? ' e perguntou sobre valores e condições'
      : /\b(visita|conhecer|agendar)\b/.test(custLower)
        ? ' e demonstrou interesse em conhecer o imóvel'
        : ' e pediu mais detalhes sobre o empreendimento';

    if (prefersLargerPlans) {
      const locSuffix = locations.length > 0 ? ` em ${locations.slice(0, 2).join(' ou ')}` : '';
      const purpSuffix = purposeClause ? ` ${purposeClause}` : '';
      sentences.push(
        `${firstName} chegou pelo anúncio do ${args.interestProperty}${purpSuffix}${detailClause}. Na conversa, surgiu o interesse em avaliar ${areaClause}${locSuffix}${restrictionClause}.`
      );
    } else {
      sentences.push(`${firstName} chegou pelo anúncio do ${args.interestProperty}${detailClause}.`);
      if (searchPhrase) {
        sentences.push(
          `Busca ${searchPhrase}${budgetText ? `, ${budgetText}` : ''}${restrictionClause}.`
        );
      }
    }
  } else if (searchPhrase) {
    const stageLower = (args.stageName || '').trim().toLowerCase();
    const stagePrefix =
      stageLower === 'qualificação' || stageLower === 'qualificacao'
        ? `${firstName} está em qualificação e busca `
        : `${firstName} procura `;
    sentences.push(
      `${stagePrefix}${searchPhrase}${budgetText ? `, ${budgetText}` : ''}${restrictionClause}.`
    );
  } else if (args.interestProperty) {
    sentences.push(
      `${firstName} demonstrou interesse no ${args.interestProperty}${budgetText ? ` (${budgetText})` : ''}${restrictionClause}.`
    );
  } else {
    sentences.push(`${firstName} demonstrou interesse em compra de imóvel${budgetText ? `, ${budgetText}` : ''}.`);
  }

  // 2. Orçamento desconhecido (informar naturalmente sem inventar)
  if (!budgetText && !args.hasPendingCommitment && !prefersLargerPlans) {
    sentences.push('Ainda não informou o orçamento.');
  }

  // 3. Compromisso pendente real ou estado da conversa + opções selecionadas integrando a abordagem
  const propCount = Math.min(FOLLOWUP_MAX_RECOMMENDED_PROPERTIES, args.compatiblePropertiesCount ?? 0);

  if (args.hasPendingCommitment) {
    sentences.push('Você ficou de enviar opções e ainda não encontramos registro desse envio.');
    if (propCount > 0) {
      sentences.push(`Selecionei ${formatCountWordsPtBr(propCount)} para cumprir esse retorno.`);
    }
  } else if (args.opportunityType === 'first_contact') {
    if (propCount > 0) {
      sentences.push(`Ainda aguarda o primeiro retorno comercial — selecionei ${formatCountWordsPtBr(propCount)} para iniciar o atendimento.`);
    } else {
      sentences.push('Ainda aguarda o primeiro retorno comercial.');
    }
  } else if (args.contactState === 'awaiting_business_reply') {
    if (propCount > 0) {
      sentences.push(`Enviou a última mensagem e aguarda retorno — selecionei ${formatCountWordsPtBr(propCount)} para responder.`);
    } else {
      sentences.push('Enviou a última mensagem e está aguardando resposta.');
    }
  } else if (propCount > 0) {
    if (prefersLargerPlans) {
      sentences.push(`Selecionei ${formatCountWordsPtBr(propCount)} com o espaço que ele procura para retomar o contato.`);
    } else {
      sentences.push(`Selecionei ${formatCountWordsPtBr(propCount)} alinhadas a esse perfil para retomar o contato.`);
    }
  }

  return sentences.join(' ');
}

/**
 * Constrói uma recomendação comercial objetiva e contextual a partir dos fatos
 * reais da conversa (mantida por compatibilidade e delegada ao estilo natural).
 */
export function buildObjectiveFollowupRecommendation(args: {
  opportunityType: FollowupOpportunityType;
  contactState?: FollowupContactState;
  interestProperty?: string | null;
  primaryNeed?: string | null;
  lastCustomerText?: string | null;
  lastBusinessText?: string | null;
  stageName?: string | null;
  contactName?: string | null;
  compatiblePropertiesCount?: number;
  hasPendingCommitment?: boolean;
}): { reason: string; approachSummary: string } {
  const {
    opportunityType,
    contactState,
    interestProperty,
    primaryNeed,
    lastCustomerText,
    contactName,
    compatiblePropertiesCount = 0,
    hasPendingCommitment = false,
  } = args;

  const firstName = getClientFirstName(contactName) || 'O cliente';
  const subjectParts: string[] = [];
  if (interestProperty) {
    subjectParts.push(`no ${interestProperty}`);
  }
  if (primaryNeed) {
    subjectParts.push(interestProperty ? `(${primaryNeed})` : `em ${primaryNeed}`);
  }
  const subjectText = subjectParts.length > 0 ? subjectParts.join(' ') : 'em imóveis para compra';

  const custLower = (lastCustomerText || '').toLowerCase();
  let customerIntentClause = '';
  if (/\b(valor|preço|preco|tabela|parcela|entrada|condiç|condic|quanto)\b/.test(custLower)) {
    customerIntentClause = ' e perguntou sobre valores e condições';
  } else if (/\b(planta|fotos|vídeo|video|detalhes|informaç|informac|saber mais|gostaria de receber)\b/.test(custLower)) {
    customerIntentClause = ' e pediu mais detalhes';
  } else if (/\b(visita|conhecer|agendar|ir ver|caminho)\b/.test(custLower)) {
    customerIntentClause = ' e falou sobre agendar visita';
  } else if (/\b(dispon[ií]vel|unidade|andar|posi[çc][aã]o)\b/.test(custLower)) {
    customerIntentClause = ' e consultou disponibilidade de unidades';
  }

  const optionsSuffix =
    compatiblePropertiesCount > 0
      ? ` Selecionei ${formatCountWordsPtBr(Math.min(3, compatiblePropertiesCount))} para apresentar.`
      : '';

  if (hasPendingCommitment) {
    return {
      reason: `${firstName} demonstrou interesse ${subjectText}${customerIntentClause}. Você ficou de enviar opções e ainda não encontramos registro desse envio.${optionsSuffix}`,
      approachSummary: `Enviar as opções compatíveis para ${firstName}.`,
    };
  }

  if (opportunityType === 'first_contact') {
    return {
      reason: `${firstName} entrou em contato com interesse ${subjectText}${customerIntentClause} e ainda aguarda o primeiro atendimento.${optionsSuffix}`,
      approachSummary: `Fazer o primeiro atendimento respondendo sobre ${interestProperty || primaryNeed || 'a busca de compra'}.`,
    };
  }

  if (contactState === 'awaiting_business_reply') {
    return {
      reason: `${firstName} mandou a última mensagem com interesse ${subjectText}${customerIntentClause} e está aguardando retorno.${optionsSuffix}`,
      approachSummary: `Responder à última mensagem de ${firstName} com opções compatíveis.`,
    };
  }

  return {
    reason: `${firstName} demonstrou interesse ${subjectText}${customerIntentClause} e vale retomar a conversa para avançar na busca.${optionsSuffix}`,
    approachSummary: `Retomar a conversa com ${firstName} apresentando opções alinhadas à busca.`,
  };
}

/**
 * Reconcilia o texto da recomendação com a classificação real do histórico de mensagens,
 * eliminando contradições e substituindo textos genéricos/burocráticos por comentários
 * personalizados e naturais (Seção 7).
 */
export function reconcileFollowupReasonAndApproach(args: {
  rawReason?: string | null;
  rawApproachSummary?: string | null;
  opportunityType: FollowupOpportunityType;
  contactState?: FollowupContactState;
  neverContacted: boolean;
  interestProperty?: string | null;
  primaryNeed?: string | null;
  lastCustomerText?: string | null;
  lastBusinessText?: string | null;
  stageName?: string | null;
  contactName?: string | null;
  profile?: Partial<LeadSearchProfile> | null;
  excludedTypeLabels?: string[];
  hasPendingCommitment?: boolean;
  compatiblePropertiesCount?: number;
  isCtwaOrigin?: boolean;
}): { reason: string; approachSummary: string | null } {
  const {
    rawReason,
    rawApproachSummary,
    opportunityType,
    contactState,
    neverContacted,
    interestProperty,
    primaryNeed,
    lastCustomerText,
    lastBusinessText,
    stageName,
    contactName,
    profile,
    excludedTypeLabels,
    hasPendingCommitment = false,
    compatiblePropertiesCount = 0,
    isCtwaOrigin = false,
  } = args;

  const cleanReason = typeof rawReason === 'string' ? rawReason.trim() : '';
  const cleanApproach =
    typeof rawApproachSummary === 'string' && rawApproachSummary.trim()
      ? rawApproachSummary.trim()
      : null;

  const hasContradictoryNeverContactedText =
    !neverContacted &&
    opportunityType === 'resumption' &&
    CONTRADICTORY_NEVER_CONTACTED_RE.test(cleanReason);

  const hasContradictoryResumptionOnFirstContact =
    opportunityType === 'first_contact' &&
    !neverContacted &&
    /\bretomar\s+relacionamento|\bretomada\b/i.test(cleanReason);

  const hasGenericReason = !cleanReason || GENERIC_BUREAUCRATIC_REASON_RE.test(cleanReason);

  // Quando temos perfil estruturado ou texto genérico/contraditório, construímos o comentário
  // personalizado natural da Seção 7 com os fatos verificados do lead.
  if (
    profile ||
    hasGenericReason ||
    hasContradictoryNeverContactedText ||
    hasContradictoryResumptionOnFirstContact
  ) {
    if (profile) {
      const personalized = buildPersonalizedCommercialReason({
        contactName,
        stageName,
        interestProperty,
        profile,
        excludedTypeLabels,
        hasPendingCommitment,
        opportunityType,
        contactState,
        lastCustomerText,
        compatiblePropertiesCount,
        isCtwaOrigin,
      });
      return {
        reason: personalized,
        approachSummary: cleanApproach,
      };
    }

    const synthesized = buildObjectiveFollowupRecommendation({
      opportunityType,
      contactState,
      interestProperty,
      primaryNeed,
      lastCustomerText,
      lastBusinessText,
      stageName,
      contactName,
      compatiblePropertiesCount,
      hasPendingCommitment,
    });
    return {
      reason: synthesized.reason,
      approachSummary:
        !hasContradictoryNeverContactedText &&
        !hasContradictoryResumptionOnFirstContact &&
        cleanApproach
          ? cleanApproach
          : synthesized.approachSummary,
    };
  }

  return {
    reason: cleanReason,
    approachSummary: cleanApproach,
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
    parts.push(
      `${bedrooms.join(' ou ')} ${bedrooms.length === 1 && bedrooms[0] === 1 ? 'quarto' : 'quartos'}`
    );
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
 * Identifica o empreendimento de origem/interesse do lead (Seção 6):
 * 1. Vínculo estruturado entre anúncio de origem (`ctwa_referral.source_id`) e cadastro de empreendimentos (`property_ad_mappings` -> `properties.name`).
 * 2. Tag estruturada 'Empreendimento' (desde que não seja chamada publicitária).
 * 3. Correspondência verificada com nomes reais de empreendimentos cadastrados.
 *
 * NUNCA utiliza chamadas publicitárias, valores de entrada, condições comerciais ou títulos promocionais
 * (ex.: "Entrada apenas R$ 30 mil"). Quando não identificado com segurança, retorna `null`.
 */
export function extractInterestProperty(args: {
  mappedAdPropertyName?: string | null;
  tagByCategory?: Record<string, string[]>;
  ctwaHeadline?: string | null;
  reasonText?: string | null;
  knownPropertyNames?: string[];
}): string | null {
  const {
    mappedAdPropertyName,
    tagByCategory = {},
    ctwaHeadline,
    reasonText,
    knownPropertyNames = [],
  } = args;

  // 1. Vínculo estruturado oficial do anúncio -> empreendimento
  if (typeof mappedAdPropertyName === 'string' && mappedAdPropertyName.trim()) {
    const cleanMapped = mappedAdPropertyName.trim();
    if (!isPromotionalAdHeadline(cleanMapped)) {
      return cleanMapped;
    }
  }

  // 2. Tag 'Empreendimento' válida (não promocional)
  const empTags = tagByCategory['Empreendimento'] || [];
  for (const rawTag of empTags) {
    const cleanTag = typeof rawTag === 'string' ? rawTag.trim() : '';
    if (cleanTag && !isPromotionalAdHeadline(cleanTag)) {
      return cleanTag;
    }
  }

  // 3. Correspondência com empreendimento oficialmente cadastrado no estoque/catálogo
  if (knownPropertyNames.length > 0) {
    const haystacks = [ctwaHeadline || '', reasonText || '']
      .map((s) => s.trim())
      .filter(Boolean);
    const sortedKnown = [...knownPropertyNames]
      .map((n) => n.trim())
      .filter((n) => n.length >= 3 && !isPromotionalAdHeadline(n))
      .sort((a, b) => b.length - a.length);

    for (const hay of haystacks) {
      const hayNorm = normalizeForMatch(hay);
      for (const propName of sortedKnown) {
        const propNorm = normalizeForMatch(propName);
        if (propNorm.length >= 3 && hayNorm.includes(propNorm)) {
          return propName;
        }
      }
    }
  }

  // Nunca usar ctwaHeadline bruto ou texto promocional como nome de empreendimento
  return null;
}

/**
 * Calcula a faixa de recência estrutural (Seção 4) a partir da última mensagem recebida do cliente:
 * 0: <= 24h (hoje / janela aberta)
 * 1: 24h a 72h (ontem / anteontem)
 * 2: 3 a 7 dias
 * 3: 8 a 14 dias
 * 4: 15 a 30 dias
 * 5: > 30 dias ou desconhecido
 */
export function getFollowupRecencyTier(
  lastCustomerMessageAt?: string | null,
  nowMs: number = Date.now()
): number {
  if (!lastCustomerMessageAt) return 5;
  const ts = new Date(lastCustomerMessageAt).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return 5;
  const elapsedHours = Math.max(0, (nowMs - ts) / (1000 * 60 * 60));
  if (elapsedHours <= 24) return 0;
  if (elapsedHours <= 72) return 1;
  if (elapsedHours <= 7 * 24) return 2;
  if (elapsedHours <= 14 * 24) return 3;
  if (elapsedHours <= 30 * 24) return 4;
  return 5;
}

/**
 * Calcula a prioridade comercial determinística (0–100) combinando os mecanismos existentes (Seção 4):
 * - Maturidade do perfil (`profileMaturity`, 0–100): até 24 pts
 * - Score IA (`contacts.ai_score`, 0–10): até 24 pts
 * - Compatibilidade com imóveis disponíveis (`bestMatchScore`, 0–100): até 16 pts
 * - Intensidade do interesse / etapa comercial + empreendimento: até 16 pts
 * - Compromissos pendentes / cliente aguardando resposta: até 12 pts
 * - Urgência da janela de 24h (`closing_soon` +8, `open` +4): até 8 pts
 */
export function calculateFollowupCommercialPriority(args: {
  confidenceScore: number | null;
  aiScore: number;
  profileMaturity: number;
  hasInterestProperty: boolean;
  hasPrimaryNeed: boolean;
  stageName?: string | null;
  awaitingBusinessReply?: boolean;
  windowStatus?: FollowupWindowStatus;
  bestMatchScore?: number | null;
  hasPendingCommitment?: boolean;
}): { score: number; tier: FollowupPriorityTier } {
  const {
    confidenceScore,
    aiScore,
    profileMaturity,
    hasInterestProperty,
    hasPrimaryNeed,
    stageName,
    awaitingBusinessReply = false,
    windowStatus,
    bestMatchScore = null,
    hasPendingCommitment = false,
  } = args;

  const matComp = Math.min(100, Math.max(0, profileMaturity)) * 0.24; // 0 a 24
  const aiComp = Math.min(10, Math.max(0, aiScore)) * 2.4; // 0 a 24

  // Compatibilidade com imóveis reais de venda (quando disponível) ou confiança complementar
  const matchComp =
    typeof bestMatchScore === 'number' && Number.isFinite(bestMatchScore) && bestMatchScore > 0
      ? Math.min(100, Math.max(0, bestMatchScore)) * 0.16 // 0 a 16
      : Math.min(100, Math.max(0, confidenceScore ?? 55)) * 0.1;

  let interestComp = 0;
  if (hasInterestProperty) interestComp += 4;
  if (hasPrimaryNeed) interestComp += 4;

  const normStage = (stageName || '').trim().toLowerCase();
  if (
    normStage === 'visita' ||
    normStage === 'proposta' ||
    normStage === 'negociação' ||
    normStage === 'negociacao'
  ) {
    interestComp += 12;
  } else if (normStage === 'interesse') {
    interestComp += 9;
  } else if (normStage === 'qualificação' || normStage === 'qualificacao') {
    interestComp += 5;
  }

  let commitmentComp = 0;
  if (hasPendingCommitment) commitmentComp += 8;
  if (awaitingBusinessReply) commitmentComp += 6;

  let windowComp = 0;
  if (windowStatus === 'closing_soon') {
    windowComp = 8;
  } else if (windowStatus === 'open') {
    windowComp = 4;
  }

  const raw =
    matComp +
    aiComp +
    matchComp +
    Math.min(16, interestComp) +
    Math.min(12, commitmentComp) +
    windowComp;
  const score = Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;

  let tier: FollowupPriorityTier = 'normal';
  if (
    score >= 65 ||
    hasPendingCommitment ||
    (aiScore >= 7 && profileMaturity >= 60)
  ) {
    tier = 'high';
  } else if (score >= 42 || aiScore >= 5 || profileMaturity >= 60) {
    tier = 'medium';
  }

  return { score, tier };
}

/**
 * Retorna a chave de dia YYYY-MM-DD em America/Sao_Paulo correspondente à última mensagem do cliente
 * (com fallback seguro para `suggestionDayKeySp` apenas em fixtures sintéticas sem data de mensagem).
 */
export function resolveItemCustomerDayKeySp(item: EnrichedFollowupItem): string {
  if (item.customerDayKeySp) return item.customerDayKeySp;
  const refIso =
    item.lastCustomerMessageAt !== undefined
      ? item.lastCustomerMessageAt
      : item.lastCommunicationAt;
  if (refIso) {
    const ms = new Date(refIso).getTime();
    if (Number.isFinite(ms) && ms > 0) {
      return saoPauloDayKey(new Date(ms));
    }
  }
  return item.suggestionDayKeySp;
}

/**
 * Comparador secundário de prioridade comercial entre duas sugestões de Follow-up.
 * Determinístico e estável: prioriza score comercial -> maturidade -> score IA -> urgência de janela -> confiança.
 */
export function compareByCommercialPriority(
  a: EnrichedFollowupItem,
  b: EnrichedFollowupItem
): number {
  if (b.commercialPriorityScore !== a.commercialPriorityScore) {
    return b.commercialPriorityScore - a.commercialPriorityScore;
  }
  if (b.profileMaturity !== a.profileMaturity) return b.profileMaturity - a.profileMaturity;
  if (b.aiScore !== a.aiScore) return b.aiScore - a.aiScore;

  // Desempate por urgência da janela de 24h aberta (quem fecha antes vem primeiro)
  const winOpenA = a.sessionWindow?.windowOpen ?? false;
  const winOpenB = b.sessionWindow?.windowOpen ?? false;
  if (winOpenA !== winOpenB) return winOpenA ? -1 : 1;
  if (winOpenA && winOpenB) {
    const remA = a.sessionWindow?.remainingMs ?? Number.MAX_SAFE_INTEGER;
    const remB = b.sessionWindow?.remainingMs ?? Number.MAX_SAFE_INTEGER;
    if (remA !== remB) return remA - remB;
  }

  const confA = a.confidenceScore ?? 0;
  const confB = b.confidenceScore ?? 0;
  if (confB !== confA) return confB - confA;

  const custA = a.lastCustomerMessageAt ? new Date(a.lastCustomerMessageAt).getTime() || 0 : 0;
  const custB = b.lastCustomerMessageAt ? new Date(b.lastCustomerMessageAt).getTime() || 0 : 0;
  if (custB !== custA) return custB - custA;

  const createdA = new Date(a.suggestionCreatedAt).getTime() || 0;
  const createdB = new Date(b.suggestionCreatedAt).getTime() || 0;
  if (createdB !== createdA) return createdB - createdA;

  return a.suggestion.id.localeCompare(b.suggestion.id);
}

/**
 * Ordenação oficial do módulo Follow-up (Seção 3):
 * - 'recent_priority' (padrão):
 *     1ª dimensão: dia da última mensagem do cliente em America/Sao_Paulo (customerDayKeySp DESC)
 *     2ª dimensão: prioridade comercial dentro do período (compareByCommercialPriority)
 * - 'window_closing_soon':
 *     Janelas de 24h abertas mais próximas do encerramento primeiro -> depois maior prioridade comercial
 * - 'priority_desc': Maior prioridade comercial geral -> recência -> id
 * - 'maturity_desc': Maior maturidade do perfil -> prioridade comercial -> id
 * - 'ai_score_desc': Maior score da IA -> prioridade comercial -> id
 * - 'longest_without_contact': Mais tempo sem contato
 */
export function compareFollowupItems(
  a: EnrichedFollowupItem,
  b: EnrichedFollowupItem,
  sortBy: FollowupSortBy = 'recent_priority'
): number {
  if (sortBy === 'recent_priority') {
    const tierA =
      typeof a.recencyTier === 'number'
        ? a.recencyTier
        : null;
    const tierB =
      typeof b.recencyTier === 'number'
        ? b.recencyTier
        : null;
    if (tierA !== null && tierB !== null && tierA !== tierB) {
      return tierA - tierB;
    }
    const dayA = resolveItemCustomerDayKeySp(a);
    const dayB = resolveItemCustomerDayKeySp(b);
    if (tierA === null && tierB === null && dayB !== dayA) {
      return dayB.localeCompare(dayA);
    }
    return compareByCommercialPriority(a, b);
  }

  if (sortBy === 'window_closing_soon') {
    const openA = a.sessionWindow?.windowOpen ?? false;
    const openB = b.sessionWindow?.windowOpen ?? false;
    if (openA !== openB) return openA ? -1 : 1;
    if (openA && openB) {
      const remA = a.sessionWindow?.remainingMs ?? Number.MAX_SAFE_INTEGER;
      const remB = b.sessionWindow?.remainingMs ?? Number.MAX_SAFE_INTEGER;
      if (remA !== remB) return remA - remB;
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
  windowFilter?: FollowupWindowFilter;
  search?: string;
  stage?: string;
  maturityBand?: FollowupMaturityBand;
  minAiScore?: number;
  opportunityType?: 'all' | FollowupOpportunityType;
  contactId?: string | null;
  now?: Date;
}

/**
 * Resolve a data de referência comercial de um item para filtragem temporal:
 * utiliza estritamente `lastCustomerMessageAt` quando o campo está definido no item
 * (mesmo se for `null`), nunca `suggestionCreatedAt`.
 * Apenas para fixtures de teste legadas onde `lastCustomerMessageAt` não foi populado
 * (`undefined`), usa `lastCommunicationAt ?? suggestionCreatedAt`.
 */
export function resolveFollowupFilterTimestamp(item: EnrichedFollowupItem): string | null {
  if (item.lastCustomerMessageAt !== undefined) {
    return item.lastCustomerMessageAt;
  }
  return item.lastCommunicationAt ?? item.suggestionCreatedAt;
}

/**
 * Filtra uma lista de itens de Follow-up combinando todos os critérios ativos.
 * O filtro padrão de data é 'yesterday' (Ontem em America/Sao_Paulo), avaliado sobre
 * a última mensagem efetivamente recebida do cliente (`lastCustomerMessageAt`).
 */
export function filterFollowupItems(
  items: EnrichedFollowupItem[],
  criteria: FollowupFilterCriteria
): EnrichedFollowupItem[] {
  const {
    status,
    dateFilter = 'yesterday',
    customFrom,
    customTo,
    windowFilter = 'all',
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

    const referenceTimestamp = resolveFollowupFilterTimestamp(item);
    if (!matchesFollowupDateFilter(referenceTimestamp, dateRange)) {
      return false;
    }

    if (windowFilter !== 'all') {
      const winStatus = item.sessionWindow?.status ?? 'unknown';
      if (windowFilter === 'open' && winStatus !== 'open' && winStatus !== 'closing_soon') {
        return false;
      }
      if (windowFilter === 'closing_soon' && winStatus !== 'closing_soon') {
        return false;
      }
      if (windowFilter === 'expired' && winStatus !== 'expired' && winStatus !== 'unknown') {
        return false;
      }
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

/**
 * Extrai o sufixo/slug do link público de um imóvel para preencher o botão URL dinâmico
 * do template `match_imovel_personalizado` (`https://ronaldomeira.com.br/imovel/{{1}}`).
 */
export function extractPropertyUrlSlug(publicUrl?: string | null): string | null {
  if (!publicUrl || !publicUrl.trim()) return null;
  try {
    const parsed = new URL(publicUrl.trim());
    const match = parsed.pathname.match(/\/imovel\/([^/?#]+)/i);
    if (match?.[1]) return decodeURIComponent(match[1]).trim();
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length > 0) return segments[segments.length - 1].trim();
    return null;
  } catch {
    const cleaned = publicUrl.trim().replace(/^\/+/, '');
    const m = cleaned.match(/imovel\/([^/?#]+)/i);
    return m?.[1] || cleaned || null;
  }
}

/**
 * Monta os parâmetros exatos do template aprovado `match_imovel_personalizado`:
 * Body: "Olá, {{1}}! Tudo bem?\n\nEncontrei uma opção de imóvel {{2}} que pode combinar com o que você está procurando.\n\nSeparei os detalhes para você conferir. Depois me conta o que achou!"
 * Button[0] (URL): "https://ronaldomeira.com.br/imovel/{{1}}"
 */
export function buildMatchImovelPersonalizadoParams(args: {
  contactName?: string | null;
  property: Pick<
    CompatiblePropertySummary,
    'title' | 'neighborhood' | 'city' | 'propertyType' | 'bedroomsMin' | 'publicUrl'
  >;
}): {
  body: [string, string];
  buttonUrlSuffix: string | null;
} {
  const firstName = getClientFirstName(args.contactName) || 'tudo bem';
  const prop = args.property;

  const parts: string[] = [];
  if (prop.bedroomsMin && prop.bedroomsMin > 0) {
    parts.push(`de ${prop.bedroomsMin} ${prop.bedroomsMin === 1 ? 'quarto' : 'quartos'}`);
  }
  const location = prop.neighborhood?.trim() || prop.city?.trim() || '';
  if (location) {
    parts.push(`no bairro ${location}`);
  }
  if (prop.title?.trim()) {
    parts.push(`(${prop.title.trim()})`);
  }

  const contextVar =
    parts.length > 0
      ? parts.join(' ')
      : prop.title?.trim() || 'alinhado ao seu perfil';

  return {
    body: [firstName, contextVar],
    buttonUrlSuffix: extractPropertyUrlSlug(prop.publicUrl),
  };
}

/**
 * Constrói mensagem livre natural e personalizada com os imóveis selecionados (Seção 10).
 * Inclui exclusivamente os imóveis selecionados com seus respectivos links públicos validados.
 */
export function buildMultiPropertyFreeFollowupMessage(args: {
  contactName?: string | null;
  properties: CompatiblePropertySummary[];
  interestProperty?: string | null;
  profileSummaryText?: string | null;
}): string {
  const firstName = getClientFirstName(args.contactName);
  const greeting = firstName ? `Oi, ${firstName}!` : 'Oi, tudo bem?';
  const selected = args.properties.filter((p) => Boolean(p.publicUrl));

  if (selected.length === 0) {
    if (args.interestProperty) {
      return `${greeting} Passando para saber se você conseguiu ver as informações sobre o ${args.interestProperty} e se posso te ajudar com mais algum detalhe.`;
    }
    return `${greeting} Passando para saber como está sua busca pelo imóvel e se posso te ajudar com novas opções.`;
  }

  const neighborhoods = Array.from(
    new Set(selected.map((p) => p.neighborhood?.trim()).filter(Boolean))
  );
  const locText =
    neighborhoods.length === 1
      ? ` em ${neighborhoods[0]}`
      : neighborhoods.length > 1
        ? ` em ${neighborhoods.slice(0, 2).join(' e ')}`
        : '';

  const intro =
    selected.length === 1
      ? `${greeting} Separei uma opção${locText} que combina com o que conversamos. Vale a pena dar uma olhada:`
      : `${greeting} Separei ${selected.length === 2 ? 'duas opções' : 'algumas opções'}${locText} que combinam com o que conversamos. Acho que vale a pena conhecer:`;

  const blocks = selected.map((prop, idx) => {
    const label =
      selected.length === 1
        ? `${prop.title}`
        : `Opção ${idx + 1} — ${prop.title}`;
    return `${label}\n${prop.publicUrl}`;
  });

  const closing =
    selected.length === 1
      ? 'Me conta o que achou dessa opção!'
      : 'Me conta o que achou dessas opções!';

  return `${intro}\n\n${blocks.join('\n\n')}\n\n${closing}`;
}
