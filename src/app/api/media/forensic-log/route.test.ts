import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

let callerUser: { id: string } | null = { id: "user-1" };
let callerRole = "owner";

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
          data: { account_id: "acct-A", account_role: callerRole },
          error: null,
        }));
      } else {
        b.maybeSingle = vi.fn(async () => ({
          data: { id: "acct-A", name: "Acme" },
          error: null,
        }));
      }
      return b;
    }),
  })),
}));

import { DELETE, GET, POST } from "./route";

describe("/api/media/forensic-log security", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    callerUser = { id: "user-1" };
    callerRole = "owner";
  });

  it("blocks unauthenticated GET/POST/DELETE with 401", async () => {
    callerUser = null;
    expect((await GET()).status).toBe(401);
    expect(
      (
        await POST(
          new Request("http://localhost/api/media/forensic-log", {
            method: "POST",
            body: JSON.stringify({ step: 1 }),
          }),
        )
      ).status,
    ).toBe(401);
    expect((await DELETE()).status).toBe(401);
  });

  it("blocks non-owner roles with 403", async () => {
    callerRole = "agent";
    expect((await GET()).status).toBe(403);
    expect(
      (
        await POST(
          new Request("http://localhost/api/media/forensic-log", {
            method: "POST",
            body: JSON.stringify({ step: 1 }),
          }),
        )
      ).status,
    ).toBe(403);
    expect((await DELETE()).status).toBe(403);
  });
});
