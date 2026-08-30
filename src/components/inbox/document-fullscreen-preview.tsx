"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

interface DocumentFullscreenPreviewProps {
  open: boolean;
  url: string;
  filename: string;
  onCancel: () => void;
  /**
   * The DOM node to confine the preview to — normally the thread's own
   * scrollable message-list container (see message-thread.tsx's
   * `scrollRef`, threaded down via MessageComposer's
   * `pdfPreviewContainerRef`). When provided, the dialog portals into it
   * instead of `<body>` and switches from `fixed`/viewport sizing to
   * `absolute`/100%-of-container sizing, so header, sidebar, contact
   * panel and the composer below all stay visible and interactive around
   * it — only the message-list area is replaced by the preview. Omit (or
   * pass a ref that hasn't resolved) to fall back to the original
   * full-viewport dialog.
   */
  containerRef?: RefObject<HTMLDivElement | null>;
}

/**
 * WhatsApp-Desktop-style pre-send PDF review: opened automatically over
 * the existing document draft, confined to the conversation's own
 * message-list area rather than a full-screen modal. Pages are laid out
 * in a single vertically scrollable column — natural scroll/swipe is the
 * only navigation, no prev/next buttons — with lazy per-page rendering
 * (a page's canvas is only rasterized once it scrolls near view) so a
 * long document doesn't pay the render cost of every page up front.
 *
 * Purely a presentation layer in front of MediaDraftPreview's
 * already-working state — see its document branch in message-composer.tsx.
 * Closing this (X, Escape, backdrop click) discards the draft, exactly
 * like the inline card's own X does today. Caption and Send live only in
 * MediaDraftPreview's own row (always visible right below this preview,
 * never covered now that the preview no longer takes over the whole
 * screen) — this component doesn't duplicate that input.
 *
 * pdfjs-dist isn't a new project dependency in spirit — it already ships
 * in node_modules as pdf-to-img's rendering engine (see
 * src/lib/documents/pdf-preview.ts) and next.config.ts already lists it
 * in serverExternalPackages. This is the same library, used directly for
 * a client-side <canvas> render instead of the server's @napi-rs/canvas
 * one — no heavier wrapper (e.g. react-pdf, which just wraps this same
 * package) is needed for "render page N to a canvas + report page count".
 */
