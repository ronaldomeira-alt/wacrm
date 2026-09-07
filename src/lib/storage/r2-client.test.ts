import { describe, expect, it } from "vitest";
import { buildR2MediaKey, isR2MediaKey } from "./r2-client";

const ACCOUNT = "11111111-2222-3333-4444-555555555555";

describe("buildR2MediaKey", () => {
  it("produces {account}/{kind}/{yyyy}/{mm}/{uuid}-{slug}.{ext}", () => {
    const key = buildR2MediaKey(ACCOUNT, "image", "photo.png", Date.UTC(2026, 8, 6));
    const parts = key.split("/");
    expect(parts[0]).toBe(ACCOUNT);
    expect(parts[1]).toBe("image");
    expect(parts[2]).toBe("2026");
    expect(parts[3]).toBe("09");
    expect(parts[4]).toMatch(/^[0-9a-f-]{36}-photo\.png$/);
  });

  it("sanitizes the basename the same way buildMediaPath does", () => {
    const key = buildR2MediaKey(ACCOUNT, "document", "My Invoice (final).PDF", Date.UTC(2026, 0, 1));
    expect(key.endsWith("-My_Invoice_final_.pdf")).toBe(true);
  });

  it("falls back to file/bin for a nameless input", () => {
    const key = buildR2MediaKey(ACCOUNT, "document", "", Date.UTC(2026, 0, 1));
    expect(key.endsWith("-file.bin")).toBe(true);
  });

  it("never produces a URL-shaped key, even for a URL-shaped filename", () => {
    const trickyNames = [
      "http://evil.example/x.png",
      "https://evil.example/x.png",
      "//evil.example/x.png",
      "javascript:alert(1).png",
    ];
    for (const name of trickyNames) {
      const key = buildR2MediaKey(ACCOUNT, "image", name);
      expect(key.startsWith("http://")).toBe(false);
      expect(key.startsWith("https://")).toBe(false);
      expect(key.includes("://")).toBe(false);
      expect(isR2MediaKey(key)).toBe(true);
    }
  });

  it("two calls in the same millisecond never collide (UUID, not timestamp)", () => {
    const now = Date.now();
    const a = buildR2MediaKey(ACCOUNT, "image", "photo.png", now);
    const b = buildR2MediaKey(ACCOUNT, "image", "photo.png", now);
    expect(a).not.toBe(b);
  });
});

describe("isR2MediaKey", () => {
  it("rejects https:// URLs (legacy Supabase / pasted external / public-bucket URL)", () => {
    expect(isR2MediaKey("https://example.supabase.co/storage/v1/object/public/chat-media/x.png")).toBe(false);
    expect(isR2MediaKey("https://media.example.com/x.png")).toBe(false);
  });

  it("rejects the Meta inbound proxy path", () => {
    expect(isR2MediaKey("/api/whatsapp/media/abc123")).toBe(false);
  });

  it("rejects null/undefined/empty", () => {
    expect(isR2MediaKey(null)).toBe(false);
    expect(isR2MediaKey(undefined)).toBe(false);
    expect(isR2MediaKey("")).toBe(false);
  });

  it("accepts a bare R2 key", () => {
    const key = buildR2MediaKey(ACCOUNT, "image", "photo.png");
    expect(isR2MediaKey(key)).toBe(true);
  });
});
