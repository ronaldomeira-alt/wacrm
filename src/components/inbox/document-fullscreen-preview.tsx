"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { ChevronLeft, ChevronRight, Send, X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { GatedButton } from "@/components/ui/gated-button";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

// Meta caps media captions at 1024 chars — mirrors MEDIA_CAPTION_MAX in
// message-composer.tsx (not imported from there: that file imports this
// component, and importing back would create a circular module).
const CAPTION_MAX = 1024;

interface DocumentFullscreenPreviewProps {
  open: boolean;
  url: string;
  filename: string;
  caption: string;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * WhatsApp-style pre-send PDF review: full-screen, page-by-page, opened
 * automatically over the existing document draft. Purely a presentation
 * layer in front of MediaDraftPreview's already-working state (caption,
 * send, discard) — see its document branch in message-composer.tsx.
 * Closing this (X, Escape, backdrop click) discards the draft, exactly
 * like the inline card's own X does today; Send calls the same onSend
 * the inline card's button already calls. No new draft/send/discard
 * logic is introduced here.
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
  caption,
  busy,
  readOnly,
  onCaptionChange,
  onConfirm,
  onCancel,
}: DocumentFullscreenPreviewProps) {
  const t = useTranslations("Inbox.composer");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  // destroy() lives on the loading task (pre-`.promise`), not on the
  // resolved PDFDocumentProxy — kept separately so cleanup can still
  // release the worker/network resources once the doc has resolved.
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // Loads the document whenever the viewer opens on a (possibly new) URL.
  // Dynamic import — same defensive pattern as pdf-preview.ts on the
  // server: keeps any pdfjs load failure local to this effect's catch
  // instead of risking a module-load-time throw.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("loading");
    setPageNum(1);
    setPageCount(0);

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

  // Renders whichever page is current onto the canvas, fit to whichever
  // of the viewer's available width/height is the tighter constraint —
  // real-estate PDFs mix portrait floor plans and landscape scans, and a
  // width-only fit let a tall portrait page's canvas grow past the
  // available vertical space, pushing the caption/send bar below the
  // fold with no way to reach it (the flex column has nothing to shrink
  // against without this). Re-runs on resize too, while the viewer is
  // open, so rotating a phone or resizing the window keeps the whole
  // page — including the footer — in view.
  useEffect(() => {
    if (status !== "ready" || !docRef.current) return;
    let cancelled = false;
    let raf = 0;

    function renderPage() {
      raf = requestAnimationFrame(async () => {
        const canvas = canvasRef.current;
        const container = pageContainerRef.current;
        if (!canvas || !container || !docRef.current) return;
        const page = await docRef.current.getPage(pageNum);
        if (cancelled) return;

        const outputScale = window.devicePixelRatio || 1;
        const unscaledViewport = page.getViewport({ scale: 1 });
        // Container's own box already excludes padding via clientWidth/
        // Height (border-box), so no manual padding subtraction needed.
        const availWidth = Math.max(container.clientWidth, 1);
        const availHeight = Math.max(container.clientHeight, 1);
        const scale = Math.min(
          availWidth / unscaledViewport.width,
          availHeight / unscaledViewport.height,
        );
        const viewport = page.getViewport({ scale });

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

        await page.render({ canvas, transform, viewport }).promise;
      });
    }

    renderPage();
    window.addEventListener("resize", renderPage);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", renderPage);
    };
  }, [status, pageNum]);

  const goPrev = () => setPageNum((n) => Math.max(1, n - 1));
  const goNext = () => setPageNum((n) => Math.min(pageCount, n + 1));

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "ArrowRight") goNext();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 top-0 left-0 h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-none bg-black/95 p-0 ring-0 sm:max-w-none"
      >
        <div className="flex h-full w-full flex-col">
          <div
            className="flex shrink-0 items-center justify-between gap-2 px-3 text-white/90"
            style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}
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
                {pageNum} / {pageCount}
              </span>
            ) : (
              <span className="w-9 shrink-0" />
            )}
          </div>

          <div
            ref={pageContainerRef}
            // `min-h-0` is load-bearing: a flex child sized only by
            // `flex-1` still refuses to shrink below its content's
            // intrinsic size by default, so without it an oversized
            // canvas grows the whole column past the dialog's height
            // instead of scrolling in place — shoving the caption/send
            // bar in the footer below (see the render effect above,
            // which now fits the canvas to this container's own
            // measured box precisely to avoid needing that overflow).
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
          >
            {status === "loading" && (
              <span className="text-sm text-white/70">{t("documentPreviewLoading")}</span>
            )}
            {status === "error" && (
              <span className="max-w-xs text-center text-sm text-white/70">
                {t("documentPreviewUnavailable")}
              </span>
            )}
            <canvas
              ref={canvasRef}
              className={cn("rounded-md shadow-lg", status !== "ready" && "hidden")}
            />

            {status === "ready" && pageCount > 1 && (
              <>
                <button
                  type="button"
                  onClick={goPrev}
                  disabled={pageNum <= 1}
                  aria-label={t("documentPreviewPrevPage")}
                  className="absolute left-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white/90 hover:bg-black/60 disabled:opacity-30 sm:left-4"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={pageNum >= pageCount}
                  aria-label={t("documentPreviewNextPage")}
                  className="absolute right-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white/90 hover:bg-black/60 disabled:opacity-30 sm:right-4"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </>
            )}
          </div>

          <div
            className="flex shrink-0 items-end gap-2 border-t border-white/10 bg-black/60 p-3"
            style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
          >
            <input
              value={caption}
              maxLength={CAPTION_MAX}
              onChange={(e) => onCaptionChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onConfirm();
                }
              }}
              placeholder={t("addCaption")}
              className="flex-1 rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-base text-white placeholder-white/50 outline-none focus:border-white/40"
            />
            <GatedButton
              size="sm"
              canAct={!readOnly}
              gateReason="enviar mensagens"
              disabled={busy}
              onClick={onConfirm}
              className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </GatedButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
