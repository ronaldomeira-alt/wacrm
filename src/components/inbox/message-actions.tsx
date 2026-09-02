"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronDown,
  Copy,
  CornerUpLeft,
  FileText,
  Forward,
  Loader2,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { EmojiPicker } from "frimousse";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { Message } from "@/types";
import { useTranslations } from "next-intl";
import { ForwardMessageDialog } from "./forward-message-dialog";

// WhatsApp's own quick-reaction bar starts with these. Kept to the 5 most
// commonly used so a 6th slot is free for "more reactions" (see
// `emojiPickerOpen` below) — same shape as WhatsApp/Slack/Discord's own
// quick-bar-plus-full-picker pattern.
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢"];

// Content types the "Copiar"/"Apagar"/"Encaminhar" menu items apply to —
// mirrors the equivalent gates in the composer and, for forward, the
// server-side check in /api/whatsapp/forward. Location/template/
// interactive messages don't have a plain resendable/copyable body.
const FORWARDABLE_TYPES = new Set(["text", "image", "video", "document", "audio"]);
const DELETABLE_TYPES = FORWARDABLE_TYPES;

// --- Swipe-to-reply (mobile/PWA) ---------------------------------------
// WhatsApp-iOS-style: dragging any bubble left-to-right arms/triggers a
// reply, without needing the hover toolbar or the long-press menu.
// Reuses the same *approach* as the conversation list's own swipe-to-
// reveal (native non-passive touch listeners so `preventDefault()` can
// actually beat the browser's own scroll, plus a real mass-spring-damper
// settle instead of a fixed-duration CSS transition — see
// conversation-list.tsx for the fuller on-device rationale) —
// reimplemented locally rather than shared, since this gesture's shape
// (one-directional, momentary, always springs back to 0) is different
// enough from that swipe's persisted "revealed" panel that sharing code
// would mean threading unrelated concepts through one abstraction.
// Right-to-left never arms anything (checked via `dx <= 0` below).

// Up to this many px, the bubble tracks the finger ~1:1.
const REPLY_SWIPE_LINEAR_PX = 56;
// Visual (post-resistance) position needed to arm the reply — inside the
// elastic zone, so the resistance is what the agent feels build up right
// before the gesture "catches" (matches native WhatsApp's feel).
const REPLY_SWIPE_THRESHOLD_PX = 64;
// Rubber-band curve scale for the resistance phase beyond the linear
// distance — same curve (and constant) Apple's UIScrollView uses, also
// used by the conversation list's own swipe, just applied over a much
// shorter travel here.
const REPLY_SWIPE_RUBBER_BAND_DIMENSION = 72;
const REPLY_SWIPE_RUBBER_BAND_CONSTANT = 0.55;
// Axis-lock guards — same values as the conversation list's swipe,
// proven on-device not to misfire against ordinary vertical scroll or a
// touchscreen's noisy first sample(s).
const REPLY_SWIPE_AXIS_THRESHOLD = 10;
const REPLY_SWIPE_AXIS_RATIO = 2.5;
// Settle back to 0 short and smooth — no exaggerated overshoot. Same
// SwiftUI-style response/dampingRatio spring model as the conversation
// list's own swipe (see settleSpring there), tuned snappier and
// critically damped (dampingRatio 1 → zero overshoot) instead of that
// swipe's slightly bouncy reveal settle: "puxei → soltei → voltou", not
// a linear/ease-in-out tween and not an instant snap.
const REPLY_SWIPE_SPRING_RESPONSE = 0.22;
const REPLY_SWIPE_SPRING_DAMPING_RATIO = 1;
const REPLY_SWIPE_SPRING_MASS = 1;
const REPLY_SWIPE_SPRING_REST_DISPLACEMENT = 0.5;
const REPLY_SWIPE_SPRING_REST_VELOCITY = 20;

function replySwipeRubberBand(overshoot: number, dimension: number): number {
  return (
    (overshoot * dimension * REPLY_SWIPE_RUBBER_BAND_CONSTANT) /
    (dimension + REPLY_SWIPE_RUBBER_BAND_CONSTANT * overshoot)
  );
}

