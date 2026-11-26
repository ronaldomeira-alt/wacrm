import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioCaptureController,
  type CaptureControllerPhase,
  type CaptureDataPayload,
} from "./audio-capture-controller";
import {
  clearAudioDiagnosticSessions,
  getAudioDiagnosticSession,
  getLiveRecorderResources,
  updateLiveRecorderResources,
} from "./audio-telemetry";

class FakeTrack {
  readyState: MediaStreamTrackState = "live";
  muted = false;
  stopCalls = 0;
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, cb: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }
  emit(type: string) {
    if (type === "ended") this.readyState = "ended";
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
  stop() {
    this.stopCalls += 1;
    this.readyState = "ended";
  }
}

class FakeMediaStream {
  tracks: FakeTrack[];
  constructor(tracks = [new FakeTrack()]) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks as unknown as MediaStreamTrack[];
  }
  getAudioTracks() {
    return this.tracks as unknown as MediaStreamTrack[];
  }
}

class FakeAudioContext {
  state: AudioContextState = "suspended";
  sampleRate = 48000;
  resumeCalls = 0;
  closeCalls = 0;
  createdSourceNodes = 0;
  private listeners = new Set<() => void>();

  addEventListener(type: string, cb: () => void) {
    if (type === "statechange") this.listeners.add(cb);
  }
  removeEventListener(type: string, cb: () => void) {
    if (type === "statechange") this.listeners.delete(cb);
  }
  setState(next: AudioContextState) {
    this.state = next;
    for (const cb of this.listeners) cb();
  }
  async resume() {
    this.resumeCalls += 1;
    if (this.state !== "closed") {
      this.setState("running");
    }
  }
  async close() {
    this.closeCalls += 1;
    if (this.state !== "closed") {
      this.setState("closed");
    }
  }
  createMediaStreamSource() {
    this.createdSourceNodes += 1;
    return {
      context: this,
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaStreamAudioSourceNode;
  }
  createAnalyser() {
    return {
      fftSize: 256,
      frequencyBinCount: 128,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getByteTimeDomainData: (arr: Uint8Array) => {
        arr.fill(140);
      },
    } as unknown as AnalyserNode;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

describe("AudioCaptureController", () => {
  let phases: Array<{ phase: CaptureControllerPhase; recordingId?: string; category?: string }>;
  let completedPayloads: CaptureDataPayload[];
  let warnings: string[];
  let contexts: FakeAudioContext[];
  let streams: FakeMediaStream[];
  let recorders: Array<{
    config: unknown;
    ondataavailable: ((bytes: Uint8Array) => void) | null;
    onerror: ((err: unknown) => void) | null;
    startCalls: number;
    stopCalls: number;
    closeCalls: number;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    close: () => Promise<void>;
  }>;

  beforeEach(() => {
    vi.useFakeTimers();
    const store = new Map<string, string>();
    (globalThis as unknown as { CustomEvent?: unknown }).CustomEvent = class {
      constructor(public type: string) {}
    };
    (globalThis as unknown as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
      dispatchEvent: () => true,
      navigator: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1",
      },
    };
    clearAudioDiagnosticSessions();
    updateLiveRecorderResources({
      micPhase: "idle",
      activeRecorders: 0,
      activeTracks: 0,
      audioContextState: null,
      pendingCount: 0,
      ramVaultCount: 0,
    });
    phases = [];
    completedPayloads = [];
    warnings = [];
    contexts = [];
    streams = [];
    recorders = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRecorderFactory(overrides?: {
    startImpl?: () => Promise<void>;
    bytes?: Uint8Array;
    emitDataOnStop?: boolean;
  }) {
    return class MockRecorder {
      ondataavailable: ((bytes: Uint8Array) => void) | null = null;
      onerror: ((err: unknown) => void) | null = null;
      config: unknown;
      startCalls = 0;
      stopCalls = 0;
      closeCalls = 0;
      constructor(config: unknown) {
        this.config = config;
        recorders.push(this);
      }
      async start() {
        this.startCalls += 1;
        if (overrides?.startImpl) await overrides.startImpl();
      }
      async stop() {
        this.stopCalls += 1;
        if (overrides?.emitDataOnStop !== false) {
          this.ondataavailable?.(overrides?.bytes ?? new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]));
        }
      }
      async close() {
        this.closeCalls += 1;
      }
    };
  }

  it("calls getUserMedia and AudioContext.resume synchronously inside startGesture, injects sourceNode, and records intentional close cleanly", async () => {
    const callOrder: string[] = [];
    const audioSession = { type: "auto" as const };
    const getUserMedia = vi.fn(() => {
      callOrder.push("getUserMedia");
      const s = new FakeMediaStream();
      streams.push(s);
      return Promise.resolve(s as unknown as MediaStream);
    });

    const controller = new AudioCaptureController(
      {
        onPhaseChange: (phase, meta) => phases.push({ phase, recordingId: meta?.recordingId, category: meta?.category }),
        onDataReady: (payload) => {
          completedPayloads.push(payload);
        },
      },
      {
        getUserMedia,
        createAudioContext: () => {
          callOrder.push("createAudioContext");
          const c = new FakeAudioContext();
          const origResume = c.resume.bind(c);
          c.resume = () => {
            callOrder.push("resumeAudioContext");
            return origResume();
          };
          contexts.push(c);
          return c as unknown as AudioContext;
        },
        getAudioSession: () => audioSession,
        loadRecorderClass: async () => makeRecorderFactory() as unknown as never,
      },
    );

    const started = controller.startGesture({
      captureV2Enabled: true,
      nativeCaptureEnabled: false,
      prewarmedRecorderClass: makeRecorderFactory() as unknown as never,
      replyToId: "reply-1",
    });

    // Synchronous order check: NO setTimeout or prior await before hardware APIs
    expect(started.started).toBe(true);
    expect(callOrder).toEqual(["createAudioContext", "resumeAudioContext", "getUserMedia"]);
    expect(audioSession.type).toBe("play-and-record");
    expect(controller.getPhase()).toBe("initializing");

    await flushMicrotasks();

    expect(controller.getPhase()).toBe("recording");
    expect(phases.map((p) => p.phase)).toEqual(["initializing", "recording"]);
    expect((recorders[0].config as { sourceNode?: unknown }).sourceNode).toBeTruthy();

    vi.advanceTimersByTime(1500);
    const stopped = await controller.stop({ sendOnStop: true });
    expect(stopped).toBe(true);
    expect(completedPayloads).toHaveLength(1);
    expect(completedPayloads[0].sendOnStop).toBe(true);
    expect(completedPayloads[0].replyToId).toBe("reply-1");
    expect(completedPayloads[0].captureDurationMs).toBe(1500);

    // Intentional close must NOT count as OS interruption and audioSession restores to auto
    const session = getAudioDiagnosticSession(started.recordingId!);
    expect(session?.audioContextState.intentionalClose).toBe(true);
    expect(session?.audioContextState.interruptionCount).toBe(0);
    expect(session?.cleanupResult).toEqual({
      ok: true,
      tracksStopped: 1,
      audioContextClosed: true,
    });
    expect(audioSession.type).toBe("auto");
    expect(controller.getPhase()).toBe("idle");
  });

  it("handles OverconstrainedError by retrying with { audio: true }", async () => {
    let attempts = 0;
    const controller = new AudioCaptureController(
      {
        onPhaseChange: (phase, meta) => phases.push({ phase, recordingId: meta?.recordingId }),
        onDataReady: (p) => {
          completedPayloads.push(p);
        },
      },
      {
        getUserMedia: vi.fn(async (constraints) => {
          attempts += 1;
          if (attempts === 1) {
            expect(constraints.audio).not.toBe(true);
            const err = new Error("bad constraints");
            err.name = "OverconstrainedError";
            throw err;
          }
          expect(constraints.audio).toBe(true);
          const s = new FakeMediaStream();
          streams.push(s);
          return s as unknown as MediaStream;
        }),
        createAudioContext: () => {
          const c = new FakeAudioContext();
          contexts.push(c);
          return c as unknown as AudioContext;
        },
        loadRecorderClass: async () => makeRecorderFactory() as unknown as never,
      },
    );

    controller.startGesture({ captureV2Enabled: true, nativeCaptureEnabled: false });
    await flushMicrotasks();

    expect(attempts).toBe(2);
    expect(controller.getPhase()).toBe("recording");
  });

  it("times out hung getUserMedia, populates cleanupResult, stops late-resolving stream, and unblocks immediate retry", async () => {
    const hung = createDeferred<MediaStream>();
    let callCount = 0;
    const lateTrack = new FakeTrack();
    const lateStream = new FakeMediaStream([lateTrack]);

    const controller = new AudioCaptureController(
      {
        onPhaseChange: (phase, meta) => phases.push({ phase, recordingId: meta?.recordingId, category: meta?.category }),
        onDataReady: (p) => {
          completedPayloads.push(p);
        },
      },
      {
        captureReadyTimeoutMs: 5000,
        getUserMedia: vi.fn(() => {
          callCount += 1;
          if (callCount === 1) return hung.promise;
          const s = new FakeMediaStream();
          streams.push(s);
          return Promise.resolve(s as unknown as MediaStream);
        }),
        createAudioContext: () => {
          const c = new FakeAudioContext();
          contexts.push(c);
          return c as unknown as AudioContext;
        },
        loadRecorderClass: async () => makeRecorderFactory() as unknown as never,
      },
    );

    const first = controller.startGesture({
      captureV2Enabled: true,
      nativeCaptureEnabled: false,
      prewarmedRecorderClass: makeRecorderFactory() as unknown as never,
    });
    expect(controller.getPhase()).toBe("initializing");

    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();

    const firstDiag = getAudioDiagnosticSession(first.recordingId!);
    expect(firstDiag?.stage).toBe("capture_ready_timeout");
    expect(firstDiag?.failureCategory).toBe("recorder_timeout");
    expect(firstDiag?.cleanupResult).toEqual({
      ok: true,
      tracksStopped: 0,
      audioContextClosed: true,
    });
    expect(contexts[0].state).toBe("closed");
    expect(getLiveRecorderResources().activeRecorders).toBe(0);
    expect(getLiveRecorderResources().activeTracks).toBe(0);

    // Late resolution of the timed-out stream MUST be immediately stopped and guarded
    hung.resolve(lateStream as unknown as MediaStream);
    await flushMicrotasks();
    expect(lateTrack.stopCalls).toBe(1);
    expect(lateTrack.readyState).toBe("ended");
    expect(getAudioDiagnosticSession(first.recordingId!)?.cleanupResult?.lateResolutionGuarded).toBe(true);

    // Immediate next attempt must succeed cleanly without restarting PWA
    const second = controller.startGesture({
      captureV2Enabled: true,
      nativeCaptureEnabled: false,
      prewarmedRecorderClass: makeRecorderFactory() as unknown as never,
    });
    expect(second.started).toBe(true);
    await flushMicrotasks();
    expect(controller.getPhase()).toBe("recording");
  });

  it("blocks concurrent double-tap while initializing or recording", async () => {
    const controller = new AudioCaptureController(
      {
        onPhaseChange: () => {},
        onDataReady: () => {},
      },
      {
        getUserMedia: vi.fn(async () => {
          const s = new FakeMediaStream();
          streams.push(s);
          return s as unknown as MediaStream;
        }),
        createAudioContext: () => {
          const c = new FakeAudioContext();
          contexts.push(c);
          return c as unknown as AudioContext;
        },
        loadRecorderClass: async () => makeRecorderFactory() as unknown as never,
      },
    );

    const first = controller.startGesture({ captureV2Enabled: true, nativeCaptureEnabled: false });
    const duplicateDuringInit = controller.startGesture({ captureV2Enabled: true, nativeCaptureEnabled: false });
    expect(first.started).toBe(true);
    expect(duplicateDuringInit).toEqual({
      started: false,
      reason: "already_active",
      recordingId: first.recordingId,
    });

    await flushMicrotasks();
    const duplicateDuringRec = controller.startGesture({ captureV2Enabled: true, nativeCaptureEnabled: false });
    expect(duplicateDuringRec.started).toBe(false);
    expect(duplicateDuringRec.reason).toBe("already_active");
  });

  it("detects unexpected OS AudioContext closure and avoids leaving phantom recording UI", async () => {
    const controller = new AudioCaptureController(
      {
        onPhaseChange: (phase, meta) => phases.push({ phase, recordingId: meta?.recordingId, category: meta?.category }),
        onDataReady: () => {},
      },
      {
        getUserMedia: vi.fn(async () => {
          const s = new FakeMediaStream();
          streams.push(s);
          return s as unknown as MediaStream;
        }),
        createAudioContext: () => {
          const c = new FakeAudioContext();
          contexts.push(c);
          return c as unknown as AudioContext;
        },
        loadRecorderClass: async () => makeRecorderFactory() as unknown as never,
      },
    );

    const started = controller.startGesture({
      captureV2Enabled: true,
      nativeCaptureEnabled: false,
      prewarmedRecorderClass: makeRecorderFactory() as unknown as never,
    });
    await flushMicrotasks();
    expect(controller.getPhase()).toBe("recording");

    // Simulate iOS killing/closing the AudioContext unexpectedly
    contexts[0].setState("closed");
    await flushMicrotasks();

    expect(controller.getPhase()).toBe("idle");
    expect(phases.at(-1)?.phase).toBe("failed");
    expect(phases.at(-1)?.category).toBe("gesture_or_context_blocked");
    expect(streams[0].tracks[0].stopCalls).toBe(1);
    const diag = getAudioDiagnosticSession(started.recordingId!);
    expect(diag?.audioContextState.interruptionCount).toBe(1);
  });

  it("ignores stale callbacks from previous recorder sessions across consecutive recordings", async () => {
    const controller = new AudioCaptureController(
      {
        onPhaseChange: (phase, meta) => phases.push({ phase, recordingId: meta?.recordingId }),
        onDataReady: (p) => {
          completedPayloads.push(p);
        },
      },
      {
        getUserMedia: vi.fn(async () => {
          const s = new FakeMediaStream();
          streams.push(s);
          return s as unknown as MediaStream;
        }),
        createAudioContext: () => {
          const c = new FakeAudioContext();
          contexts.push(c);
          return c as unknown as AudioContext;
        },
        loadRecorderClass: async () => makeRecorderFactory() as unknown as never,
      },
    );

    // Session 1
    const s1 = controller.startGesture({
      captureV2Enabled: true,
      nativeCaptureEnabled: false,
      prewarmedRecorderClass: makeRecorderFactory() as unknown as never,
    });
    await flushMicrotasks();
    await controller.stop({ sendOnStop: true });

    // Session 2
    const s2 = controller.startGesture({
      captureV2Enabled: true,
      nativeCaptureEnabled: false,
      prewarmedRecorderClass: makeRecorderFactory() as unknown as never,
    });
    await flushMicrotasks();
    expect(controller.getPhase()).toBe("recording");

    // Stale error/data callback on recorder[0] MUST NOT break or corrupt Session 2
    recorders[0].onerror?.(new Error("late failure from session 1"));
    recorders[0].ondataavailable?.(new Uint8Array([1, 2, 3]));
    await flushMicrotasks();

    expect(controller.getPhase()).toBe("recording");
    expect(controller.getActiveRecordingId()).toBe(s2.recordingId);

    await controller.stop({ sendOnStop: false });
    expect(completedPayloads.map((p) => p.recordingId)).toEqual([s1.recordingId, s2.recordingId]);
  });

  it("falls back to native MediaRecorder using the ALREADY acquired stream when WASM Recorder fails", async () => {
    const startNativeCapture = vi.fn(async (opts) => ({
      mimeType: "audio/webm",
      stream: opts.stream!,
      sampleRms: () => 0.1,
      stop: async () => ({
        bytes: new Uint8Array(300),
        mimeType: "audio/webm",
        rmsPeak: 0.1,
        analyserSamples: 2,
      }),
      close: vi.fn(),
    }));

    const getUserMedia = vi.fn(async () => {
      const s = new FakeMediaStream();
      streams.push(s);
      return s as unknown as MediaStream;
    });

    const controller = new AudioCaptureController(
      {
        onPhaseChange: (phase) => phases.push({ phase }),
        onDataReady: (p) => {
          completedPayloads.push(p);
        },
      },
      {
        getUserMedia,
        createAudioContext: () => {
          const c = new FakeAudioContext();
          contexts.push(c);
          return c as unknown as AudioContext;
        },
        isNativeSupported: () => true,
        startNativeCapture,
        loadRecorderClass: async () =>
          makeRecorderFactory({
            startImpl: async () => {
              throw new Error("AudioWorklet worker load error");
            },
          }) as unknown as never,
      },
    );

    controller.startGesture({ captureV2Enabled: true, nativeCaptureEnabled: false });
    await flushMicrotasks();

    // Crucially: getUserMedia was called ONLY ONCE (stream reused for native fallback!)
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(startNativeCapture).toHaveBeenCalledTimes(1);
    expect(startNativeCapture.mock.calls[0]?.[0]?.stream).toBe(streams[0]);
    expect(controller.getPhase()).toBe("recording");

    await controller.stop({ sendOnStop: true });
    expect(completedPayloads[0].mimeType).toBe("audio/webm");
  });

  it("cancels cleanly to idle when stopped during initializing and exposes handleVisibilityInterruption", async () => {
    const pendingGum = createDeferred<MediaStream>();
    const lateTrack = new FakeTrack();
    const controller = new AudioCaptureController(
      {
        onPhaseChange: (phase) => phases.push({ phase }),
        onDataReady: (p) => {
          completedPayloads.push(p);
        },
        onWarning: (w) => warnings.push(w),
      },
      {
        getUserMedia: () => pendingGum.promise,
        createAudioContext: () => {
          const c = new FakeAudioContext();
          contexts.push(c);
          return c as unknown as AudioContext;
        },
        loadRecorderClass: async () => makeRecorderFactory() as unknown as never,
      },
    );

    controller.startGesture({ captureV2Enabled: true, nativeCaptureEnabled: false });
    expect(controller.getPhase()).toBe("initializing");

    const ok = await controller.stop({ sendOnStop: false });
    expect(ok).toBe(false);
    expect(controller.getPhase()).toBe("idle");

    pendingGum.resolve(new FakeMediaStream([lateTrack]) as unknown as MediaStream);
    await flushMicrotasks();
    expect(lateTrack.stopCalls).toBe(1);
  });

  it("handles permission_denied cleanly and allows immediate subsequent retry", async () => {
    let call = 0;
    const controller = new AudioCaptureController(
      {
        onPhaseChange: (phase, meta) => phases.push({ phase, recordingId: meta?.recordingId, category: meta?.category }),
        onDataReady: () => {},
      },
      {
        getUserMedia: vi.fn(async () => {
          call += 1;
          if (call === 1) {
            const err = new Error("Permission denied");
            err.name = "NotAllowedError";
            throw err;
          }
          const s = new FakeMediaStream();
          streams.push(s);
          return s as unknown as MediaStream;
        }),
        createAudioContext: () => {
          const c = new FakeAudioContext();
          contexts.push(c);
          return c as unknown as AudioContext;
        },
        loadRecorderClass: async () => makeRecorderFactory() as unknown as never,
      },
    );

    const first = controller.startGesture({
      captureV2Enabled: true,
      nativeCaptureEnabled: false,
      prewarmedRecorderClass: makeRecorderFactory() as unknown as never,
    });
    await flushMicrotasks();

    const d1 = getAudioDiagnosticSession(first.recordingId!);
    expect(d1?.failureCategory).toBe("permission_denied");
    expect(d1?.cleanupResult?.audioContextClosed).toBe(true);
    expect(controller.getPhase()).toBe("idle");

    const second = controller.startGesture({
      captureV2Enabled: true,
      nativeCaptureEnabled: false,
      prewarmedRecorderClass: makeRecorderFactory() as unknown as never,
    });
    await flushMicrotasks();
    expect(second.started).toBe(true);
    expect(controller.getPhase()).toBe("recording");
  });

  it("recovers safely when track ends mid-recording or page becomes hidden", async () => {
    const controller = new AudioCaptureController(
      {
        onPhaseChange: (phase, meta) => phases.push({ phase, recordingId: meta?.recordingId, category: meta?.category }),
        onDataReady: (p) => {
          completedPayloads.push(p);
        },
        onWarning: (w) => warnings.push(w),
      },
      {
        getUserMedia: vi.fn(async () => {
          const s = new FakeMediaStream();
          streams.push(s);
          return s as unknown as MediaStream;
        }),
        createAudioContext: () => {
          const c = new FakeAudioContext();
          contexts.push(c);
          return c as unknown as AudioContext;
        },
        loadRecorderClass: async () => makeRecorderFactory() as unknown as never,
      },
    );

    // 1. track.ended mid-recording triggers warning + graceful stop (not ghost recording)
    controller.startGesture({
      captureV2Enabled: true,
      nativeCaptureEnabled: false,
      prewarmedRecorderClass: makeRecorderFactory() as unknown as never,
    });
    await flushMicrotasks();
    expect(controller.getPhase()).toBe("recording");
    streams[0].tracks[0].emit("ended");
    await flushMicrotasks();

    expect(warnings).toHaveLength(1);
    expect(completedPayloads).toHaveLength(1);
    expect(completedPayloads[0].sendOnStop).toBe(false);
    expect(controller.getPhase()).toBe("idle");

    // 2. handleVisibilityInterruption mid-recording saves locally as sendOnStop=false
    controller.startGesture({
      captureV2Enabled: true,
      nativeCaptureEnabled: false,
      prewarmedRecorderClass: makeRecorderFactory() as unknown as never,
    });
    await flushMicrotasks();
    await controller.handleVisibilityInterruption();
    expect(completedPayloads).toHaveLength(2);
    expect(completedPayloads[1].sendOnStop).toBe(false);
    expect(controller.getPhase()).toBe("idle");
  });
});
