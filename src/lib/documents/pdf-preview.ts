import { logError } from "@/lib/observability/log";

export interface PdfPreview {
  pageCount: number;
  /** PNG bytes of page 1, rendered at a size close to what the WhatsApp
   *  card shows (a small thumbnail, not a print-quality page). */
  thumbnail: Buffer;
}

/**
 * `pdf-to-img` renders via its own nested `pdfjs-dist` copy (it pins
 * `~5.6`, incompatible with the `^6.3` we depend on directly for the
 * client-side viewer, so npm nests a private copy under
 * `pdf-to-img/node_modules/pdfjs-dist` rather than hoisting — normal
 * Node resolution, not a bug). That nested pdfjs-dist's Node build
 * polyfills `DOMMatrix`/`ImageData`/`Path2D` onto `globalThis` by
 * `require("@napi-rs/canvas")`ing at its own module-load time, via a
 * `createRequire(import.meta.url)` call three directories deep inside
 * an already-externalized package (see next.config.ts's
 * `serverExternalPackages`). Confirmed 2026-08-30 in production: that
 * nested, dynamically-constructed require fails with "Cannot find
 * module '@napi-rs/canvas'" even after `@napi-rs/canvas` was made a
 * direct, required dependency of this project (ruling out "it's only
 * optional and got skipped at install") — the failure is in resolving
 * it from that deeply-nested, dynamically-built require path through
 * Turbopack's external-module bridge, not in whether the package is
 * installed at all.
 *
 * pdfjs-dist's own polyfill code only *warns* when that require fails
 * (`Cannot load "@napi-rs/canvas" package`) — but something further
 * down in the same module unconditionally reads the bare `DOMMatrix`
 * identifier assuming the polyfill above already ran, so the whole
 * module import throws `ReferenceError: DOMMatrix is not defined`
 * instead of degrading gracefully.
 *
 * Fix: resolve `@napi-rs/canvas` ourselves, directly, from this file —
 * a plain top-level-ish import from our own app code, not a nested
 * dynamic require three packages deep — and pre-set the globals before
 * pdf-to-img (and its nested pdfjs-dist) ever gets a chance to try and
 * fail on its own. pdfjs-dist's `if (!globalThis.DOMMatrix)` guards
 * mean it silently skips its own broken require once these are already
 * set, regardless of whether that nested require would work.
 */
async function ensurePdfCanvasPolyfills(): Promise<void> {
  if (globalThis.DOMMatrix && globalThis.ImageData && globalThis.Path2D) return;
  try {
    const canvas = await import("@napi-rs/canvas");
    if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix as unknown as typeof DOMMatrix;
    if (!globalThis.ImageData) globalThis.ImageData = canvas.ImageData as unknown as typeof ImageData;
    if (!globalThis.Path2D) globalThis.Path2D = canvas.Path2D as unknown as typeof Path2D;
  } catch (error) {
    logError("documents.canvas_polyfill", error);
  }
}

/**
 * Renders the first page of a PDF to a PNG thumbnail and reports the
 * page count. Best-effort — returns null (never throws) on anything
 * that isn't a valid, renderable PDF, so a caller can always fall back
 * to the plain document pill. Scale 1.5 keeps the thumbnail close to
 * the ~140px-wide card WhatsApp itself renders without wasting storage
 * on a full-resolution page image.
 *
 * `pdf-to-img` is loaded via a dynamic `import()` inside the try block
 * rather than a static top-level import, so a broken/missing native
 * dependency in its chain can't crash the whole Node process at module
 * load time (incident 2026-08-20/21) — this module is imported
 * transitively from both the inbound webhook route and the outbound
 * send path, so that would take down all of WhatsApp send/receive, not
 * just PDF previews. A dynamic import fails locally to this function
 * instead, so the catch below can do what the docstring above always
 * promised: degrade to no-preview.
 */
export async function renderPdfPreview(pdfBuffer: Buffer): Promise<PdfPreview | null> {
  try {
    await ensurePdfCanvasPolyfills();
    const { pdf } = await import("pdf-to-img");
    const document = await pdf(pdfBuffer, { scale: 1.5 });
    if (document.length < 1) return null;
    const thumbnail = await document.getPage(1);
    return { pageCount: document.length, thumbnail };
  } catch (error) {
    logError("documents.pdf_preview_render", error);
    return null;
  }
}
