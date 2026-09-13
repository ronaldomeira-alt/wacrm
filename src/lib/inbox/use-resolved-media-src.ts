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

const RESOLVE_CACHE_STORAGE_KEY = "wacrm_media_resolve_cache_v1";
const MAX_PERSISTED_RESOLUTIONS = 300;

export function loadPersistedResolutions(): void {
  if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") return;
  try {
    const raw = localStorage.getItem(RESOLVE_CACHE_STORAGE_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw) as Record<string, CachedResolution>;
    const now = Date.now();
    for (const [key, item] of Object.entries(entries)) {
      if (
        item &&
        typeof item.url === "string" &&
        typeof item.expiresAt === "number" &&
        item.expiresAt - EXPIRY_BUFFER_MS > now
      ) {
        resolveCache.set(key, item);
      }
    }
  } catch {
    // Ignore storage parse or private-mode errors
  }
}

// Immediately load on module evaluation
loadPersistedResolutions();

let persistTimer: ReturnType<typeof setTimeout> | null = null;
export function savePersistedResolutions(): void {
  if (typeof localStorage === "undefined" || typeof localStorage.setItem !== "function") return;
  if (persistTimer !== null) return;

  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const now = Date.now();
      const toPersist: Record<string, CachedResolution> = {};
      let count = 0;
      for (const [key, item] of resolveCache.entries()) {
        if (item.expiresAt - EXPIRY_BUFFER_MS > now) {
          toPersist[key] = item;
          count++;
          if (count >= MAX_PERSISTED_RESOLUTIONS) break;
        }
      }
      localStorage.setItem(RESOLVE_CACHE_STORAGE_KEY, JSON.stringify(toPersist));
    } catch {
      // Ignore quota or security errors
    }
  }, 50);
}

// ---------------------------------------------------------------------------
// 0. Local Blob Registry (Instant 0ms preview for staging & optimistic messages)
// ---------------------------------------------------------------------------
const localBlobRegistry = new Map<string, string>();
const revokeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Registers an in-memory blob: URL for a storage key or path.
 * Used during staging and optimistic send so components (MessageAlbum,
 * MessageBubble, Lightbox) render the instant local bitmap with 0ms delay
 * and zero network roundtrips.
 */
export function registerLocalMediaBlob(key: string, blobUrl: string): void {
  if (!key || !blobUrl || !blobUrl.startsWith("blob:")) return;
  localBlobRegistry.set(key, blobUrl);
  const existingTimer = revokeTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
    revokeTimers.delete(key);
  }
}

/** Returns the registered local blob URL for a key if still active. */
export function getLocalMediaBlob(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return localBlobRegistry.get(key);
}

/**
 * Schedules revocation of a local blob after a safety delay (default 5 min).
 * Gives plenty of time for message bubbles, animations, and transitions to
 * settle while preventing long-term memory leaks.
 */
export function scheduleRevokeLocalMediaBlob(key: string, delayMs = 300_000): void {
  const blobUrl = localBlobRegistry.get(key);
  if (!blobUrl) return;

  const existing = revokeTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    revokeTimers.delete(key);
    const current = localBlobRegistry.get(key);
    if (current === blobUrl) {
      localBlobRegistry.delete(key);
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // Ignore
      }
    }
  }, delayMs);

  revokeTimers.set(key, timer);
}

/** Immediately revokes a local blob (e.g. user cancelled or discarded draft). */
export function revokeLocalMediaBlobImmediately(key: string): void {
  const existing = revokeTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    revokeTimers.delete(key);
  }
  const blobUrl = localBlobRegistry.get(key);
  if (blobUrl) {
    localBlobRegistry.delete(key);
    if (blobUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // Ignore
      }
    }
  }
}

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
    savePersistedResolutions();

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
  // 1. Instant local blob (0ms wait for staged/optimistic media)
  const localBlob = localBlobRegistry.get(url);
  if (localBlob) {
    return localBlob;
  }

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
  savePersistedResolutions();
}

const inFlightResolutions = new Map<string, Promise<string>>();

/** Resolves a single private R2 key through the batched queue. */
export async function resolvePrivateKey(key: string): Promise<string> {
  const cached = resolveCache.get(key);
  if (cached && cached.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    return cached.url;
  }

  const existingInFlight = inFlightResolutions.get(key);
  if (existingInFlight) {
    return existingInFlight;
  }

  const promise = new Promise<string>((resolve, reject) => {
    let list = pendingBatch.get(key);
    if (!list) {
      list = [];
      pendingBatch.set(key, list);
    }
    list.push({ resolve, reject });

    if (batchTimer === null) {
      batchTimer = setTimeout(flushBatch, BATCH_DEBOUNCE_MS);
    }
  }).finally(() => {
    inFlightResolutions.delete(key);
  });

  inFlightResolutions.set(key, promise);
  return promise;
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

  const uniqueNeededR2 = Array.from(new Set(neededR2));
  if (uniqueNeededR2.length > 0) {
    tasks.push(
      ...uniqueNeededR2.map(async (k) => {
        try {
          const resolved = await resolvePrivateKey(k);
          result.set(k, resolved);
        } catch {
          // Leave unmapped on error
        }
      }),
    );
  }

  const uniqueNeededProxy = Array.from(new Set(neededProxy));
  if (uniqueNeededProxy.length > 0) {
    tasks.push(
      ...uniqueNeededProxy.map(async (k) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, url]);

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
  const [asyncResolved, setAsyncResolved] = useState<Map<string, string>>(() => new Map());
  const [error, setError] = useState(false);

  // Synchronously compute current resolved URLs from memory cache and async map
  const resolvedUrls = useMemo(() => {
    return urls.map((u) => {
      if (!u) return "";
      return (
        asyncResolved.get(u) ??
        getCachedMediaSrc(u) ??
        (isR2MediaKey(u) || u.startsWith("/api/whatsapp/media/") ? "" : u)
      );
    });
  }, [urls, asyncResolved]);

  const missingKeys = useMemo(() => {
    return urls.filter(
      (u): u is string => !!u && isR2MediaKey(u) && !getCachedMediaSrc(u) && !asyncResolved.has(u),
    );
  }, [urls, asyncResolved]);

  const missingInbound = useMemo(() => {
    return urls.filter(
      (u): u is string =>
        !!u && u.startsWith("/api/whatsapp/media/") && !getInboundBlob(u) && !asyncResolved.has(u),
    );
  }, [urls, asyncResolved]);

  const loading = missingKeys.length > 0 || missingInbound.length > 0;

  useEffect(() => {
    if (missingKeys.length === 0 && missingInbound.length === 0) {
      return;
    }

    let cancelled = false;

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
        setAsyncResolved((prev) => {
          const next = new Map(prev);
          for (const [k, v] of resolvedMap.entries()) {
            next.set(k, v);
          }
          return next;
        });
      } catch {
        if (!cancelled) {
          setError(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [missingKeys, missingInbound]);

  return { urls: resolvedUrls, loading, error };
}

/** Test-only helper to clear module caches between unit test suites. */
export function __resetResolvedMediaCacheForTests(): void {
  for (const timer of revokeTimers.values()) {
    clearTimeout(timer);
  }
  revokeTimers.clear();
  localBlobRegistry.clear();

  resolveCache.clear();
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(RESOLVE_CACHE_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
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
  inFlightResolutions.clear();
  if (batchTimer !== null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
}
