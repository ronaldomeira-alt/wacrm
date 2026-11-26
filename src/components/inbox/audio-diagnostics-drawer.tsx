"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Check, Copy, RefreshCw, Trash2, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import {
  assessIosUaVersion,
  clearAudioDiagnosticSessions,
  detectRuntimeMode,
  getAudioDiagnosticSessions,
  getLiveRecorderResources,
  getPublishedBuildInfo,
  subscribeAudioDiagnostics,
  type AudioDiagnosticSession,
  type LiveRecorderResources,
} from "@/lib/inbox/audio-telemetry";
import { pickBestNativeAudioMimeType } from "@/lib/inbox/native-audio-recorder";
import {
  isAuthorizedForAudioFlags,
  resolveAudioFeatureFlags,
  setLocalAudioFeatureFlag,
  subscribeAudioFeatureFlags,
  type AudioFeatureFlagKey,
} from "@/lib/inbox/audio-feature-flags";
import { listAllPendingAudio } from "@/lib/inbox/pending-audio-db";

interface AudioDiagnosticsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const FLAG_LABELS: Array<{ key: AudioFeatureFlagKey; label: string; hint: string }> = [
  {
    key: "audio_outbox_v2_enabled",
    label: "Outbox Local-First v2",
    hint: "Armazenamento ArrayBuffer + cofre RAM (Fase 2)",
  },
  {
    key: "audio_capture_v2_enabled",
    label: "Captura iOS Endurecida v2",
    hint: "Ciclo de vida AudioContext/track + validação RMS (Fase 4A)",
  },
  {
    key: "audio_native_capture_enabled",
    label: "MediaRecorder Nativo (Contingência)",
    hint: "Fallback nativo sem WASM (Fase 4B)",
  },
];

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "0s";
  const s = Math.round(ms / 100) / 10;
  return `${s}s`;
}

