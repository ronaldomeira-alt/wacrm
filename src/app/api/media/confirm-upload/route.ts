import { NextResponse } from "next/server";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, NotFound } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { getR2Client, RESOLVE_TTL_SECONDS, type MediaKind } from "@/lib/storage/r2-client";
import { buildPublicMediaUrl, validateSizeAndMime } from "@/lib/storage/media-purpose";

/**
 * Step 2 of the R2 upload flow: the browser calls this once its direct
 * PUT to the presigned URL from /api/media/presign-upload finishes.
 * This is what makes server-side validation authoritative even though
 * the bytes never passed through our own server — a presigned PUT's
 * signature binds Content-Type but NOT Content-Length, so a caller
 * could in principle PUT a larger body than it declared. HeadObject
 * reads what R2 actually received; only once *that* passes validation
 * does the row (and therefore the object) become usable — a failure
 * here deletes the object immediately rather than leaving an
 * unvalidated one sitting in the bucket.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount();

    const limit = checkRateLimit(`media-upload:${userId}`, RATE_LIMITS.mediaUpload);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json();
    const { key } = body as { key?: string };
    if (typeof key !== "string" || !key) {
      return NextResponse.json({ error: "key is required" }, { status: 400 });
    }

    const { data: row, error: rowError } = await supabase
      .from("media_objects")
      .select("id, bucket, visibility, kind, status")
      .eq("account_id", accountId)
      .eq("object_key", key)
      .eq("status", "pending")
      .maybeSingle();

    if (rowError) {
      return NextResponse.json({ error: "Failed to look up the upload" }, { status: 500 });
    }
    if (!row) {
      return NextResponse.json(
        { error: "No pending upload found for this key" },
        { status: 404 },
      );
    }

    const client = getR2Client();

    let head;
    try {
      head = await client.send(new HeadObjectCommand({ Bucket: row.bucket, Key: key }));
    } catch (err) {
      if (err instanceof NotFound) {
        return NextResponse.json(
          { error: "Object was not found in storage — the PUT may not have completed" },
          { status: 400 },
        );
      }
      throw err;
    }

    const actualSize = head.ContentLength ?? 0;
    const actualContentType = head.ContentType ?? "application/octet-stream";

    const validationError = validateSizeAndMime(row.kind as MediaKind, actualContentType, actualSize);
    if (validationError) {
      // What actually landed in R2 doesn't match what this kind allows
      // — delete it immediately rather than leave an invalid object
      // sitting in the bucket, and drop the reservation row so the
      // dedup slot is free for a legitimate retry.
      await client.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: key })).catch(() => {});
      await supabase.from("media_objects").delete().eq("id", row.id);
      return NextResponse.json(validationError, { status: 400 });
    }

    const publicUrl = row.visibility === "public" ? buildPublicMediaUrl(key) : null;

    const { error: updateError } = await supabase
      .from("media_objects")
      .update({
        status: "completed",
        confirmed_at: new Date().toISOString(),
        content_type: actualContentType,
        size_bytes: actualSize,
        public_url: publicUrl,
      })
      .eq("id", row.id);

    if (updateError) {
      return NextResponse.json({ error: "Failed to finalize the upload" }, { status: 500 });
    }

    const expiresAt = Date.now() + RESOLVE_TTL_SECONDS * 1000;
    const resolvedUrl =
      row.visibility === "public"
        ? (publicUrl ?? undefined)
        : await getSignedUrl(
            client,
            new GetObjectCommand({
              Bucket: row.bucket,
              Key: key,
              ResponseCacheControl: "private, max-age=86400, immutable",
            }),
            { expiresIn: RESOLVE_TTL_SECONDS },
          );

    return NextResponse.json({
      key,
      publicUrl: publicUrl ?? undefined,
      resolvedUrl,
      expiresAt,
    });
  } catch (error) {
    console.error("[media/confirm-upload] error:", error);
    return toErrorResponse(error);
  }
}
