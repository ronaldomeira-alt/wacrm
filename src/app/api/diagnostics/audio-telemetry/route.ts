import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/storage/admin-client";

const MAX_BODY_BYTES = 48_000;
const MAX_BATCH_SIZE = 20;
const RETENTION_MAX_ROWS_PER_ACCOUNT = 500;
const RETENTION_MAX_AGE_DAYS = 14;

const ALLOWED_FAILURE_CATEGORIES = new Set([
  "none",
  "permission_denied",
  "gesture_or_context_blocked",
  "encoder_init_failed",
  "recorder_timeout",
  "recorder_error",
  "empty_or_silent_capture",
  "file_too_large",
  "track_interrupted",
  "idb_persist_failed",
  "upload_timeout",
  "upload_http_error",
  "send_timeout",
  "send_conflict",
  "send_session_expired",
  "send_http_error",
  "meta_async_failure",
  "network_offline",
  "cancelled",
  "unknown",
]);

async function requireDiagnosticsAccess() {
  const ctx = await getCurrentAccount();
  if (ctx.role === "owner") return ctx;

  const { data: profile } = await ctx.supabase
    .from("profiles")
    .select("beta_features")
    .eq("user_id", ctx.userId)
    .maybeSingle();

  const beta = Array.isArray(profile?.beta_features) ? profile.beta_features : [];
  if (!beta.includes("audio_diagnostics_enabled")) {
    return null;
  }
  return ctx;
}

function clampString(val: unknown, maxLen: number): string | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function clampInt(val: unknown, min: number, max: number): number | null {
  if (typeof val !== "number" || !Number.isFinite(val)) return null;
  return Math.max(min, Math.min(max, Math.round(val)));
}

