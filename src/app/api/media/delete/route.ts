import { NextResponse } from "next/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { getR2Client, isR2MediaKey } from "@/lib/storage/r2-client";

/**
 * Best-effort GC for private (`visibility='private'`) media — mirrors
 * `deleteAccountMedia`'s calling convention (fire-and-forget from the
 * caller, e.g. discarding a staged-but-unsent composer draft).
 *
 * Dedup means several messages can share the exact same physical R2
 * object; this never deletes on the first call for a shared object —
 * it decrements `reference_count` and only issues the real
 * DeleteObjectCommand once that reaches 0. See the migration's doc
 * comment on `reference_count` for why a naive delete-on-first-call
 * would be a correctness bug (it could destroy media an earlier,
 * already-sent message still references).
 *
 * Public media (template header images) is deliberately permanent and
 * has no delete path here at all — this endpoint only ever operates on
 * `visibility='private'` rows.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await getCurrentAccount();

    if (!hasMinRole(role, "agent")) {
      return NextResponse.json({ error: "Insufficient role" }, { status: 403 });
    }

    const limit = checkRateLimit(`media-upload:${userId}`, RATE_LIMITS.mediaUpload);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json();
    const { key } = body as { key?: string };
    if (typeof key !== "string" || !isR2MediaKey(key) || key.split("/")[0] !== accountId) {
      return NextResponse.json({ error: "Invalid or foreign key" }, { status: 400 });
    }

    const { data: row, error: rowError } = await supabase
      .from("media_objects")
      .select("id, bucket, visibility")
      .eq("account_id", accountId)
      .eq("object_key", key)
      .maybeSingle();

    if (rowError) {
      return NextResponse.json({ error: "Failed to look up the object" }, { status: 500 });
    }
    if (!row) {
      // Nothing to do — either never existed or already GC'd. Same
      // idempotent-success shape as the old deleteAccountMedia call
      // sites expect (they never inspect the result).
      return NextResponse.json({ deleted: false });
    }
    if (row.visibility === "public") {
      return NextResponse.json(
        { error: "Public-bucket media is not deletable via this endpoint" },
        { status: 403 },
      );
    }

    const { data: newCount, error: decrementError } = await supabase.rpc(
      "decrement_media_object_reference",
      { p_object_id: row.id },
    );
    if (decrementError) {
      return NextResponse.json({ error: "Failed to release the reference" }, { status: 500 });
    }

    if (newCount > 0) {
      // Still referenced elsewhere — released our reference, object stays.
      return NextResponse.json({ deleted: false, referenceCount: newCount });
    }

    const client = getR2Client();
    await client.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: key })).catch((err) => {
      console.error("[media/delete] R2 delete failed (row already dropped below):", err);
    });
    await supabase.from("media_objects").delete().eq("id", row.id);

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("[media/delete] error:", error);
    return toErrorResponse(error);
  }
}
