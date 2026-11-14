import type { Message } from '@/types';
import { getPlatformProfile } from '@/lib/platform/platform-profile';

/**
 * Platform-aware in-memory LRU cache for conversation messages.
 * - iPhone/Mobile: capped to at most 3 conversations and at most 30 messages each
 *   to avoid Safari/WebKit mobile memory exhaustion and crashes.
 * - Windows/Desktop: keeps 10 conversations and complete message history.
 */
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
  const profile = getPlatformProfile();
  const maxConvs = profile.maxCachedConversations;
  const maxMsgsPerConv = profile.maxCachedMessagesPerConv;

  // Enforce message limit per conversation if defined (iPhone = 30)
  const storedMessages =
    maxMsgsPerConv && messages.length > maxMsgsPerConv
      ? messages.slice(-maxMsgsPerConv)
      : messages;

  if (messageCache.has(conversationId)) {
    messageCache.delete(conversationId);
  } else if (messageCache.size >= maxConvs) {
    // Evict oldest entry (first key in map iterator)
    const oldestKey = messageCache.keys().next().value;
    if (oldestKey) messageCache.delete(oldestKey);
  }
  messageCache.set(conversationId, storedMessages);
}

export function appendCachedMessage(
  conversationId: string,
  newMsg: Message
): void {
  const cached = messageCache.get(conversationId);
  if (!cached) return;

  const profile = getPlatformProfile();
  const maxMsgsPerConv = profile.maxCachedMessagesPerConv;

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

  let next = [...cached, newMsg];
  if (maxMsgsPerConv && next.length > maxMsgsPerConv) {
    next = next.slice(-maxMsgsPerConv);
  }
  messageCache.set(conversationId, next);
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

/**
 * Releases unneeded resources when leaving or switching conversations.
 * On mobile/iPhone, prunes memory down aggressively so WebKit stays lightweight.
 */
export function releaseConversationResources(closedConversationId?: string): void {
  const profile = getPlatformProfile();
  if (profile.aggressiveResourceCleanup) {
    // If specific conversation closed, evict it if cache exceeds small limit
    if (closedConversationId && messageCache.size > profile.maxCachedConversations) {
      messageCache.delete(closedConversationId);
    }
    // Prune cache down to maxCachedConversations (3)
    while (messageCache.size > profile.maxCachedConversations) {
      const oldestKey = messageCache.keys().next().value;
      if (oldestKey) messageCache.delete(oldestKey);
      else break;
    }

    // Trigger cleanup of active media playback
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('wacrm:pause-all-audio'));
    }
  }
}

/**
 * Diagnostics helper to inspect cache usage.
 */
export function getMessageCacheStats(): {
  conversationCount: number;
  totalMessages: number;
  conversations: { id: string; messageCount: number }[];
} {
  let total = 0;
  const list: { id: string; messageCount: number }[] = [];
  messageCache.forEach((msgs, id) => {
    total += msgs.length;
    list.push({ id, messageCount: msgs.length });
  });
  return {
    conversationCount: messageCache.size,
    totalMessages: total,
    conversations: list,
  };
}