function sanitizeSessionPayload(raw: Record<string, unknown>) {
  const recordingId = clampString(raw.recordingId, 80);
  const correlationId = clampString(raw.correlationId, 80);
  const stage = clampString(raw.stage, 64);
  if (!recordingId || !correlationId || !stage) return null;

  const rawCategory = clampString(raw.failureCategory, 48) ?? "none";
  const failureCategory = ALLOWED_FAILURE_CATEGORIES.has(rawCategory) ? rawCategory : "unknown";

  // Allowlist strictly non-PII diagnostic fields. Never store audio bytes,
  // transcripts, phone numbers, URLs, tokens, or message bodies.
  const payload = {
    wacrmVersion: clampString(raw.wacrmVersion, 24),
    buildCommit: clampString(raw.buildCommit, 40),
    iosVersion: clampString(raw.iosVersion, 24),
    runtimeMode: clampString(raw.runtimeMode, 32),
    stage,
    interactionStartedAt: clampInt(raw.interactionStartedAt, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: clampInt(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER),
    userActivationState:
      raw.userActivationState && typeof raw.userActivationState === "object"
        ? {
            isActive: Boolean((raw.userActivationState as Record<string, unknown>).isActive),
            hasBeenActive: Boolean((raw.userActivationState as Record<string, unknown>).hasBeenActive),
          }
        : null,
    micPermission:
      raw.micPermission && typeof raw.micPermission === "object" ? raw.micPermission : {},
    recorderState: clampString(raw.recorderState, 32),
    audioContextState:
      raw.audioContextState && typeof raw.audioContextState === "object"
        ? raw.audioContextState
        : {},
    trackStates:
      raw.trackStates && typeof raw.trackStates === "object" ? raw.trackStates : {},
    encoderInit:
      raw.encoderInit && typeof raw.encoderInit === "object" ? raw.encoderInit : {},
    interruptionEvents: Array.isArray(raw.interruptionEvents)
      ? raw.interruptionEvents.slice(-20)
      : [],
    captureDurationMs: clampInt(raw.captureDurationMs, 0, 3_600_000) ?? 0,
    fragmentCount: clampInt(raw.fragmentCount, 0, 10_000) ?? 0,
    fileSizeBytes: clampInt(raw.fileSizeBytes, 0, 100_000_000) ?? 0,
    format: clampString(raw.format, 48),
    codec: clampString(raw.codec, 32),
    validationResult:
      raw.validationResult && typeof raw.validationResult === "object"
        ? raw.validationResult
        : null,
    persistenceResult:
      raw.persistenceResult && typeof raw.persistenceResult === "object"
        ? raw.persistenceResult
        : null,
    uploadResult:
      raw.uploadResult && typeof raw.uploadResult === "object" ? raw.uploadResult : null,
    sendResult:
      raw.sendResult && typeof raw.sendResult === "object" ? raw.sendResult : null,
    reconcileResult:
      raw.reconcileResult && typeof raw.reconcileResult === "object"
        ? raw.reconcileResult
        : null,
    retryCount: clampInt(raw.retryCount, 0, 100) ?? 0,
    connectivityState:
      raw.connectivityState && typeof raw.connectivityState === "object"
        ? raw.connectivityState
        : null,
    visibilityState: clampString(raw.visibilityState, 24),
    failureCategory,
    errorDetail: clampString(raw.errorDetail, 240),
    cleanupResult:
      raw.cleanupResult && typeof raw.cleanupResult === "object" ? raw.cleanupResult : null,
  };

  return {
    recording_id: recordingId,
    correlation_id: correlationId,
    stage,
    failure_category: failureCategory,
    runtime_mode: payload.runtimeMode,
    ios_version: payload.iosVersion,
    build_commit: payload.buildCommit,
    duration_ms: payload.captureDurationMs,
    size_bytes: payload.fileSizeBytes,
    payload,
  };
}

async function enforceRetention(accountId: string): Promise<void> {
  try {
    const admin = supabaseAdmin();
    const cutoff = new Date(Date.now() - RETENTION_MAX_AGE_DAYS * 86_400_000).toISOString();
    await admin
      .from("audio_diagnostic_sessions")
      .delete()
      .eq("account_id", accountId)
      .lt("updated_at", cutoff);

    const { data: overflow } = await admin
      .from("audio_diagnostic_sessions")
      .select("id")
      .eq("account_id", accountId)
      .order("updated_at", { ascending: false })
      .range(RETENTION_MAX_ROWS_PER_ACCOUNT, RETENTION_MAX_ROWS_PER_ACCOUNT + 100);

    if (overflow && overflow.length > 0) {
      await admin
        .from("audio_diagnostic_sessions")
        .delete()
        .in(
          "id",
          overflow.map((r: { id: string }) => r.id),
        );
    }
  } catch {
    // Best-effort retention cleanup
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDiagnosticsAccess();
    if (!ctx) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const limit = checkRateLimit(`audio-telemetry:${ctx.userId}`, RATE_LIMITS.audioTelemetry);
    if (!limit.success) return rateLimitResponse(limit);

    const rawText = await request.text();
    if (rawText.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    let parsed: { sessions?: unknown };
    try {
      parsed = JSON.parse(rawText) as { sessions?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0) {
      return NextResponse.json({ error: "sessions array is required" }, { status: 400 });
    }

    const sanitized = parsed.sessions
      .slice(0, MAX_BATCH_SIZE)
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map(sanitizeSessionPayload)
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (sanitized.length === 0) {
      return NextResponse.json({ error: "No valid diagnostic sessions provided" }, { status: 400 });
    }

    const rows = sanitized.map((row) => ({
      ...row,
      account_id: ctx.accountId,
      user_id: ctx.userId,
      updated_at: new Date().toISOString(),
    }));

    const admin = supabaseAdmin();
    const { error } = await admin
      .from("audio_diagnostic_sessions")
      .upsert(rows, { onConflict: "account_id,recording_id" });

    if (error) {
      console.error("[audio-telemetry] upsert failed:", error.message);
      return NextResponse.json({ error: "Failed to persist telemetry" }, { status: 500 });
    }

    if (Math.random() < 0.1) {
      void enforceRetention(ctx.accountId);
    }

    return NextResponse.json({ ok: true, accepted: rows.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET(request: Request) {
  try {
    const ctx = await requireDiagnosticsAccess();
    if (!ctx) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const limit = checkRateLimit(`audio-telemetry:${ctx.userId}`, RATE_LIMITS.audioTelemetry);
    if (!limit.success) return rateLimitResponse(limit);

    const url = new URL(request.url);
    const limitParam = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 50));

    const admin = supabaseAdmin();
    const { data, error } = await admin
      .from("audio_diagnostic_sessions")
      .select("recording_id, correlation_id, stage, failure_category, runtime_mode, ios_version, build_commit, duration_ms, size_bytes, payload, created_at, updated_at")
      .eq("account_id", ctx.accountId)
      .order("updated_at", { ascending: false })
      .limit(limitParam);

    if (error) {
      return NextResponse.json({ error: "Failed to read telemetry" }, { status: 500 });
    }

    return NextResponse.json({ sessions: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
