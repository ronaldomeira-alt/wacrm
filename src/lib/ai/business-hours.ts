import type { AiConfig } from './types';

export interface BusinessHoursContext {
  isBusinessHours: boolean;
  startHour: string;
  endHour: string;
  offHoursInstructions: string | null;
  instructionForModel: string;
}

/**
 * Check if the given timestamp falls within the account's configured business hours.
 * Uses America/Sao_Paulo (or user's timezone) for consistent wall-clock calculation.
 */
export function getBusinessHoursContext(
  config: AiConfig,
  currentDate: Date = new Date(),
): BusinessHoursContext {
  const startHour = config.businessHoursStart || '08:00';
  const endHour = config.businessHoursEnd || '18:00';
  const businessDays = config.businessDays && config.businessDays.length > 0
    ? config.businessDays
    : [1, 2, 3, 4, 5]; // Mon-Fri default
  const offHoursInstructions = config.offHoursInstructions || null;

  // Convert to Brazilian time (UTC-3)
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'narrow',
  });

  const parts = formatter.formatToParts(currentDate);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 12);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);

  // JavaScript getDay(): 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  // Calculate day in America/Sao_Paulo
  const spDateStr = currentDate.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
  const spDate = new Date(spDateStr);
  const dayOfWeek = spDate.getDay();

  const [startH, startM] = startHour.split(':').map(Number);
  const [endH, endM] = endHour.split(':').map(Number);

  const currentMinutes = hour * 60 + minute;
  const startMinutes = (startH || 8) * 60 + (startM || 0);
  const endMinutes = (endH || 18) * 60 + (endM || 0);

  const isDayAllowed = businessDays.includes(dayOfWeek);
  const isTimeAllowed = currentMinutes >= startMinutes && currentMinutes < endMinutes;
  const isBusinessHours = isDayAllowed && isTimeAllowed;

  let instructionForModel = '';
  if (isBusinessHours) {
    instructionForModel = `HORÁRIO ATUAL: HORÁRIO COMERCIAL ATIVO (${startHour} às ${endHour}).\n` +
      `Orientação: Acolha o cliente com agilidade. Se uma fronteira for atingida ou o cliente solicitar atendimento humano, informe com naturalidade que a equipe (Ronaldo ou Thatianna) dará sequência imediata ao contato.`;
  } else {
    instructionForModel = `HORÁRIO ATUAL: FORA DO EXPEDIENTE COMERCIAL (Expediente padrão: ${startHour} às ${endHour}).\n` +
      `Orientação: Continue acolhendo o cliente e respondendo dúvidas técnicas no território permitido. Se atingir uma fronteira comercial (preço, negociação, visita, etc.) ou se o cliente solicitar atendimento humano, faça a transição com cordialidade, acolhendo o interesse e avisando gentilmente que nossa equipe (Ronaldo ou Thatianna) entrará em contato logo no início do próximo período de atendimento.\n` +
      (offHoursInstructions ? `Instrução adicional de plantão configurada: "${offHoursInstructions}"` : '');
  }

  return {
    isBusinessHours,
    startHour,
    endHour,
    offHoursInstructions,
    instructionForModel,
  };
}
