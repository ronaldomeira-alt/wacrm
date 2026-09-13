import type { Message } from "@/types";
import { registerLocalMediaBlob, getLocalMediaBlob } from "@/lib/inbox/use-resolved-media-src";

export type AlbumItemStatus =
  | "pending"
  | "uploading"
  | "processing"
  | "sent"
  | "failed"
  | "cancelled";

export interface OptimisticAlbumItem {
  clientItemId: string;
  albumId: string;
  albumIndex: number;
  localPreviewUrl: string;
  remoteMediaKey?: string | null;
  status: AlbumItemStatus;
  progress?: number;
  bytesUploaded?: number;
  totalBytes?: number;
  error?: string | null;
  file?: File;
  caption?: string;
  replyToId?: string;
}

export interface OptimisticAlbum {
  albumId: string;
  conversationId: string;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  items: OptimisticAlbumItem[];
  progress: number;
  status: "sending" | "completed" | "has_errors" | "cancelled";
  createdAt: string;
}

export interface CreateOptimisticAlbumParams {
  conversationId: string;
  files: File[];
  caption?: string;
  replyToId?: string;
  userId?: string;
  albumId?: string;
  baseTime?: number;
}

export interface CreateOptimisticAlbumResult {
  album: OptimisticAlbum;
  messages: Message[];
}

/**
 * Creates an OptimisticAlbum entity and its corresponding initial Message rows
 * in exactly 0ms of CPU work. All positions are immediately populated.
 */
export function createOptimisticAlbum(
  params: CreateOptimisticAlbumParams
): CreateOptimisticAlbumResult {
  const {
    conversationId,
    files,
    caption,
    replyToId,
    userId,
    baseTime = Date.now(),
  } = params;

  const total = files.length;
  const albumId =
    params.albumId ||
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `album-${baseTime}-${Math.random().toString(36).slice(2, 8)}`);

  const items: OptimisticAlbumItem[] = [];
  const messages: Message[] = [];

  for (let idx = 0; idx < total; idx++) {
    const file = files[idx];
    const clientItemId = `temp-${albumId}-${idx}`;
    const blobUrl = URL.createObjectURL(file);

    // Register blob under clientItemId and blobUrl for 0ms lookup
    registerLocalMediaBlob(clientItemId, blobUrl);
    registerLocalMediaBlob(blobUrl, blobUrl);

    const item: OptimisticAlbumItem = {
      clientItemId,
      albumId,
      albumIndex: idx,
      localPreviewUrl: blobUrl,
      status: "pending",
      progress: 0,
      totalBytes: file.size,
      bytesUploaded: 0,
      file,
      caption: idx === 0 ? caption : undefined,
      replyToId,
    };
    items.push(item);

    const msg: Message = {
      id: clientItemId,
      conversation_id: conversationId,
      sender_type: "agent",
      sender_id: userId,
      content_type: "image",
      content_text: idx === 0 ? caption : undefined,
      media_url: clientItemId,
      status: "sending",
      created_at: new Date(baseTime + idx * 10).toISOString(),
      reply_to_message_id: replyToId,
      album_id: albumId,
      album_index: idx,
      client_ref: clientItemId,
      metadata: {
        album_id: albumId,
        album_index: idx,
        clientItemId,
      },
    };
    messages.push(msg);
  }

  const album: OptimisticAlbum = {
    albumId,
    conversationId,
    total,
    completed: 0,
    failed: 0,
    cancelled: 0,
    items,
    progress: 0,
    status: "sending",
    createdAt: new Date(baseTime).toISOString(),
  };

  return { album, messages };
}

export interface AlbumProgressSummary {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  isSending: boolean;
  hasErrors: boolean;
  progress: number; // 0 to 1
  percent: number; // 0 to 100
}

/**
 * Calculates REAL aggregated progress from the messages of an album.
 * Strictly avoids timers or fake percentages:
 * e.g. 7 images -> 0/7 = 0%, 1/7 = 14%, 2/7 = 28%, 3/7 = 42%, 4/7 = 57%, 5/7 = 71%, 6/7 = 85%, 7/7 = 100%.
 */
export function calculateAlbumProgress(messages: Message[]): AlbumProgressSummary {
  const total = messages.length;
  if (total === 0) {
    return {
      total: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      isSending: false,
      hasErrors: false,
      progress: 1,
      percent: 100,
    };
  }

  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let sending = 0;

  for (const m of messages) {
    const isCancelled =
      m.metadata?.cancelled === true || (m as unknown as { cancelled?: boolean }).cancelled === true;

    if (isCancelled) {
      cancelled++;
    } else if (m.status === "failed") {
      failed++;
    } else if (
      m.status === "sent" ||
      m.status === "delivered" ||
      m.status === "read"
    ) {
      completed++;
    } else if (m.status === "sending") {
      sending++;
    }
  }

  const isSending = sending > 0;
  const hasErrors = failed > 0;
  const progress = total > 0 ? completed / total : 0;
  const percent = Math.round(progress * 100);

  return {
    total,
    completed,
    failed,
    cancelled,
    isSending,
    hasErrors,
    progress,
    percent,
  };
}

