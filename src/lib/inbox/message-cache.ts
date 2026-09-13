import type { Message } from '@/types';

/**
 * In-memory LRU cache for conversation messages (session-scoped).
 * Keeps the latest 10 visited conversations in memory so returning
 * to a conversation renders immediately (0ms wait) while fresh
 * data revalidates in the background (stale-while-revalidate).
 */
const MAX_CACHED_CONVERSATIONS = 10;
const messageCache = new Map<string, Message[]>();

export function getCachedMessages(conversationId: string): Message[] | undefined {
  const cached = messageCache.get(conversationId);
  if (cached) {
    // Refresh LRU order (delete & re-insert at tail)
    messageCache.delete(conversationId);
    messageCache.set(conversationId, cached);
  }
  return cached;
}

export function setCachedMessages(
  conversationId: string,
  messages: Message[]
): void {
  if (messageCache.has(conversationId)) {
    messageCache.delete(conversationId);
  } else if (messageCache.size >= MAX_CACHED_CONVERSATIONS) {
    // Evict oldest entry (first key in map iterator)
    const oldestKey = messageCache.keys().next().value;
    if (oldestKey) messageCache.delete(oldestKey);
  }
  messageCache.set(conversationId, messages);
}

export function appendCachedMessage(
  conversationId: string,
  newMsg: Message
): void {
  const cached = messageCache.get(conversationId);
  if (!cached) return;

  // 1. If already present by id, update in-place
  const idIdx = cached.findIndex((m) => m.id === newMsg.id);
  if (idIdx !== -1) {
    const updated = cached.slice();
    updated[idIdx] = { ...updated[idIdx], ...newMsg };
    messageCache.set(conversationId, updated);
    return;
  }

  // 2. If matching by client_ref, replace temp row with new message
  if (newMsg.client_ref) {
    const refIdx = cached.findIndex(
      (m) => m.client_ref === newMsg.client_ref || m.id === newMsg.client_ref
    );
    if (refIdx !== -1) {
      const updated = cached.slice();
      updated[refIdx] = { ...updated[refIdx], ...newMsg };
      messageCache.set(conversationId, updated);
      return;
    }
  }

  // 3. If matching by album_id + album_index, update in-place
  if (newMsg.album_id && typeof newMsg.album_index === 'number') {
    const albumIdx = cached.findIndex(
      (m) =>
        m.album_id === newMsg.album_id &&
        (m.album_index === newMsg.album_index ||
          (m.metadata as Record<string, unknown> | undefined)?.album_index === newMsg.album_index)
    );
    if (albumIdx !== -1) {
      const updated = cached.slice();
      updated[albumIdx] = { ...updated[albumIdx], ...newMsg };
      messageCache.set(conversationId, updated);
      return;
    }
  }

  messageCache.set(conversationId, [...cached, newMsg]);
}

export function updateCachedMessage(
  conversationId: string,
  updated: Partial<Message> & { id: string }
): void {
  const cached = messageCache.get(conversationId);
  if (!cached) return;
  messageCache.set(
    conversationId,
    cached.map((m) => (m.id === updated.id ? { ...m, ...updated } : m))
  );
}

export function removeCachedMessage(
  conversationId: string,
  messageId: string
): void {
  const cached = messageCache.get(conversationId);
  if (!cached) return;
  messageCache.set(
    conversationId,
    cached.filter((m) => m.id !== messageId)
  );
}

export function clearMessageCache(): void {
  messageCache.clear();
}
