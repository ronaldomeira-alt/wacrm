import { saoPauloDayKey, saoPauloDayStartIso } from '@/lib/dashboard/date-utils';
import type { LeadSummary } from '@/lib/ai/lead-analysis-types';
import { WHATSAPP_SESSION_WINDOW_MS } from '@/lib/whatsapp/session-window';
import type { AiSuggestion, AiSuggestionStatus } from '@/types';

export const FOLLOWUP_TIMEZONE = 'America/Sao_Paulo';
export const FOLLOWUP_WINDOW_CLOSING_SOON_MS = 6 * 60 * 60 * 1000; // 6h ou menos restantes na janela de 24h

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
}

export interface RawConversationMessageRow {
  conversation_id?: string | null;
  sender_type?: string | null;
  content_type?: string | null;
  content_text?: string | null;
  media_url?: string | null;
  template_name?: string | null;
  created_at?: string | null;
  private?: boolean | null;
  event?: string | null;
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

  const text = typeof msg.content_text === 'string' ? msg.content_text.trim() : '';
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
    const text = typeof msg.content_text === 'string' ? msg.content_text.trim() : '';

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

/**
 * Constrói uma recomendação comercial objetiva e contextual (Seções 4 e 8) a partir dos fatos
 * reais da conversa (imóvel/empreendimento, necessidade, última pergunta do cliente, resposta
 * da equipe/Clara e estado da oportunidade).
 */
export function buildObjectiveFollowupRecommendation(args: {
  opportunityType: FollowupOpportunityType;
  contactState?: FollowupContactState;
  interestProperty?: string | null;
  primaryNeed?: string | null;
  lastCustomerText?: string | null;
  lastBusinessText?: string | null;
  stageName?: string | null;
}): { reason: string; approachSummary: string } {
  const {
    opportunityType,
    contactState,
    interestProperty,
    primaryNeed,
    lastCustomerText,
    lastBusinessText,
  } = args;

  const subjectParts: string[] = [];
  if (interestProperty) {
    subjectParts.push(`no empreendimento ${interestProperty}`);
  }
  if (primaryNeed) {
    subjectParts.push(
      interestProperty ? `(${primaryNeed})` : `em ${primaryNeed}`
    );
  }
  const subjectText =
    subjectParts.length > 0 ? subjectParts.join(' ') : 'em opções do portfólio';

  const custLower = (lastCustomerText || '').toLowerCase();
  let customerIntentClause = '';
  if (/\b(valor|preço|preco|tabela|parcela|entrada|condiç|condic|quanto)\b/.test(custLower)) {
    customerIntentClause = ', perguntou sobre valores e condições';
  } else if (/\b(planta|fotos|vídeo|video|detalhes|informaç|informac|saber mais|gostaria de receber)\b/.test(custLower)) {
    customerIntentClause = ', solicitou informações e detalhes do imóvel';
  } else if (/\b(visita|conhecer|agendar|ir ver|caminho)\b/.test(custLower)) {
    customerIntentClause = ', tratou sobre visita ao imóvel';
  } else if (/\b(dispon[ií]vel|unidade|andar|posi[çc][aã]o)\b/.test(custLower)) {
    customerIntentClause = ', consultou disponibilidade de unidades';
  } else if (/\b(loca[çc][aã]o|alugar|aluguel|anual|temporada)\b/.test(custLower)) {
    customerIntentClause = ', consultou opções de locação';
  } else if (custLower.includes('?')) {
    customerIntentClause = ', deixou uma dúvida na conversa';
  }

  if (opportunityType === 'first_contact') {
    return {
      reason: `O cliente entrou em contato demonstrando interesse ${subjectText}${customerIntentClause}, mas ainda aguarda o primeiro atendimento comercial.`,
      approachSummary: `Realizar o primeiro atendimento respondendo diretamente à solicitação sobre ${interestProperty || primaryNeed || 'o imóvel'} e qualificando o perfil.`,
    };
  }

  if (contactState === 'awaiting_business_reply') {
    return {
      reason: `O cliente interagiu por último demonstrando interesse ${subjectText}${customerIntentClause} e está aguardando retorno do atendimento.`,
      approachSummary: `Responder prontamente à última mensagem do cliente sobre ${interestProperty || primaryNeed || 'a busca'} e apresentar opções compatíveis.`,
    };
  }

  const receivedInfoClause = lastBusinessText
    ? 'após receber as informações enviadas no atendimento'
    : 'após a abordagem inicial';

  return {
    reason: `O cliente demonstrou interesse ${subjectText}${customerIntentClause} e não respondeu ${receivedInfoClause}.`,
    approachSummary: `Retomar a conversa verificando se continua interessado em ${interestProperty || primaryNeed || 'avançar na busca'} e apresentando opções compatíveis.`,
  };
}

/**
 * Reconcilia o texto da recomendação com a classificação real do histórico de mensagens (Seção 8),
 * eliminando contradições como um card de "Retomada de contato" cujo texto afirma "nunca contatado".
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

  if (!cleanReason || hasContradictoryNeverContactedText || hasContradictoryResumptionOnFirstContact) {
    const synthesized = buildObjectiveFollowupRecommendation({
      opportunityType,
      contactState,
      interestProperty,
      primaryNeed,
      lastCustomerText,
      lastBusinessText,
      stageName,
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
 * Identifica o empreendimento de interesse do lead quando conhecido (via tag 'Empreendimento',
 * origem CTWA ou menção direta verificada no catálogo/conversa).
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
 * Calcula a prioridade comercial determinística (0–100) calibrada pela realidade operacional (Seção 3):
 *
 * 1. Interesse comercial efetivamente demonstrado (0–30 pts / 30%):
 *    - Empreendimento específico identificado (+10)
 *    - Necessidade principal clara: tipologia/bairro/quartos/finalidade (+8)
 *    - Etapa do pipeline (+12 para Visita/Proposta/Negociação; +9 para Interesse; +5 para Qualificação)
 * 2. Maturidade comercial do perfil (`profileMaturity`, 0–100) — peso 25% (0–25 pts)
 * 3. Score de qualificação da IA (`contacts.ai_score`, 0–10) — peso 25% (0–25 pts)
 * 4. Urgência real de acompanhamento (0–12 pts / 12%):
 *    - Cliente aguardando resposta ou primeiro atendimento (+6)
 *    - Janela de 24h do WhatsApp prestes a encerrar (+6) ou aberta (+4)
 * 5. Confiança da sugestão (`payload.score`, 0–100) — peso complementar 8% (0–8 pts)
 *
 * Isso impede que um lead com baixa maturidade e baixo score supere um comprador qualificado
 * apenas porque a IA gerou uma confiança alta na recomendação.
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
  } = args;

  let interestComp = 0;
  if (hasInterestProperty) interestComp += 10;
  if (hasPrimaryNeed) interestComp += 8;

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

  const matComp = Math.min(100, Math.max(0, profileMaturity)) * 0.25; // 0 a 25
  const aiComp = Math.min(10, Math.max(0, aiScore)) * 2.5; // 0 a 25

  let urgencyComp = 0;
  if (awaitingBusinessReply) urgencyComp += 6;
  if (windowStatus === 'closing_soon') {
    urgencyComp += 6;
  } else if (windowStatus === 'open') {
    urgencyComp += 4;
  }

  const confComp = Math.min(100, Math.max(0, confidenceScore ?? 55)) * 0.08; // 0 a 8 (complementar)

  const raw =
    Math.min(30, interestComp) +
    matComp +
    aiComp +
    Math.min(12, urgencyComp) +
    confComp;
  const score = Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;

  let tier: FollowupPriorityTier = 'normal';
  if (
    score >= 65 ||
    (aiScore >= 7 && profileMaturity >= 60) ||
    (aiScore >= 7 && (confidenceScore ?? 0) >= 75 && profileMaturity >= 45)
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
    const dayA = resolveItemCustomerDayKeySp(a);
    const dayB = resolveItemCustomerDayKeySp(b);
    if (dayB !== dayA) {
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