/**
 * Reconciles an incoming backend or Realtime message with optimistic messages in-place.
 * CRITICAL RULE: Never wipes out or disturbs other pending optimistic messages!
 * Preserves local preview blob so there is zero flash/reload when the real message lands.
 */
export function reconcileOptimisticMessages(
  prevMessages: Message[],
  incomingMessage: Message
): { updatedMessages: Message[]; matched: boolean } {
  // 1. If message already exists by real ID, update it in-place
  const existingIdIdx = prevMessages.findIndex((m) => m.id === incomingMessage.id);
  if (existingIdIdx !== -1) {
    const copy = prevMessages.slice();
    copy[existingIdIdx] = { ...copy[existingIdIdx], ...incomingMessage };
    return { updatedMessages: copy, matched: true };
  }

  let matchIdx = -1;

  // Priority 1: Match by client_ref
  if (incomingMessage.client_ref) {
    matchIdx = prevMessages.findIndex(
      (m) =>
        m.client_ref === incomingMessage.client_ref ||
        m.id === incomingMessage.client_ref
    );
  }

  // Priority 2: Match by album_id + album_index
  if (matchIdx === -1 && incomingMessage.album_id) {
    const incIndex =
      typeof incomingMessage.album_index === "number"
        ? incomingMessage.album_index
        : (incomingMessage.metadata as Record<string, unknown> | null)?.album_index;

    if (typeof incIndex === "number") {
      matchIdx = prevMessages.findIndex((m) => {
        if (m.album_id !== incomingMessage.album_id) return false;
        const mIndex =
          typeof m.album_index === "number"
            ? m.album_index
            : (m.metadata as Record<string, unknown> | null)?.album_index;
        return mIndex === incIndex;
      });
    }
  }

  // Priority 3: Match by album_id + media_url
  if (matchIdx === -1 && incomingMessage.album_id && incomingMessage.media_url) {
    matchIdx = prevMessages.findIndex(
      (m) =>
        m.album_id === incomingMessage.album_id &&
        m.media_url === incomingMessage.media_url
    );
  }

  // Priority 4: Single optimistic message fallback (NOT in an album)
  if (matchIdx === -1 && !incomingMessage.album_id) {
    matchIdx = prevMessages.findIndex(
      (m) =>
        m.id.startsWith("temp-") &&
        !m.album_id &&
        m.content_type === incomingMessage.content_type
    );
  }

  if (matchIdx !== -1) {
    // RECONCILE IN-PLACE
    const existing = prevMessages[matchIdx];

    // Seed/register existing local blob with new remote ID/key so resolution is instant
    const localBlob =
      getLocalMediaBlob(existing.id) ||
      (existing.media_url?.startsWith("blob:") ? existing.media_url : null);

    if (localBlob) {
      registerLocalMediaBlob(incomingMessage.id, localBlob);
      if (incomingMessage.media_url) {
        registerLocalMediaBlob(incomingMessage.media_url, localBlob);
      }
    }

    // Never let an unconfirmed status like 'sending' overwrite an already established 'failed' status
    const finalStatus =
      existing.status === "failed" && incomingMessage.status === "sending"
        ? "failed"
        : incomingMessage.status || existing.status;

    const reconciled: Message = {
      ...existing,
      ...incomingMessage,
      status: finalStatus,
      // Keep local blob reference if existing had one, guaranteeing zero flash
      media_url: localBlob || incomingMessage.media_url || existing.media_url,
      album_id: incomingMessage.album_id || existing.album_id,
      album_index:
        typeof incomingMessage.album_index === "number"
          ? incomingMessage.album_index
          : existing.album_index,
      client_ref: incomingMessage.client_ref || existing.client_ref,
      metadata: {
        ...(existing.metadata || {}),
        ...(incomingMessage.metadata || {}),
        album_id: incomingMessage.album_id || existing.album_id,
        album_index:
          typeof incomingMessage.album_index === "number"
            ? incomingMessage.album_index
            : existing.album_index,
      },
    };

    const copy = prevMessages.slice();
    copy[matchIdx] = reconciled;
    return { updatedMessages: copy, matched: true };
  }

  // Priority 5: Fallback slot match by album_id + album_index before appending
  if (incomingMessage.album_id) {
    const incIndex =
      typeof incomingMessage.album_index === "number"
        ? incomingMessage.album_index
        : (incomingMessage.metadata as Record<string, unknown> | null)?.album_index;

    if (typeof incIndex === "number") {
      const slotIdx = prevMessages.findIndex((m) => {
        if (m.album_id !== incomingMessage.album_id) return false;
        const mIndex =
          typeof m.album_index === "number"
            ? m.album_index
            : (m.metadata as Record<string, unknown> | null)?.album_index;
        return mIndex === incIndex;
      });

      if (slotIdx !== -1) {
        const copy = prevMessages.slice();
        const existingSlot = copy[slotIdx];
        const finalSlotStatus =
          existingSlot.status === "failed" && incomingMessage.status === "sending"
            ? "failed"
            : incomingMessage.status || existingSlot.status;
        copy[slotIdx] = { ...existingSlot, ...incomingMessage, status: finalSlotStatus };
        return { updatedMessages: copy, matched: true };
      }
    }
  }

  // No match: append as a new message
  return { updatedMessages: [...prevMessages, incomingMessage], matched: false };
}
