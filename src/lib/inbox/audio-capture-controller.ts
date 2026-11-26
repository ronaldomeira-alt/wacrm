"use client";

import {
  startAudioDiagnosticSession,
  updateAudioDiagnosticSession,
  updateLiveRecorderResources,
  type AudioDiagnosticSession,
  type AudioFailureCategory,
} from "./audio-telemetry";
import { computeByteTimeDomainRms } from "./audio-validation";
import {
  isNativeMediaRecorderSupported,
  startNativeAudioCapture,
  type NativeRecorderHandle,
} from "./native-audio-recorder";
import { audioLog, audioLogError } from "./pending-audio-log";
import { stopAllAudioPlayback } from "./audio-playback-coordinator";
import { TimeoutError, withTimeout } from "@/lib/net/with-timeout";
import type Recorder from "opus-recorder";

export type CaptureControllerPhase =
  | "idle"
  | "initializing"
  | "recording"
  | "finalizing"
  | "failed";

export interface CaptureDataPayload {
  recordingId: string;
  bytes: Uint8Array;
  mimeType: string;
  captureDurationMs: number;
  sendOnStop: boolean;
  rmsPeak?: number;
  analyserSamples: number;
  replyToId?: string;
}

export interface CapturePhaseMeta {
  recordingId?: string;
  category?: AudioFailureCategory;
  errorDetail?: string;
  userMessage?: string;
  reason?: string;
}

export interface AudioCaptureControllerCallbacks {
  onPhaseChange: (phase: CaptureControllerPhase, meta?: CapturePhaseMeta) => void;
  onDataReady: (payload: CaptureDataPayload) => void | Promise<void>;
  onWarning?: (message: string) => void;
}

export interface StartGestureOptions {
  captureV2Enabled: boolean;
  nativeCaptureEnabled: boolean;
  prewarmedRecorderClass?: { new (config: unknown): Recorder } | null;
  replyToId?: string;
}

export interface StartGestureResult {
  started: boolean;
  recordingId?: string;
  reason?: "already_active" | "unsupported";
}

interface NavigatorAudioSessionLike {
  type?: "auto" | "playback" | "transient" | "transient-solo" | "ambient" | "play-and-record";
}

export interface AudioCaptureControllerDeps {
  encoderPath?: string;
  captureReadyTimeoutMs?: number;
  recorderStopTimeoutMs?: number;
  recorderCloseTimeoutMs?: number;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
  getPrewarmedRecorderClass?: () => { new (config: unknown): Recorder } | null;
  loadRecorderClass?: () => Promise<{ new (config: unknown): Recorder }>;
  isNativeSupported?: () => boolean;
  startNativeCapture?: typeof startNativeAudioCapture;
  getAudioSession?: () => NavigatorAudioSessionLike | null;
  now?: () => number;
  createId?: () => string;
}

const DEFAULT_ENCODER_PATH = "/opus/encoderWorker.8.0.5-c3a64a87b286.min.js";
const DEFAULT_CAPTURE_READY_TIMEOUT_MS = 12_000;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;

const DEFAULT_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

interface SessionState {
  recordingId: string;
  generation: number;
  phase: CaptureControllerPhase;
  disposed: boolean;
  timedOut: boolean;
  intentionalClose: boolean;
  sendOnStop: boolean;
  replyToId?: string;
  captureV2Enabled: boolean;
  nativeCaptureEnabled: boolean;
  gestureStartedAt: number;
  captureActivatedAt: number | null;
  priorAudioSessionType?: NavigatorAudioSessionLike["type"];
  audioSessionTouched: boolean;
  audioContext: AudioContext | null;
  audioContextStateListener: (() => void) | null;
  stream: MediaStream | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  analyserNode: AnalyserNode | null;
  analyserBuf: Uint8Array<ArrayBuffer> | null;
  rmsPeak: number;
  analyserSamples: number;
  recorder: Recorder | null;
  nativeRecorder: NativeRecorderHandle | null;
  initTimer: ReturnType<typeof setTimeout> | null;
  cleanupPromise: Promise<{ ok: boolean; tracksStopped: number; audioContextClosed: boolean }> | null;
  trackListeners: Array<{ track: MediaStreamTrack; ended: () => void; mute: () => void }>;
  pendingDataResolver: ((bytes: Uint8Array) => void) | null;
  pendingDataBytes: Uint8Array | null;
}

function stopStreamTracks(stream: MediaStream | null | undefined): number {
  if (!stream) return 0;
  let stopped = 0;
  const tracks = typeof stream.getTracks === "function" ? stream.getTracks() : [];
  for (const tr of tracks) {
    try {
      tr.stop();
      stopped += 1;
    } catch {
      // ignore track stop error
    }
  }
  return stopped;
}

function defaultGetAudioSession(): NavigatorAudioSessionLike | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { audioSession?: NavigatorAudioSessionLike };
  return nav.audioSession ?? null;
}

function defaultCreateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `audio-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Coordinates single-session microphone acquisition, synchronous iOS WebKit
 * gesture unlocking (`AudioContext` + `getUserMedia` in the exact `pointerdown`
 * turn), `sourceNode` injection into `opus-recorder`, late-resolution cleanup,
 * and React-independent resource lifetimes.
 */
export class AudioCaptureController {
  private readonly callbacks: AudioCaptureControllerCallbacks;
  private readonly encoderPath: string;
  private readonly captureReadyTimeoutMs: number;
  private readonly recorderStopTimeoutMs: number;
  private readonly recorderCloseTimeoutMs: number;
  private readonly getUserMediaFn: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null;
  private readonly createAudioContextFn: (() => AudioContext) | null;
  private readonly loadRecorderClassFn: () => Promise<{ new (config: unknown): Recorder }>;
  private readonly isNativeSupportedFn: () => boolean;
  private readonly startNativeCaptureFn: typeof startNativeAudioCapture;
  private readonly getAudioSessionFn: () => NavigatorAudioSessionLike | null;
  private readonly nowFn: () => number;
  private readonly createIdFn: () => string;

  private activeSession: SessionState | null = null;
  private generationCounter = 0;
  private destroyed = false;

  constructor(callbacks: AudioCaptureControllerCallbacks, deps: AudioCaptureControllerDeps = {}) {
    this.callbacks = callbacks;
    this.encoderPath = deps.encoderPath ?? DEFAULT_ENCODER_PATH;
    this.captureReadyTimeoutMs = deps.captureReadyTimeoutMs ?? DEFAULT_CAPTURE_READY_TIMEOUT_MS;
    this.recorderStopTimeoutMs = deps.recorderStopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.recorderCloseTimeoutMs = deps.recorderCloseTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.getUserMediaFn =
      deps.getUserMedia ??
      (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia
        ? (constraints) => navigator.mediaDevices.getUserMedia(constraints)
        : null);
    this.createAudioContextFn =
      deps.createAudioContext ??
      (typeof AudioContext !== "undefined" ? () => new AudioContext() : null);
    this.loadRecorderClassFn =
      deps.loadRecorderClass ??
      (async () => (await import("opus-recorder")).default as unknown as { new (config: unknown): Recorder });
    this.isNativeSupportedFn = deps.isNativeSupported ?? isNativeMediaRecorderSupported;
    this.startNativeCaptureFn = deps.startNativeCapture ?? startNativeAudioCapture;
    this.getAudioSessionFn = deps.getAudioSession ?? defaultGetAudioSession;
    this.nowFn = deps.now ?? (() => Date.now());
    this.createIdFn = deps.createId ?? defaultCreateId;
  }

  getPhase(): CaptureControllerPhase {
    return this.activeSession?.phase ?? "idle";
  }

  getActiveRecordingId(): string | null {
    return this.activeSession?.recordingId ?? null;
  }

  sampleRms(): number {
    const session = this.activeSession;
    if (!session || session.disposed) return 0;
    if (session.nativeRecorder) {
      session.rmsPeak = session.nativeRecorder.sampleRms();
      return session.rmsPeak;
    }
    const analyser = session.analyserNode;
    const buf = session.analyserBuf;
    if (!analyser || !buf) return session.rmsPeak;
    try {
      analyser.getByteTimeDomainData(buf);
      const rms = computeByteTimeDomainRms(buf);
      session.analyserSamples += 1;
      if (rms > session.rmsPeak) session.rmsPeak = rms;
    } catch {
      // non-fatal RMS read
    }
    return session.rmsPeak;
  }

  /**
   * Starts capture synchronously inside the user's pointerdown turn so iOS WebKit
   * preserves `userActivation` across both `AudioContext.resume()` and
   * `navigator.mediaDevices.getUserMedia()`.
   */
  startGesture(opts: StartGestureOptions): StartGestureResult {
    if (this.destroyed) {
      return { started: false, reason: "unsupported" };
    }
    if (
      this.activeSession &&
      (this.activeSession.phase === "initializing" ||
        this.activeSession.phase === "recording" ||
        this.activeSession.phase === "finalizing")
    ) {
      return { started: false, reason: "already_active", recordingId: this.activeSession.recordingId };
    }

    stopAllAudioPlayback();

    const recordingId = this.createIdFn();
    const nativeSupported = this.isNativeSupportedFn();
    if (!this.getUserMediaFn || (!this.createAudioContextFn && !(opts.captureV2Enabled && nativeSupported))) {
      startAudioDiagnosticSession({
        recordingId,
        correlationId: recordingId,
        prewarmed: Boolean(opts.prewarmedRecorderClass),
      });
      updateAudioDiagnosticSession(
        recordingId,
        (prev) => ({
          ...prev,
          stage: "capture_unsupported",
          recorderState: "failed",
          failureCategory: "encoder_init_failed",
          errorDetail: "getUserMedia or AudioContext unavailable",
        }),
        { flush: true },
      );
      updateLiveRecorderResources({
        micPhase: "idle",
        activeRecorders: 0,
        activeTracks: 0,
        audioContextState: null,
      });
      this.callbacks.onPhaseChange("failed", {
        recordingId,
        category: "encoder_init_failed",
        errorDetail: "getUserMedia or AudioContext unavailable",
        reason: "unsupported",
      });
      return { started: false, reason: "unsupported" };
    }

    const gestureStartedAt = this.nowFn();
    const generation = ++this.generationCounter;

    const session: SessionState = {
      recordingId,
      generation,
      phase: "initializing",
      disposed: false,
      timedOut: false,
      intentionalClose: false,
      sendOnStop: false,
      replyToId: opts.replyToId,
      captureV2Enabled: opts.captureV2Enabled,
      nativeCaptureEnabled: opts.nativeCaptureEnabled,
      gestureStartedAt,
      captureActivatedAt: null,
      audioSessionTouched: false,
      audioContext: null,
      audioContextStateListener: null,
      stream: null,
      sourceNode: null,
      analyserNode: null,
      analyserBuf: null,
      rmsPeak: 0,
      analyserSamples: 0,
      recorder: null,
      nativeRecorder: null,
      initTimer: null,
      cleanupPromise: null,
      trackListeners: [],
      pendingDataResolver: null,
      pendingDataBytes: null,
    };

    this.activeSession = session;

    startAudioDiagnosticSession({
      recordingId,
      correlationId: recordingId,
      prewarmed: Boolean(opts.prewarmedRecorderClass),
    });

    updateLiveRecorderResources({
      micPhase: "initializing",
      activeRecorders: 0,
      activeTracks: 0,
      audioContextState: null,
    });
    this.callbacks.onPhaseChange("initializing", { recordingId });

    // Best-effort permission state probe (never blocks capture)
    if (typeof navigator !== "undefined" && navigator.permissions?.query) {
      void navigator.permissions
        .query({ name: "microphone" as PermissionName })
        .then((perm) => {
          updateAudioDiagnosticSession(recordingId, (prev) => ({
            ...prev,
            micPermission: { ...prev.micPermission, preState: perm.state },
          }));
        })
        .catch(() => {});
    }

    // Configure iOS WebKit AudioSession category synchronously when available
    try {
      const audioSession = this.getAudioSessionFn();
      if (audioSession && "type" in audioSession) {
        session.priorAudioSessionType = audioSession.type;
        if (audioSession.type !== "play-and-record") {
          audioSession.type = "play-and-record";
          session.audioSessionTouched = true;
        }
      }
    } catch {
      // Older Safari builds throw or lack navigator.audioSession
    }

    // Create & unlock AudioContext synchronously inside user gesture WITHOUT awaiting before getUserMedia()
    let ctx: AudioContext | null = null;
    if (!opts.nativeCaptureEnabled && this.createAudioContextFn) {
      try {
        ctx = this.createAudioContextFn();
        session.audioContext = ctx;
        this.attachAudioContextListener(session, ctx);
        if (ctx.state === "suspended" || (ctx.state as string) === "interrupted") {
          void ctx.resume().catch(() => {});
        }
      } catch {
        ctx = null;
        session.audioContext = null;
      }
    }

    // Request microphone synchronously in the exact same turn as pointerdown
    const micRequestedAt = this.nowFn();
    const streamPromise = this.acquireMicrophoneStream(session);

    updateAudioDiagnosticSession(recordingId, (prev) => ({
      ...prev,
      stage: "recorder_starting",
      gestureToGetUserMediaMs: Math.max(0, micRequestedAt - gestureStartedAt),
      micPermission: { ...prev.micPermission, requestedAt: micRequestedAt },
      audioContextState: {
        ...prev.audioContextState,
        beforeStart: ctx?.state,
        sampleRate: ctx?.sampleRate,
      },
    }));

    // Hard timeout guarding initialization (never allows ghost recording UI or leaked late streams)
    session.initTimer = setTimeout(() => {
      void this.handleInitializationTimeout(session);
    }, this.captureReadyTimeoutMs);

    void this.completeInitialization(session, streamPromise, micRequestedAt, opts.prewarmedRecorderClass ?? null);

    return { started: true, recordingId };
  }

  private async acquireMicrophoneStream(session: SessionState): Promise<MediaStream> {
    if (!this.getUserMediaFn) {
      throw new Error("getUserMedia unavailable");
    }
    try {
      return await this.getUserMediaFn({ audio: DEFAULT_AUDIO_CONSTRAINTS });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (
        !session.disposed &&
        (name === "OverconstrainedError" || name === "ConstraintNotSupportedError")
      ) {
        return await this.getUserMediaFn({ audio: true });
      }
      throw err;
    }
  }

  private attachAudioContextListener(session: SessionState, ctx: AudioContext): void {
    if (typeof ctx.addEventListener !== "function") return;
    const listener = () => {
      if (session.disposed) return;
      const unexpectedChange = !session.intentionalClose && ctx.state !== "running";
      updateAudioDiagnosticSession(session.recordingId, (prev) => ({
        ...prev,
        audioContextState: {
          ...prev.audioContextState,
          afterGetUserMedia: ctx.state,
          intentionalClose: session.intentionalClose || prev.audioContextState.intentionalClose,
          interruptionCount: unexpectedChange
            ? prev.audioContextState.interruptionCount + 1
            : prev.audioContextState.interruptionCount,
        },
        interruptionEvents: unexpectedChange
          ? [
              ...prev.interruptionEvents,
              { type: "audiocontext_statechange", at: this.nowFn(), detail: ctx.state },
            ]
          : prev.interruptionEvents,
      }));
      updateLiveRecorderResources({ audioContextState: ctx.state });

      if (unexpectedChange) {
        if (ctx.state === "closed") {
          void this.failActiveSession(
            session,
            "gesture_or_context_blocked",
            "AudioContext closed unexpectedly by OS/WebKit",
            "unexpected_audiocontext_close",
          );
        } else if (
          session.phase === "recording" &&
          (ctx.state === "suspended" || (ctx.state as string) === "interrupted")
        ) {
          void ctx.resume().catch(() => {});
        }
      }
    };
    session.audioContextStateListener = listener;
    ctx.addEventListener("statechange", listener);
  }

  private attachTrackListeners(session: SessionState, tracks: MediaStreamTrack[]): void {
    for (const tr of tracks) {
      if (typeof tr.addEventListener !== "function") continue;
      const ended = () => {
        if (session.disposed) return;
        updateAudioDiagnosticSession(session.recordingId, (prev) => ({
          ...prev,
          trackStates: {
            ...prev.trackStates,
            endedEvents: prev.trackStates.endedEvents + 1,
            readyStates: tracks.map((x) => x.readyState),
          },
          interruptionEvents: [
            ...prev.interruptionEvents,
            { type: "track_ended", at: this.nowFn(), detail: tr.readyState },
          ],
        }));

        if (session.phase === "initializing") {
          void this.failActiveSession(
            session,
            "track_interrupted",
            "Microphone track ended before capture became active",
            "track_ended_during_init",
          );
          return;
        }

        if (session.phase === "recording" && session.captureV2Enabled) {
          session.sendOnStop = false;
          this.callbacks.onWarning?.("Microfone interrompido pelo iOS — tentando salvar o áudio gravado.");
          void this.stop({ sendOnStop: false });
        }
      };

      const mute = () => {
        if (session.disposed) return;
        updateAudioDiagnosticSession(session.recordingId, (prev) => ({
          ...prev,
          trackStates: {
            ...prev.trackStates,
            mutedStates: tracks.map((x) => Boolean(x.muted)),
          },
          interruptionEvents: [
            ...prev.interruptionEvents,
            { type: "track_mute", at: this.nowFn() },
          ],
        }));
      };

      tr.addEventListener("ended", ended);
      tr.addEventListener("mute", mute);
      session.trackListeners.push({ track: tr, ended, mute });
    }
  }

  private async completeInitialization(
    session: SessionState,
    streamPromise: Promise<MediaStream>,
    micRequestedAt: number,
    prewarmedClass: { new (config: unknown): Recorder } | null,
  ): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await streamPromise;
    } catch (err) {
      if (session.disposed) {
        updateAudioDiagnosticSession(session.recordingId, (prev) => ({
          ...prev,
          interruptionEvents: [
            ...prev.interruptionEvents,
            {
              type: "late_getusermedia_rejected",
              at: this.nowFn(),
              detail: err instanceof Error ? err.message : String(err),
            },
          ],
        }));
        return;
      }
      await this.handleInitFailure(session, err);
      return;
    }

    // Late resolution after timeout or cancel: immediately extinguish mic hardware & abort cleanly
    if (session.disposed || this.activeSession !== session) {
      const lateStopped = stopStreamTracks(stream);
      updateAudioDiagnosticSession(session.recordingId, (prev) => ({
        ...prev,
        interruptionEvents: [
          ...prev.interruptionEvents,
          {
            type: "late_stream_disposed",
            at: this.nowFn(),
            detail: `stopped_tracks:${lateStopped}`,
          },
        ],
        cleanupResult: prev.cleanupResult
          ? {
              ...prev.cleanupResult,
              tracksStopped: prev.cleanupResult.tracksStopped + lateStopped,
              lateResolutionGuarded: true,
            }
          : {
              ok: true,
              tracksStopped: lateStopped,
              audioContextClosed: session.audioContext ? session.audioContext.state === "closed" : true,
              lateResolutionGuarded: true,
            },
      }));
      return;
    }

    session.stream = stream;
    const tracks = typeof stream.getAudioTracks === "function"
      ? stream.getAudioTracks()
      : typeof stream.getTracks === "function"
        ? stream.getTracks()
        : [];

    const micResolvedAt = this.nowFn();
    updateAudioDiagnosticSession(session.recordingId, (prev) => ({
      ...prev,
      getUserMediaDurationMs: Math.max(0, micResolvedAt - micRequestedAt),
      micPermission: {
        ...prev.micPermission,
        resolvedAt: micResolvedAt,
        outcome: tracks.length > 0 ? "granted" : "error",
      },
      trackStates: {
        count: tracks.length,
        readyStates: tracks.map((t) => t.readyState),
        mutedStates: tracks.map((t) => Boolean(t.muted)),
        endedEvents: prev.trackStates.endedEvents,
      },
    }));

    if (tracks.length === 0 || tracks.every((t) => t.readyState === "ended")) {
      await this.failActiveSession(
        session,
        "track_interrupted",
        "Microphone stream returned no live audio tracks",
        "no_live_tracks",
      );
      return;
    }

    this.attachTrackListeners(session, tracks);

    try {
      if (session.nativeCaptureEnabled || (!session.audioContext && session.captureV2Enabled && this.isNativeSupportedFn())) {
        await this.startNativeOnSession(session, stream);
        return;
      }

      if (!session.audioContext) {
        if (!this.createAudioContextFn) {
          throw new Error("AudioContext unavailable");
        }
        const lazyCtx = this.createAudioContextFn();
        session.audioContext = lazyCtx;
        this.attachAudioContextListener(session, lazyCtx);
      }

      const ctx = session.audioContext;
      if (ctx.state === "closed") {
        throw new Error("AudioContext closed before recorder initialization");
      }
      if (ctx.state === "suspended" || (ctx.state as string) === "interrupted") {
        void ctx.resume().catch(() => {});
      }

      const sourceNode = ctx.createMediaStreamSource(stream);
      session.sourceNode = sourceNode;

      // Passive AnalyserNode monitor connected from the same sourceNode
      if (session.captureV2Enabled && typeof ctx.createAnalyser === "function") {
        try {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          sourceNode.connect(analyser);
          session.analyserNode = analyser;
          session.analyserBuf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        } catch {
          // Non-fatal: continue without analyser
        }
      }

      const RecorderClass = prewarmedClass || (await this.loadRecorderClassFn());
      if (session.disposed || this.activeSession !== session) {
        await this.cleanupSessionResources(session);
        return;
      }

      const recorder = new RecorderClass({
        encoderPath: this.encoderPath,
        sourceNode,
        numberOfChannels: 1,
        encoderApplication: 2048,
        encoderSampleRate: 48000,
        streamPages: false,
      });

      session.recorder = recorder;

      recorder.ondataavailable = (bytes: Uint8Array) => {
        if (session.disposed && !session.pendingDataResolver) return;
        session.pendingDataBytes = bytes;
        if (session.pendingDataResolver) {
          const resolve = session.pendingDataResolver;
          session.pendingDataResolver = null;
          resolve(bytes);
        }
      };

      recorder.onerror = (error: unknown) => {
        if (session.disposed) return;
        audioLogError("recording:error", error, {
          traceId: session.recordingId,
          reason: "recorder-error",
        });
        const msg = error instanceof Error ? error.message : String(error);
        void this.failActiveSession(session, "recorder_error", msg, "recorder_onerror");
      };

      await recorder.start();

      if (session.disposed || this.activeSession !== session) {
        await this.cleanupSessionResources(session);
        return;
      }

      if ((ctx.state as string) === "closed" || tracks.every((t) => t.readyState === "ended")) {
        await this.failActiveSession(
          session,
          "track_interrupted",
          "Audio resources closed immediately during recorder startup",
          "closed_during_start",
        );
        return;
      }

      this.markSessionRecordingActive(session, tracks, ctx.state);
    } catch (err) {
      if (session.disposed) return;

      const errName = err instanceof Error ? err.name : "Error";
      const isPermDenied = errName === "NotAllowedError" || errName === "PermissionDeniedError";

      // Automatic fallback reusing the ALREADY acquired stream when WASM/Worklet fails
      if (
        session.captureV2Enabled &&
        !isPermDenied &&
        !session.nativeCaptureEnabled &&
        this.isNativeSupportedFn()
      ) {
        try {
          if (session.recorder) {
            session.intentionalClose = true;
            await session.recorder.close().catch(() => {});
            session.recorder = null;
          }
          session.intentionalClose = false;
          await this.startNativeOnSession(session, stream);
          return;
        } catch (nativeErr) {
          audioLogError("recording:error", nativeErr, {
            traceId: session.recordingId,
            reason: "native-fallback-failed",
          });
        }
      }

      await this.handleInitFailure(session, err);
    }
  }

  private async startNativeOnSession(session: SessionState, stream: MediaStream): Promise<void> {
    const nativeHandle = await this.startNativeCaptureFn({
      stream,
      audioContext: session.audioContext,
      ownsAudioContext: false,
      onTrackEnded: () => {
        if (session.disposed) return;
        updateAudioDiagnosticSession(session.recordingId, (prev) => ({
          ...prev,
          interruptionEvents: [
            ...prev.interruptionEvents,
            { type: "track_ended_native", at: this.nowFn() },
          ],
        }));
        if (session.phase === "recording") {
          session.sendOnStop = false;
          this.callbacks.onWarning?.("Microfone interrompido pelo iOS — salvando o áudio gravado.");
          void this.stop({ sendOnStop: false });
        }
      },
      onError: (err) => {
        if (session.disposed) return;
        audioLogError("recording:error", err, {
          traceId: session.recordingId,
          reason: "native-recorder-error",
        });
        void this.failActiveSession(
          session,
          "recorder_error",
          err instanceof Error ? err.message : String(err),
          "native_recorder_onerror",
        );
      },
    });

    if (session.disposed || this.activeSession !== session) {
      nativeHandle.close();
      await this.cleanupSessionResources(session);
      return;
    }

    session.nativeRecorder = nativeHandle;
    if (session.initTimer) {
      clearTimeout(session.initTimer);
      session.initTimer = null;
    }

    const tracks = typeof stream.getTracks === "function" ? stream.getTracks() : [];
    session.phase = "recording";
    session.captureActivatedAt = this.nowFn();

    updateAudioDiagnosticSession(session.recordingId, (prev) => ({
      ...prev,
      stage: "recording_active_native",
      recorderState: "recording",
      format: nativeHandle.mimeType,
      codec: nativeHandle.mimeType.includes("mp4") ? "aac" : "opus",
      encoderInit: {
        ...prev.encoderInit,
        readyAt: session.captureActivatedAt ?? undefined,
        latencyMs: Math.max(0, (session.captureActivatedAt ?? this.nowFn()) - session.gestureStartedAt),
      },
    }));
    updateLiveRecorderResources({
      micPhase: "recording",
      activeRecorders: 1,
      activeTracks: tracks.length,
      audioContextState: "native_mediarecorder",
    });
    this.callbacks.onPhaseChange("recording", { recordingId: session.recordingId });
  }

  private markSessionRecordingActive(
    session: SessionState,
    tracks: MediaStreamTrack[],
    ctxState: string,
  ): void {
    if (session.initTimer) {
      clearTimeout(session.initTimer);
      session.initTimer = null;
    }
    const readyAt = this.nowFn();
    session.phase = "recording";
    session.captureActivatedAt = readyAt;

    updateAudioDiagnosticSession(session.recordingId, (prev) => ({
      ...prev,
      stage: "recording_active",
      recorderState: "recording",
      encoderInit: {
        ...prev.encoderInit,
        readyAt,
        latencyMs: Math.max(0, readyAt - session.gestureStartedAt),
      },
      audioContextState: {
        ...prev.audioContextState,
        beforeStart: prev.audioContextState.beforeStart ?? ctxState,
        sampleRate: session.audioContext?.sampleRate ?? prev.audioContextState.sampleRate,
      },
      trackStates: {
        count: tracks.length,
        readyStates: tracks.map((tr) => tr.readyState),
        mutedStates: tracks.map((tr) => Boolean(tr.muted)),
        endedEvents: prev.trackStates.endedEvents,
      },
    }));
    updateLiveRecorderResources({
      micPhase: "recording",
      activeRecorders: 1,
      activeTracks: tracks.length,
      audioContextState: ctxState,
    });
    this.callbacks.onPhaseChange("recording", { recordingId: session.recordingId });
  }

  private async handleInitializationTimeout(session: SessionState): Promise<void> {
    if (session.disposed || session.phase !== "initializing") return;
    session.timedOut = true;
    session.disposed = true;
    session.initTimer = null;

    const timeoutErr = new TimeoutError("audio capture initialization", this.captureReadyTimeoutMs);
    const detail = timeoutErr.message;
    audioLogError("recording:capture-ready-wait:timeout", timeoutErr, {
      traceId: session.recordingId,
      reason: "capture-ready",
    });

    const cleanupRes = await this.cleanupSessionResources(session);
    if (this.activeSession === session) {
      this.activeSession = null;
    }

    updateAudioDiagnosticSession(
      session.recordingId,
      (prev) => ({
        ...prev,
        stage: "capture_ready_timeout",
        recorderState: "failed",
        failureCategory: "recorder_timeout",
        errorDetail: detail,
        cleanupResult: {
          ok: cleanupRes.ok,
          tracksStopped: cleanupRes.tracksStopped,
          audioContextClosed: cleanupRes.audioContextClosed,
        },
      }),
      { flush: true },
    );

    updateLiveRecorderResources({
      micPhase: "failed",
      activeRecorders: 0,
      activeTracks: 0,
      audioContextState: null,
    });

    this.callbacks.onPhaseChange("failed", {
      recordingId: session.recordingId,
      category: "recorder_timeout",
      errorDetail: detail,
    });
  }

  private async handleInitFailure(session: SessionState, err: unknown): Promise<void> {
    const errName = err instanceof Error ? err.name : "Error";
    const errMsg = err instanceof Error ? err.message : String(err);
    let category: AudioFailureCategory = "unknown";
    if (errName === "NotAllowedError" || errName === "PermissionDeniedError") {
      category = "permission_denied";
    } else if (errName === "TypeError" || errMsg.toLowerCase().includes("audiocontext")) {
      category = "gesture_or_context_blocked";
    } else if (errMsg.toLowerCase().includes("worker") || errMsg.toLowerCase().includes("wasm")) {
      category = "encoder_init_failed";
    }

    await this.failActiveSession(session, category, `${errName}: ${errMsg}`, "init_failed", errName);
  }

  private async failActiveSession(
    session: SessionState,
    category: AudioFailureCategory,
    errorDetail: string,
    reason: string,
    permissionErrorName?: string,
  ): Promise<void> {
    if (session.disposed && session.phase === "failed") return;
    session.disposed = true;
    session.phase = "failed";
    if (session.initTimer) {
      clearTimeout(session.initTimer);
      session.initTimer = null;
    }

    const cleanupRes = await this.cleanupSessionResources(session);
    if (this.activeSession === session) {
      this.activeSession = null;
    }

    audioLogError("recording:error", new Error(errorDetail), {
      traceId: session.recordingId,
      reason,
    });

    updateAudioDiagnosticSession(
      session.recordingId,
      (prev) => ({
        ...prev,
        stage: reason === "init_failed" ? "start_failed" : "recorder_error",
        recorderState: "failed",
        micPermission: permissionErrorName
          ? {
              ...prev.micPermission,
              resolvedAt: this.nowFn(),
              outcome: category === "permission_denied" ? "denied" : "error",
              errorName: permissionErrorName,
            }
          : prev.micPermission,
        encoderInit: {
          ...prev.encoderInit,
          latencyMs: this.nowFn() - session.gestureStartedAt,
          error: errorDetail,
        },
        failureCategory: category,
        errorDetail,
        cleanupResult: {
          ok: cleanupRes.ok,
          tracksStopped: cleanupRes.tracksStopped,
          audioContextClosed: cleanupRes.audioContextClosed,
        },
      }),
      { flush: true },
    );

    updateLiveRecorderResources({
      micPhase: "failed",
      activeRecorders: 0,
      activeTracks: 0,
      audioContextState: null,
    });

    this.callbacks.onPhaseChange("failed", {
      recordingId: session.recordingId,
      category,
      errorDetail,
      reason,
    });
  }

  /**
   * Stops capture and yields the encoded audio payload through `onDataReady`.
   * If invoked while still `initializing` (e.g. a very brief tap/release),
   * aborts cleanly to `idle` instead of dangling an unresolved hardware request.
   */
  async stop(options: { sendOnStop: boolean }): Promise<boolean> {
    const session = this.activeSession;
    if (!session || session.disposed) return false;

    if (session.phase === "initializing") {
      await this.cancel("released_before_ready");
      return false;
    }

    if (session.phase !== "recording") {
      return false;
    }

    this.sampleRms();
    session.phase = "finalizing";
    session.sendOnStop = options.sendOnStop;
    session.intentionalClose = true;

    const captureDurationMs = session.captureActivatedAt
      ? Math.max(0, this.nowFn() - session.captureActivatedAt)
      : 0;
    const ctxStateOnStop = session.audioContext?.state;

    updateAudioDiagnosticSession(session.recordingId, (prev) => ({
      ...prev,
      stage: "finalizing_capture",
      recorderState: "finalizing",
      audioContextState: {
        ...prev.audioContextState,
        onStop: ctxStateOnStop,
        intentionalClose: true,
      },
    }));

    this.callbacks.onPhaseChange("finalizing", { recordingId: session.recordingId });

    if (session.nativeRecorder) {
      const nativeRec = session.nativeRecorder;
      session.nativeRecorder = null;
      try {
        const res = await withTimeout(nativeRec.stop(), this.recorderStopTimeoutMs, "native audio stop");
        const cleanupRes = await this.cleanupSessionResources(session);
        session.disposed = true;
        if (this.activeSession === session) this.activeSession = null;

        updateAudioDiagnosticSession(session.recordingId, (prev) => ({
          ...prev,
          cleanupResult: {
            ok: cleanupRes.ok,
            tracksStopped: cleanupRes.tracksStopped,
            audioContextClosed: cleanupRes.audioContextClosed,
          },
        }));

        await this.callbacks.onDataReady({
          recordingId: session.recordingId,
          bytes: res.bytes,
          mimeType: res.mimeType,
          captureDurationMs,
          sendOnStop: session.sendOnStop,
          rmsPeak: res.rmsPeak,
          analyserSamples: res.analyserSamples,
          replyToId: session.replyToId,
        });
        return true;
      } catch (err) {
        nativeRec.close();
        await this.failActiveSession(
          session,
          err instanceof TimeoutError ? "recorder_timeout" : "recorder_error",
          err instanceof Error ? err.message : String(err),
          "native_stop_failed",
        );
        return false;
      }
    }

    const recorder = session.recorder;
    if (!recorder) {
      await this.failActiveSession(
        session,
        "recorder_error",
        "Missing active recorder on stop",
        "missing_recorder",
      );
      return false;
    }

    try {
      const dataPromise = session.pendingDataBytes
        ? Promise.resolve(session.pendingDataBytes)
        : new Promise<Uint8Array>((resolve) => {
            session.pendingDataResolver = resolve;
          });

      await withTimeout(recorder.stop(), this.recorderStopTimeoutMs, "audio recorder stop");
      const bytes = await withTimeout(dataPromise, 2_000, "audio encoded data flush");

      const cleanupRes = await this.cleanupSessionResources(session);
      session.disposed = true;
      if (this.activeSession === session) this.activeSession = null;

      updateAudioDiagnosticSession(session.recordingId, (prev) => ({
        ...prev,
        audioContextState: {
          ...prev.audioContextState,
          onStop: ctxStateOnStop,
          intentionalClose: true,
        },
        cleanupResult: {
          ok: cleanupRes.ok,
          tracksStopped: cleanupRes.tracksStopped,
          audioContextClosed: cleanupRes.audioContextClosed,
        },
      }));

      await this.callbacks.onDataReady({
        recordingId: session.recordingId,
        bytes,
        mimeType: "audio/ogg",
        captureDurationMs,
        sendOnStop: session.sendOnStop,
        rmsPeak: session.analyserSamples > 0 ? session.rmsPeak : undefined,
        analyserSamples: session.analyserSamples,
        replyToId: session.replyToId,
      });
      return true;
    } catch (err) {
      session.pendingDataResolver = null;
      await this.failActiveSession(
        session,
        err instanceof TimeoutError ? "recorder_timeout" : "recorder_error",
        err instanceof Error ? err.message : String(err),
        "recorder_stop_failed",
      );
      return false;
    }
  }

  /**
   * Discards/aborts the current active capture cleanly and releases all hardware
   * resources immediately so a subsequent capture can start without restart.
   */
  async cancel(reason = "user_cancelled"): Promise<void> {
    const session = this.activeSession;
    if (!session) return;

    session.disposed = true;
    session.intentionalClose = true;
    session.pendingDataResolver = null;
    if (session.initTimer) {
      clearTimeout(session.initTimer);
      session.initTimer = null;
    }

    const cleanupRes = await this.cleanupSessionResources(session);
    if (this.activeSession === session) {
      this.activeSession = null;
    }

    updateAudioDiagnosticSession(session.recordingId, (prev) => ({
      ...prev,
      stage: "cancelled",
      recorderState: "cancelled",
      failureCategory: "cancelled",
      errorDetail: reason,
      audioContextState: {
        ...prev.audioContextState,
        intentionalClose: true,
      },
      cleanupResult: {
        ok: cleanupRes.ok,
        tracksStopped: cleanupRes.tracksStopped,
        audioContextClosed: cleanupRes.audioContextClosed,
      },
    }));

    updateLiveRecorderResources({
      micPhase: "idle",
      activeRecorders: 0,
      activeTracks: 0,
      audioContextState: null,
    });

    if (!this.destroyed) {
      this.callbacks.onPhaseChange("idle", { recordingId: session.recordingId, reason });
    }
  }

  /**
   * Handles iOS backgrounding (`visibilitychange: hidden` / `pagehide`).
   * Aborts cleanly if still initializing; saves locally if actively recording.
   */
  async handleVisibilityInterruption(): Promise<void> {
    const session = this.activeSession;
    if (!session || session.disposed) return;

    updateAudioDiagnosticSession(session.recordingId, (prev) => ({
      ...prev,
      interruptionEvents: [
        ...prev.interruptionEvents,
        { type: "page_hidden_or_pagehide", at: this.nowFn(), detail: session.phase },
      ],
    }));

    if (session.phase === "initializing") {
      await this.cancel("visibility_interrupted_during_init");
      return;
    }
    if (session.phase === "recording" && session.captureV2Enabled) {
      await this.stop({ sendOnStop: false });
    }
  }

  /**
   * Call ONLY when the owning component truly unmounts.
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.activeSession) {
      await this.cancel("component_unmount");
    }
  }

  private cleanupSessionResources(
    session: SessionState,
  ): Promise<{ ok: boolean; tracksStopped: number; audioContextClosed: boolean }> {
    if (session.cleanupPromise) return session.cleanupPromise;

    session.cleanupPromise = (async () => {
      session.intentionalClose = true;
      if (session.initTimer) {
        clearTimeout(session.initTimer);
        session.initTimer = null;
      }

      for (const entry of session.trackListeners) {
        try {
          entry.track.removeEventListener("ended", entry.ended);
          entry.track.removeEventListener("mute", entry.mute);
        } catch {}
      }
      session.trackListeners = [];

      if (session.audioContext && session.audioContextStateListener) {
        try {
          session.audioContext.removeEventListener("statechange", session.audioContextStateListener);
        } catch {}
        session.audioContextStateListener = null;
      }

      try {
        session.sourceNode?.disconnect();
      } catch {}
      try {
        session.analyserNode?.disconnect();
      } catch {}
      session.sourceNode = null;
      session.analyserNode = null;
      session.analyserBuf = null;

      let tracksStopped = stopStreamTracks(session.stream);

      let closedOk = true;
      if (session.nativeRecorder) {
        const nr = session.nativeRecorder;
        session.nativeRecorder = null;
        try {
          nr.close();
        } catch {
          closedOk = false;
        }
      }

      if (session.recorder) {
        const rec = session.recorder;
        session.recorder = null;
        const internalStream = (rec as unknown as { stream?: MediaStream }).stream;
        if (internalStream && internalStream !== session.stream) {
          tracksStopped += stopStreamTracks(internalStream);
        }
        try {
          await withTimeout(rec.close(), this.recorderCloseTimeoutMs, "audio recorder close");
        } catch (err) {
          closedOk = false;
          audioLogError("recording:error", err, {
            traceId: session.recordingId,
            reason: "recorder-close",
          });
        }
      }

      let audioContextClosed = session.audioContext === null;
      if (session.audioContext) {
        const ctx = session.audioContext;
        session.audioContext = null;
        if (ctx.state === "closed") {
          audioContextClosed = true;
        } else {
          try {
            await withTimeout(ctx.close(), this.recorderCloseTimeoutMs, "audio context close");
            audioContextClosed = true;
          } catch {
            closedOk = false;
            audioContextClosed = (ctx.state as string) === "closed";
          }
        }
      }

      if (session.audioSessionTouched) {
        try {
          const audioSession = this.getAudioSessionFn();
          if (audioSession && "type" in audioSession) {
            audioSession.type = session.priorAudioSessionType ?? "auto";
          }
        } catch {
          // ignore
        }
        session.audioSessionTouched = false;
      }

      session.stream = null;
      audioLog("recording:cleanup:complete", {
        traceId: session.recordingId,
        tracksStopped,
        audioContextClosed,
        ok: closedOk && audioContextClosed,
      });

      return {
        ok: closedOk && audioContextClosed,
        tracksStopped,
        audioContextClosed,
      };
    })();

    return session.cleanupPromise;
  }
}

export type AudioSessionDiagnosticSummary = Pick<
  AudioDiagnosticSession,
  "recordingId" | "stage" | "failureCategory" | "cleanupResult"
>;
