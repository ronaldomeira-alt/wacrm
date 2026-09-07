import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCachedMediaSrc,
  seedMediaResolution,
  resolveMediaKeys,
  __resetResolvedMediaCacheForTests,
} from "./use-resolved-media-src";
import { isR2MediaKey } from "@/lib/storage/media-url-kind";

describe("use-resolved-media-src", () => {
  beforeEach(() => {
    __resetResolvedMediaCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    __resetResolvedMediaCacheForTests();
    vi.restoreAllMocks();
  });

  describe("getCachedMediaSrc & seedMediaResolution", () => {
    it("returns plain URLs as-is synchronously", () => {
      expect(getCachedMediaSrc("https://example.com/image.png")).toBe(
        "https://example.com/image.png",
      );
      expect(getCachedMediaSrc("http://cdn.com/asset.jpg")).toBe(
        "http://cdn.com/asset.jpg",
      );
    });

    it("returns null for unseen R2 keys and undefined input", () => {
      expect(getCachedMediaSrc(undefined)).toBeNull();
      expect(getCachedMediaSrc("acc_123/image/2026/09/pic.png")).toBeNull();
    });

    it("returns seeded resolution immediately from memory cache", () => {
      const key = "acc_123/image/2026/09/pic.png";
      const signedUrl = "https://r2.example.com/signed?sig=123";

      seedMediaResolution(key, signedUrl);
      expect(getCachedMediaSrc(key)).toBe(signedUrl);
    });

    it("expires cached resolution when expired", () => {
      const key = "acc_123/image/2026/09/expired.png";
      const signedUrl = "https://r2.example.com/signed?sig=expired";

      // Seed with an expiry in the past
      seedMediaResolution(key, signedUrl, Date.now() - 1000);
      expect(getCachedMediaSrc(key)).toBeNull();
    });
  });

  describe("isR2MediaKey", () => {
    it("identifies R2 keys vs URLs vs proxy paths", () => {
      expect(isR2MediaKey(null)).toBe(false);
      expect(isR2MediaKey(undefined)).toBe(false);
      expect(isR2MediaKey("")).toBe(false);
      expect(isR2MediaKey("https://storage.supabase.co/file.png")).toBe(false);
      expect(isR2MediaKey("http://cdn.example.com/file.png")).toBe(false);
      expect(isR2MediaKey("/api/whatsapp/media/meta-media-id-123")).toBe(false);

      expect(isR2MediaKey("acc_abc/image/2026/09/file.png")).toBe(true);
      expect(isR2MediaKey("account-1/document/doc.pdf")).toBe(true);
    });
  });

  describe("batching & chunking (Safeguard 2)", () => {
    it("batches concurrent requests and chunks at 40 keys maximum", async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/media/resolve") {
          const body = JSON.parse(init?.body as string) as { keys: string[] };
          const resolved = body.keys.map((k) => ({
            key: k,
            url: `https://signed.example.com/${k}`,
            expiresAt: Date.now() + 86400 * 1000,
          }));
          return {
            ok: true,
            json: async () => ({ resolved, invalid: [] }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });

      vi.stubGlobal("fetch", fetchMock);

      // Generate 45 unique R2 keys
      const keys = Array.from({ length: 45 }, (_, i) => `acc_test/image/file_${i}.png`);

      const promise = resolveMediaKeys(keys);
      const results = await promise;

      expect(results.size).toBe(45);
      expect(results.get("acc_test/image/file_0.png")).toBe(
        "https://signed.example.com/acc_test/image/file_0.png",
      );

      // Should have made 2 chunked requests: chunk 1 (40 keys), chunk 2 (5 keys)
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const firstCallBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(firstCallBody.keys).toHaveLength(40);

      const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
      expect(secondCallBody.keys).toHaveLength(5);
    });

    it("deduplicates keys and returns immediately if all keys are cached", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      seedMediaResolution("acc_1/image/a.png", "https://signed.example.com/a.png");
      seedMediaResolution("acc_1/image/b.png", "https://signed.example.com/b.png");

      const results = await resolveMediaKeys([
        "acc_1/image/a.png",
        "acc_1/image/b.png",
        "acc_1/image/a.png",
      ]);

      expect(results.get("acc_1/image/a.png")).toBe("https://signed.example.com/a.png");
      expect(results.get("acc_1/image/b.png")).toBe("https://signed.example.com/b.png");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("Inbound Meta Blob LRU cache (Safeguard 1)", () => {
    it("evicts oldest blob and revokes Object URL when cache exceeds 60 items", async () => {
      const revokeMock = vi.fn();
      vi.stubGlobal("URL", {
        ...globalThis.URL,
        createObjectURL: vi.fn(() => `blob:mock-${Math.random()}`),
        revokeObjectURL: revokeMock,
      });

      const fetchMock = vi.fn(async () => {
        return {
          ok: true,
          blob: async () => new Blob(["test"], { type: "image/jpeg" }),
        } as Response;
      });
      vi.stubGlobal("fetch", fetchMock);

      // Resolving 65 inbound Meta proxy URLs sequentially
      for (let i = 0; i < 65; i++) {
        const proxyUrl = `/api/whatsapp/media/meta_id_${i}`;
        await resolveMediaKeys([proxyUrl]);
      }

      // First 5 blobs should have been evicted and revoked
      expect(revokeMock).toHaveBeenCalledTimes(5);
    });
  });
});
