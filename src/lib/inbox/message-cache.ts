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
  if (!cached.some((m) => m.id === newMsg.id)) {
    messageCache.set(conversationId, [...cached, newMsg]);
  }
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
