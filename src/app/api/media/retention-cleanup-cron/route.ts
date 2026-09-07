import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/storage/admin-client";
import { runRetentionCleanupBatch } from "@/lib/storage/media-retention";

/**
 * Retenção automática de mídia (leads arquivados 60+ dias, ou inativos
 * 180+ dias sem mensagem real): apaga fotos/vídeos/áudios/PDFs/
 * documentos/thumbnails desses leads, preservando texto e todo dado
 * estrutural do CRM. Ver `media_retention_eligible_messages` (view) e
 * `runRetentionCleanupBatch` pra lógica completa, incluindo respeito a
 * reference_count/dedup.
 *
 * Mesmo padrão de agendamento externo (cron-job.org) e autenticação
 * (`x-cron-secret` + MEDIA_CLEANUP_CRON_SECRET) do endpoint irmão
 * /api/media/cleanup-cron. Processa em lotes de até 100 mensagens por
 * chamada — idempotente e retomável por construção: a view só lista
 * mensagens que ainda têm mídia presente, então uma mensagem já limpa
 * simplesmente não aparece mais na próxima chamada.
 */
export async function GET(request: Request) {
  const expected = process.env.MEDIA_CLEANUP_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const supplied = request.headers.get("x-cron-secret") ?? "";
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const admin = supabaseAdmin();
    const result = await runRetentionCleanupBatch(admin);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[media/retention-cleanup-cron] batch failed:", err);
    return NextResponse.json({ error: "batch failed" }, { status: 500 });
  }
}
