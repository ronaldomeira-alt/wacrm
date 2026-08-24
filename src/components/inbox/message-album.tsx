"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CornerUpLeft, Forward, ImageOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import { useResolvedMediaSrc } from "@/lib/inbox/use-resolved-media-src";
import { MessageActions } from "./message-actions";
import { MessageReactions } from "./message-reactions";
import { MediaLightbox } from "./media-lightbox";
import { ForwardMessageDialog } from "./forward-message-dialog";

// --- Grouping ------------------------------------------------------------
//
// `Message` (types/index.ts) has no persisted batch/album id, so grouping
// is derived purely from safe consecutiveness signals already present in
// the loaded message list: strictly adjacent (no other message of any
// kind — including text — in between), same conversation, same sender,
// every message `content_type === 'image'`, and close enough in time to
// plausibly be one multi-file send. If any of that isn't unambiguous the
// run simply never forms — the images fall through to the existing,
// unchanged per-message bubble rendering.
//
// The gap threshold is generous on purpose: the composer's multi-file
// batch upload is sequential (see message-composer.tsx's handlePicked),
// so a slow network can space consecutive images out by a few seconds
// each without them actually being a different, unrelated send.
const ALBUM_MAX_GAP_MS = 8_000;

export interface AlbumGroup {
  /** First message's id — stable across recomputation, used as the
   *  React key so the album's own local UI state (selection, lightbox)
   *  survives unrelated re-renders. */
  id: string;
  messages: Message[];
}

/**
 * Walks the already-loaded, chronologically-ordered message list and
 * returns a `Map` from every grouped message's id to the `AlbumGroup` it
 * belongs to. Messages that don't qualify for grouping are simply absent
 * from the map. Pure and cheap (single pass, no I/O) — safe to call from
 * a `useMemo` keyed on the message array.
 */
export function computeAlbumGroups(messages: Message[]): Map<string, AlbumGroup> {
  const result = new Map<string, AlbumGroup>();
  let run: Message[] = [];

  const flush = () => {
    if (run.length >= 2) {
      const group: AlbumGroup = { id: run[0].id, messages: run };
      for (const m of run) result.set(m.id, group);
    }
    run = [];
  };

  for (const m of messages) {
    const qualifies = m.content_type === "image" && !!m.media_url;
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
      prev.sender_id === m.sender_id
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

interface MessageAlbumProps {
  /** 2+ messages, already validated by computeAlbumGroups. */
  messages: Message[];
  currentUserId?: string;
  /** Reactions on the album's first (representative) message — same
   *  convention MessageBubble already uses for a single message. */
  reactions?: MessageReaction[];
  onReply: (message: Message) => void;
  onReact: (messageId: string, emoji: string) => void;
  onDelete: (message: Message) => Promise<void> | void;
  onToggleReaction: (messageId: string, emoji: string) => void;
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
    <div className="relative h-full w-full bg-muted">
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
        <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />
      )}
      {!!overlayCount && overlayCount > 0 && (
        // Cheap overlay — opacity/backdrop-filter only, no per-frame
        // work and nothing that recomputes on scroll.
        <div className="absolute inset-0 flex items-center justify-center bg-black/45 backdrop-blur-[2px]">
          <span className="text-xl font-semibold text-white">+{overlayCount}</span>
        </div>
      )}
    </div>
  );
}

function MessageAlbumComponent({
  messages,
  currentUserId,
  reactions,
  onReply,
  onReact,
  onDelete,
  onToggleReaction,
}: MessageAlbumProps) {
  const t = useTranslations("Inbox.bubble");
  const tActions = useTranslations("Inbox.actions");

  const first = messages[0];
  const isAgent = first.sender_type === "agent" || first.sender_type === "bot";
  const urls = useMemo(() => messages.map((m) => m.media_url!), [messages]);

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [selected, setSelected] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // --- Long-press → select the whole album ---------------------------
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  // Set the instant the timer fires; consumed by the very next click (the
  // pointerup that ends a long-press also fires a synthetic click) so
  // that click doesn't immediately re-toggle what the long-press just set.
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

  // No preventDefault anywhere here — unlike swipe-to-reply, this gesture
  // never needs to beat the browser's own scroll: a real drag or scroll
  // simply exceeds the tolerance below and cancels the pending timer
  // before anything visual happens, leaving native scrolling untouched.
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
        // Tapping a selected album deselects it — same as a native
        // multi-select gallery — instead of opening the viewer.
        setSelected(false);
        return;
      }
      setLightboxIndex(index);
    },
    [selected],
  );

  const handleDeleteAlbum = useCallback(async () => {
    setDeleting(true);
    try {
      // Sequential, not Promise.all — mirrors the project's established
      // convention for multi-item operations (see message-composer.tsx's
      // batch upload) rather than firing every delete at once.
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
  const gridClass = cn(
    "grid gap-0.5",
    messages.length === 2 ? "h-40 w-60 grid-cols-2" : "h-60 w-60 grid-cols-2 grid-rows-2",
  );

  return (
    <>
      <MessageActions
        message={first}
        onReply={onReply}
        onReact={onReact}
        onDelete={onDelete}
        forwardMessages={messages}
      >
        <div className="flex flex-col" style={{ alignItems: isAgent ? "flex-end" : "flex-start" }}>
          <div
            className={cn(
              "relative overflow-hidden rounded-2xl outline-2 outline-offset-2 outline-primary transition-[outline-color]",
              isAgent ? "rounded-br-md" : "rounded-bl-md",
              gridClass,
              selected ? "outline" : "outline-0",
            )}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            // Suppresses iOS Safari's native long-press "save image" sheet
            // so our own long-press-to-select gesture can win instead —
            // tap-to-open and the swipe-to-reply gesture (owned by
            // MessageActions, unaffected by this) both still work exactly
            // as before.
            style={{ WebkitTouchCallout: "none" }}
          >
            {messages.slice(0, visibleCount).map((m, i) => (
              <button
                key={m.id}
                type="button"
                onClick={() => openAt(i)}
                aria-label={t("photo")}
                className={cn(
                  "block h-full w-full cursor-zoom-in",
                  messages.length === 3 && i === 0 && "row-span-2",
                )}
              >
                <AlbumTile url={m.media_url!} overlayCount={i === 3 ? overflowCount : undefined} />
              </button>
            ))}

            {selected && (
              <div className="pointer-events-none absolute right-1.5 top-1.5 z-[1] flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="h-3 w-3" />
              </div>
            )}
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
      </MessageActions>

      <MediaLightbox
        open={lightboxIndex !== null}
        onOpenChange={(next) => {
          if (!next) setLightboxIndex(null);
        }}
        src={urls[lightboxIndex ?? 0] ?? ""}
        alt={t("photo")}
        images={urls}
        initialIndex={lightboxIndex ?? 0}
      />

      <ForwardMessageDialog
        message={null}
        messages={forwardOpen ? messages : null}
        open={forwardOpen}
        onOpenChange={setForwardOpen}
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
