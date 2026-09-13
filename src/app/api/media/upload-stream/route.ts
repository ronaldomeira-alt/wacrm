import { NextResponse } from "next/server";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { getR2Bucket, getR2Client, RESOLVE_TTL_SECONDS, type MediaKind } from "@/lib/storage/r2-client";
import { buildPublicMediaUrl, validateSizeAndMime } from "@/lib/storage/media-purpose";
import { MEDIA_MAX_BYTES, MEDIA_MAX_BYTES_BY_KIND } from "@/lib/storage/upload-media";
import { enqueueMediaNormalization } from "@/lib/media/server-media-normalization";

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount();

    const limit = checkRateLimit(`media-stream:${userId}`, RATE_LIMITS.mediaUpload);
    if (!limit.success) return rateLimitResponse(limit);

    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const declaredContentType = url.searchParams.get("contentType") || "application/octet-stream";

    if (!key) {
      return NextResponse.json({ error: "key parameter is required" }, { status: 400 });
    }

    // Verify pending reservation belongs to this account
    const { data: row, error: rowError } = await supabase
      .from("media_objects")
      .select("id, bucket, visibility, kind, status")
      .eq("account_id", accountId)
      .eq("object_key", key)
      .eq("status", "pending")
      .maybeSingle();

    if (rowError || !row) {
      return NextResponse.json(
        { error: "No pending reservation found for this key" },
        { status: 404 }
      );
    }

    let fileBuffer: Buffer;
    let actualContentType = declaredContentType;
    const requestContentType = request.headers.get("content-type") || "";

    if (requestContentType.includes("multipart/form-data")) {
      try {
        const formData = await request.formData();
        const file = formData.get("file");
        if (!file || typeof file === "string") {
          return NextResponse.json({ error: "No file provided in form data" }, { status: 400 });
        }
        const blob = file as Blob;
        const formType = blob.type ? blob.type.split(";")[0].toLowerCase().trim() : "";
        if (formType && formType !== "application/octet-stream") {
          actualContentType = formType;
        }
        const arrayBuf = await blob.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuf);
      } catch (formErr) {
        console.warn("[media/upload-stream] formData parse failed:", formErr);
        return NextResponse.json(
          { error: "Falha ao processar arquivo multipart (upload truncado ou corrompido)." },
          { status: 400 }
        );
      }
    } else {
      const arrayBuf = await request.arrayBuffer();
      fileBuffer = Buffer.from(arrayBuf);
    }

    if (actualContentType === "application/octet-stream" || !actualContentType) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.endsWith(".heic")) actualContentType = "image/heic";
      else if (lowerKey.endsWith(".heif")) actualContentType = "image/heif";
      else if (lowerKey.endsWith(".jpg") || lowerKey.endsWith(".jpeg")) actualContentType = "image/jpeg";
      else if (lowerKey.endsWith(".png")) actualContentType = "image/png";
      else if (lowerKey.endsWith(".webp")) actualContentType = "image/webp";
      else if (lowerKey.endsWith(".mp4") || lowerKey.endsWith(".m4v")) actualContentType = "video/mp4";
      else if (lowerKey.endsWith(".3gp") || lowerKey.endsWith(".3gpp")) actualContentType = "video/3gpp";
      else if (lowerKey.endsWith(".mov")) actualContentType = "video/quicktime";
      else if (lowerKey.endsWith(".pdf")) actualContentType = "application/pdf";
    }

    const kindLimit = (row.kind && MEDIA_MAX_BYTES_BY_KIND[row.kind as MediaKind]) || MEDIA_MAX_BYTES;
    if (fileBuffer.length > kindLimit) {
      return NextResponse.json(
        { error: `File exceeds maximum allowed size (${Math.round(kindLimit / 1024 / 1024)}MB)` },
        { status: 400 }
      );
    }

    const validationError = validateSizeAndMime(row.kind as MediaKind, actualContentType, fileBuffer.length);
    if (validationError) {
      return NextResponse.json(validationError, { status: 400 });
    }

    const client = getR2Client();
    const bucket = getR2Bucket();

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: actualContentType,
        Body: fileBuffer,
        CacheControl: "private, max-age=31536000, immutable",
      })
    );

    const publicUrl = row.visibility === "public" ? buildPublicMediaUrl(key) : null;

    const isHeicOrNeedsNormalization =
      row.kind === "image" &&
      (actualContentType === "image/heic" ||
        actualContentType === "image/heif" ||
        key.toLowerCase().endsWith(".heic") ||
        key.toLowerCase().endsWith(".heif") ||
        fileBuffer.length > 5 * 1024 * 1024);

    const { error: updateError } = await supabase
      .from("media_objects")
      .update({
        status: "completed",
        confirmed_at: new Date().toISOString(),
        content_type: actualContentType,
        size_bytes: fileBuffer.length,
        public_url: publicUrl,
        processing_status: isHeicOrNeedsNormalization ? "pending" : "none",
      })
      .eq("id", row.id);

    if (updateError) {
      return NextResponse.json({ error: "Failed to finalize upload" }, { status: 500 });
    }

    if (isHeicOrNeedsNormalization) {
      enqueueMediaNormalization({ objectKey: key, accountId });
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
      requiresProcessing: isHeicOrNeedsNormalization,
      processingStatus: isHeicOrNeedsNormalization ? "pending" : "none",
    });
  } catch (error) {
    console.error("[media/upload-stream] error:", error);
    return toErrorResponse(error);
  }
}
