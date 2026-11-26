import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const IN_FLIGHT_WINDOW_MS = 45_000;

export type ReconcileState =
  | "confirmed"
  | "in_flight"
  | "ambiguous_dispatch"
  | "safe_to_retry";

function isMissingDispatchColumn(err: { message?: string } | null): boolean {
  return Boolean(err?.message?.includes("meta_dispatch_started_at"));
}

/**
 * Read-only reconciliation endpoint for ambiguous client send timeouts/aborts.
 * Strictly scoped to the caller's `accountId` via `conversations!inner(account_id)`.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole("agent");

    const limit = checkRateLimit(`reconcile:${userId}`, RATE_LIMITS.audioReconcile);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const url = new URL(request.url);
    const clientRef = url.searchParams.get("client_ref")?.trim() ?? "";
    if (!clientRef || clientRef.length > 200) {
      return NextResponse.json(
        { error: "Query parameter 'client_ref' is required" },
        { status: 400 },
      );
    }

    interface RowShape {
      id: string;
      status: string | null;
      message_id: string | null;
      updated_at?: string | null;
      created_at?: string | null;
      meta_dispatch_started_at?: string | null;
    }

    let row: RowShape | null = null;
    const primary = await supabase
      .from("messages")
      .select(
        "id, status, message_id, updated_at, created_at, meta_dispatch_started_at, conversations!inner(account_id)",
      )
      .eq("client_ref", clientRef)
      .eq("conversations.account_id", accountId)
      .maybeSingle();

    if (primary.error && isMissingDispatchColumn(primary.error)) {
      const fallback = await supabase
        .from("messages")
        .select("id, status, message_id, updated_at, created_at, conversations!inner(account_id)")
        .eq("client_ref", clientRef)
        .eq("conversations.account_id", accountId)
        .maybeSingle();
      if (fallback.error) {
        return NextResponse.json({ error: fallback.error.message }, { status: 500 });
      }
      row = fallback.data as RowShape | null;
    } else if (primary.error) {
      return NextResponse.json({ error: primary.error.message }, { status: 500 });
    } else {
      row = primary.data as RowShape | null;
    }

    if (!row) {
      return NextResponse.json({
        state: "safe_to_retry" as ReconcileState,
        reason: "not_found",
      });
    }

    if (
      row.status === "sent" ||
      row.status === "delivered" ||
      row.status === "read" ||
      Boolean(row.message_id)
    ) {
      return NextResponse.json({
        state: "confirmed" as ReconcileState,
        message_id: row.id,
        whatsapp_message_id: row.message_id,
        status: row.status,
      });
    }

    if (row.status === "failed") {
      return NextResponse.json({
        state: "safe_to_retry" as ReconcileState,
        message_id: row.id,
        status: row.status,
        reason: "previous_failed",
      });
    }

    if (row.status === "sending") {
      const ts = row.updated_at || row.created_at || "";
      const parsedTs = ts ? Date.parse(ts) : NaN;
      const ageMs = Number.isFinite(parsedTs) ? Math.max(0, Date.now() - parsedTs) : 0;

      if (ageMs < IN_FLIGHT_WINDOW_MS) {
        return NextResponse.json({
          state: "in_flight" as ReconcileState,
          message_id: row.id,
          age_ms: ageMs,
        });
      }

      if (row.meta_dispatch_started_at) {
        return NextResponse.json({
          state: "ambiguous_dispatch" as ReconcileState,
          message_id: row.id,
          reason: "meta_dispatch_started_without_ack",
        });
      }

      return NextResponse.json({
        state: "safe_to_retry" as ReconcileState,
        message_id: row.id,
        reason: "stale_pre_dispatch_claim",
      });
    }

    return NextResponse.json({
      state: "safe_to_retry" as ReconcileState,
      message_id: row.id,
      status: row.status,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