// Raw finger delta → the bubble's actual visual offset: 1:1 up to
// REPLY_SWIPE_LINEAR_PX, then eased via the rubber-band curve. Swiping
// left (dx <= 0) never moves the bubble.
function replySwipeVisualX(dx: number): number {
  if (dx <= 0) return 0;
  if (dx <= REPLY_SWIPE_LINEAR_PX) return dx;
  return (
    REPLY_SWIPE_LINEAR_PX +
    replySwipeRubberBand(dx - REPLY_SWIPE_LINEAR_PX, REPLY_SWIPE_RUBBER_BAND_DIMENSION)
  );
}

interface MessageActionsProps {
  message: Message;
  /**
   * All three callbacks take the message (or its id) explicitly so the
   * caller can pass one stable function shared across every message
   * instead of a per-message closure — required for `memo()` below to
   * actually skip re-renders.
   */
  onReply: (message: Message) => void;
  onReact: (messageId: string, emoji: string) => void;
  /** Delete this (agent-sent) message. Awaited so the confirm dialog can
   *  show a spinner and stay open on failure. */
  onDelete: (message: Message) => Promise<void> | void;
  /**
   * Album context: when set, "Encaminhar" forwards every message in this
   * array (in order) instead of just `message` — same ForwardMessageDialog
   * mechanism underneath, just given more than one target. Absent for a
   * regular single-message bubble.
   */
  forwardMessages?: Message[];
  /**
   * Reveals a customer voice note's transcript. Never invoked for the
   * agent's own audio — see `canTranscribe` below, which gates the menu
   * item itself. Resolves once the text is available (already cached on
   * `message.transcript_text`, or freshly fetched from
   * /api/ai/transcribe) — the caller is responsible for storing it back
   * onto the message so the bubble can render it.
   */
  onTranscribe?: (message: Message) => Promise<void> | void;
  /**
   * Render-prop instead of a plain node: the chevron trigger + dropdown
   * menu (`cornerAction`) needs to live *inside* `<MessageBubble>`'s own
   * bubble box (its `relative rounded-2xl` div) so it can be positioned
   * at that box's actual top-right corner — the bubble hugs its content
   * width, so anchoring from this wrapper (which spans up to 75% of the
   * row) would misplace it for any bubble narrower than that cap.
   */
  children: (cornerAction: ReactNode) => ReactNode;
}

/**
 * Right-click/long-press context menu wrapper around a `<MessageBubble>`.
 * The bubble itself stays a pure presenter — this component owns the
 * action surface (state + handlers) and hands the bubble a `cornerAction`
 * node (chevron trigger + dropdown) to render in its own top-right corner.
 *
 * Two ways in, same menu: a small chevron sits in the bubble's corner at
 * all times (per WhatsApp/iMessage-style low-key affordance) — clicking/
 * tapping it opens the menu. A right-click (desktop) or long-press
 * (mobile — the browser fires `contextmenu` for that natively) opens the
 * exact same controlled menu directly, without needing the chevron.
 */
