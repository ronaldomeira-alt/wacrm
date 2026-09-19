import type { AiConfig } from './types';

export const TIMEZONE = 'America/Sao_Paulo';
export const DEFAULT_BUSINESS_START_HOUR = '08:00';
export const DEFAULT_BUSINESS_END_HOUR = '20:00';
export const DEFAULT_BUSINESS_DAYS = [1, 2, 3, 4, 5, 6]; // Seg-Sáb (1 a 6) conforme ai_configs

export interface WallClockParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/**
 * Extracts wall-clock date and time components for a given instant in the specified timezone.
 * Robust across environments and ICU builds (handles midnight "24" normalization).
 */
export function wallClockParts(date: Date, timeZone: string = TIMEZONE): WallClockParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    // Some ICU builds report midnight as "24" with hour12:false.
    h: Number(parts.hour) % 24,
    mi: Number(parts.minute),
    s: Number(parts.second),
  };
}

/**
 * Milliseconds to ADD to a UTC instant's epoch-ms-as-if-UTC reading of
 * the target timezone's wall clock to get back the real UTC instant.
 */
export function tzOffsetMs(date: Date, timeZone: string = TIMEZONE): number {
  const p = wallClockParts(date, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - date.getTime();
}

/**
 * Simple business hours checker based on wall clock hour in TIMEZONE (08:00–20:00 default).
 */
export function isBusinessHours(
  date: Date,
  startHour: number = 8,
  endHour: number = 20,
  timeZone: string = TIMEZONE,
): boolean {
  const { h } = wallClockParts(date, timeZone);
  return h >= startHour && h < endHour;
}

/**
 * Next instant at or after `date` that is startHour local time in TIMEZONE.
 */
export function nextBusinessHourStart(
  date: Date,
  startHour: number = 8,
  timeZone: string = TIMEZONE,
): Date {
  const offset = tzOffsetMs(date, timeZone);
  const p = wallClockParts(date, timeZone);
  const todayAtStartUtc = new Date(Date.UTC(p.y, p.mo - 1, p.d, startHour, 0, 0) - offset);
  if (todayAtStartUtc.getTime() >= date.getTime()) return todayAtStartUtc;
  return new Date(todayAtStartUtc.getTime() + 24 * 60 * 60 * 1000);
}

export interface BusinessHoursContext {
  isBusinessHours: boolean;
  startHour: string;
  endHour: string;
  offHoursInstructions: string | null;
  instructionForModel: string;
  nextBusinessHourStart?: Date;
  nextBusinessHourFormatted?: string;
}

/**
 * Check if the given timestamp falls within the account's configured business hours.
 * Uses America/Sao_Paulo (or user's timezone) for consistent wall-clock calculation.
 */
export function getBusinessHoursContext(
  config: AiConfig,
  currentDate: Date = new Date(),
): BusinessHoursContext {
  const startHour = config.businessHoursStart || DEFAULT_BUSINESS_START_HOUR;
  const endHour = config.businessHoursEnd || DEFAULT_BUSINESS_END_HOUR;
  const businessDays =
    config.businessDays && config.businessDays.length > 0
      ? config.businessDays
      : DEFAULT_BUSINESS_DAYS;
  const offHoursInstructions = config.offHoursInstructions || null;

  const p = wallClockParts(currentDate, TIMEZONE);
  const dayOfWeek = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();

  const [startH, startM] = startHour.split(':').map(Number);
  const [endH, endM] = endHour.split(':').map(Number);

  const currentMinutes = p.h * 60 + p.mi;
  const startMinutes = (startH ?? 8) * 60 + (startM || 0);
  const endMinutes = (endH ?? 20) * 60 + (endM || 0);

  const isDayAllowed = businessDays.includes(dayOfWeek);
  const isTimeAllowed = currentMinutes >= startMinutes && currentMinutes < endMinutes;
  const isBusinessHoursCurrent = isDayAllowed && isTimeAllowed;

  const nextStart = nextBusinessHourStart(currentDate, startH ?? 8, TIMEZONE);
  const nextP = wallClockParts(nextStart, TIMEZONE);
  const isSameDay = nextP.d === p.d && nextP.mo === p.mo && nextP.y === p.y;
  const nextBusinessHourFormatted = isSameDay
    ? `hoje a partir das ${startHour}`
    : `amanhã a partir das ${startHour}`;

  let instructionForModel = '';
  if (isBusinessHoursCurrent) {
    instructionForModel =
      `HORÁRIO ATUAL: HORÁRIO COMERCIAL ATIVO (${startHour} às ${endHour}).\n` +
      `Orientação: Estamos dentro do expediente comercial ativo. Acolha o cliente com agilidade e responda com segurança no território livre.\n` +
      `- Se ainda houver o que explorar do perfil do cliente (tipo de imóvel, metragem, objetivo de moradia vs investimento), faça uma pergunta de condução relevante.\n` +
      `- Se a triagem estiver concluída ou se atingir uma fronteira comercial (preço, fluxo de pagamento, visita, reserva), informe com clareza que nossa equipe dará continuidade ao atendimento e passe o bastão (transfer_required = true).\n` +
      `- NUNCA mencione "próximo horário comercial", pois a equipe está em expediente ativo agora.`;
  } else {
    instructionForModel =
      `HORÁRIO ATUAL: FORA DO EXPEDIENTE COMERCIAL (Expediente padrão: ${startHour} às ${endHour}).\n` +
      `Orientação: Estamos no período noturno/fora do expediente comercial. Você pode continuar acolhendo, respondendo dúvidas do empreendimento e entendendo as preferências do cliente. Porém, atente-se às regras de continuidade fora de horário:\n` +
      `1. NUNCA crie a falsa impressão de que a equipe humana está disponível ou online neste momento. É TERMINANTEMENTE PROIBIDO usar expressões como "já vão seguir com você", "já dão sequência", "em instantes", "agora mesmo" ou equivalentes imediatos.\n` +
      `2. Quando a conversa chegar ao ponto em que o próximo passo depender da equipe humana (condições de pagamento, tabela de valores, agendamento de visita, seleção de opções personalizadas pela equipe ou término da triagem), registre a solicitação e deixe EXPLÍCITO e CLARO que a continuidade do atendimento ocorrerá NO PRÓXIMO HORÁRIO COMERCIAL (${nextBusinessHourFormatted}).\n` +
      `3. Varie as frases com naturalidade humana, NUNCA mencionando nomes de pessoas da equipe (ex: "Já deixei todas as suas preferências anotadas por aqui. Como estamos fora do horário de atendimento, nossa equipe dará continuidade ao seu atendimento no próximo horário comercial com as melhores opções" ou "Perfeito! Já entendi o que você busca. Como já passou do nosso horário de atendimento, nossa equipe continuará seu atendimento no próximo horário comercial trazendo os detalhes").\n` +
      `4. Nunca deixe o cliente em dúvida se alguém vai entrar em contato ou quando isso acontecerá.\n` +
      (offHoursInstructions ? `Instrução adicional de plantão configurada: "${offHoursInstructions}"` : '');
  }

  return {
    isBusinessHours: isBusinessHoursCurrent,
    startHour,
    endHour,
    offHoursInstructions,
    instructionForModel,
    nextBusinessHourStart: nextStart,
    nextBusinessHourFormatted,
  };
}

/**
 * Deterministic architectural guard for off-hours handoffs.
 * Ensures that if a transfer/handoff occurs outside business hours, any hallucinated or
 * misplaced immediate phrasing ("já vão seguir", "já dão sequência", "em instantes", etc.)
 * is deterministically sanitized and replaced with polite off-hours continuity wording.
 */
export function sanitizeOffHoursHandoffResponse(
  text: string,
  nextPeriod: string = 'no próximo horário comercial',
): string {
  if (!text || !text.trim()) return text;

  // Handles Portuguese accented characters (á, ã, ê, etc.) where standard \b fails
  const immediatePattern =
    /(?:^|\s|[.,!?;:])(?:j[aá]\s+(?:v[aã]o|d[aã]o|dar[aã]o|seguem|seguir[aã]o|entram|entrar[aã]o|atendem|atender[aã]o|respondem)(?:\s+(?:seguir|sequ[eê]ncia|em\s+contato|atendimento))?|(?:seguir|dar\s+sequ[eê]ncia|entrar\s+em\s+contato)\s+com\s+voc[eê]\s+j[aá]|sequ[eê]ncia\s+imediata|atendimento\s+imediato|em\s+instantes|agora\s+mesmo|daqui\s+a\s+pouco)(?![a-zà-úA-ZÀ-Ú])/i;

  const hasOffHoursMention =
    /(?:fora\s+d[oe]\s+(?:nosso\s+)?(?:hor[aá]rio|expediente)|pr[oó]ximo\s+(?:hor[aá]rio|expediente)|pela\s+manh[aã]|assim\s+que\s+(?:o\s+expediente|a\s+equipe)\s+retornar|retornar(?:em)?\s+pela\s+manh[aã])/i.test(
      text,
    );

  // If already free of immediate claims and explicitly mentions off-hours, leave intact
  if (!immediatePattern.test(text) && hasOffHoursMention) {
    return text;
  }

  let sanitized = text
    // Replace "vou encaminhar sua conversa para nossa equipe seguir com você já..."
    .replace(
      /,?\s*vou\s+(?:direcionar|encaminhar|transferir)\s+(?:nossa|sua|esta)?\s*(?:conversa|atendimento)?\s*(?:para\s+nossa\s+equipe|para\s+o\s+Ronaldo\s+ou\s+a\s+Thatianna)?\s*(?:para\s+)?(?:seguir\s+com\s+voc[eê]\s+j[aá]|j[aá]\s+seguir\s+com\s+voc[eê])[^.!?]*/gi,
      `. Já deixei tudo registrado por aqui e, como estamos fora do horário de atendimento, nossa equipe dará continuidade ao seu atendimento ${nextPeriod}`,
    )
    // Replace "que já dão sequência com você..."
    .replace(
      /,?\s*(?:que\s+)?j[aá]\s+(?:d[aã]o|dar[aã]o|v[aã]o\s+dar)\s+sequ[eê]ncia\s+(?:personalizada\s+)?com\s+voc[eê][^.!?]*/gi,
      `, e como estamos fora do horário de atendimento, nossa equipe dará continuidade ao seu atendimento ${nextPeriod}`,
    )
    // Replace standalone "seguir com você já"
    .replace(
      /(?:seguir|dar\s+sequ[eê]ncia)\s+com\s+voc[eê]\s+j[aá][^.!?]*/gi,
      `dar continuidade com você ${nextPeriod}`,
    )
    .replace(/\b(?:em\s+instantes|agora\s+mesmo|daqui\s+a\s+pouco)\b/gi, nextPeriod)
    .replace(/\b(?:sequ[eê]ncia\s+imediata|atendimento\s+imediato)\b/gi, `continuidade ${nextPeriod}`)
    .replace(/[!.]?\s*Um\s+momento!?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // If after regex replacements the text STILL contains immediate wording or lacks off-hours context
  if (immediatePattern.test(sanitized) || !hasOffHoursMention) {
    sanitized = sanitized.replace(immediatePattern, ` ${nextPeriod}`);
    if (!/(?:fora\s+d[oe]\s+(?:nosso\s+)?(?:hor[aá]rio|expediente)|pr[oó]ximo\s+(?:hor[aá]rio|expediente))/i.test(sanitized)) {
      sanitized += ` (Como estamos fora do nosso horário de atendimento, nossa equipe dará continuidade ao seu contato ${nextPeriod}.)`;
    }
  }

  return sanitized;
}
