import { useCallback, useEffect, useMemo, useState } from "react";
import { isR2MediaKey } from "@/lib/storage/media-url-kind";

/**
 * Resolves a message's `media_url` to something an `<img>`/lightbox can
 * load directly.
 *
 *  - Inbound (customer) media is a same-origin authenticated proxy path
 *    (`/api/whatsapp/media/<id>`, see that route) — fetched once and
 *    stored in an in-memory LRU cache of `blob:` URLs so switching
 *    conversations never re-downloads media from Meta. Oldest entries are
 *    safely revoked with `URL.revokeObjectURL` when capacity is reached.
 *  - A plain `https://` value (legacy Supabase URL, a pasted external
 *    link, or our own `/api/media/public/{key}` permanent link) is
 *    already fetchable and passes through as-is synchronously.
 *  - A bare R2 key (private media) has no stable URL at all — it's
 *    resolved via POST /api/media/resolve into a signed URL.
 *    Resolved values are cached in a module-level map (shared across
 *    every component instance) with 24h TTL.
 *  - Multiple concurrent requests are coalesced into a single batched
 *    POST /api/media/resolve request (chunked to at most 40 keys),
 *    eliminating N-request fanout on conversation open.
 */

interface CachedResolution {
  url: string;
  expiresAt: number;
}

// Module-level — shared by every component instance across the app session.
const resolveCache = new Map<string, CachedResolution>();

// Re-resolve this long before the server's TTL actually lapses.
const EXPIRY_BUFFER_MS = 60_000;

// ---------------------------------------------------------------------------
// 1. Inbound Meta blob LRU cache (Safeguard 1: bounded size + safe revoke)
// ---------------------------------------------------------------------------
const MAX_INBOUND_BLOBS = 60;
const inboundBlobCache = new Map<string, string>();

function getInboundBlob(url: string): string | undefined {
  const hit = inboundBlobCache.get(url);
  if (!hit) return undefined;
  // Touch LRU: re-insert at end
  inboundBlobCache.delete(url);
  inboundBlobCache.set(url, hit);
  return hit;
}

function setInboundBlob(url: string, blobUrl: string): void {
  if (inboundBlobCache.has(url)) {
    inboundBlobCache.delete(url);
  } else if (inboundBlobCache.size >= MAX_INBOUND_BLOBS) {
    const oldestKey = inboundBlobCache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldestBlob = inboundBlobCache.get(oldestKey);
      if (oldestBlob && oldestBlob.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(oldestBlob);
        } catch {
          // Ignore revoke errors
        }
      }
      inboundBlobCache.delete(oldestKey);
    }
  }
  inboundBlobCache.set(url, blobUrl);
}

// ---------------------------------------------------------------------------
// 2. Batching Queue with Chunking (Safeguard 2: chunk at most 40 keys)
// ---------------------------------------------------------------------------
const MAX_KEYS_PER_CHUNK = 40;
const BATCH_DEBOUNCE_MS = 10;

interface BatchQueueItem {
  resolve: (url: string) => void;
  reject: (err: unknown) => void;
}

const pendingBatch = new Map<string, BatchQueueItem[]>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function flushBatch() {
  batchTimer = null;
  if (pendingBatch.size === 0) return;

  const currentBatch = new Map(pendingBatch);
  pendingBatch.clear();

  const allKeys = Array.from(currentBatch.keys());
  for (let i = 0; i < allKeys.length; i += MAX_KEYS_PER_CHUNK) {
    const chunkKeys = allKeys.slice(i, i + MAX_KEYS_PER_CHUNK);
    void processBatchChunk(chunkKeys, currentBatch);
  }
}

