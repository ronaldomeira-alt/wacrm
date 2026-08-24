"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useTranslations } from "next-intl";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MAX_DELAY_MS = 300;
const DOUBLE_TAP_MAX_DISTANCE_PX = 24;

interface MediaLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already-resolved src (blob: URL for proxy-backed media, or a plain
   *  URL) — passed in rather than fetched here so opening the lightbox
   *  never re-downloads an image the bubble already loaded. Used as-is
   *  when `images` is omitted; otherwise only a fallback if `images`
   *  turns out empty. */
  src: string;
  alt: string;
  /**
   * Album context: sibling images (already-resolved srcs, same
   * convention as `src`) to scroll through vertically, iPhone-Photos-
   * style — see the component doc. Omit for the existing single-image
   * behavior; every current caller keeps working unchanged.
   */
  images?: string[];
  /** Index into `images` to open on. Ignored when `images` is omitted. */
  initialIndex?: number;
}

/**
 * Full-bleed image viewer. Reuses the shared Dialog primitive rather
 * than a bespoke overlay, just overriding DialogContent to fill the
 * screen instead of the default centered card.
 *
 * Two modes, chosen by whether `images` has more than one entry:
 *  - Single image (the default — every existing caller): hand-rolled
 *    pinch-zoom + pan (Pointer Events — no library; the project has
 *    none and this is the only place that needs it) plus double-tap-to-
 *    zoom and a mouse wheel fallback for desktop.
 *  - Album (2+ images): no zoom/pan, no arrow buttons — a native
 *    vertical `scroll-snap` list, iPhone-Photos-style. The browser's own
 *    scroll physics (touch, trackpad, or mouse wheel) drive it; the
 *    counter tracks whichever image is currently snapped into view.
 */
