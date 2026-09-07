import { NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { getR2Bucket, getR2Client, isR2MediaKey } from "@/lib/storage/r2-client";

/** 24h TTL — allows browser caching, keeps URLs stable across conversation
 *  navigation and long-duration CRM sessions without breaking previews. */
export const RESOLVE_TTL_SECONDS = 24 * 60 * 60;

const MAX_KEYS_PER_REQUEST = 50;

/**
 * Read path for private-bucket media: turns a bare R2 key into a
 * short-TTL signed GET URL, after verifying the caller's own account
 * actually owns it. Two independent checks, not one:
 *  1. the key's leading path segment (the account id, by construction
 *     of buildR2MediaKey) must equal the caller's own accountId;
 *  2. a completed `media_objects` row for that exact
 *     (account_id, object_key, visibility='private') must exist.
 * (1) alone would still let a guessed-but-never-uploaded key resolve
 * to a signed URL for an object that doesn't exist (R2 would just
 * 404 the GET — safe, but not the behavior we want); (2) is what
 * makes an unknown/foreign/tampered key fail here, at our own layer,
 * rather than downstream at R2.
 *
 * Public-bucket media never goes through this endpoint — its
 * permanent URL is stored directly in the DB and used as-is.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount();

    const limit = checkRateLimit(`media-resolve:${userId}`, RATE_LIMITS.mediaResolve);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json();
    const { keys } = body as { keys?: unknown };

    if (!Array.isArray(keys) || keys.length === 0) {
      return NextResponse.json({ error: "keys must be a non-empty array" }, { status: 400 });
    }
    if (keys.length > MAX_KEYS_PER_REQUEST) {
      return NextResponse.json(
        { error: `At most ${MAX_KEYS_PER_REQUEST} keys per request` },
        { status: 400 },
      );
    }
    if (!keys.every((k) => typeof k === "string")) {
      return NextResponse.json({ error: "keys must be strings" }, { status: 400 });
    }
    const requested = keys as string[];

    // Cheap, no-DB-round-trip rejection first: not a real R2 key at
    // all, or its account segment doesn't match the caller.
    const invalid: string[] = [];
    const candidates: string[] = [];
    for (const key of requested) {
      if (isR2MediaKey(key) && key.split("/")[0] === accountId) {
        candidates.push(key);
      } else {
        invalid.push(key);
      }
    }

    let ownedKeys = new Set<string>();
    if (candidates.length > 0) {
      const { data: rows, error } = await supabase
        .from("media_objects")
        .select("object_key")
        .eq("account_id", accountId)
        .eq("visibility", "private")
        .eq("status", "completed")
        .in("object_key", candidates);

      if (error) {
        return NextResponse.json({ error: "Failed to verify media ownership" }, { status: 500 });
      }
      ownedKeys = new Set((rows ?? []).map((r) => r.object_key as string));
    }

    for (const key of candidates) {
      if (!ownedKeys.has(key)) invalid.push(key);
    }

    const bucket = getR2Bucket();
    const client = getR2Client();
    const expiresAt = Date.now() + RESOLVE_TTL_SECONDS * 1000;

    const resolved = await Promise.all(
      candidates
        .filter((key) => ownedKeys.has(key))
        .map(async (key) => ({
          key,
          url: await getSignedUrl(
            client,
            new GetObjectCommand({
              Bucket: bucket,
              Key: key,
              ResponseCacheControl: "private, max-age=86400, immutable",
            }),
            {
              expiresIn: RESOLVE_TTL_SECONDS,
            },
          ),
          expiresAt,
        })),
    );

    return NextResponse.json({ resolved, invalid });
  } catch (error) {
    console.error("[media/resolve] error:", error);
    return toErrorResponse(error);
  }
}
