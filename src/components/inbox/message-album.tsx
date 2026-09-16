"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  CornerUpLeft,
  Forward,
  ImageOff,
  Play,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import { useResolvedMediaSrc, useResolvedMediaSrcs } from "@/lib/inbox/use-resolved-media-src";
import { getLocalVideoThumbnail } from "@/lib/media/video-thumbnail";
import { MessageActions } from "./message-actions";
import { MessageReactions } from "./message-reactions";
import { MediaLightbox } from "./media-lightbox";
import { FailedMediaViewer } from "./failed-media-viewer";
import { ForwardMessageDialog } from "./forward-message-dialog";
import { VideoAlbumViewer } from "./video-album-viewer";
import { calculateAlbumProgress } from "@/lib/inbox/optimistic-album";

// --- Grouping ------------------------------------------------------------
//
// `Message` (types/index.ts) grouping is derived from album_id / metadata.album_id
// as primary key (batch send), falling back to adjacent consecutiveness signals.
const ALBUM_MAX_GAP_MS = 8_000;

export interface AlbumGroup {
  /** First message's id or explicit album_id — stable across recomputation, used as the
   *  React key so the album's own local UI state (selection, lightbox)
   *  survives unrelated re-renders. */
  id: string;
  messages: Message[];
  albumId?: string;
}

/**
 * Walks the already-loaded, chronologically-ordered message list and
 * returns a `Map` from every grouped message's id to the `AlbumGroup` it
 * belongs to. Messages that don't qualify for grouping are simply absent
 * from the map.
 *
 * Prioritizes `album_id` / `metadata.album_id`:
 * - If 2+ messages share the same `album_id` (from the same conversation & sender),
 *   they belong unconditionally to the same album, regardless of any time gap.
 * - Original selection order is strictly preserved via album_index or created_at.
 * - For messages lacking an `album_id`, falls back to the temporal proximity rule.
 */