export function DocumentFullscreenPreview({
  open,
  url,
  filename,
  onCancel,
  containerRef,
}: DocumentFullscreenPreviewProps) {
  const t = useTranslations("Inbox.composer");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  // destroy() lives on the loading task (pre-`.promise`), not on the
  // resolved PDFDocumentProxy — kept separately so cleanup can still
  // release the worker/network resources once the doc has resolved.
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const [pageCount, setPageCount] = useState(0);
  // Each page's natural height/width ratio, fetched once (cheap — just
  // page metadata, not a render) right after the doc loads. Used to size
  // every page's placeholder slot up front via CSS aspect-ratio, so the
  // scrollable column doesn't jump around as pages lazily render in.
  const [pageAspectRatios, setPageAspectRatios] = useState<number[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const canvasElsRef = useRef(new Map<number, HTMLCanvasElement>());
  const renderedPagesRef = useRef(new Set<number>());

  // Loads the document whenever the viewer opens on a (possibly new) URL,
  // then fetches every page's aspect ratio (metadata only — cheap even
  // for a long document, unlike actually rendering each page). Dynamic
  // import — same defensive pattern as pdf-preview.ts on the server:
  // keeps any pdfjs load failure local to this effect's catch instead of
  // risking a module-load-time throw.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("loading");
    setPageCount(0);
    setPageAspectRatios([]);
    setCurrentPage(1);
    canvasElsRef.current.clear();
    renderedPagesRef.current.clear();

    void (async () => {
      try {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        const loadingTask = pdfjsLib.getDocument({ url });
        loadingTaskRef.current = loadingTask;
        const doc = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);

        const ratios: number[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          ratios.push(vp.height / vp.width);
        }
        if (cancelled) return;
        setPageAspectRatios(ratios);
        setStatus("ready");
      } catch (error) {
        console.error("[documents] client-side PDF preview failed:", error);
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      void loadingTaskRef.current?.destroy();
      loadingTaskRef.current = null;
      docRef.current = null;
    };
  }, [open, url]);

  // Renders a single page into its canvas, fit to the scroll container's
  // width (the only constraint that matters now — height follows the
  // page's own aspect ratio in a vertically scrolling column). Re-render
  // is guarded by `renderedPagesRef` so re-observing an already-rendered
  // page (e.g. scrolling back up past it) is a no-op, not a re-render.
  async function renderPage(pageNumber: number) {
    const doc = docRef.current;
    const canvas = canvasElsRef.current.get(pageNumber);
    if (!doc || !canvas || renderedPagesRef.current.has(pageNumber)) return;
    renderedPagesRef.current.add(pageNumber);

    const page: PDFPageProxy = await doc.getPage(pageNumber);
    const outputScale = window.devicePixelRatio || 1;
    const unscaledViewport = page.getViewport({ scale: 1 });
    // The canvas's own parent slot — not the outer scroll container — is
    // the actual box being filled: the slot is capped by the `max-w-3xl
    // mx-auto` wrapper, which on a wide confined panel (contact panel
    // hidden, or the full-screen fallback on a wide monitor) is far
    // narrower than the scroll container itself. Measuring the
    // container's width instead of the slot's rendered a canvas much
    // larger than its aspect-ratio'd slot, which then overflowed it.
    // Re-read live (not cached) — the slot's width can change (contact
    // panel toggled, window resized) between when it was first sized and
    // when it actually scrolls into view.
    const availWidth = Math.max(canvas.parentElement?.clientWidth ?? 0, 1);
    const scale = availWidth / unscaledViewport.width;
    const viewport = page.getViewport({ scale });

    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

    await page.render({ canvas, transform, viewport }).promise;
  }

  // Lazy render + "which page are we looking at" tracking, both driven
  // by the same IntersectionObserver over the page slots — natural
  // scroll is the only navigation now (no prev/next buttons): rendering
  // a page just before it's visible (rootMargin) keeps scrolling smooth,
  // and the header's "N / M" counter follows whichever slot has the
  // most visible area.
  useEffect(() => {
    if (status !== "ready" || pageAspectRatios.length === 0) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let bestPage = -1;
        let bestRatio = 0;
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) {
            void renderPage(pageNumber);
            if (entry.intersectionRatio > bestRatio) {
              bestRatio = entry.intersectionRatio;
              bestPage = pageNumber;
            }
          }
        }
        if (bestPage > 0) setCurrentPage(bestPage);
      },
      { root: container, rootMargin: "50% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    const slots = container.querySelectorAll<HTMLElement>("[data-page]");
    slots.forEach((slot) => observer.observe(slot));
    return () => observer.disconnect();
  }, [status, pageAspectRatios]);

  // Every already-rendered page was rasterized to fit the container's
  // width *at that moment*. Toggling the contact panel (or resizing the
  // window) changes that width without necessarily scrolling anything,
  // so nothing would otherwise re-trigger those canvases to match the
  // new size — they'd just sit there under- or over-sized within their
  // (correctly resized, aspect-ratio-driven) slot. A ResizeObserver on
  // the scroll container itself catches every cause of that (window
  // resize, sidebar/contact-panel toggle, DevTools, etc.), not just
  // `window`'s own resize event.
  useEffect(() => {
    if (status !== "ready") return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(() => {
      renderedPagesRef.current.clear();
      for (const pageNumber of canvasElsRef.current.keys()) {
        void renderPage(pageNumber);
      }
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [status]);

  // Whether the caller actually wants this confined to a sub-region.
  // Falls back to the original full-viewport dialog when no container
  // was threaded through — e.g. a caller that hasn't wired
  // pdfPreviewContainerRef yet.
  const confined = !!containerRef;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      // A true viewport-covering modal makes sense for the full-screen
      // fallback (it should trap focus/block the page like any other
      // full-screen dialog); confined to the message-list area, the rest
      // of the app — sidebar, contact panel, and crucially the composer
      // below with its Send button — must stay interactive, which rules
      // out Base UI's default modal focus-trap/pointer-block behavior.
      modal={!confined}
      // Base UI dismisses a dialog by default the moment a pointer press
      // or focus move lands outside its own DOM subtree — which, once
      // confined, is exactly what typing in the (now-visible, DOM-
      // sibling) composer caption input or clicking Send does. Without
      // this, doing either silently discarded the draft instead of
      // reaching it. Only the explicit X (onCancel) should close/discard
      // once confined; the full-screen fallback keeps the original
      // click-outside-to-dismiss behavior.
      disablePointerDismissal={confined}
    >
      <DialogContent
        showCloseButton={false}
        container={containerRef}
        overlayClassName={confined ? "absolute inset-0" : undefined}
        className={cn(
          // Overrides the shared DialogContent's base `display: grid` —
          // its single-child grid row auto-sizes to that child's own
          // *content* height rather than stretching to fill the Popup's
          // own (correctly h-full-constrained) box, the same class of
          // bug as a flex child needing `min-h-0`, just grid's version
          // of it. `flex` sidesteps it entirely: a flex container's
          // cross-axis stretch isn't content-size-dependent the way
          // grid's `auto` row track is. Scoped to this dialog only —
          // shared dialog.tsx and every other Dialog caller keep `grid`.
          "flex top-0 left-0 max-w-none translate-x-0 translate-y-0 rounded-none border-none bg-black/95 p-0 ring-0 sm:max-w-none",
          confined ? "absolute inset-0 h-full w-full" : "fixed inset-0 h-[100dvh] w-screen",
        )}
      >
        <div className="flex h-full w-full flex-col">
          <div
            className="flex shrink-0 items-center justify-between gap-2 px-3 text-white/90"
            style={confined ? undefined : { paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}
          >
            <button
              type="button"
              onClick={onCancel}
              aria-label={t("removeAttachment")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/40 hover:bg-black/60"
            >
              <X className="h-5 w-5" />
            </button>
            <span className="min-w-0 flex-1 truncate text-center text-sm">{filename}</span>
            {pageCount > 0 ? (
              <span className="shrink-0 rounded-full bg-black/40 px-2.5 py-1 text-xs">
                {currentPage} / {pageCount}
              </span>
            ) : (
              <span className="w-9 shrink-0" />
            )}
          </div>

          <div
            ref={scrollContainerRef}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4"
          >
            {status === "loading" && (
              <div className="flex h-full items-center justify-center">
                <span className="text-sm text-white/70">{t("documentPreviewLoading")}</span>
              </div>
            )}
            {status === "error" && (
              <div className="flex h-full items-center justify-center">
                <span className="max-w-xs text-center text-sm text-white/70">
                  {t("documentPreviewUnavailable")}
                </span>
              </div>
            )}
            {status === "ready" && (
              <div className="mx-auto flex max-w-3xl flex-col gap-4">
                {pageAspectRatios.map((ratio, i) => {
                  const pageNumber = i + 1;
                  return (
                    <div
                      key={pageNumber}
                      data-page={pageNumber}
                      className="w-full"
                      style={{ aspectRatio: `1 / ${ratio}` }}
                    >
                      <canvas
                        ref={(el) => {
                          if (el) canvasElsRef.current.set(pageNumber, el);
                          else canvasElsRef.current.delete(pageNumber);
                        }}
                        className="h-full w-full rounded-md shadow-lg"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
