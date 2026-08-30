export interface PdfPreview {
  pageCount: number;
  /** PNG bytes of page 1, rendered at a size close to what the WhatsApp
   *  card shows (a small thumbnail, not a print-quality page). */
  thumbnail: Buffer;
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
 *
 * `pdf-to-img` renders via `pdfjs-dist`, whose Node build resolves
 * `@napi-rs/canvas` at runtime to supply `DOMMatrix`/`ImageData`/
 * `Path2D` (see its own defensive try/catch around that require).
 * `@napi-rs/canvas` was only ever an *optionalDependency* of pdfjs-dist,
 * never declared by this project directly — production silently
 * dropped the whole package (not just a platform binary) wherever the
 * install step omits optional dependencies, which pdfjs-dist's own
 * try/catch can't fully paper over: it warns and skips the polyfill,
 * but something further down unconditionally references the bare
 * `DOMMatrix` identifier, so the module import throws anyway
 * (`ReferenceError: DOMMatrix is not defined`, confirmed 2026-08-30 via
 * production stack trace). Fixed by declaring `@napi-rs/canvas` as a
 * direct (required) dependency in package.json so it always installs.
 */
export async function renderPdfPreview(pdfBuffer: Buffer): Promise<PdfPreview | null> {
  try {
    const { pdf } = await import("pdf-to-img");
    const document = await pdf(pdfBuffer, { scale: 1.5 });
    if (document.length < 1) return null;
    const thumbnail = await document.getPage(1);
    return { pageCount: document.length, thumbnail };
  } catch (error) {
    console.error("[documents] PDF preview render failed:", error);
    return null;
  }
}
