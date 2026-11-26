"use client";

/**
 * Structured, non-blocking audio recording & delivery telemetry.
 *
 * Design invariants:
 *  - Zero PII, audio content, transcripts, phone numbers, credentials,
 *    or signed URLs are ever recorded here.
 *  - Ring buffer bounded to MAX_SESSIONS (60) in memory + localStorage
 *    so it survives PWA force-quits and reloads without leaking memory.
 *  - Flush to `/api/diagnostics/audio-telemetry` runs strictly
 *    asynchronously (`setTimeout(..., 0)`) outside the critical audio
 *    capture path, and is gated on authorization (`telemetryEnabled`).
 */

export type AudioRuntimeMode =
  | "ios_pwa_standalone"
  | "ios_safari"
  | "android_pwa"
  | "android_browser"
  | "desktop"
  | "other";

export type AudioFailureCategory =
  | "none"
  | "permission_denied"
  | "gesture_or_context_blocked"
  | "encoder_init_failed"
  | "recorder_timeout"
  | "recorder_error"
  | "empty_or_silent_capture"
  | "file_too_large"
  | "track_interrupted"
  | "idb_persist_failed"
  | "upload_timeout"
  | "upload_http_error"
  | "send_timeout"
  | "send_conflict"
  | "send_session_expired"
  | "send_http_error"
  | "meta_async_failure"
  | "network_offline"
  | "cancelled"
  | "unknown";

export type AudioRecorderLifecycleState =
  | "idle"
  | "requesting_permission"
  | "initializing"
  | "recording"
  | "paused"
  | "finalizing"
  | "stopped"
  | "failed"
  | "cancelled";

export interface AudioInterruptionEvent {
  type: string;
  at: number;
  detail?: string;
}

export interface AudioDiagnosticSession {
  recordingId: string;
  correlationId: string;
  wacrmVersion: string;
  buildCommit: string;
  iosVersion: string | null;
  runtimeMode: AudioRuntimeMode;
  stage: string;
  interactionStartedAt: number;
  updatedAt: number;
  userActivationState: { isActive: boolean; hasBeenActive: boolean } | null;
  micPermission: {
    preState?: string;
    requestedAt?: number;
    resolvedAt?: number;
    outcome?: "granted" | "denied" | "error" | "timeout";
    errorName?: string;
  };
  recorderState: AudioRecorderLifecycleState;
  audioContextState: {
    beforeStart?: string;
    afterGetUserMedia?: string;
    onStop?: string;
    sampleRate?: number;
    interruptionCount: number;
  };
  trackStates: {
    count: number;
    readyStates: string[];
    mutedStates: boolean[];
    endedEvents: number;
  };
  encoderInit: {
    prewarmed: boolean;
    startedAt?: number;
    readyAt?: number;
    latencyMs?: number;
    error?: string;
  };
  interruptionEvents: AudioInterruptionEvent[];
  captureDurationMs: number;
  fragmentCount: number;
  fileSizeBytes: number;
  format: string;
  codec: string;
  validationResult: {
    ok: boolean;
    reason?: string;
    hasOggMagic?: boolean;
    hasEosFlag?: boolean;
    rmsPeak?: number;
  } | null;
  persistenceResult: {
    ok: boolean;
    storage?: "idb_v1" | "idb_v2" | "ram_vault" | "none";
    latencyMs?: number;
    error?: string;
  } | null;
  uploadResult: {
    ok: boolean;
    provider?: "r2" | "supabase";
    latencyMs?: number;
    attempts?: number;
    httpStatus?: number;
    error?: string;
  } | null;
  sendResult: {
    ok: boolean;
    latencyMs?: number;
    attempts?: number;
    httpStatus?: number;
    deduplicated?: boolean;
    error?: string;
  } | null;
  reconcileResult: {
    attempted: boolean;
    outcome?: string;
    status?: string;
  } | null;
  retryCount: number;
  connectivityState: {
    online: boolean;
    effectiveType?: string;
  };
  visibilityState: string;
  failureCategory: AudioFailureCategory;
  errorDetail?: string;
  cleanupResult: {
    ok: boolean;
    tracksStopped: number;
    audioContextClosed: boolean;
    error?: string;
  } | null;
}

export interface LiveRecorderResources {
  micPhase: string;
  activeRecorders: number;
  activeTracks: number;
  audioContextState: string | null;
  pendingCount: number;
  ramVaultCount: number;
}

const STORAGE_KEY = "wacrm:audio-telemetry-ring:v1";
const MAX_SESSIONS = 60;
const MAX_INTERRUPTIONS_PER_SESSION = 20;

