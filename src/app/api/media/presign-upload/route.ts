import { NextResponse } from "next/server";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { hasMinRole } from "@/lib/auth/roles";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import {
  buildR2MediaKey,
  getR2Bucket,
  getR2Client,
  RESOLVE_TTL_SECONDS,
  type MediaKind,
} from "@/lib/storage/r2-client";
import {
  isMediaPurpose,
  ruleForPurpose,
  validateMediaShape,
} from "@/lib/storage/media-purpose";

// Short — this URL is only ever used for one PUT, immediately after
// the response that hands it back.
const PRESIGN_TTL_SECONDS = 120;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Step 1 of the R2 upload flow (see resolve-media-for-send.ts's doc
 * comment and the plan for the full picture): validates the request,
 * dedups against `media_objects`, and — for a genuinely new file —
 * reserves a `pending` row and hands back a presigned PUT the browser
 * uses to upload directly to R2. Credentials never leave this route;
 * the browser only ever receives a single-object, short-TTL, signed
 * URL. Server-side validation here (size/MIME against the purpose's
 * rule) is a fast-fail convenience, not the authoritative check — the
 * PUT's own signature binds Content-Type, but not size, so
 * /api/media/confirm-upload's HEAD-based re-validation is what
 * actually enforces the limit against what R2 really received.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await getCurrentAccount();

    const limit = checkRateLimit(`media-upload:${userId}`, RATE_LIMITS.mediaUpload);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json();
    const { purpose, kind, filename, contentType, sizeBytes, sha256 } = body as {
      purpose?: string;
      kind?: string;
      filename?: string;
      contentType?: string;
      sizeBytes?: number;
      sha256?: string;
    };

    if (!isMediaPurpose(purpose)) {
      return NextResponse.json({ error: "Invalid or missing purpose" }, { status: 400 });
    }
    const rule = ruleForPurpose(purpose);
    if (!hasMinRole(role, rule.minRole)) {
      return NextResponse.json({ error: "Insufficient role for this upload purpose" }, { status: 403 });
    }
    if (typeof filename !== "string" || !filename) {
      return NextResponse.json({ error: "filename is required" }, { status: 400 });
    }
    if (typeof contentType !== "string" || !contentType) {
      return NextResponse.json({ error: "contentType is required" }, { status: 400 });
    }
    if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return NextResponse.json({ error: "sizeBytes must be a positive number" }, { status: 400 });
    }
    if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
      return NextResponse.json({ error: "sha256 must be a 64-character hex digest" }, { status: 400 });
    }
    if (!rule.allowedKinds.includes(kind as MediaKind)) {
      return NextResponse.json(
        { error: `"${kind}" is not a valid media kind for purpose "${purpose}"` },
        { status: 400 },
      );
    }
    const mediaKind = kind as MediaKind;

    const validationError = validateMediaShape(purpose, mediaKind, contentType, sizeBytes);
    if (validationError) {
      return NextResponse.json(validationError, { status: 400 });
    }

    const { visibility } = rule;

    // Dedup check — an existing completed object for this exact
    // (account, content, visibility) is reused as-is, no new R2 traffic.
    const { data: existing, error: existingError } = await supabase
      .from("media_objects")
      .select("id, object_key, public_url, status")
      .eq("account_id", accountId)
      .eq("sha256", sha256)
      .eq("visibility", visibility)
      .maybeSingle();

    if (existingError) {
      return NextResponse.json({ error: "Failed to check for an existing object" }, { status: 500 });
    }

    if (existing?.status === "completed") {
      const { error: bumpError } = await supabase.rpc("increment_media_object_reference", {
        p_object_id: existing.id,
      });
      if (bumpError) {
        console.error("[media/presign-upload] reference bump failed:", bumpError);
      }

      let resolvedUrl: string | undefined;
      let expiresAt: number | undefined;
      if (visibility === "private") {
        try {
          const client = getR2Client();
          const bucket = getR2Bucket();
          const command = new GetObjectCommand({
            Bucket: bucket,
            Key: existing.object_key,
            ResponseCacheControl: "private, max-age=86400, immutable",
          });
          resolvedUrl = await getSignedUrl(client, command, { expiresIn: RESOLVE_TTL_SECONDS });
          expiresAt = Date.now() + RESOLVE_TTL_SECONDS * 1000;
        } catch (e) {
          console.error("[media/presign-upload] dedup sign failed:", e);
        }
      }

      return NextResponse.json({
        dedup: true,
        key: existing.object_key,
        publicUrl: existing.public_url ?? undefined,
        resolvedUrl,
        expiresAt,
      });
    }
    if (existing?.status === "pending") {
      return NextResponse.json(
        { error: "An upload of this exact file is already in progress — retry shortly" },
        { status: 409 },
      );
    }

    const objectKey = buildR2MediaKey(accountId, mediaKind, filename);
    const bucket = getR2Bucket();

    const { error: insertError } = await supabase.from("media_objects").insert({
      account_id: accountId,
      sha256,
      object_key: objectKey,
      bucket,
      visibility,
      kind: mediaKind,
      content_type: contentType,
      size_bytes: sizeBytes,
      status: "pending",
    });

    if (insertError) {
      if (insertError.code === "23505") {
        // Lost a concurrent race for the same (account, sha256, visibility)
        // slot — someone else's request claimed it a moment ago.
        return NextResponse.json(
          { error: "An upload of this exact file is already in progress — retry shortly" },
          { status: 409 },
        );
      }
      console.error("[media/presign-upload] insert failed:", insertError);
      return NextResponse.json({ error: "Failed to reserve upload slot" }, { status: 500 });
    }

    const client = getR2Client();
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ContentType: contentType,
        CacheControl: "private, max-age=31536000, immutable",
      }),
      { expiresIn: PRESIGN_TTL_SECONDS },
    );

    return NextResponse.json({
      dedup: false,
      key: objectKey,
      uploadUrl,
      expiresIn: PRESIGN_TTL_SECONDS,
    });
  } catch (error) {
    console.error("[media/presign-upload] error:", error);
    return toErrorResponse(error);
  }
}
