import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  toErrorResponse: vi.fn((err: unknown) => {
    const status = (err as { status?: number })?.status ?? 401;
    const message = err instanceof Error ? err.message : "Unauthorized";
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }),
  row: null as Record<string, unknown> | null,
  queryError: null as { message: string } | null,
}));

vi.mock("@/lib/auth/account", () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: mocks.toErrorResponse,
}));

import { GET } from "./route";

function makeSupabaseMock() {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: mocks.row,
              error: mocks.queryError,
            })),
          })),
        })),
      })),
    })),
  };
}

describe("GET /api/whatsapp/send/reconcile", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    mocks.row = null;
    mocks.queryError = null;
    mocks.requireRole.mockResolvedValue({
      supabase: makeSupabaseMock(),
      accountId: "acct-1",
      userId: "user-1",
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    mocks.requireRole.mockRejectedValue(err);

    const res = await GET(new Request("https://crm.test/api/whatsapp/send/reconcile?client_ref=abc"));
    expect(res.status).toBe(401);
  });

  it("requires non-empty client_ref", async () => {
    const res = await GET(new Request("https://crm.test/api/whatsapp/send/reconcile"));
    expect(res.status).toBe(400);
  });

  it("returns confirmed when Meta delivery status or message_id exists", async () => {
    mocks.row = {
      id: "msg-1",
      status: "delivered",
      message_id: "wamid.123",
      updated_at: new Date().toISOString(),
    };

    const res = await GET(new Request("https://crm.test/api/whatsapp/send/reconcile?client_ref=rec-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      state: "confirmed",
      message_id: "msg-1",
      whatsapp_message_id: "wamid.123",
      status: "delivered",
    });
  });

  it("returns in_flight for fresh sending claims (< 45s)", async () => {
    mocks.row = {
      id: "msg-2",
      status: "sending",
      message_id: null,
      updated_at: new Date(Date.now() - 10_000).toISOString(),
      meta_dispatch_started_at: new Date(Date.now() - 8_000).toISOString(),
    };

    const res = await GET(new Request("https://crm.test/api/whatsapp/send/reconcile?client_ref=rec-2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("in_flight");
  });

  it("returns ambiguous_dispatch for stale sending rows where Meta POST had already started", async () => {
    mocks.row = {
      id: "msg-3",
      status: "sending",
      message_id: null,
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      meta_dispatch_started_at: new Date(Date.now() - 55_000).toISOString(),
    };

    const res = await GET(new Request("https://crm.test/api/whatsapp/send/reconcile?client_ref=rec-3"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      state: "ambiguous_dispatch",
      message_id: "msg-3",
      reason: "meta_dispatch_started_without_ack",
    });
  });

  it("returns safe_to_retry when row is absent or failed or stale pre-dispatch", async () => {
    mocks.row = null;
    const resNotFound = await GET(
      new Request("https://crm.test/api/whatsapp/send/reconcile?client_ref=rec-missing"),
    );
    expect((await resNotFound.json()).state).toBe("safe_to_retry");

    mocks.row = {
      id: "msg-4",
      status: "sending",
      message_id: null,
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      meta_dispatch_started_at: null,
    };
    const resPreDispatch = await GET(
      new Request("https://crm.test/api/whatsapp/send/reconcile?client_ref=rec-4"),
    );
    expect((await resPreDispatch.json()).state).toBe("safe_to_retry");
  });
});
