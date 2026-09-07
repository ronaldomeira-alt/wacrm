import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getR2Client } from "./r2-client";

/**
 * Retenção automática: apaga fotos/vídeos/áudios/PDFs/documentos/
 * thumbnails de leads arquivados há 60+ dias ou inativos há 180+ dias
 * (ver a view `media_retention_eligible_messages`). NUNCA apaga
 * contato/conversa/mensagem — só as colunas media_url /
 * document_thumbnail_url e o objeto físico correspondente.
 *
 * Respeita reference_count: um objeto R2 só é fisicamente apagado
 * (e sua linha em media_objects removida) quando o decremento chega a
 * zero — mesmo padrão de /api/media/delete. Enquanto outra mensagem
 * (de um lead não elegível) ainda referenciar o mesmo objeto
 * deduplicado, só a referência desta mensagem é liberada.
 *
 * Nunca toca em media_objects.visibility='public' (template headers —
 * de todo modo nunca aparecem em messages.media_url, mas a checagem é
 * defensiva).
 */

const BATCH_LIMIT = 100;

export interface RetentionBatchResult {
  processedMessages: number;
  referencesReleased: number;
  objectsDeleted: number;
  thumbnailsDeleted: number;
  bytesFreed: number;
  errors: Array<{ messageId: string; error: string }>;
}

export async function runRetentionCleanupBatch(
  admin: SupabaseClient,
): Promise<RetentionBatchResult> {
  const result: RetentionBatchResult = {
    processedMessages: 0,
    referencesReleased: 0,
    objectsDeleted: 0,
    thumbnailsDeleted: 0,
    bytesFreed: 0,
    errors: [],
  };

  const { data: rows, error } = await admin
    .from("media_retention_eligible_messages")
    .select(
      "message_id, contact_id, media_url, document_thumbnail_url, media_object_id, media_object_bucket, media_object_visibility, reason",
    )
    .limit(BATCH_LIMIT);
  if (error) throw error;
  if (!rows || rows.length === 0) return result;

  const r2 = getR2Client();

  for (const row of rows as Array<{
    message_id: string;
    contact_id: string;
    media_url: string | null;
    document_thumbnail_url: string | null;
    media_object_id: string | null;
    media_object_bucket: string | null;
    media_object_visibility: string | null;
    reason: "archived_60d" | "inactive_180d";
  }>) {
    try {
      // 1) Bare R2 key referenced by messages.media_url.
      if (row.media_url && row.media_object_id) {
        if (row.media_object_visibility === "public") {
          // Defensive — should never happen (template headers never
          // appear in messages.media_url), so treat as an anomaly and
          // skip this message entirely rather than touch public media.
          result.errors.push({
            messageId: row.message_id,
            error: "media_object_visibility=public — skipped defensively",
          });
          continue;
        }

        const { data: newCount, error: decErr } = await admin.rpc(
          "decrement_media_object_reference",
          { p_object_id: row.media_object_id },
        );
        if (decErr) throw decErr;

        const { error: nullErr } = await admin
          .from("messages")
          .update({ media_url: null })
          .eq("id", row.message_id);
        if (nullErr) throw nullErr;

        await admin.from("media_retention_deletions").insert({
          message_id: row.message_id,
          contact_id: row.contact_id,
          kind: "media_reference",
          reason: row.reason,
          object_key: row.media_url,
          bucket: row.media_object_bucket,
        });
        result.referencesReleased++;

        if (newCount === 0 && row.media_object_bucket) {
          const { data: sizeRow } = await admin
            .from("media_objects")
            .select("size_bytes")
            .eq("id", row.media_object_id)
            .maybeSingle();
          await r2
            .send(new DeleteObjectCommand({ Bucket: row.media_object_bucket, Key: row.media_url }))
            .catch((err) => {
              console.error("[media-retention] R2 delete failed (row dropped below anyway):", err);
            });
          await admin.from("media_objects").delete().eq("id", row.media_object_id);
          const bytes = sizeRow?.size_bytes ?? 0;
          result.objectsDeleted++;
          result.bytesFreed += bytes;
          await admin.from("media_retention_deletions").insert({
            message_id: row.message_id,
            contact_id: row.contact_id,
            kind: "media_object",
            reason: row.reason,
            object_key: row.media_url,
            bucket: row.media_object_bucket,
            size_bytes: bytes,
          });
        }
      }

      // 2) PDF/document thumbnail — always Supabase Storage
      // (`chat-media/.../doc-thumbs/...`), never deduped, 1:1 per
      // message, so no reference-count logic needed here.
      if (row.document_thumbnail_url) {
        const path = row.document_thumbnail_url.replace(/^.*\/chat-media\//, "");
        const { data: headData } = await admin.storage.from("chat-media").list(
          path.split("/").slice(0, -1).join("/"),
          { search: path.split("/").pop() },
        );
        const sizeBytes = headData?.[0]?.metadata?.size ?? 0;

        const { error: removeErr } = await admin.storage.from("chat-media").remove([path]);
        if (removeErr) throw removeErr;

        const { error: nullThumbErr } = await admin
          .from("messages")
          .update({ document_thumbnail_url: null })
          .eq("id", row.message_id);
        if (nullThumbErr) throw nullThumbErr;

        result.thumbnailsDeleted++;
        result.bytesFreed += sizeBytes;
        await admin.from("media_retention_deletions").insert({
          message_id: row.message_id,
          contact_id: row.contact_id,
          kind: "thumbnail",
          reason: row.reason,
          object_key: path,
          bucket: "chat-media",
          size_bytes: sizeBytes,
        });
      }

      result.processedMessages++;
    } catch (err) {
      result.errors.push({
        messageId: row.message_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
