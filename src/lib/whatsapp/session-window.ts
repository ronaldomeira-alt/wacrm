import type { SupabaseClient } from '@supabase/supabase-js';

export const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ConversationSessionStatus {
  windowOpen: boolean;
  expired: boolean;
  lastCustomerMessageAt: string | null;
  hoursSinceLastCustomerMessage: number | null;
  remainingMs: number;
}

/**
 * Calcula determinísticamente o estado da janela de atendimento de 24 horas
 * a partir de um timestamp da última mensagem recebida do cliente.
 *
 * Regra oficial WhatsApp Cloud API:
 * - Mensagem livre só é permitida se existir mensagem do cliente (`sender_type = 'customer'`)
 *   há estritamente menos de 24 horas (`elapsedMs < 24h`).
 * - Sem mensagem do cliente ou com `elapsedMs >= 24h`, a janela está encerrada (`windowOpen = false`).
 */
export function evaluateSessionWindowFromTimestamp(
  lastCustomerMessageAt: string | null | undefined,
  nowMs: number = Date.now()
): ConversationSessionStatus {
  if (!lastCustomerMessageAt) {
    return {
      windowOpen: false,
      expired: true,
      lastCustomerMessageAt: null,
      hoursSinceLastCustomerMessage: null,
      remainingMs: 0,
    };
  }

  const lastMs = new Date(lastCustomerMessageAt).getTime();
  if (!Number.isFinite(lastMs) || lastMs <= 0) {
    return {
      windowOpen: false,
      expired: true,
      lastCustomerMessageAt: null,
      hoursSinceLastCustomerMessage: null,
      remainingMs: 0,
    };
  }

  const elapsedMs = Math.max(0, nowMs - lastMs);
  const windowOpen = elapsedMs < WHATSAPP_SESSION_WINDOW_MS;
  const remainingMs = windowOpen ? Math.max(0, WHATSAPP_SESSION_WINDOW_MS - elapsedMs) : 0;
  const hoursSinceLastCustomerMessage = Math.round((elapsedMs / (60 * 60 * 1000)) * 10) / 10;

  return {
    windowOpen,
    expired: !windowOpen,
    lastCustomerMessageAt,
    hoursSinceLastCustomerMessage,
    remainingMs,
  };
}

/**
 * Consulta a última mensagem do cliente (`sender_type = 'customer'`) na conversa
 * e retorna o status oficial da janela de 24 horas.
 */
export async function getConversationSessionStatus(
  db: SupabaseClient,
  conversationId: string,
  nowMs: number = Date.now()
): Promise<ConversationSessionStatus> {
  if (!conversationId) {
    return evaluateSessionWindowFromTimestamp(null, nowMs);
  }

  try {
    const { data, error } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return evaluateSessionWindowFromTimestamp(null, nowMs);
    }

    const createdAt = (data as { created_at?: string | null } | null)?.created_at ?? null;
    return evaluateSessionWindowFromTimestamp(createdAt, nowMs);
  } catch {
    return evaluateSessionWindowFromTimestamp(null, nowMs);
  }
}

/**
 * Conta quantos placeholders posicionais `{{1}}..{{N}}` existem em um texto de template.
 */
export function countTemplatePlaceholders(text: string | null | undefined): number {
  if (!text) return 0;
  const matches = text.match(/\{\{(\d+)\}\}/g);
  if (!matches) return 0;
  const indices = matches.map((m) => parseInt(m.replace(/\D/g, ''), 10));
  return Math.max(0, ...indices);
}

/**
 * Renderiza o preview fiel de um template aprovado substituindo apenas os placeholders
 * `{{1}}..{{N}}`, sem alterar em nenhuma hipótese o texto fixo aprovado na Meta.
 */
export function renderApprovedTemplatePreview(
  bodyText: string,
  bodyValues: string[]
): string {
  return (bodyText || '').replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const idx = parseInt(n, 10) - 1;
    const val = bodyValues[idx]?.trim();
    return val ? val : `{{${n}}}`;
  });
}

/**
 * Valida se um template está aprovado (`status === 'APPROVED'`) e se todas as variáveis
 * obrigatórias do body (e header de texto, se houver) estão preenchidas.
 */
export function validateApprovedTemplateSubmission(
  template: {
    name: string;
    status?: string | null;
    body_text: string;
    header_type?: string | null;
    header_content?: string | null;
  },
  bodyValues: string[],
  headerTextValue?: string | null
): { valid: boolean; reason?: string } {
  if (String(template.status || '').toUpperCase() !== 'APPROVED') {
    return {
      valid: false,
      reason: `O template "${template.name}" não está aprovado para envio (status atual: ${template.status || 'desconhecido'}).`,
    };
  }

  const requiredBodyVars = countTemplatePlaceholders(template.body_text);
  for (let i = 0; i < requiredBodyVars; i++) {
    const val = bodyValues[i]?.trim();
    if (!val) {
      return {
        valid: false,
        reason: `A variável obrigatória {{${i + 1}}} do template "${template.name}" não foi preenchida.`,
      };
    }
  }

  if (String(template.header_type || '').toLowerCase() === 'text') {
    const requiredHeaderVars = countTemplatePlaceholders(template.header_content);
    if (requiredHeaderVars > 0 && !(headerTextValue && headerTextValue.trim())) {
      return {
        valid: false,
        reason: `A variável do cabeçalho do template "${template.name}" não foi preenchida.`,
      };
    }
  }

  return { valid: true };
}
