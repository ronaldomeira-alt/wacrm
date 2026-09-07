import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";

/**
 * Cloudflare R2 client — server-only. Never import this from a
 * "use client" file or any module reachable from the browser bundle;
 * it reads the account's real R2 credentials from process.env.
 *
 * R2 is S3-compatible, so the AWS SDK v3 client works against it
 * unchanged (region is a required field for the SDK but meaningless
 * to R2 — "auto" is Cloudflare's documented placeholder).
 *
 * Single bucket (`wacrm-media`, private) for everything — both
 * conversation-scoped media (chat attachments, forwarded media, voice
 * notes) and deliberately-public commercial media (WhatsApp template
 * header images). "Public" is a `media_objects.visibility` flag, not a
 * separate bucket: an R2 Custom Domain would need its zone's DNS
 * managed by this Cloudflare account, which crmronaldomeira.com isn't,
 * and every paid path to get one (Partial/CNAME setup, a delegated
 * subdomain zone) requires a Business/Enterprise plan — ruled out by
 * the zero-recurring-cost requirement. Instead, `/api/media/public/
 * [...key]` (no session) mints a short-TTL signed GET URL for a
 * `visibility='public'` object and 302-redirects to it — see that
 * route and resolve-media-for-send.ts's fourth branch.
 */

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
}

/**
 * Reads + validates every R2 env var in one place so a missing
 * variable fails loudly and immediately, at first use, rather than
 * as a cryptic SDK error deep inside a request handler. Never logs
 * the resolved values.
 */
export function getR2Config(): R2Config {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  const endpoint = process.env.R2_ENDPOINT;

  const missing = [
    !accountId && "R2_ACCOUNT_ID",
    !accessKeyId && "R2_ACCESS_KEY_ID",
    !secretAccessKey && "R2_SECRET_ACCESS_KEY",
    !bucket && "R2_BUCKET",
    !endpoint && "R2_ENDPOINT",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `R2 storage is not configured — missing env var(s): ${missing.join(", ")}`,
    );
  }

  return {
    accountId: accountId!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    bucket: bucket!,
    endpoint: endpoint!,
  };
}

let _r2Client: S3Client | null = null;
let _r2Bucket: string | null = null;

/** Lazy singleton, same shape as the various `supabaseAdmin()` helpers
 *  elsewhere in this codebase (see src/lib/flows/admin-client.ts). */
export function getR2Client(): S3Client {
  if (!_r2Client) {
    const config = getR2Config();
    _r2Client = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    _r2Bucket = config.bucket;
  }
  return _r2Client;
}

/** The configured bucket name — call after (or alongside) getR2Client()
 *  so the same missing-env-var error surfaces consistently. */
export function getR2Bucket(): string {
  if (!_r2Bucket) {
    _r2Bucket = getR2Config().bucket;
  }
  return _r2Bucket;
}

export { isR2MediaKey } from "./media-url-kind";

export const RESOLVE_TTL_SECONDS = 86400;

export type MediaKind = "image" | "video" | "audio" | "document";

/**
 * Sanitizes a filename into a short, safe basename — mirrors
 * `buildMediaPath`'s logic in upload-media.ts exactly (same rules:
 * lower-cased non-safe chars collapsed to `_`, 40-char cap, "file"/
 * "bin" fallbacks) so the two path builders behave identically from
 * a caller's point of view, differing only in the parent-path shape.
 */
function safeBasenameAndExt(fileName: string): { base: string; ext: string } {
  const hasExt = /\.[^.]+$/.test(fileName);
  const ext = hasExt ? fileName.split(".").pop()!.toLowerCase() : "bin";
  const base =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 40) || "file";
  return { base, ext };
}

/**
 * Builds the R2 object key for a new upload:
 *
 *   {account_id}/{kind}/{yyyy}/{mm}/{uuid}-{slug}.{ext}
 *
 * Same key shape regardless of `visibility` — public vs private is a
 * `media_objects` column, not anything encoded in the key.
 *
 * Deliberately never URL-shaped (no scheme, no "://") — this is what
 * lets every consumer of a stored `media_url`/`header_media_url` value
 * tell "R2 key" apart from "legacy Supabase URL" / "Meta inbound proxy
 * path" / "our own public-media redirect URL" just by looking at the
 * string's shape, with zero DB schema change. `r2-client.test.ts`
 * asserts this invariant directly, including against filenames that
 * are themselves URL-shaped.
 *
 * Uses a fresh UUID (not a timestamp) as the object's own id — unlike
 * `buildMediaPath`'s timestamp scheme, this doubles as the value the
 * `media_objects` dedup table can reference without any ambiguity
 * about which physical object a row describes.
 */
export function buildR2MediaKey(
  accountId: string,
  kind: MediaKind,
  fileName: string,
  now: number = Date.now(),
): string {
  const { base, ext } = safeBasenameAndExt(fileName);
  const date = new Date(now);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const id = randomUUID();
  return `${accountId}/${kind}/${yyyy}/${mm}/${id}-${base}.${ext}`;
}