export function AudioDiagnosticsDrawer({ open, onOpenChange }: AudioDiagnosticsDrawerProps) {
  const { accountRole, profile, profileLoading } = useAuth();
  const authCtx = {
    accountRole,
    betaFeatures: profile?.beta_features,
    profileLoading,
  };
  const authorized = isAuthorizedForAudioFlags(authCtx);

  const [sessions, setSessions] = useState<AudioDiagnosticSession[]>([]);
  const [resources, setResources] = useState<LiveRecorderResources>(() => getLiveRecorderResources());
  const [pendingDbCount, setPendingDbCount] = useState<number>(0);
  const [flags, setFlags] = useState(() => resolveAudioFeatureFlags(authCtx));
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [runningProbes, setRunningProbes] = useState(false);
  const [probeReport, setProbeReport] = useState<Record<string, unknown> | null>(null);

  const runIsolationProbes = () => {
    setRunningProbes(true);
    const startedAt = Date.now();
    // Trigger hardware probes synchronously inside user click turn to mirror
    // real mic acquisition gesture semantics.
    let audioCtx: AudioContext | null = null;
    let ctxInitialState = "unavailable";
    let ctxResumedPromise: Promise<void> | null = null;
    try {
      if (typeof AudioContext !== "undefined") {
        audioCtx = new AudioContext();
        ctxInitialState = audioCtx.state;
        ctxResumedPromise = audioCtx.resume();
      }
    } catch (err) {
      ctxInitialState = `error:${err instanceof Error ? err.message : String(err)}`;
    }

    const gumPromise =
      typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia
        ? navigator.mediaDevices.getUserMedia({ audio: true })
        : Promise.reject(new Error("getUserMedia unavailable"));

    void (async () => {
      const gumStart = Date.now();
      let micProbe: Record<string, unknown>;
      try {
        const stream = await gumPromise;
        const tracks = stream.getTracks();
        micProbe = {
          ok: tracks.length > 0,
          latencyMs: Date.now() - gumStart,
          trackCount: tracks.length,
          readyStates: tracks.map((t) => t.readyState),
          mutedStates: tracks.map((t) => Boolean(t.muted)),
        };
        for (const t of tracks) {
          try {
            t.stop();
          } catch {}
        }
      } catch (err) {
        micProbe = {
          ok: false,
          latencyMs: Date.now() - gumStart,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        };
      }

      let ctxProbe: Record<string, unknown> = { ok: false, initialState: ctxInitialState };
      if (audioCtx) {
        try {
          if (ctxResumedPromise) {
            await Promise.race([
              ctxResumedPromise,
              new Promise((_, rej) => setTimeout(() => rej(new Error("resume_timeout_3000ms")), 3000)),
            ]);
          }
          ctxProbe = {
            ok: audioCtx.state === "running",
            initialState: ctxInitialState,
            resumedState: audioCtx.state,
            sampleRate: audioCtx.sampleRate,
            hasAudioWorklet: Boolean(audioCtx.audioWorklet),
          };
        } catch (err) {
          ctxProbe = {
            ok: false,
            initialState: ctxInitialState,
            currentState: audioCtx.state,
            error: err instanceof Error ? err.message : String(err),
          };
        } finally {
          await audioCtx.close().catch(() => {});
        }
      }

      let workerProbe: Record<string, unknown>;
      try {
        const res = await fetch("/opus/encoderWorker.8.0.5-c3a64a87b286.min.js", { method: "HEAD" });
        workerProbe = { ok: res.ok, status: res.status };
      } catch (err) {
        workerProbe = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      const nativeBestMime = pickBestNativeAudioMimeType();
      const audioSessionType =
        typeof navigator !== "undefined"
          ? ((navigator as Navigator & { audioSession?: { type?: string } }).audioSession?.type ?? "unsupported")
          : "unsupported";

      setProbeReport({
        testedAt: new Date().toISOString(),
        totalMs: Date.now() - startedAt,
        audioSessionType,
        probeA_getUserMedia: micProbe,
        probeB_audioContext: ctxProbe,
        probeC_opusWorker: workerProbe,
        probeD_nativeBestMime: nativeBestMime || "none",
      });
      setRunningProbes(false);
    })();
  };

  const refreshState = useCallback(async () => {
    setSessions(getAudioDiagnosticSessions());
    setResources(getLiveRecorderResources());
    setFlags(
      resolveAudioFeatureFlags({
        accountRole,
        betaFeatures: profile?.beta_features,
        profileLoading,
      }),
    );
    try {
      const pending = await listAllPendingAudio();
      setPendingDbCount(pending.length);
    } catch {
      // Ignore IDB inspection failure in HUD
    }
  }, [accountRole, profile?.beta_features, profileLoading]);

  useEffect(() => {
    if (!authorized || !open) return;
    const timer = setTimeout(() => {
      void refreshState();
    }, 0);
    const unsubDiag = subscribeAudioDiagnostics(() => {
      setSessions(getAudioDiagnosticSessions());
      setResources(getLiveRecorderResources());
    });
    const unsubFlags = subscribeAudioFeatureFlags(() => {
      setFlags(
        resolveAudioFeatureFlags({
          accountRole,
          betaFeatures: profile?.beta_features,
          profileLoading,
        }),
      );
    });
    return () => {
      clearTimeout(timer);
      unsubDiag();
      unsubFlags();
    };
  }, [authorized, open, refreshState, accountRole, profile?.beta_features, profileLoading]);

  const handleServerRefresh = async () => {
    setRefreshing(true);
    await refreshState();
    try {
      const res = await fetch("/api/diagnostics/audio-telemetry?limit=30");
      if (res.ok) {
        const data = (await res.json()) as {
          sessions?: Array<{
            recording_id: string;
            correlation_id: string;
            stage: string;
            failure_category: string;
            payload: Partial<AudioDiagnosticSession>;
            updated_at: string;
          }>;
        };
        if (Array.isArray(data.sessions) && data.sessions.length > 0) {
          const local = getAudioDiagnosticSessions();
          const byId = new Map(local.map((s) => [s.recordingId, s]));
          for (const row of data.sessions) {
            if (!byId.has(row.recording_id) && row.payload) {
              byId.set(row.recording_id, {
                ...(row.payload as AudioDiagnosticSession),
                recordingId: row.recording_id,
                correlationId: row.correlation_id,
                stage: row.stage,
                failureCategory: (row.failure_category as AudioDiagnosticSession["failureCategory"]) || "none",
              });
            }
          }
          setSessions(
            Array.from(byId.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
          );
        }
      }
    } catch {
      // Ignore remote refresh errors
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopyJson = async () => {
    const build = getPublishedBuildInfo();
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const uaAssessment = assessIosUaVersion(ua);
    const exportPayload = {
      exportedAt: new Date().toISOString(),
      build,
      runtimeMode: detectRuntimeMode(),
      iosVersion: uaAssessment.iosVersion,
      safariVersion: uaAssessment.safariVersion,
      iosVersionNote: uaAssessment.note,
      online: typeof navigator !== "undefined" ? navigator.onLine : true,
      visibilityState: typeof document !== "undefined" ? document.visibilityState : "unknown",
      flags,
      resources: {
        ...resources,
        pendingDbCount,
      },
      probeReport,
      sessions: sessions.slice(0, 30),
    };
    const json = JSON.stringify(exportPayload, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // iOS fallback using temporary textarea
      try {
        const ta = document.createElement("textarea");
        ta.value = json;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {}
    }
  };

  if (!authorized || !open) return null;

  const build = getPublishedBuildInfo();
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const uaAssessment = assessIosUaVersion(ua);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Diagnóstico de Áudio"
    >
      <div className="flex max-h-[88dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-border bg-background text-foreground shadow-2xl sm:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <div>
              <h2 className="text-sm font-semibold">Diagnóstico de Áudio (iOS PWA)</h2>
              <p className="text-[11px] text-muted-foreground">
                v{build.wacrmVersion} · {build.buildCommit} · {detectRuntimeMode()}
                {uaAssessment.iosVersion ? ` · iOS ${uaAssessment.iosVersion}` : ""}
                {uaAssessment.safariVersion ? ` (Safari ${uaAssessment.safariVersion})` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void handleServerRefresh()}
              disabled={refreshing}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Atualizar"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={() => void handleCopyJson()}
              className="flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20"
              title="Copiar JSON"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? "Copiado" : "Copiar JSON"}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                clearAudioDiagnosticSessions();
                setSessions([]);
              }}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="Limpar histórico local"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Fechar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs">
          {/* Live resources */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-muted/40 p-2.5">
              <div className="text-[10px] text-muted-foreground">Gravador / Mic</div>
              <div className="mt-0.5 font-semibold">
                {resources.micPhase} · rec:{resources.activeRecorders} · trk:{resources.activeTracks}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-2.5">
              <div className="text-[10px] text-muted-foreground">AudioContext</div>
              <div className="mt-0.5 font-semibold">
                {resources.audioContextState ?? "closed/idle"}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-2.5">
              <div className="text-[10px] text-muted-foreground">Pendentes (Outbox v2 / Legado v1)</div>
              <div className="mt-0.5 font-semibold">
                Outbox: {resources.pendingCount} · Legado IDB: {pendingDbCount} · RAM: {resources.ramVaultCount}
              </div>
            </div>
          </div>

          {/* Feature flags (canary / instant rollback) */}
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Feature Flags (Canário / Rollback Imediato)
            </div>
            <div className="space-y-2">
              {FLAG_LABELS.map((item) => {
                const enabled = flags[item.key];
                return (
                  <label
                    key={item.key}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-1 py-1 hover:bg-muted/40"
                  >
                    <div>
                      <div className="font-medium text-foreground">{item.label}</div>
                      <div className="text-[11px] text-muted-foreground">{item.hint}</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => {
                        const updated = setLocalAudioFeatureFlag(authCtx, item.key, e.target.checked);
                        setFlags(updated);
                      }}
                      className="h-4 w-4 accent-primary"
                    />
                  </label>
                );
              })}
            </div>
          </div>

          {/* Isolated Device Probes (Owner/Beta only) */}
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Autoteste Isolado (Hardware / WebKit)
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Testa getUserMedia, AudioContext, Worker Opus e Codecs sem enviar áudio.
                </div>
              </div>
              <button
                type="button"
                onClick={runIsolationProbes}
                disabled={runningProbes}
                className="shrink-0 rounded-md bg-primary/10 px-2.5 py-1.5 text-[11px] font-semibold text-primary hover:bg-primary/20 disabled:opacity-50"
              >
                {runningProbes ? "Testando…" : "Executar Probes"}
              </button>
            </div>
            {probeReport && (
              <pre className="mt-2 max-h-36 overflow-auto rounded bg-muted/60 p-2 font-mono text-[10px] text-foreground">
                {JSON.stringify(probeReport, null, 2)}
              </pre>
            )}
          </div>

          {/* Recent recordings */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Gravações Recentes ({sessions.length})
              </span>
            </div>
            {sessions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground">
                Nenhuma gravação registrada nesta sessão ainda. Faça uma gravação no Inbox e volte aqui para inspecionar.
              </div>
            ) : (
              <div className="space-y-2">
                {sessions.slice(0, 25).map((s) => {
                  const hasFailure = s.failureCategory && s.failureCategory !== "none" && s.failureCategory !== "cancelled";
                  return (
                    <div
                      key={s.recordingId}
                      className={`rounded-lg border p-2.5 ${
                        hasFailure
                          ? "border-red-500/40 bg-red-500/5"
                          : "border-border bg-card"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-foreground">
                          {s.recordingId.slice(0, 8)} · {s.stage}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            hasFailure
                              ? "bg-red-500/15 text-red-500"
                              : s.sendResult?.ok
                                ? "bg-emerald-500/15 text-emerald-500"
                                : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {s.failureCategory !== "none" ? s.failureCategory : s.recorderState}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        <span>Dur: {formatDuration(s.captureDurationMs)}</span>
                        <span>Tam: {formatBytes(s.fileSizeBytes)}</span>
                        <span>IDB: {s.persistenceResult ? (s.persistenceResult.ok ? s.persistenceResult.storage : "FALHOU") : "-"}</span>
                        <span>Up: {s.uploadResult ? (s.uploadResult.ok ? s.uploadResult.provider : "FALHOU") : "-"}</span>
                        <span>Envio: {s.sendResult ? (s.sendResult.ok ? "OK" : `ERR ${s.sendResult.httpStatus ?? ""}`) : "-"}</span>
                        {s.reconcileResult?.attempted && (
                          <span>Reconcil: {s.reconcileResult.outcome ?? "-"}</span>
                        )}
                        <span>Tent: {s.retryCount}</span>
                      </div>
                      {s.errorDetail && (
                        <div className="mt-1 break-words rounded bg-muted/60 px-2 py-1 font-mono text-[10px] text-red-500">
                          {s.errorDetail}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
