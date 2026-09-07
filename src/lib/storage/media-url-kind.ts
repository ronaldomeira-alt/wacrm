/**
 * Isomorphic — zero Node/AWS-SDK dependencies, safe to import from a
 * "use client" file. Kept separate from r2-client.ts (which pulls in
 * `node:crypto` and `@aws-sdk/client-s3`) specifically so client
 * components (e.g. use-resolved-media-src.ts) can check a stored
 * `media_url`/`header_media_url`'s shape without bundling server-only
 * code. r2-client.ts re-exports this so existing server-side imports
 * are unaffected.
 *
 * True when a stored value is a bare R2 object key rather than a plain
 * URL (legacy Supabase, a pasted external link, or our own
 * `/api/media/public/{key}` permanent link) or the Meta inbound proxy
 * path. The single source of truth is "does it look like a URL or our
 * known proxy path," not any positive R2-specific pattern, so a future
 * legitimate key format doesn't silently fall through.
 */
export type R2MediaKey = string & { readonly __brand?: "R2MediaKey" };

export function isR2MediaKey(value: string | null | undefined): value is R2MediaKey {
  if (!value) return false;
  if (value.startsWith("http://") || value.startsWith("https://")) return false;
  if (value.startsWith("/api/whatsapp/media/")) return false;
  return true;
}