async function processBatchChunk(
  keys: string[],
  listenersMap: Map<string, BatchQueueItem[]>,
) {
  try {
    const res = await fetch("/api/media/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    });

    if (!res.ok) {
      throw new Error(`Failed to resolve media (HTTP ${res.status})`);
    }

    const data = (await res.json()) as {
      resolved: { key: string; url: string; expiresAt: number }[];
      invalid: string[];
    };

    const resolvedMap = new Map<string, string>();
    for (const r of data.resolved) {
      resolveCache.set(r.key, { url: r.url, expiresAt: r.expiresAt });
      resolvedMap.set(r.key, r.url);
    }

    for (const key of keys) {
      const listeners = listenersMap.get(key) ?? [];
      const resolvedUrl = resolvedMap.get(key);
      if (resolvedUrl) {
        for (const { resolve } of listeners) resolve(resolvedUrl);
      } else {
        for (const { reject } of listeners) {
          reject(new Error(`Media key ${key} was invalid or not found`));
        }
      }
    }
  } catch (err) {
    for (const key of keys) {
      const listeners = listenersMap.get(key) ?? [];
      for (const { reject } of listeners) reject(err);
    }
  }
}

/** Synchronously checks if a media URL is already available in cache or plain format. */
export function getCachedMediaSrc(url: string | undefined): string | null {
  if (!url) return null;
  if (isR2MediaKey(url)) {
    const cached = resolveCache.get(url);
    if (cached && cached.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
      return cached.url;
    }
    return null;
  }
  if (url.startsWith("/api/whatsapp/media/")) {
    return getInboundBlob(url) ?? null;
  }
  return url;
}

/** Pre-seeds resolution cache with a known signed or public URL (e.g. upon upload confirm). */
export function seedMediaResolution(key: string, url: string, expiresAt?: number): void {
  resolveCache.set(key, {
    url,
    expiresAt: expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
  });
}

/** Resolves a single private R2 key through the batched queue. */
export async function resolvePrivateKey(key: string): Promise<string> {
  const cached = resolveCache.get(key);
  if (cached && cached.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    return cached.url;
  }

  return new Promise<string>((resolve, reject) => {
    let list = pendingBatch.get(key);
    if (!list) {
      list = [];
      pendingBatch.set(key, list);
    }
    list.push({ resolve, reject });

    if (batchTimer === null) {
      batchTimer = setTimeout(flushBatch, BATCH_DEBOUNCE_MS);
    }
  });
}

/** Resolves an array of media keys/URLs, returning a map of original key -> resolved URL. */
export async function resolveMediaKeys(keys: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const neededR2: string[] = [];
  const neededProxy: string[] = [];

  for (const k of keys) {
    if (!k) continue;
    const cached = getCachedMediaSrc(k);
    if (cached) {
      result.set(k, cached);
    } else if (isR2MediaKey(k)) {
      neededR2.push(k);
    } else if (k.startsWith("/api/whatsapp/media/")) {
      neededProxy.push(k);
    } else {
      result.set(k, k);
    }
  }

  const tasks: Promise<void>[] = [];

  if (neededR2.length > 0) {
    tasks.push(
      ...neededR2.map(async (k) => {
        try {
          const resolved = await resolvePrivateKey(k);
          result.set(k, resolved);
        } catch {
          // Leave unmapped on error
        }
      }),
    );
  }

  if (neededProxy.length > 0) {
    tasks.push(
      ...neededProxy.map(async (k) => {
        try {
          const res = await fetch(k);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const blobUrl = URL.createObjectURL(blob);
          setInboundBlob(k, blobUrl);
          result.set(k, blobUrl);
        } catch {
          // Leave unmapped on error
        }
      }),
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }

  return result;
}

/** Fire-and-forget prefetch of uncached R2 keys to warm cache before scrolling/clicking. */
export function prefetchMediaKeys(keys: string[]): void {
  const uncached = keys.filter((k) => isR2MediaKey(k) && !getCachedMediaSrc(k));
  if (uncached.length === 0) return;
  void resolveMediaKeys(uncached);
}

/**
 * Hook for resolving a single media URL.
 * Initializes synchronously from cache so returning to a conversation
 * renders immediately with 0ms delay and zero spinners.
 */
export function useResolvedMediaSrc(url: string | undefined) {
  const initialSrc = getCachedMediaSrc(url);
  const [src, setSrc] = useState<string | null>(initialSrc);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState<boolean>(!initialSrc && !!url);

  const load = useCallback(async () => {
    if (!url) {
      setSrc(null);
      setLoading(false);
      return;
    }

    const currentCached = getCachedMediaSrc(url);
    if (currentCached) {
      setSrc(currentCached);
      setLoading(false);
      setError(false);
      return;
    }

    setLoading(true);
    setError(false);

    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        setInboundBlob(url, blobUrl);
        setSrc(blobUrl);
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
    const currentCached = getCachedMediaSrc(url);
    if (!currentCached && url) {
      void load();
    } else if (currentCached && currentCached !== src) {
      setSrc(currentCached);
      setLoading(false);
    }
  }, [load, url, src]);

  return { src, loading, error, setError };
}

/**
 * Hook for resolving multiple media URLs in parallel (e.g. MessageAlbum).
 * Guarantees all items passed to a lightbox or gallery are resolved URLs
 * rather than raw R2 storage keys.
 */
export function useResolvedMediaSrcs(urls: (string | undefined)[]): {
  urls: string[];
  loading: boolean;
  error: boolean;
} {
  const initialResolved = useMemo(() => {
    return urls.map((u) => getCachedMediaSrc(u) ?? u ?? "");
  }, [urls]);

  const allCached = useMemo(() => {
    return urls.every((u) => !u || !!getCachedMediaSrc(u));
  }, [urls]);

  const [resolvedUrls, setResolvedUrls] = useState<string[]>(initialResolved);
  const [loading, setLoading] = useState<boolean>(!allCached && urls.length > 0);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const missingKeys = urls.filter(
      (u): u is string => !!u && isR2MediaKey(u) && !getCachedMediaSrc(u),
    );
    const missingInbound = urls.filter(
      (u): u is string =>
        !!u && u.startsWith("/api/whatsapp/media/") && !getInboundBlob(u),
    );

    if (missingKeys.length === 0 && missingInbound.length === 0) {
      setResolvedUrls(urls.map((u) => getCachedMediaSrc(u) ?? u ?? ""));
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(false);

    (async () => {
      try {
        const resolvedMap = await resolveMediaKeys(missingKeys);
        await Promise.all(
          missingInbound.map(async (inboundUrl) => {
            try {
              const res = await fetch(inboundUrl);
              if (res.ok) {
                const blob = await res.blob();
                const blobUrl = URL.createObjectURL(blob);
                setInboundBlob(inboundUrl, blobUrl);
                resolvedMap.set(inboundUrl, blobUrl);
              }
            } catch {
              // Non-fatal for individual blob
            }
          }),
        );

        if (cancelled) return;
        setResolvedUrls(
          urls.map((u) => (u ? (resolvedMap.get(u) ?? getCachedMediaSrc(u) ?? u) : "")),
        );
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [urls]);

  return { urls: resolvedUrls, loading, error };
}

/** Test-only helper to clear module caches between unit test suites. */
export function __resetResolvedMediaCacheForTests(): void {
  resolveCache.clear();
  for (const blobUrl of inboundBlobCache.values()) {
    if (blobUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // Ignore
      }
    }
  }
  inboundBlobCache.clear();
  pendingBatch.clear();
  if (batchTimer !== null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
}
