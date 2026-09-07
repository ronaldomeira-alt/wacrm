import { NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/storage/admin-client";
import { getR2Bucket, getR2Client, isR2MediaKey } from "@/lib/storage/r2-client";

/** Short — minted fresh on every hit and never persisted; only needs
 *  to outlive the redirect + the client's immediate follow-up GET. */
const REDIRECT_TTL_SECONDS = 5 * 60;

/**
 * Permanent, unauthenticated link for deliberately-public commercial
 * media (currently: WhatsApp template header images) — see the plan's
 * "Revisão 2" for why this exists instead of an R2 Custom Domain
 * (zero recurring cost, no DNS change to crmronaldomeira.com).
 *
 * No session is required by design, but every request is still fully
 * gated:
 *  1. `isR2MediaKey` rejects anything URL-shaped or the Meta proxy
 *     path before touching the database at all.
 *  2. The row lookup filters on `visibility = 'public' AND status =
 *     'completed'` — visibility is read from `media_objects`, never
 *     accepted as a request parameter, so a caller can never choose
 *     "treat this key as public."
 *  3. A key that's unknown, private, or still `pending` all produce
 *     the exact same generic 404 — this endpoint is never an oracle
 *     that reveals which of those three is true for a given key.
 *  4. The signed URL is minted fresh against the bucket per request
 *     and never written anywhere; only a 302 redirect is returned.
 *  5. Rate-limited per IP (no account to key on) via
 *     RATE_LIMITS.mediaPublicRedirect.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkRateLimit(`media-public:${ip}`, RATE_LIMITS.mediaPublicRedirect);
  if (!limit.success) return rateLimitResponse(limit);

  const { key: segments } = await params;
  const key = (segments ?? []).join("/");

  if (!isR2MediaKey(key)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const admin = supabaseAdmin();
  const { data: row, error } = await admin
    .from("media_objects")
    .select("object_key")
    .eq("object_key", key)
    .eq("visibility", "public")
    .eq("status", "completed")
    .maybeSingle();

  if (error) {
    console.error("[media/public] lookup failed:", error);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Same response whether the key is unknown, private, or still
  // pending — never distinguish, so this endpoint can't be used to
  // fingerprint private keys.
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const client = getR2Client();
  const bucket = getR2Bucket();
  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: row.object_key }),
    { expiresIn: REDIRECT_TTL_SECONDS },
  );

  return NextResponse.redirect(url, { status: 302 });
}
