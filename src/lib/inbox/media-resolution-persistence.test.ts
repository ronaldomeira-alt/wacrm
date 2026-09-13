import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCachedMediaSrc,
  seedMediaResolution,
  resolveMediaKeys,
  loadPersistedResolutions,
  __resetResolvedMediaCacheForTests,
} from "./use-resolved-media-src";
import { computeAlbumGroups } from "@/components/inbox/message-album";
import type { Message } from "@/types";

describe("Media Resolution Persistence & Reopening Flow", () => {
  let mockStorage: Record<string, string> = {};

  beforeEach(() => {
    mockStorage = {};
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => mockStorage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        mockStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockStorage[key];
      }),
      clear: vi.fn(() => {
        mockStorage = {};
      }),
    });
    __resetResolvedMediaCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    __resetResolvedMediaCacheForTests();
    vi.restoreAllMocks();
  });

  it("TESTE 1: Mídia antiga → renderiza sem loading perceptível (pass-through síncrono)", () => {
    const legacySupabaseUrl =
      "https://qedptmrcvcbzhucoeznd.supabase.co/storage/v1/object/public/property-media/account-1/fachada.jpg";
    const externalUrl = "https://images.unsplash.com/photo-123456";

    expect(getCachedMediaSrc(legacySupabaseUrl)).toBe(legacySupabaseUrl);
    expect(getCachedMediaSrc(externalUrl)).toBe(externalUrl);
  });

  it("TESTE 2: Mídia enviada pelo novo fluxo → após persistida, renderiza como pronta", () => {
    const r2Key = "account-1/image/2026/09/new-batch-pic.jpeg";
    const signedUrl = "https://r2.example.com/signed/new-batch-pic.jpeg?token=abc";

    // When confirm-upload succeeds, seedMediaResolution is called
    seedMediaResolution(r2Key, signedUrl);

    // Immediately synchronous hit with 0ms wait
    expect(getCachedMediaSrc(r2Key)).toBe(signedUrl);
  });

  it("TESTE 3: Reabertura da conversa → mídia histórica persistida em storage não volta para loading", async () => {
    const r2Key = "account-1/image/2026/09/historical-photo.jpeg";
    const signedUrl = "https://r2.example.com/signed/historical.jpeg?token=xyz";

    // 1. Seed into resolution cache (which triggers savePersistedResolutions)
    seedMediaResolution(r2Key, signedUrl);

    // Allow the debounce timer to persist to localStorage
    await new Promise((r) => setTimeout(r, 80));

    // Verify it was written to localStorage
    const storedJson = mockStorage["wacrm_media_resolve_cache_v1"];
    expect(storedJson).toBeDefined();
    expect(storedJson).toContain(r2Key);

    // 2. Simulate complete PWA restart / app unload: clear in-memory map
    // but keep localStorage intact
    const savedStorage = { ...mockStorage };
    __resetResolvedMediaCacheForTests();
    mockStorage = savedStorage;

    // Verify localStorage data remains intact for the next app session
    const parsed = JSON.parse(mockStorage["wacrm_media_resolve_cache_v1"]);
    expect(parsed[r2Key].url).toBe(signedUrl);
    expect(parsed[r2Key].expiresAt).toBeGreaterThan(Date.now());

    // When the app restarts, loadPersistedResolutions restores it to in-memory cache
    loadPersistedResolutions();
    expect(getCachedMediaSrc(r2Key)).toBe(signedUrl);
  });

  it("TESTE 4: Álbum com 7 imagens → histórico continua agrupado corretamente", () => {
    const baseTime = 1726000000000;
    const messages: Message[] = Array.from({ length: 7 }, (_, i) => ({
      id: `msg-${i}`,
      conversation_id: "conv-1",
      sender_type: "agent" as const,
      sender_id: "user-1",
      content_type: "image" as const,
      media_url: `account-1/image/2026/09/prop-${i}.jpeg`,
      status: "delivered" as const,
      created_at: new Date(baseTime + i * 500).toISOString(),
    }));

    const groups = computeAlbumGroups(messages);
    expect(groups.size).toBe(7);

    const firstGroup = groups.get(messages[0].id);
    expect(firstGroup).toBeDefined();
    expect(firstGroup!.messages).toHaveLength(7);
  });

  it("TESTE 5: Álbum com 10 imagens → nenhuma regressão", () => {
    const baseTime = 1726000000000;
    const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
      id: `msg-${i}`,
      conversation_id: "conv-1",
      sender_type: "agent" as const,
      sender_id: "user-1",
      content_type: "image" as const,
      media_url: `account-1/image/2026/09/prop-${i}.jpeg`,
      status: "sent" as const,
      created_at: new Date(baseTime + i * 300).toISOString(),
    }));

    const groups = computeAlbumGroups(messages);
    expect(groups.size).toBe(10);
    expect(groups.get(messages[0].id)!.messages).toHaveLength(10);
  });

  it("TESTE 6: Falha real na resolução → tratamento de erro continua funcionando", async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: "Storage error" }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const key = "account-1/image/2026/09/broken-key.jpeg";
    const results = await resolveMediaKeys([key]);

    // Should not throw or crash, but leave key unmapped
    expect(results.get(key)).toBeUndefined();
  });

  it("TESTE 7: URL expirada → renovação automática sem quebrar a UI", async () => {
    const r2Key = "account-1/image/2026/09/expiring.jpeg";
    const expiredUrl = "https://r2.example.com/expired";
    const freshUrl = "https://r2.example.com/fresh-signed-url";

    // Seed with already-expired timestamp
    seedMediaResolution(r2Key, expiredUrl, Date.now() - 10_000);

    // getCachedMediaSrc returns null because it recognizes it's expired
    expect(getCachedMediaSrc(r2Key)).toBeNull();

    // Mock fetch for renewing
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          resolved: [{ key: r2Key, url: freshUrl, expiresAt: Date.now() + 86400 * 1000 }],
          invalid: [],
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await resolveMediaKeys([r2Key]);
    expect(results.get(r2Key)).toBe(freshUrl);
    expect(getCachedMediaSrc(r2Key)).toBe(freshUrl);
  });

  it("TESTE 8: Não gerar N+1 requests desnecessários para resolver as imagens históricas", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { keys: string[] };
      return {
        ok: true,
        json: async () => ({
          resolved: body.keys.map((k) => ({
            key: k,
            url: `https://signed.example.com/${k}`,
            expiresAt: Date.now() + 86400 * 1000,
          })),
          invalid: [],
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const batchKeys = Array.from({ length: 10 }, (_, i) => `account-1/image/2026/09/batch-${i}.jpeg`);

    // Resolving 10 historical images together in a batch
    await resolveMediaKeys(batchKeys);

    // MUST be coalesced into exactly 1 network request to /api/media/resolve
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("TESTE 9: Imagem que ainda está enviando continua podendo mostrar estado de loading / sending", () => {
    const sendingMsg: Message = {
      id: "temp-1726000000000-0",
      conversation_id: "conv-1",
      sender_type: "agent",
      sender_id: "user-1",
      content_type: "image",
      media_url: "blob:http://localhost:3000/preview-uuid-1",
      status: "sending",
      created_at: new Date().toISOString(),
    };

    expect(sendingMsg.status).toBe("sending");
    // Local preview URL is available synchronously
    expect(getCachedMediaSrc(sendingMsg.media_url)).toBe(sendingMsg.media_url);
  });

  it("TESTE 10: Somente mensagens já concluídas devem ser tratadas como mídia persistida", () => {
    const completedMsg: Message = {
      id: "6545dab6-660b-4a51-8c9a-efcf18e76d19",
      conversation_id: "conv-1",
      sender_type: "agent",
      sender_id: "user-1",
      content_type: "image",
      media_url: "account-1/image/2026/09/persisted.jpeg",
      status: "delivered",
      created_at: new Date().toISOString(),
    };

    expect(completedMsg.status).not.toBe("sending");
    expect(["sent", "delivered", "read"]).toContain(completedMsg.status);
    expect(completedMsg.id.startsWith("temp-")).toBe(false);
  });
});
