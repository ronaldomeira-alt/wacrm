import { supabaseAdmin } from "./admin-client";
import { renderPdfPreview } from "./pdf-preview";
import { isDeliverableUrl } from "@/lib/webhooks/ssrf";
import { MEDIA_MAX_BYTES_BY_KIND } from "@/lib/storage/upload-media";

/** True when the mime type or filename extension indicates a PDF —
 *  the only document kind this feature generates a preview for (see
 *  074_document_preview.sql). Checked before doing any real work so a
 *  Word/Excel/PPT/txt document never triggers a wasted PDF-parse
 *  attempt (pdf-to-img would just fail on it and we'd fall back
 *  anyway, but this skips that round-trip). */
export function looksLikePdf(mimeType: string | null, filename: string | null): boolean {
  if (mimeType === "application/pdf") return true;
  return !!filename && filename.toLowerCase().endsWith(".pdf");
}

export interface GenerateDocumentPreviewArgs {
  messageId: string;
  accountId: string;
  pdfBuffer: Buffer;
}

/**
 * Renders page 1 of a just-received or just-sent PDF, uploads it to the
 * account's `chat-media` bucket, and patches the message row with the
 * thumbnail URL + page count + file size. Best-effort and non-blocking
 * by design (never throws) — callers fire this without awaiting, same
 * as the other post-send/post-insert side effects in this codebase
 * (see `maybeActivateCtwaFep`). Worst case the message keeps the plain
 * document pill it already renders while this hasn't (or never)
 * completed.
 */
export async function generateDocumentPreview({
  messageId,
  accountId,
  pdfBuffer,
}: GenerateDocumentPreviewArgs): Promise<void> {
  console.log(`[thumb-trace] ${messageId} 1/5 generateDocumentPreview start, bytes=${pdfBuffer.byteLength}`);
  try {
    const preview = await renderPdfPreview(pdfBuffer);
    if (!preview) {
      console.log(`[thumb-trace] ${messageId} 3/5 renderPdfPreview returned null (no thumbnail) — stopping here`);
      return;
    }
    console.log(`[thumb-trace] ${messageId} 3/5 renderPdfPreview ok, pageCount=${preview.pageCount}, thumbnailBytes=${preview.thumbnail.byteLength}`);

    const path = `account-${accountId}/doc-thumbs/${messageId}.png`;
    console.log(`[thumb-trace] ${messageId} 4/5 uploading to chat-media/${path}`);
    const { error: uploadError } = await supabaseAdmin()
      .storage.from("chat-media")
      .upload(path, preview.thumbnail, {
        contentType: "image/png",
        upsert: true,
      });
    if (uploadError) {
      console.error(`[thumb-trace] ${messageId} 4/5 upload FAILED:`, uploadError);
      console.error("[documents] thumbnail upload failed:", uploadError);
      return;
    }
    console.log(`[thumb-trace] ${messageId} 4/5 upload ok`);

    const {
      data: { publicUrl },
    } = supabaseAdmin().storage.from("chat-media").getPublicUrl(path);
    console.log(`[thumb-trace] ${messageId} 5/5 updating message row, publicUrl=${publicUrl}`);

    const { error: updateError } = await supabaseAdmin()
      .from("messages")
      .update({
        document_page_count: preview.pageCount,
        document_file_size: pdfBuffer.byteLength,
        document_thumbnail_url: publicUrl,
      })
      .eq("id", messageId);
    if (updateError) {
      console.error(`[thumb-trace] ${messageId} 5/5 message update FAILED:`, updateError);
      console.error("[documents] message preview update failed:", updateError);
    } else {
      console.log(`[thumb-trace] ${messageId} 5/5 message update ok — DONE`);
    }
  } catch (error) {
    console.error(`[thumb-trace] ${messageId} UNCAUGHT error:`, error);
    console.error("[documents] preview generation failed:", error);
  }
}

/**
 * Outbound-send variant: fetches the PDF bytes from its own media_url
 * (a `chat-media` public URL for a composer upload, or whatever a Flow's
 * `send_media` node was configured with) before generating the preview.
 * SSRF-guarded the same way outbound webhook delivery is — this is our
 * server fetching a URL that isn't always one we control — and size-
 * capped to the same ceiling document uploads are already held to, so a
 * misconfigured external URL can't make this download unbounded.
 */
export async function generateDocumentPreviewFromUrl({
  messageId,
  accountId,
  url,
}: {
  messageId: string;
  accountId: string;
  url: string;
}): Promise<void> {
  console.log(`[thumb-trace] ${messageId} 0/5 generateDocumentPreviewFromUrl start, url=${url}`);
  try {
    const deliverable = await isDeliverableUrl(url);
    console.log(`[thumb-trace] ${messageId} 2/5 isDeliverableUrl=${deliverable}`);
    if (!deliverable) {
      console.log(`[thumb-trace] ${messageId} 2/5 stopping: SSRF guard rejected url=${url}`);
      return;
    }

    const response = await fetch(url);
    console.log(`[thumb-trace] ${messageId} 2/5 fetch status=${response.status} ok=${response.ok}`);
    if (!response.ok) {
      console.log(`[thumb-trace] ${messageId} 2/5 stopping: fetch not ok`);
      return;
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MEDIA_MAX_BYTES_BY_KIND.document) {
      console.log(`[thumb-trace] ${messageId} 2/5 stopping: content-length ${contentLength} exceeds ${MEDIA_MAX_BYTES_BY_KIND.document}`);
      return;
    }

    const pdfBuffer = Buffer.from(await response.arrayBuffer());
    console.log(`[thumb-trace] ${messageId} 2/5 downloaded bytes=${pdfBuffer.byteLength}`);
    if (pdfBuffer.byteLength > MEDIA_MAX_BYTES_BY_KIND.document) {
      console.log(`[thumb-trace] ${messageId} 2/5 stopping: downloaded size exceeds ${MEDIA_MAX_BYTES_BY_KIND.document}`);
      return;
    }

    await generateDocumentPreview({ messageId, accountId, pdfBuffer });
  } catch (error) {
    console.error(`[thumb-trace] ${messageId} UNCAUGHT error in generateDocumentPreviewFromUrl:`, error);
    console.error("[documents] preview fetch failed:", error);
  }
}
