import { useCallback, useEffect, useState } from "react";
import { isR2MediaKey } from "@/lib/storage/media-url-kind";

/**
 * Resolves a message's `media_url` to something an `<img>`/lightbox can
 * load directly.
 *
 *  - Inbound (customer) media is a same-origin authenticated proxy path
 *    (`/api/whatsapp/media/<id>`, see that route) — the browser can't
 *    just point an `<img src>` at it and get a stable result across
 *    re-renders the way it can a plain URL, so this fetches it once and
 *    hands back a `blob:` URL instead.
 *  - A plain `https://` value (legacy Supabase URL, a pasted external
 *    link, or our own `/api/media/public/{key}` permanent link) is
 *    already fetchable and passes through as-is.
 *  - A bare R2 key (private media) has no stable URL at all — it's
 *    resolved via POST /api/media/resolve into a short-TTL signed URL.
 *    Resolved values are cached in a module-level map (shared across
 *    every component instance, not per-hook state) so the same key
 *    rendered by both a message bubble and the media gallery reuses one
 *    signed URL, and a re-render doesn't re-hit the endpoint before the
 *    cached URL is actually close to expiring.
 *
 * Extracted out of `message-bubble.tsx`'s `MediaImage` so the same
 * resolution (and blob lifecycle — revoked on unmount/url change) is
 * shared with the media gallery's image thumbnails instead of a second
 * copy of this fetch-and-revoke dance.
 */

interface CachedResolution {
  url: string;
  expiresAt: number;
}

// Module-level — intentionally outside the hook, shared by every
// component instance across the whole app session.
const resolveCache = new Map<string, CachedResolution>();
// Coalesces concurrent resolve calls for the same key (e.g. the same
// message rendered in both the thread and a lightbox mounting at once)
// into a single in-flight request.
const inFlight = new Map<string, Promise<string>>();

// Re-resolve this long before the server's TTL actually lapses, so a
// slow network / render never hands back a URL that expires before the
// browser gets to use it.
const EXPIRY_BUFFER_MS = 30_000;

async function resolvePrivateKey(key: string): Promise<string> {
  const cached = resolveCache.get(key);
  if (cached && cached.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    return cached.url;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const res = await fetch("/api/media/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: [key] }),
      });
      if (!res.ok) throw new Error("Failed to resolve media");
      const data = (await res.json()) as {
        resolved: { key: string; url: string; expiresAt: number }[];
        invalid: string[];
      };
      const hit = data.resolved.find((r) => r.key === key);
      if (!hit) throw new Error("Media not found or not accessible");
      resolveCache.set(key, { url: hit.url, expiresAt: hit.expiresAt });
      return hit.url;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

export function useResolvedMediaSrc(url: string | undefined) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    setError(false);

    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        setSrc(URL.createObjectURL(blob));
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else if (isR2MediaKey(url)) {
      try {
        const resolved = await resolvePrivateKey(url);
        setSrc(resolved);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    load();
    return () => {
      setSrc((current) => {
        if (current?.startsWith("blob:")) URL.revokeObjectURL(current);
        return current;
      });
    };
  }, [load]);

  return { src, loading, error, setError };
}