function MessageActionsComponent({
  message,
  onReply,
  onReact,
  onDelete,
  forwardMessages,
  onTranscribe,
  children,
}: MessageActionsProps) {
  const t = useTranslations("Inbox.actions");

  // Long-press fires `contextmenu` on touch devices; we capture it and
  // open the same controlled menu directly (see handleContextMenu below).
  const [menuOpen, setMenuOpen] = useState(false);
  // Swaps the menu's content in place (quick reactions + actions →
  // search + full emoji grid) instead of opening a second nested
  // floating layer — a Menu-within-a-Menu popover risks the outer one
  // treating focus moving into the nested one as an outside interaction
  // and closing itself. Reset whenever the menu itself closes, so it
  // always reopens on the default view.
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);

  // Swipe-to-reply — the drag itself writes straight to the DOM (no
  // setState mid-gesture, no re-render per frame); see the constants
  // block above for the physics rationale.
  const swipeContentRef = useRef<HTMLDivElement>(null);
  const swipeIndicatorRef = useRef<HTMLDivElement>(null);
  const swipeCurrentXRef = useRef(0);
  const swipeSpringFrameRef = useRef<number | null>(null);
  const swipeDragRef = useRef({
    active: false,
    axis: null as "x" | "y" | null,
    startX: 0,
    startY: 0,
  });

  const cancelSwipeSpring = useCallback(() => {
    if (swipeSpringFrameRef.current !== null) {
      cancelAnimationFrame(swipeSpringFrameRef.current);
      swipeSpringFrameRef.current = null;
    }
  }, []);

  // Writes the bubble's translateX and the reply-indicator's opacity/
  // scale for one frame — shared by both the live drag and the settle
  // spring below so they never fall out of sync with each other.
  const applySwipeVisual = useCallback((x: number) => {
    const el = swipeContentRef.current;
    if (el) el.style.transform = x === 0 ? "" : `translate3d(${x}px,0,0)`;
    swipeCurrentXRef.current = x;
    const indicator = swipeIndicatorRef.current;
    if (indicator) {
      const progress = Math.min(1, Math.max(0, x / REPLY_SWIPE_THRESHOLD_PX));
      indicator.style.opacity = String(progress);
      indicator.style.transform = `translate3d(0,-50%,0) scale(${0.7 + progress * 0.3})`;
    }
  }, []);

  // Mass-spring-damper settle back to 0, stepped every
  // requestAnimationFrame — not a fixed-duration CSS transition, so a
  // fast release and a slow one can still both resolve to the same
  // short, no-overshoot "puxei → soltei → voltou" feel via
  // REPLY_SWIPE_SPRING_DAMPING_RATIO=1 (critically damped) rather than
  // needing release velocity to shape it. Interruptible: a new touch
  // starting mid-bounce cancels this first (see handleTouchStart below).
  const settleSwipeSpring = useCallback(() => {
    cancelSwipeSpring();
    let pos = swipeCurrentXRef.current;
    let vel = 0;
    let lastTime: number | null = null;
    const angularFreq = (2 * Math.PI) / REPLY_SWIPE_SPRING_RESPONSE;
    const stiffness = angularFreq * angularFreq * REPLY_SWIPE_SPRING_MASS;
    const damping = 2 * REPLY_SWIPE_SPRING_DAMPING_RATIO * angularFreq * REPLY_SWIPE_SPRING_MASS;

    function frame(time: number) {
      if (lastTime === null) lastTime = time;
      const dt = Math.min((time - lastTime) / 1000, 1 / 30);
      lastTime = time;
      const accel = (-stiffness * pos - damping * vel) / REPLY_SWIPE_SPRING_MASS;
      vel += accel * dt;
      pos += vel * dt;
      const settled =
        Math.abs(pos) < REPLY_SWIPE_SPRING_REST_DISPLACEMENT &&
        Math.abs(vel) < REPLY_SWIPE_SPRING_REST_VELOCITY;
      if (settled) {
        applySwipeVisual(0);
        swipeSpringFrameRef.current = null;
        return;
      }
      applySwipeVisual(pos);
      swipeSpringFrameRef.current = requestAnimationFrame(frame);
    }
    swipeSpringFrameRef.current = requestAnimationFrame(frame);
  }, [applySwipeVisual, cancelSwipeSpring]);

  // Belt-and-suspenders: cancel any running spring loop on unmount so it
  // never writes to a detached node.
  useEffect(() => cancelSwipeSpring, [cancelSwipeSpring]);

  useEffect(() => {
    const el = swipeContentRef.current;
    if (!el) return;

    function handleTouchStart(e: TouchEvent) {
      const touch = e.touches[0];
      if (!touch) return;
      // Grabbing the bubble mid-bounce from a previous gesture continues
      // from wherever it actually is, not a jump back to 0.
      cancelSwipeSpring();
      swipeDragRef.current = {
        active: true,
        axis: null,
        startX: touch.clientX,
        startY: touch.clientY,
      };
    }

    function handleTouchMove(e: TouchEvent) {
      const drag = swipeDragRef.current;
      if (!drag.active) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - drag.startX;
      const dy = touch.clientY - drag.startY;

      if (drag.axis === null) {
        // Vertical wins on the first sign of doubt — same bias as the
        // conversation list's swipe: it's far worse to accidentally eat
        // a scroll than to occasionally need a slightly more deliberate
        // swipe. Horizontal only locks once it's unambiguous AND
        // rightward (leftward never arms this gesture).
        if (Math.abs(dy) >= REPLY_SWIPE_AXIS_THRESHOLD && Math.abs(dy) >= Math.abs(dx)) {
          drag.axis = "y";
        } else if (
          dx > 0 &&
          Math.abs(dx) >= REPLY_SWIPE_AXIS_THRESHOLD &&
          Math.abs(dx) > Math.abs(dy) * REPLY_SWIPE_AXIS_RATIO
        ) {
          drag.axis = "x";
        } else if (Math.abs(dx) >= REPLY_SWIPE_AXIS_THRESHOLD) {
          // Horizontal-dominant but leftward, or not decisive enough —
          // never becomes this gesture; resolving to "y" here lets
          // vertical scroll keep working uninterrupted.
          drag.axis = "y";
        } else {
          return; // not enough signal yet either way
        }
      }
      if (drag.axis === "y") return;

      // Locked horizontal — this is our gesture now, not the page's
      // scroll. Only possible because this listener is native and
      // non-passive (React's touch props can't call preventDefault on a
      // passive listener).
      e.preventDefault();
      applySwipeVisual(replySwipeVisualX(dx));
    }

    function handleTouchEnd() {
      const drag = swipeDragRef.current;
      if (!drag.active) return;
      drag.active = false;
      if (drag.axis !== "x") return;
      // Past-threshold at release arms the reply — reuses the exact same
      // onReply the hover-toolbar menu's "Responder" item already calls,
      // so there's only ever one reply code path.
      const armed = swipeCurrentXRef.current >= REPLY_SWIPE_THRESHOLD_PX;
      settleSwipeSpring();
      if (armed) onReply(message);
    }

    // touchmove is the only listener that ever calls preventDefault, and
    // only once the gesture is confirmed horizontal — so it can't be
    // passive; the rest never block the browser's own handling.
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
    el.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [applySwipeVisual, settleSwipeSpring, cancelSwipeSpring, onReply, message]);

  const isAgent =
    message.sender_type === "agent" || message.sender_type === "bot";
  const canCopy = message.content_type === "text";
  const canForward = FORWARDABLE_TYPES.has(message.content_type);
  const canDelete = isAgent && DELETABLE_TYPES.has(message.content_type);
  // Customer voice notes only — never the agent's own (product decision
  // 2026-09-01: this is about surfacing the CUSTOMER's stated intent,
  // not a general-purpose transcription tool). Shown even once already
  // transcribed — see handleTranscribe, it becomes a free "show it again
  // under the bubble" tap instead of disappearing.
  const canTranscribe = !isAgent && message.content_type === "audio";
  const [transcribing, setTranscribing] = useState(false);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuOpen(true);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(message);
      setDeleteConfirmOpen(false);
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setDeleting(false);
    }
  };

  const handleCopy = async () => {
    const text = message.content_text ?? "";
    if (!text) {
      toast.error(t("nothingToCopy"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const handleTranscribe = async () => {
    if (!onTranscribe || transcribing) return;
    setTranscribing(true);
    try {
      await onTranscribe(message);
    } catch {
      toast.error(t("transcribeFailed"));
    } finally {
      setTranscribing(false);
    }
  };

  const handlePickEmoji = (emoji: string) => {
    onReact(message.id, emoji);
    setMenuOpen(false);
  };

  // The corner trigger + its menu — handed to `children()` so
  // `<MessageBubble>` can render it inside its own bubble box, anchored to
  // that box's actual top-right corner (see the `children` prop doc).
  const cornerAction = (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
        if (!open) setEmojiPickerOpen(false);
      }}
    >
      {/* Always present at low opacity — "part of the bubble" rather than
          a hover-revealed control — brightening on hover/focus and while
          the menu is open, where it also rotates 180°. `h-8 w-8` keeps a
          real 32px tap target around the smaller 15px glyph. */}
      <DropdownMenuTrigger
        aria-label={t("openMenu")}
        className={cn(
          "absolute right-2.5 top-2.5 z-10 flex h-8 w-8 items-center justify-center rounded-full opacity-40 outline-none transition-[opacity,transform] duration-150 ease-out hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-current data-popup-open:rotate-180 data-popup-open:opacity-100",
          isAgent ? "text-primary-foreground" : "text-muted-foreground",
        )}
      >
        <ChevronDown className="h-[15px] w-[15px]" strokeWidth={2.25} />
      </DropdownMenuTrigger>
      {/* Dark, glass-like surface regardless of app theme (Apple
          Messages/Linear/Arc-style elevated menu) — always anchored so it
          grows from the chevron, i.e. from the bubble's own top-right
          corner, never centered or floating away from the message. Wider
          while the full emoji picker is showing — it needs the room a
          reaction/action list doesn't. */}
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className={cn(
          "rounded-2xl border-none bg-zinc-900/95 p-1.5 text-zinc-100 shadow-xl ring-1 ring-white/10 backdrop-blur-md",
          emojiPickerOpen ? "w-72" : "w-56",
        )}
      >
        {emojiPickerOpen ? (
          <div className="flex flex-col">
            <div className="mb-1 flex items-center gap-1 px-0.5 pt-0.5">
              <button
                type="button"
                onClick={() => setEmojiPickerOpen(false)}
                aria-label={t("back")}
                className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <span className="text-[13px] font-medium text-zinc-200">
                {t("chooseReaction")}
              </span>
            </div>
            {/* frimousse — unstyled/composable emoji picker; visual styling
                lives in globals.css via its `[frimousse-*]` attribute
                selectors (see the comment there), since those aren't
                reachable through `className` the way Tailwind utilities
                are. Selecting an emoji reuses the exact same
                handlePickEmoji the quick-reaction row below already
                calls — one single "apply a reaction" path either way. */}
            <EmojiPicker.Root
              onEmojiSelect={(emoji) => handlePickEmoji(emoji.emoji)}
              columns={8}
            >
              <EmojiPicker.Search
                placeholder={t("searchReaction")}
                className="mb-1.5"
                // base-ui's DropdownMenu implements its own "type a
                // letter to jump to a matching item" behavior on any
                // keydown that bubbles up to it — including from this
                // plain-text search input — and calls preventDefault()
                // unconditionally, so every keystroke was silently
                // swallowed before React could ever update the input's
                // value. Stopping propagation here (standard React
                // event handling, not a base-ui/frimousse workaround)
                // keeps the keystroke local to the input; frimousse's
                // own search/grid keyboard handling is attached to this
                // same element, so it's unaffected.
                onKeyDown={(e) => e.stopPropagation()}
              />
              <EmojiPicker.Viewport className="h-64">
                <EmojiPicker.Loading className="flex h-full items-center justify-center text-xs text-zinc-500">
                  {t("loadingEmojis")}
                </EmojiPicker.Loading>
                <EmojiPicker.Empty className="flex h-full items-center justify-center text-xs text-zinc-500">
                  {t("noEmojiFound")}
                </EmojiPicker.Empty>
                <EmojiPicker.List />
              </EmojiPicker.Viewport>
            </EmojiPicker.Root>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-0.5 px-1 pb-1.5">
              {QUICK_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => handlePickEmoji(e)}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-transform hover:scale-125 hover:bg-white/10"
                  aria-label={t("reactWith", { emoji: e })}
                >
                  {e}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setEmojiPickerOpen(true)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
                aria-label={t("moreReactions")}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </div>
            <DropdownMenuSeparator className="-mx-1.5 bg-white/10" />
            <DropdownMenuItem
              className="h-11 rounded-xl px-2.5 text-[13px] text-zinc-100 focus:bg-white/10 focus:text-zinc-50"
              onClick={() => onReply(message)}
            >
              <CornerUpLeft className="text-zinc-400" />
              {t("reply")}
            </DropdownMenuItem>
            {canForward && (
              <DropdownMenuItem
                className="h-11 rounded-xl px-2.5 text-[13px] text-zinc-100 focus:bg-white/10 focus:text-zinc-50"
                onClick={() => setForwardOpen(true)}
              >
                <Forward className="text-zinc-400" />
                {t("forward")}
              </DropdownMenuItem>
            )}
            {canCopy && (
              <DropdownMenuItem
                className="h-11 rounded-xl px-2.5 text-[13px] text-zinc-100 focus:bg-white/10 focus:text-zinc-50"
                onClick={handleCopy}
              >
                <Copy className="text-zinc-400" />
                {t("copyText")}
              </DropdownMenuItem>
            )}
            {canTranscribe && (
              // Amber — same tone already used for dropdown items elsewhere
              // (e.g. "Pendente" in message-thread.tsx's conversation menu),
              // not a new color.
              <DropdownMenuItem
                className="h-11 rounded-xl px-2.5 text-[13px] text-amber-400 focus:bg-amber-400/10 focus:text-amber-400"
                onClick={handleTranscribe}
                disabled={transcribing}
              >
                {transcribing ? <Loader2 className="animate-spin" /> : <FileText />}
                {t("transcribe")}
              </DropdownMenuItem>
            )}
            {/* WhatsApp only lets you delete messages you sent — never
                the other party's. */}
            {canDelete && (
              <DropdownMenuItem
                className="h-11 rounded-xl px-2.5 text-[13px]"
                variant="destructive"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 />
                {t("deleteMessage")}
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div
      className={cn(
        "flex w-full",
        isAgent ? "justify-end" : "justify-start",
      )}
      onContextMenu={handleContextMenu}
    >
      {/* `min-w-0` lets this flex child actually respect the 75% cap.
       *  Default `min-width: auto` lets content (a long quote preview,
       *  an unbroken URL) push past the cap and shove the row past
       *  100%, which used to bleed across into the contact-sidebar
       *  area. See issue #165.
       *
       *  No `select-none`/`touch-callout:none` here (on purpose — this
       *  used to force-disable selection so a mobile long-press would
       *  reliably fire `onContextMenu` instead of racing the native
       *  text-selection gesture). Native selection now wins that race
       *  deliberately: agents can select/copy a snippet of a message
       *  body, on both desktop (drag + Ctrl/Cmd-C) and mobile (long-
       *  press → native handles + callout). This menu stays reachable
       *  via desktop right-click and the corner chevron either way. */}
      <div className="relative min-w-0 max-w-[75%]">
        {/* Swipe-to-reply indicator — fades/scales in as the bubble is
            dragged right; purely cosmetic, driven imperatively by the
            touch handlers above (opacity/transform only, never a
            re-render mid-gesture). Anchored to the bubble's own resting
            left edge, so it reads as emerging from behind it exactly as
            the bubble slides away — identical for inbound/outbound
            bubbles since this container's own box never resizes during
            the gesture, only `swipeContentRef`'s transform does. */}
        <div
          ref={swipeIndicatorRef}
          aria-hidden
          className="pointer-events-none absolute left-0 top-1/2 z-0 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full bg-muted text-muted-foreground opacity-0"
          style={{ transform: "translate3d(0,-50%,0) scale(0.7)" }}
        >
          <CornerUpLeft className="h-3.5 w-3.5" />
        </div>
        <div ref={swipeContentRef} className="relative z-[1]">
          {children(cornerAction)}
        </div>
      </div>

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("deleteConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("deleteConfirmDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteConfirmOpen(false)}
              disabled={deleting}
            >
              {t("cancel")}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {t("deleteConfirmButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ForwardMessageDialog
        message={forwardOpen ? message : null}
        messages={forwardOpen ? forwardMessages : null}
        open={forwardOpen}
        onOpenChange={setForwardOpen}
      />
    </div>
  );
}

/**
 * Memoized: a message thread can render hundreds of these, and only the
 * one(s) whose message actually changed need to re-render. Effective as
 * long as callers pass stable prop references — see the doc on
 * MessageActionsProps and MessageThread's call site.
 */
export const MessageActions = memo(MessageActionsComponent);
