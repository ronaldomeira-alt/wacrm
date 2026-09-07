export interface ForwardContactRecipient {
  id: string;
  name?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  conversation?: {
    id: string;
    last_message_at?: string | null;
  } | null;
}

/**
 * Sorts forward recipients according to WhatsApp-like priority:
 * 1. Current active conversation contact (Priority 1 - top absolute)
 * 2. Contacts with conversations sorted by `last_message_at` descending (Priority 2)
 * 3. Contacts without conversations sorted alphabetically by name / phone (Priority 3)
 * 4. Alphabetical tie-breaker when `last_message_at` timestamps are identical
 */
export function sortForwardRecipients(
  contacts: ForwardContactRecipient[],
  currentContactId?: string | null,
): ForwardContactRecipient[] {
  return [...contacts].sort((a, b) => {
    // 1. PRIORIDADE 1: Conversa aberta atualmente (topo absoluto)
    if (currentContactId) {
      if (a.id === currentContactId && b.id !== currentContactId) return -1;
      if (b.id === currentContactId && a.id !== currentContactId) return 1;
    }

    const timeA = a.conversation?.last_message_at
      ? new Date(a.conversation.last_message_at).getTime()
      : 0;
    const timeB = b.conversation?.last_message_at
      ? new Date(b.conversation.last_message_at).getTime()
      : 0;

    // 2. PRIORIDADE 2: Contatos com conversa ativa (ordenados por last_message_at DESC)
    if (timeA > 0 && timeB > 0) {
      if (timeA !== timeB) return timeB - timeA;
    } else if (timeA > 0) {
      return -1; // a tem conversa ativa com timestamp, b não
    } else if (timeB > 0) {
      return 1; // b tem conversa ativa com timestamp, a não
    }

    // 3. PRIORIDADE 3 / Desempate: Ordem alfabética pelo nome ou telefone
    const nameA = a.name?.trim() || a.phone?.trim() || "";
    const nameB = b.name?.trim() || b.phone?.trim() || "";
    return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
  });
}