export function computeAlbumGroups(messages: Message[]): Map<string, AlbumGroup> {
  const result = new Map<string, AlbumGroup>();

  // Pass 1: Group by explicit album_id (batch send priority)
  const albumIdGroups = new Map<string, Message[]>();

  for (const m of messages) {
    const qualifies =
      (m.content_type === "image" || m.content_type === "video") && !!m.media_url;
    if (!qualifies) continue;

    const albumId = m.album_id || (m.metadata as Record<string, unknown> | undefined)?.album_id;
    if (albumId && typeof albumId === "string") {
      const key = `${m.conversation_id}:${m.sender_type}:${m.sender_id ?? ""}:${albumId}`;
      let list = albumIdGroups.get(key);
      if (!list) {
        list = [];
        albumIdGroups.set(key, list);
      }
      list.push(m);
    }
  }

  const processedMessageIds = new Set<string>();
  for (const rawList of albumIdGroups.values()) {
    // Deduplicate within the album group:
    // If both an optimistic temp message and a real DB message coexist during
    // the upload/reconciliation window, map them to their logical slot (album_index
    // or client_ref) and retain only the most up-to-date message for rendering.
    const dedupedSlotMap = new Map<string | number, Message>();

    for (const m of rawList) {
      const idx =
        typeof m.album_index === "number"
          ? m.album_index
          : (m.metadata as Record<string, unknown> | undefined)?.album_index;
      const clientRef = m.client_ref || (m.id.startsWith("temp-") ? m.id : undefined);

      const slotKey =
        typeof idx === "number"
          ? `idx_${idx}`
          : clientRef
          ? `ref_${clientRef}`
          : m.id;

      const existing = dedupedSlotMap.get(slotKey);
      if (!existing) {
        dedupedSlotMap.set(slotKey, m);
      } else {
        const mIsTemp = m.id.startsWith("temp-");
        const existingIsTemp = existing.id.startsWith("temp-");

        // Prefer confirmed DB record over optimistic temp record, but NEVER
        // overwrite a real failure with a generic 'sending' or unconfirmed state
        if (existing.status === "failed" && m.status === "sending") {
          dedupedSlotMap.set(slotKey, existing);
        } else if (m.status === "failed" && existing.status === "sending") {
          dedupedSlotMap.set(slotKey, m);
        } else if (existingIsTemp && !mIsTemp) {
          if (existing.status === "failed" && m.status !== "sent" && m.status !== "delivered" && m.status !== "read") {
            dedupedSlotMap.set(slotKey, existing);
          } else {
            dedupedSlotMap.set(slotKey, m);
          }
        } else if (existing.status === "sending" && m.status !== "sending") {
          dedupedSlotMap.set(slotKey, m);
        }
      }
    }

    const list = Array.from(dedupedSlotMap.values());

    if (list.length >= 2) {
      // Strictly preserve original selection order (album_index 0..N)
      list.sort((a, b) => {
        const idxA =
          typeof a.album_index === "number"
            ? a.album_index
            : (a.metadata as Record<string, unknown> | undefined)?.album_index;
        const idxB =
          typeof b.album_index === "number"
            ? b.album_index
            : (b.metadata as Record<string, unknown> | undefined)?.album_index;
        if (typeof idxA === "number" && typeof idxB === "number") return idxA - idxB;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      const albumIdVal =
        list[0].album_id ||
        (list[0].metadata as Record<string, unknown> | undefined)?.album_id;
      const group: AlbumGroup = {
        id: typeof albumIdVal === "string" && albumIdVal ? albumIdVal : list[0].id,
        messages: list,
        albumId: typeof albumIdVal === "string" ? albumIdVal : undefined,
      };

      // Register ALL raw message IDs to this album group so that neither the
      // deduplicated item nor any transient duplicate is rendered standalone.
      for (const m of rawList) {
        result.set(m.id, group);
        processedMessageIds.add(m.id);
      }
    }
  }

  // Pass 2: Fallback temporal clustering for messages without an album_id
  let run: Message[] = [];

  const flush = () => {
    if (run.length >= 2) {
      const group: AlbumGroup = { id: run[0].id, messages: run };
      for (const m of run) result.set(m.id, group);
    }
    run = [];
  };

  for (const m of messages) {
    if (processedMessageIds.has(m.id)) {
      flush();
      continue;
    }

    const qualifies =
      (m.content_type === "image" || m.content_type === "video") && !!m.media_url;
    if (!qualifies) {
      flush();
      continue;
    }

    const prev = run[run.length - 1];
    let continuesRun = false;
    if (
      prev &&
      prev.conversation_id === m.conversation_id &&
      prev.sender_type === m.sender_type &&
      prev.sender_id === m.sender_id &&
      // Never mix kinds in a fallback (non-album_id) run — a photo and a
      // video landing seconds apart are two separate sends, not a batch.
      prev.content_type === m.content_type
    ) {
      const gapMs = new Date(m.created_at).getTime() - new Date(prev.created_at).getTime();
      continuesRun = gapMs >= 0 && gapMs <= ALBUM_MAX_GAP_MS;
    }
    if (!continuesRun) flush();
    run.push(m);
  }
  flush();

  return result;
}

// --- Presentation ----------------------------------------------------------

export interface MessageAlbumProps {
  /** 2+ messages, already validated by computeAlbumGroups (or single if embedded). */
  messages: Message[];
  currentUserId?: string;
  /** ID of the contact whose conversation is currently open. */
  currentContactId?: string;
  /** Reactions on the album's first (representative) message — same
   *  convention MessageBubble already uses for a single message. */
  reactions?: MessageReaction[];
  onReply: (message: Message) => void;
  onReact: (messageId: string, emoji: string) => void;
  onDelete: (message: Message) => Promise<void> | void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onRetryMessage?: (message: Message) => void;
  onCancelMessage?: (message: Message) => void;
  onCancelAlbum?: (albumId: string) => void;
}

// Long-press timing/tolerance — same shape as the composer's own
// press-and-hold gesture (message-composer.tsx's LONG_PRESS_MS /
// TOUCH_MOVE_CANCEL_PX): a short timer armed on pointerdown, cancelled by
// any movement past a small tolerance so a natural finger wobble or the
// start of a real drag/scroll never falsely arms selection.
const ALBUM_LONG_PRESS_MS = 300;
const ALBUM_LONG_PRESS_MOVE_CANCEL_PX = 10;

function AlbumTile({
  url,
  overlayCount,
}: {
  url: string;
  /** When set and > 0, dims/blurs the tile and centers a "+N" count —
   *  used only on the 4th visible tile when the album has more than 4
   *  images. */
  overlayCount?: number;
}) {
  const { src, loading, error } = useResolvedMediaSrc(url);

  return (
    <div className="relative h-full w-full bg-muted/40 overflow-hidden">
      {error ? (
        <div className="flex h-full w-full items-center justify-center">
          <ImageOff className="h-6 w-6 text-muted-foreground" />
        </div>
      ) : loading || !src ? (
        <div className="flex h-full w-full items-center justify-center">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      )}

      {/* Overflow overlay on tile 3 (+N) */}
      {!!overlayCount && overlayCount > 0 && (
        <div className="absolute inset-0 flex items-center justify-center select-none backdrop-blur-[2px] bg-black/45">
          <span className="text-3xl font-medium text-white tracking-wide">+{overlayCount}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Video counterpart to AlbumTile — a static grid cell that only ever
 * shows a poster + play glyph (never a live `<video>`), matching the
 * same "instant, cheap tile" contract as the photo grid. Playback
 * itself happens in the fullscreen dialog opened by the album's own
 * tap handler (openAt), not here — reused as `resolvedUrl` there via
 * the album's shared `useResolvedMediaSrcs`.
 */
function VideoAlbumTile({
  message,
  overlayCount,
}: {
  message: Message;
  overlayCount?: number;
}) {
  const url = message.media_url!;
  const rawThumbnail = (message.metadata as Record<string, unknown> | undefined)?.thumbnail_url;
  const thumbnailUrl = typeof rawThumbnail === "string" ? rawThumbnail : null;
  // Same dual-source resolution as MediaVideo's poster (message-bubble.tsx):
  // a fresh send's `data:` URL is used directly, a persisted R2 key (after
  // reload) is resolved through the normal signed-URL pipeline.
  const { src: resolvedThumbnailSrc } = useResolvedMediaSrc(
    thumbnailUrl && !thumbnailUrl.startsWith("data:") ? thumbnailUrl : undefined,
  );
  const poster =
    (thumbnailUrl?.startsWith("data:") ? thumbnailUrl : resolvedThumbnailSrc) ||
    getLocalVideoThumbnail(url) ||
    getLocalVideoThumbnail(message.id) ||
    null;

  const isFailed =
    message.status === "failed" &&
    !Boolean((message.metadata as Record<string, unknown> | undefined)?.cancelled);
  const isSending = message.status === "sending";

  return (
    <div
      className={cn(
        "relative h-full w-full bg-black/30 overflow-hidden transition-all",
        isFailed && "ring-2 ring-inset ring-red-500/80"
      )}
    >
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={poster}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          className={cn("h-full w-full object-cover", isFailed && "opacity-85")}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/60 border-t-transparent" />
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        {isFailed ? (
          <div className="flex items-center gap-1 rounded-full bg-red-600/90 px-2 py-1 text-white shadow-lg backdrop-blur-sm animate-in fade-in zoom-in-90">
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="text-[10px] font-bold tracking-wide">Falha</span>
          </div>
        ) : isSending ? (
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white shadow backdrop-blur-sm">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
          </div>
        ) : (
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white shadow">
            <Play className="h-3.5 w-3.5 fill-white ml-0.5" />
          </div>
        )}
      </div>

      {!!overlayCount && overlayCount > 0 && (
        <div className="absolute inset-0 flex items-center justify-center select-none backdrop-blur-[2px] bg-black/45">
          <span className="text-3xl font-medium text-white tracking-wide">+{overlayCount}</span>
        </div>
      )}
    </div>
  );
}

function AlbumStatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-white" />;
    case "sent":
      return <Check className="h-3 w-3 text-white" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-white" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return <AlertCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function CentralAlbumProgress({
  total,
  completed,
  progressValue,
  onCancel,
}: {
  total: number;
  completed: number;
  progressValue?: number;
  onCancel?: () => void;
}) {
  const radius = 21;
  const circumference = 2 * Math.PI * radius; // ~131.95
  const rawProgress =
    typeof progressValue === "number"
      ? progressValue
      : total > 0
      ? completed / total
      : 0;
  // Minimum visible start arc (0.04) so user immediately sees active ring
  const progress = Math.min(1, Math.max(0.04, rawProgress));
  const strokeDashoffset = circumference - progress * circumference;

  return (
    <div className="pointer-events-auto absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex flex-col items-center justify-center gap-1 select-none">
      <div className="relative flex h-[50px] w-[50px] items-center justify-center rounded-full bg-black/45 shadow-[0_4px_16px_rgba(0,0,0,0.35)] backdrop-blur-md">
        <svg
          className="absolute inset-0 -rotate-90 pointer-events-none"
          width="50"
          height="50"
          viewBox="0 0 50 50"
        >
          <circle
            cx="25"
            cy="25"
            r={radius}
            stroke="rgba(255, 255, 255, 0.22)"
            strokeWidth="2"
            fill="transparent"
          />
          <circle
            cx="25"
            cy="25"
            r={radius}
            stroke="#FFFFFF"
            strokeWidth="2"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            fill="transparent"
            className="transition-[stroke-dashoffset] duration-300 ease-out"
          />
        </svg>

        {onCancel ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            className="group flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/10 active:scale-90 transition"
            title="Cancelar envio do álbum"
            aria-label="Cancelar envio do álbum"
          >
            <div className="h-3 w-3 rounded-[2px] bg-white group-hover:scale-105 transition-transform" />
          </button>
        ) : (
          <div className="h-3 w-3 rounded-[2px] bg-white" />
        )}
      </div>

      {total > 0 && (
        <span className="rounded-full bg-black/40 backdrop-blur-sm px-2 py-0.5 text-[10px] font-medium tracking-wide text-white/90 shadow-sm">
          {completed}/{total}
        </span>
      )}
    </div>
  );
}

function MessageAlbumComponent({
  messages,
  currentUserId,
  currentContactId,
  reactions,
  onReply,
  onReact,
  onDelete,
  onToggleReaction,
  onRetryMessage,
  onCancelAlbum,
}: MessageAlbumProps) {
  const t = useTranslations("Inbox.bubble");
  const tActions = useTranslations("Inbox.actions");
  const shadeFilterId = useId();

  const first = messages[0];
  const isAgent = first.sender_type === "agent" || first.sender_type === "bot";
  // A batch (shared album_id) is always homogeneous — see handleSendMediaBatch,
  // which never mixes kinds in one call — and computeAlbumGroups guards the
  // fallback (no album_id) grouping path the same way, so checking the
  // first message's kind is enough for the whole group.
  const isVideoAlbum = first.content_type === "video";
  const urls = useMemo(() => messages.map((m) => m.media_url!), [messages]);
  const { urls: resolvedUrls } = useResolvedMediaSrcs(urls);
  const lightboxImages = useMemo(
    () => urls.map((u, i) => resolvedUrls[i] || u),
    [urls, resolvedUrls],
  );

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [videoDialogIndex, setVideoDialogIndex] = useState<number | null>(null);
  const [selected, setSelected] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failedViewerOpen, setFailedViewerOpen] = useState(false);

  // Status and timing derivation
  const timeString = useMemo(() => {
    try {
      return new Date(first.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }, [first.created_at]);

  const progressSummary = useMemo(() => calculateAlbumProgress(messages), [messages]);
  const isAlbumSending = progressSummary.isSending;

  const albumStatus: Message["status"] = useMemo(() => {
    const hasSending = messages.some((m) => m.status === "sending");
    const hasFailed = messages.some(
      (m) => m.status === "failed" && !(m.metadata as Record<string, unknown> | undefined)?.cancelled
    );
    const allRead = messages.every((m) => m.status === "read");
    const allDelivered = messages.every(
      (m) => m.status === "delivered" || m.status === "read"
    );

    if (hasSending) return "sending";
    if (hasFailed) return "failed";
    if (allRead) return "read";
    if (allDelivered) return "delivered";
    return "sent";
  }, [messages]);

  // --- Long-press → select the whole album ---------------------------
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const justLongPressedRef = useRef(false);

  const clearPressTimer = useCallback(() => {
    if (pressTimerRef.current !== null) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pressStartRef.current = { x: e.clientX, y: e.clientY };
      clearPressTimer();
      pressTimerRef.current = setTimeout(() => {
        pressTimerRef.current = null;
        justLongPressedRef.current = true;
        setSelected((s) => !s);
      }, ALBUM_LONG_PRESS_MS);
    },
    [clearPressTimer],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = pressStartRef.current;
      if (!start || pressTimerRef.current === null) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > ALBUM_LONG_PRESS_MOVE_CANCEL_PX) clearPressTimer();
    },
    [clearPressTimer],
  );

  const handlePointerUp = useCallback(() => {
    clearPressTimer();
    pressStartRef.current = null;
  }, [clearPressTimer]);

  useEffect(() => clearPressTimer, [clearPressTimer]);

  const openAt = useCallback(
    (index: number) => {
      if (justLongPressedRef.current) {
        justLongPressedRef.current = false;
        return;
      }
      if (selected) {
        setSelected(false);
        return;
      }
      if (isVideoAlbum) {
        setVideoDialogIndex(index);
      } else {
        setLightboxIndex(index);
      }
    },
    [selected, isVideoAlbum],
  );

  // Reply-quote "jump to message" landing here: message-thread.tsx can
  // locate this album's own container (data-album-anchor-id) and scroll to
  // it directly, but it has no way to reach into this component's own
  // lightbox/video-dialog state — especially for an item past visibleCount,
  // which has no clickable tile of its own to target. A custom event
  // decouples the two: any album listens, and only the one actually
  // holding the target message id acts on it.
  useEffect(() => {
    const handler = (e: Event) => {
      const messageId = (e as CustomEvent<{ messageId: string }>).detail?.messageId;
      if (!messageId) return;
      const index = messages.findIndex((m) => m.id === messageId);
      if (index === -1) return;
      if (isVideoAlbum) setVideoDialogIndex(index);
      else setLightboxIndex(index);
    };
    window.addEventListener("wacrm:jump-to-album-item", handler);
    return () => window.removeEventListener("wacrm:jump-to-album-item", handler);
  }, [messages, isVideoAlbum]);

  const handleDeleteAlbum = useCallback(async () => {
    setDeleting(true);
    try {
      for (const m of messages) {
        await onDelete(m);
      }
      setSelected(false);
    } catch {
      toast.error(tActions("deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }, [messages, onDelete, tActions]);

  const visibleCount = Math.min(messages.length, 4);
  const overflowCount = messages.length > 4 ? messages.length - 4 : 0;
  const failedMessages = useMemo(() => {
    return messages.filter(
      (m) =>
        m.status === "failed" &&
        !Boolean((m.metadata as Record<string, unknown> | undefined)?.cancelled)
    );
  }, [messages]);
  const totalFailedCount = failedMessages.length;

  const gridClass = cn(
    "grid gap-0.5",
    messages.length === 1
      ? "h-60 w-60 grid-cols-1"
      : messages.length === 2
      ? "h-40 w-60 grid-cols-2"
      : "h-60 w-60 grid-cols-2 grid-rows-2",
  );

  return (
    <>
      <MessageActions
        message={first}
        currentContactId={currentContactId}
        onReply={onReply}
        onReact={onReact}
        onDelete={onDelete}
        forwardMessages={messages}
      >
        {(cornerAction) => (
        <div className="flex flex-col" style={{ alignItems: isAgent ? "flex-end" : "flex-start" }}>
          <div className="flex items-center gap-2">
            {isAgent && totalFailedCount > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (isVideoAlbum) {
                    const firstFailedIdx = messages.findIndex((m) => m.status === "failed");
                    openAt(firstFailedIdx !== -1 ? firstFailedIdx : 0);
                  } else {
                    setFailedViewerOpen(true);
                  }
                }}
                className="group flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-full bg-red-600 px-2 text-white shadow-md transition-transform hover:scale-105 active:scale-95 animate-in fade-in zoom-in-90 duration-200"
                title={
                  isVideoAlbum
                    ? "Falha no envio de vídeos. Toque para ver e reenviar."
                    : "Falha no envio de fotos. Toque para ver e reenviar."
                }
                aria-label={
                  isVideoAlbum ? "Falha no envio de vídeos do álbum" : "Falha no envio de fotos do álbum"
                }
              >
                <AlertCircle className="h-4 w-4 shrink-0 stroke-[2.5]" />
                {totalFailedCount > 1 && (
                  <span className="text-[11px] font-bold leading-none">{totalFailedCount}</span>
                )}
              </button>
            )}

            <div
              data-album-anchor-id={first.id}
              className={cn(
                "relative overflow-hidden rounded-2xl border-0 transition-[outline-color]",
                isAgent ? "rounded-br-md" : "rounded-bl-md",
                gridClass,
                selected ? "outline outline-2 outline-offset-2 outline-primary" : "outline-0",
              )}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              style={{ WebkitTouchCallout: "none" }}
            >
              {messages.slice(0, visibleCount).map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  data-message-id={m.id}
                  onClick={() => openAt(i)}
                  aria-label={isVideoAlbum ? t("video") : t("photo")}
                  className={cn(
                    "block h-full w-full cursor-zoom-in",
                    messages.length === 3 && i === 0 && "row-span-2",
                  )}
                >
                  {isVideoAlbum ? (
                    <VideoAlbumTile
                      message={m}
                      overlayCount={i === 3 ? overflowCount : undefined}
                    />
                  ) : (
                    <AlbumTile
                      url={resolvedUrls[i] || m.media_url!}
                      overlayCount={i === 3 ? overflowCount : undefined}
                    />
                  )}
                </button>
              ))}

              {/* Central Progress Indicator with Stop/Cancel button while album is sending */}
              {isAlbumSending && (
                <CentralAlbumProgress
                  total={progressSummary.total}
                  completed={progressSummary.completed}
                  progressValue={progressSummary.progress}
                  onCancel={() => {
                    const albumId =
                      first.album_id ||
                      (first.metadata as Record<string, unknown> | undefined)?.album_id;
                    if (albumId && typeof albumId === "string" && onCancelAlbum) {
                      onCancelAlbum(albumId);
                    }
                  }}
                />
              )}

              {/* WhatsApp-style bottom-right timestamp and status check footer */}
              <svg
                aria-hidden
                className="pointer-events-none absolute inset-0 z-[12] h-full w-full"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <defs>
                  <filter id={shadeFilterId} x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="8" />
                  </filter>
                </defs>
                <ellipse
                  cx="100"
                  cy="100"
                  rx="42"
                  ry="18"
                  fill="rgba(0,0,0,0.5)"
                  filter={`url(#${shadeFilterId})`}
                  transform="rotate(-40 100 100)"
                />
              </svg>
              <span className="pointer-events-none absolute bottom-[6px] right-2 z-[13] flex items-center gap-1 text-[11px] text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
                {timeString}
                {isAgent && <AlbumStatusIcon status={albumStatus} />}
              </span>

              {selected && (
                <div className="pointer-events-none absolute right-1.5 top-1.5 z-[14] flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="h-3 w-3" />
                </div>
              )}
              {!selected && cornerAction}
            </div>
          </div>

          {/* Selection action bar — reuses the exact same reply/forward/
              delete mechanisms MessageActions already wires up for a
              single message, just triggered from this album-specific
              long-press instead of the hover toolbar/context menu. */}
          {selected && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  onReply(first);
                  setSelected(false);
                }}
                className="flex h-7 items-center gap-1 rounded-full border border-border bg-popover px-2.5 text-[11px] text-popover-foreground hover:bg-muted"
              >
                <CornerUpLeft className="h-3 w-3" />
                {tActions("reply")}
              </button>
              <button
                type="button"
                onClick={() => setForwardOpen(true)}
                className="flex h-7 items-center gap-1 rounded-full border border-border bg-popover px-2.5 text-[11px] text-popover-foreground hover:bg-muted"
              >
                <Forward className="h-3 w-3" />
                {tActions("forward")}
              </button>
              {isAgent && (
                <button
                  type="button"
                  onClick={handleDeleteAlbum}
                  disabled={deleting}
                  className="flex h-7 items-center gap-1 rounded-full border border-border bg-popover px-2.5 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" />
                  {tActions("deleteMessage")}
                </button>
              )}
            </div>
          )}

          {reactions && reactions.length > 0 && (
            <MessageReactions
              reactions={reactions}
              currentUserId={currentUserId}
              onToggle={(emoji) => {
                const own = reactions.find(
                  (r) => r.actor_type === "agent" && r.actor_id === currentUserId,
                );
                const next = own?.emoji === emoji ? "" : emoji;
                onToggleReaction(first.id, next);
              }}
            />
          )}
        </div>
        )}
      </MessageActions>

      <MediaLightbox
        open={lightboxIndex !== null}
        onOpenChange={(next) => {
          if (!next) setLightboxIndex(null);
        }}
        src={lightboxImages[lightboxIndex ?? 0] ?? ""}
        alt={t("photo")}
        images={lightboxImages}
        initialIndex={lightboxIndex ?? 0}
        messages={messages}
        onRetryMessage={onRetryMessage}
      />

      {/* Video album centralized viewer with vertical navigation */}
      <VideoAlbumViewer
        open={videoDialogIndex !== null}
        onOpenChange={(next) => {
          if (!next) setVideoDialogIndex(null);
        }}
        messages={messages}
        initialIndex={videoDialogIndex ?? 0}
        onRetryMessage={onRetryMessage}
      />

      <ForwardMessageDialog
        message={null}
        messages={forwardOpen ? messages : null}
        open={forwardOpen}
        onOpenChange={setForwardOpen}
        currentContactId={currentContactId}
      />

      <FailedMediaViewer
        open={failedViewerOpen}
        onOpenChange={setFailedViewerOpen}
        failedMessages={failedMessages}
        onRetryMessage={onRetryMessage}
      />
    </>
  );
}

/**
 * Memoized: a thread can have several albums, and only the one(s) whose
 * own messages actually changed need to re-render. Effective as long as
 * `computeAlbumGroups` keeps producing the same message array reference
 * for an unchanged run — true except when the underlying `messages` prop
 * itself changes identity, same tradeoff MessageRow already accepts.
 */
export const MessageAlbum = memo(MessageAlbumComponent);