export function MediaLightbox({
  open,
  onOpenChange,
  src,
  alt,
  images,
  initialIndex = 0,
}: MediaLightboxProps) {
  const t = useTranslations("Inbox.bubble");
  const items = images && images.length > 0 ? images : [src];
  const [index, setIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Pointer-gesture bookkeeping lives in refs, not state — it changes on
  // every pointermove and must never trigger a re-render mid-gesture.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gestureStart = useRef({
    scale: 1,
    tx: 0,
    ty: 0,
    distance: 0,
    midX: 0,
    midY: 0,
  });
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  // Closing (any path — backdrop click, Escape, close button) always
  // resets zoom/pan so the next image this lightbox is reused for (a
  // different message) doesn't inherit the previous one's state.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset]
  );

  // Sync to whichever image the caller opened on, and reset zoom — runs
  // on every open (not just mount) since this same lightbox instance is
  // reused across different messages/albums.
  useEffect(() => {
    if (!open) return;
    setIndex(initialIndex);
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialIndex]);

  const isAlbum = items.length > 1;
  const currentSrc = items[index] ?? items[0] ?? "";

  // --- Album mode: vertical scroll-snap, index follows scroll ---------
  const albumScrollRef = useRef<HTMLDivElement>(null);
  const albumScrollRafRef = useRef<number | null>(null);

  // Land on whichever image the caller opened at. Deferred one frame so
  // the container (freshly mounted when the dialog opens) has already
  // been laid out — setting scrollTop before that is a no-op in some
  // browsers.
  useEffect(() => {
    if (!open || !isAlbum) return;
    const raf = requestAnimationFrame(() => {
      const el = albumScrollRef.current;
      if (el) el.scrollTop = initialIndex * el.clientHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [open, isAlbum, initialIndex]);

  // Cheap: one rAF-throttled read of scrollTop/clientHeight per frame,
  // no per-render work and nothing that runs outside an active scroll.
  const handleAlbumScroll = useCallback(() => {
    if (albumScrollRafRef.current !== null) return;
    albumScrollRafRef.current = requestAnimationFrame(() => {
      albumScrollRafRef.current = null;
      const el = albumScrollRef.current;
      if (!el || el.clientHeight <= 0) return;
      const next = Math.min(
        Math.max(Math.round(el.scrollTop / el.clientHeight), 0),
        items.length - 1,
      );
      setIndex((prev) => (prev === next ? prev : next));
    });
  }, [items.length]);

  useEffect(() => {
    return () => {
      if (albumScrollRafRef.current !== null) cancelAnimationFrame(albumScrollRafRef.current);
    };
  }, []);

  function clampTranslate(nextScale: number, nextTx: number, nextTy: number) {
    // Keeps the image from being panned entirely off-screen once
    // zoomed — bound the translate to how far the scaled image
    // actually overhangs the (unscaled) viewport box on each axis.
    const el = containerRef.current;
    if (!el) return { tx: nextTx, ty: nextTy };
    const { width, height } = el.getBoundingClientRect();
    const maxX = (width * (nextScale - 1)) / 2;
    const maxY = (height * (nextScale - 1)) / 2;
    return {
      tx: Math.min(maxX, Math.max(-maxX, nextTx)),
      ty: Math.min(maxY, Math.max(-maxY, nextTy)),
    };
  }

  function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function handlePointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gestureStart.current = {
        scale,
        tx,
        ty,
        distance: distanceBetween(a, b),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      };
    } else if (pointers.current.size === 1 && scale > 1) {
      setDragging(true);
      gestureStart.current = { ...gestureStart.current, scale, tx, ty, midX: e.clientX, midY: e.clientY };
    }
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const newDistance = distanceBetween(a, b);
      if (gestureStart.current.distance === 0) return;
      const rawScale =
        gestureStart.current.scale * (newDistance / gestureStart.current.distance);
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, rawScale));
      // Anchor the zoom on the pinch midpoint rather than the image
      // center, so the point between the two fingers stays put.
      const scaleRatio = nextScale / gestureStart.current.scale;
      const nextTx = gestureStart.current.tx * scaleRatio;
      const nextTy = gestureStart.current.ty * scaleRatio;
      const clamped = clampTranslate(nextScale, nextTx, nextTy);
      setScale(nextScale);
      setTx(clamped.tx);
      setTy(clamped.ty);
    } else if (pointers.current.size === 1 && dragging) {
      const dx = e.clientX - gestureStart.current.midX;
      const dy = e.clientY - gestureStart.current.midY;
      const clamped = clampTranslate(scale, gestureStart.current.tx + dx, gestureStart.current.ty + dy);
      setTx(clamped.tx);
      setTy(clamped.ty);
    }
  }

  function endGesture(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    setDragging(false);
    if (pointers.current.size === 0 && scale < MIN_SCALE) {
      reset();
    }
  }

  function handleClick(e: React.MouseEvent) {
    // Double-tap-to-zoom, tracked manually — mobile Safari's `dblclick`
    // support for touch is inconsistent, but two `click`s (which touch
    // reliably fires) close together at roughly the same point is a
    // solid proxy for a double-tap.
    const now = Date.now();
    const prev = lastTap.current;
    lastTap.current = { time: now, x: e.clientX, y: e.clientY };
    if (
      prev &&
      now - prev.time < DOUBLE_TAP_MAX_DELAY_MS &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_MAX_DISTANCE_PX
    ) {
      lastTap.current = null;
      if (scale > 1) {
        reset();
      } else {
        setScale(DOUBLE_TAP_ZOOM);
      }
    }
  }

  function handleWheel(e: React.WheelEvent) {
    // Desktop fallback — mouse users have no pinch gesture.
    e.preventDefault();
    const delta = -e.deltaY * 0.0025;
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta * scale));
    const clamped = clampTranslate(nextScale, tx, ty);
    setScale(nextScale);
    setTx(clamped.tx);
    setTy(clamped.ty);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 top-0 left-0 h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-none bg-black/95 p-0 ring-0 sm:max-w-none"
      >
        <button
          type="button"
          onClick={() => handleOpenChange(false)}
          aria-label={t("close")}
          className="absolute right-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white/90 hover:bg-black/60"
          style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
        >
          <X className="h-5 w-5" />
        </button>

        {items.length > 1 && (
          <div
            className="absolute left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/40 px-2.5 py-1 text-xs text-white/90"
            style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
          >
            {index + 1} / {items.length}
          </div>
        )}

        {isAlbum ? (
          // Vertical scroll-snap feed — one full-screen slot per image,
          // native browser scroll physics (touch, trackpad, or wheel)
          // drive the motion, so it's smooth for free and needs no
          // custom gesture code. No zoom/pan here — matches the
          // reference iPhone album viewer, which doesn't offer it either.
          <div
            ref={albumScrollRef}
            onScroll={handleAlbumScroll}
            className="h-full w-full snap-y snap-mandatory overflow-y-auto overscroll-y-contain"
          >
            {items.map((url, i) => (
              <div
                key={i}
                className="flex h-full w-full snap-start snap-always items-center justify-center"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={i === 0 ? alt : ""}
                  draggable={false}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            ))}
          </div>
        ) : (
          <div
            ref={containerRef}
            className="flex h-full w-full items-center justify-center overflow-hidden touch-none select-none"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            onClick={handleClick}
            onWheel={handleWheel}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={currentSrc}
              alt={alt}
              draggable={false}
              className="max-h-full max-w-full object-contain"
              style={{
                transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                transition: dragging ? "none" : "transform 150ms ease-out",
              }}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
