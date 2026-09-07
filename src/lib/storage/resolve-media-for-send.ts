import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getR2Bucket, getR2Client, isR2MediaKey } from "./r2-client";
import { publicMediaUrlPrefix } from "./media-purpose";
import { supabaseAdmin } from "./admin-client";

/**
 * How long a signed URL minted for an outbound fetch stays valid.
 * Meta fetches media immediately at send time, and
 * generateDocumentPreviewFromUrl fetches immediately server-side too —
 * this only needs to outlast one request, with generous headroom for
 * a retry.
 */
const SEND_TIME_URL_TTL_SECONDS = 10 * 60;

async function resolvePublicKeyToSignedUrl(key: string): Promise<string> {
  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from("media_objects")
    .select("object_key")
    .eq("object_key", key)
    .eq("visibility", "public")
    .eq("status", "completed")
    .maybeSingle();

  if (!row) {
    throw new Error(`Public media object not found or not public for key: ${key}`);
  }

  const client = getR2Client();
  const bucket = getR2Bucket();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: row.object_key }), {
    expiresIn: SEND_TIME_URL_TTL_SECONDS,
  });
}

/**
 * Resolves a stored `media_url` / `header_media_url` value into
 * something an outside party (Meta's servers, or our own SSRF-guarded
 * fetch in generateDocumentPreviewFromUrl/ensureImageHeaderHandle) can
 * actually GET right now. Never persists the result anywhere — minted
 * fresh on every call, used once, discarded.
 *
 *  - our own `{NEXT_PUBLIC_SITE_URL}/api/media/public/{key}` (built by
 *    media-purpose.ts's buildPublicMediaUrl) — resolved *in process*
 *    to a signed GET URL, never by making an HTTP request to that
 *    route. This matters: `ensureImageHeaderHandle`'s fetch uses
 *    `redirect: 'manual'` as an SSRF guard against a pasted external
 *    URL 3xx-bouncing to an internal address — if this function
 *    instead just returned our own public-media URL unchanged, that
 *    fetch would see the route's 302 and fail the send.
 *  - any other `https://...` — a legacy Supabase URL, or a pasted
 *    external link — already fetchable, returned as-is.
 *  - `/api/whatsapp/media/...` — the Meta inbound proxy path, needs our
 *    own session auth and is never actually fetchable by an outside
 *    party. Callers should never pass this in for an outbound send —
 *    forward/route.ts re-hosts inbound media before it ever reaches
 *    the send core — so this is a defensive passthrough, not a real
 *    code path.
 *  - anything else — a bare R2 key — is private media, signed into a
 *    short-TTL GET URL.
 */
export async function resolveMediaUrlForSend(mediaUrl: string): Promise<string> {
  let publicPrefix: string | null = null;
  try {
    publicPrefix = publicMediaUrlPrefix();
  } catch {
    // NEXT_PUBLIC_SITE_URL unset — this branch can't apply; fall through.
  }
  if (publicPrefix && mediaUrl.startsWith(publicPrefix)) {
    return resolvePublicKeyToSignedUrl(mediaUrl.slice(publicPrefix.length));
  }

  if (!isR2MediaKey(mediaUrl)) {
    return mediaUrl;
  }

  const client = getR2Client();
  const bucket = getR2Bucket();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: mediaUrl }),
    { expiresIn: SEND_TIME_URL_TTL_SECONDS },
  );
}
