import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { supabaseAdmin } from "@/lib/storage/admin-client";
import { getR2Client } from "@/lib/storage/r2-client";

/**
 * Sweeps abandoned uploads: a `media_objects` row stuck at
 * status='pending' this long means the browser never called
 * /api/media/confirm-upload — the PUT failed, the tab was closed
 * mid-upload, or the confirm request itself never landed. Deletes the
 * row and, best-effort, the R2 object in case the PUT actually
 * succeeded (see presign-upload/confirm-upload's doc comments).
 *
 * Meant to be hit on a schedule via an external pinger (cron-job.org —
 * see the automations/cron and ai/followups/cron routes for the same
 * pattern already used in this project), not a real background worker
 * — Hostinger has no built-in cron. Requires a shared secret via the
 * `x-cron-secret` header, same convention as automations/cron.
 */
const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour
const BATCH_LIMIT = 100;

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

  const admin = supabaseAdmin();
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString();

  const { data: stale, error } = await admin
    .from("media_objects")
    .select("id, bucket, visibility, object_key")
    .eq("status", "pending")
    .lt("created_at", staleBefore)
    .limit(BATCH_LIMIT);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!stale || stale.length === 0) {
    return NextResponse.json({ processed: 0, deleted: 0 });
  }

  let deleted = 0;
  for (const row of stale) {
    try {
      const client = getR2Client();
      await client
        .send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.object_key }))
        .catch(() => {
          // Object may never have actually landed (the common case —
          // the PUT itself failed/never happened) — not an error.
        });
      const { error: deleteRowError } = await admin
        .from("media_objects")
        .delete()
        .eq("id", row.id);
      if (deleteRowError) {
        console.error("[media/cleanup-cron] row delete failed:", deleteRowError);
        continue;
      }
      deleted += 1;
    } catch (err) {
      console.error("[media/cleanup-cron] sweep failed for row:", row.id, err);
    }
  }

  return NextResponse.json({ processed: stale.length, deleted });
}