const sessionsMap = new Map<string, AudioDiagnosticSession>();
const sessionOrder: string[] = [];
const listeners = new Set<() => void>();
let hydrated = false;
let telemetryEnabled = false;
const pendingFlushIds = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

let liveResources: LiveRecorderResources = {
  micPhase: "idle",
  activeRecorders: 0,
  activeTracks: 0,
  audioContextState: null,
  pendingCount: 0,
  ramVaultCount: 0,
};

export function setAudioTelemetryEnabled(enabled: boolean): void {
  telemetryEnabled = enabled;
  if (enabled && pendingFlushIds.size > 0) {
    scheduleFlush();
  }
}

export function getPublishedBuildInfo(): { wacrmVersion: string; buildCommit: string } {
  return {
    wacrmVersion: process.env.NEXT_PUBLIC_APP_VERSION || "0.8.1",
    buildCommit: process.env.NEXT_PUBLIC_BUILD_COMMIT || "unknown",
  };
}

export function detectIosVersion(userAgent: string): string | null {
  const match = userAgent.match(/OS (\d+[_.]\d+(?:[_.]\d+)?)/i);
  if (!match || !/iPhone|iPad|iPod/i.test(userAgent)) return null;
  return match[1].replace(/_/g, ".");
}

export function detectRuntimeMode(): AudioRuntimeMode {
  if (typeof window === "undefined") return "other";
  const ua = window.navigator.userAgent || "";
  const standalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true;

  if (/iPhone|iPad|iPod/i.test(ua)) {
    return standalone ? "ios_pwa_standalone" : "ios_safari";
  }
  if (/Android/i.test(ua)) {
    return standalone ? "android_pwa" : "android_browser";
  }
  if (/Windows|Macintosh|Linux/i.test(ua)) {
    return "desktop";
  }
  return "other";
}

function getConnectivitySnapshot(): { online: boolean; effectiveType?: string } {
  if (typeof navigator === "undefined") return { online: true };
  const conn = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
  return {
    online: navigator.onLine !== false,
    effectiveType: typeof conn?.effectiveType === "string" ? conn.effectiveType : undefined,
  };
}

function getUserActivationSnapshot(): { isActive: boolean; hasBeenActive: boolean } | null {
  if (typeof navigator === "undefined") return null;
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation;
  if (!ua) return null;
  return {
    isActive: Boolean(ua.isActive),
    hasBeenActive: Boolean(ua.hasBeenActive),
  };
}

export function createCorrelationId(prefix = "aud"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeErrorText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw =
    value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  // Strip any accidental URL query strings / tokens / phone-like sequences
  return raw
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .slice(0, 240);
}

function ensureHydrated(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as AudioDiagnosticSession[];
    if (!Array.isArray(parsed)) return;
    for (const s of parsed.slice(-MAX_SESSIONS)) {
      if (s && typeof s.recordingId === "string") {
        sessionsMap.set(s.recordingId, s);
        sessionOrder.push(s.recordingId);
      }
    }
  } catch {
    // Ignore corrupted localStorage ring buffer
  }
}

function persistRingBuffer(): void {
  if (typeof window === "undefined") return;
  try {
    const list = sessionOrder
      .map((id) => sessionsMap.get(id))
      .filter((s): s is AudioDiagnosticSession => Boolean(s));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Ignore quota errors
  }
}

function notifyListeners(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {}
  }
}

function evictIfNeeded(): void {
  while (sessionOrder.length > MAX_SESSIONS) {
    const oldest = sessionOrder.shift();
    if (oldest) sessionsMap.delete(oldest);
  }
}

function scheduleFlush(): void {
  if (!telemetryEnabled || typeof window === "undefined") return;
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingTelemetry();
  }, 400);
}

export async function flushPendingTelemetry(): Promise<void> {
  if (!telemetryEnabled || pendingFlushIds.size === 0) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;

  const ids = Array.from(pendingFlushIds).slice(0, 20);
  const batch = ids
    .map((id) => sessionsMap.get(id))
    .filter((s): s is AudioDiagnosticSession => Boolean(s));

  if (batch.length === 0) {
    for (const id of ids) pendingFlushIds.delete(id);
    return;
  }

  for (const id of ids) pendingFlushIds.delete(id);

  try {
    await fetch("/api/diagnostics/audio-telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: batch }),
      keepalive: true,
    });
  } catch {
    // Telemetry must never surface errors or block the app; drop on network error
    // since local ring buffer still retains the session for Copy JSON.
  }
}

