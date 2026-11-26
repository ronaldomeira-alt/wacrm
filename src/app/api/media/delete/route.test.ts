import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

const r2SendMock = vi.fn(async () => ({}));
let mediaObjectRow: { id: string; bucket: string; visibility: string } | null = {
  id: "obj-1",
  bucket: "wacrm-media",
  visibility: "private",
};
let decrementResult = 0;
let mediaObjectsDeleted = false;

let messageRefs: Array<{ id: string; status: string }> = [];
let messageThumbRefs: Array<{ id: string; status: string }> = [];
let broadcastRefs: Array<{ id: string }> = [];
let templateRefs: Array<{ id: string }> = [];
let refLookupError: { message: string } | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })) },
    rpc: vi.fn(async () => ({ data: decrementResult, error: null })),
    from: vi.fn((table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = vi.fn(chain);
      b.eq = vi.fn(chain);
      if (table === "profiles") {
        b.maybeSingle = vi.fn(async () => ({
          data: { account_id: "acct-A", account_role: "agent" },
          error: null,
        }));
      } else if (table === "accounts") {
        b.maybeSingle = vi.fn(async () => ({
          data: { id: "acct-A", name: "Acme" },
          error: null,
        }));
      } else if (table === "media_objects") {
        b.maybeSingle = vi.fn(async () => ({ data: mediaObjectRow, error: null }));
        b.delete = vi.fn(() => ({
          eq: vi.fn(async () => {
            mediaObjectsDeleted = true;
            return { error: null };
          }),
        }));
      }
      return b;
    }),
  })),
}));

vi.mock("@/lib/storage/admin-client", () => ({
  supabaseAdmin: vi.fn(() => ({
    from: vi.fn((table: string) => {
      let colChecked = "";
      const b: Record<string, unknown> = {};
      b.select = vi.fn(() => b);
      b.eq = vi.fn((col: string) => {
        if (
          col === "media_url" ||
          col === "document_thumbnail_url" ||
          col === "header_media_url"
        ) {
          colChecked = col;
        }
        return b;
      });
      b.limit = vi.fn(async () => {
        if (refLookupError) return { data: null, error: refLookupError };
        if (table === "messages" && colChecked === "media_url") {
          return { data: messageRefs, error: null };
        }
        if (table === "messages" && colChecked === "document_thumbnail_url") {
          return { data: messageThumbRefs, error: null };
        }
        if (table === "broadcasts") return { data: broadcastRefs, error: null };
        if (table === "message_templates") return { data: templateRefs, error: null };
        return { data: [], error: null };
      });
      return b;
    }),
  })),
}));

vi.mock("@/lib/storage/r2-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/r2-client")>();
  return {
    ...actual,
    getR2Client: vi.fn(() => ({ send: r2SendMock })),
  };
});

import { POST } from "./route";

const VALID_KEY = "acct-A/audio/2026/11/abc-voice.ogg";

describe("POST /api/media/delete protection", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    r2SendMock.mockClear();
    mediaObjectRow = { id: "obj-1", bucket: "wacrm-media", visibility: "private" };
    decrementResult = 0;
    mediaObjectsDeleted = false;
    messageRefs = [];
    messageThumbRefs = [];
    broadcastRefs = [];
    templateRefs = [];
    refLookupError = null;
  });

  it("refuses deletion (409) when any message references the R2 key", async () => {
    messageRefs = [{ id: "msg-1", status: "sent" }];
    const res = await POST(
      new Request("http://localhost/api/media/delete", {
        method: "POST",
        body: JSON.stringify({ key: VALID_KEY }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { deleted: boolean; protected: boolean };
    expect(body.deleted).toBe(false);
    expect(body.protected).toBe(true);
    expect(r2SendMock).not.toHaveBeenCalled();
    expect(mediaObjectsDeleted).toBe(false);
  });

  it("preserves the object (500) when reference lookup fails or is ambiguous", async () => {
    refLookupError = { message: "connection error" };
    const res = await POST(
      new Request("http://localhost/api/media/delete", {
        method: "POST",
        body: JSON.stringify({ key: VALID_KEY }),
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { deleted: boolean; protected: boolean };
    expect(body.deleted).toBe(false);
    expect(body.protected).toBe(true);
    expect(r2SendMock).not.toHaveBeenCalled();
  });

  it("deletes unreferenced media once reference_count reaches 0", async () => {
    const res = await POST(
      new Request("http://localhost/api/media/delete", {
        method: "POST",
        body: JSON.stringify({ key: VALID_KEY }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
    expect(r2SendMock).toHaveBeenCalledTimes(1);
    expect(mediaObjectsDeleted).toBe(true);
  });
});
