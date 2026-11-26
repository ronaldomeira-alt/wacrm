import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

let callerUser: { id: string } | null = { id: "user-1" };
let callerRole = "owner";
let callerBetaFeatures: string[] = [];
const upsertedRows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: callerUser }, error: null })) },
    from: vi.fn((table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = vi.fn(chain);
      b.eq = vi.fn(chain);
      if (table === "profiles") {
        b.maybeSingle = vi.fn(async () => ({
          data: {
            account_id: "acct-A",
            account_role: callerRole,
            beta_features: callerBetaFeatures,
          },
          error: null,
        }));
      } else if (table === "accounts") {
        b.maybeSingle = vi.fn(async () => ({
          data: { id: "acct-A", name: "Acme" },
          error: null,
        }));
      }
      return b;
    }),
  })),
}));

vi.mock("@/lib/storage/admin-client", () => ({
  supabaseAdmin: vi.fn(() => ({
    from: vi.fn(() => ({
      upsert: vi.fn(async (rows: Array<Record<string, unknown>>) => {
        upsertedRows.push(...rows);
        return { error: null };
      }),
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            limit: vi.fn(async () => ({ data: upsertedRows, error: null })),
          })),
        })),
      })),
    })),
  })),
}));

import { GET, POST } from "./route";

describe("/api/diagnostics/audio-telemetry", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    callerUser = { id: "user-1" };
    callerRole = "owner";
    callerBetaFeatures = [];
    upsertedRows.length = 0;
  });

  it("rejects unauthenticated callers with 401", async () => {
    callerUser = null;
    const req = new Request("http://localhost/api/diagnostics/audio-telemetry", {
      method: "POST",
      body: JSON.stringify({ sessions: [] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("rejects non-owner without beta flag with 403", async () => {
    callerRole = "agent";
    callerBetaFeatures = [];
    const req = new Request("http://localhost/api/diagnostics/audio-telemetry", {
      method: "POST",
      body: JSON.stringify({
        sessions: [{ recordingId: "r1", correlationId: "c1", stage: "started" }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("persists sanitized sessions for owner and allows GET", async () => {
    const req = new Request("http://localhost/api/diagnostics/audio-telemetry", {
      method: "POST",
      body: JSON.stringify({
        sessions: [
          {
            recordingId: "rec-123",
            correlationId: "corr-123",
            stage: "sent",
            failureCategory: "none",
            captureDurationMs: 4200,
            fileSizeBytes: 12800,
            transcript: "MUST_NOT_BE_STORED",
            phone: "5583999999999",
          },
        ],
      }),
    });
    const postRes = await POST(req);
    expect(postRes.status).toBe(200);
    expect(upsertedRows).toHaveLength(1);
    const storedPayload = upsertedRows[0].payload as Record<string, unknown>;
    expect(storedPayload.transcript).toBeUndefined();
    expect(storedPayload.phone).toBeUndefined();

    const getRes = await GET(new Request("http://localhost/api/diagnostics/audio-telemetry"));
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(1);
  });
});