export function startAudioDiagnosticSession(input: {
  recordingId: string;
  correlationId?: string;
  prewarmed?: boolean;
}): AudioDiagnosticSession {
  ensureHydrated();
  const now = Date.now();
  const { wacrmVersion, buildCommit } = getPublishedBuildInfo();
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

  const session: AudioDiagnosticSession = {
    recordingId: input.recordingId,
    correlationId: input.correlationId ?? createCorrelationId("aud"),
    wacrmVersion,
    buildCommit,
    iosVersion: detectIosVersion(ua),
    runtimeMode: detectRuntimeMode(),
    stage: "interaction_started",
    interactionStartedAt: now,
    updatedAt: now,
    userActivationState: getUserActivationSnapshot(),
    micPermission: {},
    recorderState: "initializing",
    audioContextState: { interruptionCount: 0 },
    trackStates: { count: 0, readyStates: [], mutedStates: [], endedEvents: 0 },
    encoderInit: { prewarmed: Boolean(input.prewarmed), startedAt: now },
    interruptionEvents: [],
    captureDurationMs: 0,
    fragmentCount: 0,
    fileSizeBytes: 0,
    format: "audio/ogg",
    codec: "opus",
    validationResult: null,
    persistenceResult: null,
    uploadResult: null,
    sendResult: null,
    reconcileResult: null,
    retryCount: 0,
    connectivityState: getConnectivitySnapshot(),
    visibilityState: typeof document !== "undefined" ? document.visibilityState : "visible",
    failureCategory: "none",
    cleanupResult: null,
  };

  if (!sessionsMap.has(session.recordingId)) {
    sessionOrder.push(session.recordingId);
  }
  sessionsMap.set(session.recordingId, session);
  evictIfNeeded();
  persistRingBuffer();
  notifyListeners();
  return session;
}

export function updateAudioDiagnosticSession(
  recordingId: string,
  updater: (prev: AudioDiagnosticSession) => AudioDiagnosticSession,
  options: { flush?: boolean } = {},
): AudioDiagnosticSession {
  ensureHydrated();
  let current = sessionsMap.get(recordingId);
  if (!current) {
    current = startAudioDiagnosticSession({ recordingId });
  }
  const updated = updater({
    ...current,
    updatedAt: Date.now(),
    connectivityState: getConnectivitySnapshot(),
    visibilityState: typeof document !== "undefined" ? document.visibilityState : current.visibilityState,
  });
  if (updated.errorDetail) {
    updated.errorDetail = sanitizeErrorText(updated.errorDetail);
  }
  if (updated.interruptionEvents.length > MAX_INTERRUPTIONS_PER_SESSION) {
    updated.interruptionEvents = updated.interruptionEvents.slice(-MAX_INTERRUPTIONS_PER_SESSION);
  }
  sessionsMap.set(recordingId, updated);
  persistRingBuffer();
  notifyListeners();
  if (options.flush) {
    pendingFlushIds.add(recordingId);
    scheduleFlush();
  }
  return updated;
}

export function getAudioDiagnosticSession(recordingId: string): AudioDiagnosticSession | null {
  ensureHydrated();
  return sessionsMap.get(recordingId) ?? null;
}

export function getAudioDiagnosticSessions(): AudioDiagnosticSession[] {
  ensureHydrated();
  return sessionOrder
    .map((id) => sessionsMap.get(id))
    .filter((s): s is AudioDiagnosticSession => Boolean(s))
    .slice()
    .reverse();
}

export function clearAudioDiagnosticSessions(): void {
  ensureHydrated();
  sessionsMap.clear();
  sessionOrder.length = 0;
  pendingFlushIds.clear();
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
  notifyListeners();
}

export function updateLiveRecorderResources(patch: Partial<LiveRecorderResources>): void {
  liveResources = { ...liveResources, ...patch };
  notifyListeners();
}

export function getLiveRecorderResources(): LiveRecorderResources {
  return { ...liveResources };
}

export function subscribeAudioDiagnostics(listener: () => void): () => void {
  ensureHydrated();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function classifySendErrorCategory(errorMsg: string, httpStatus?: number): AudioFailureCategory {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "network_offline";
  const lower = errorMsg.toLowerCase();
  if (httpStatus === 409 || lower.includes("in progress") || lower.includes("conflict")) {
    return "send_conflict";
  }
  if (lower.includes("session_expired") || lower.includes("24h") || lower.includes("janela")) {
    return "send_session_expired";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("abort")) {
    return "send_timeout";
  }
  return "send_http_error";
}

export function classifyUploadErrorCategory(errorMsg: string): AudioFailureCategory {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "network_offline";
  const lower = errorMsg.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("abort")) {
    return "upload_timeout";
  }
  return "upload_http_error";
}
