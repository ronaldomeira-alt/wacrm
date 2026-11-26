import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickBestNativeAudioMimeType, startNativeAudioCapture } from "./native-audio-recorder";

describe("native-audio-recorder", () => {
  const startCalls: Array<number | undefined> = [];
  let supportedMimes = new Set<string>();

  beforeEach(() => {
    startCalls.length = 0;
    supportedMimes = new Set<string>();

    class FakeMediaRecorder {
      static isTypeSupported = (mime: string) => supportedMimes.has(mime);
      mimeType: string;
      state: RecordingState = "inactive";
      ondataavailable: ((ev: { data: Blob }) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      private listeners = new Map<string, Set<() => void>>();

      constructor(_stream: MediaStream, opts?: { mimeType?: string }) {
        this.mimeType = opts?.mimeType || "audio/mp4";
      }
      addEventListener(type: string, cb: () => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(cb);
      }
      removeEventListener(type: string, cb: () => void) {
        this.listeners.get(type)?.delete(cb);
      }
      start(timeslice?: number) {
        startCalls.push(timeslice);
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob([new Uint8Array(64)], { type: this.mimeType }) });
        for (const cb of this.listeners.get("stop") ?? []) cb();
      }
    }

    (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  });

  it("prioritizes Ogg Opus and WebM Opus ahead of fragmented MP4", () => {
    supportedMimes = new Set(["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]);
    expect(pickBestNativeAudioMimeType()).toBe("audio/webm;codecs=opus");

    supportedMimes = new Set(["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"]);
    expect(pickBestNativeAudioMimeType()).toBe("audio/ogg;codecs=opus");

    supportedMimes = new Set(["audio/mp4"]);
    expect(pickBestNativeAudioMimeType()).toBe("audio/mp4");
  });

  it("omits timeslice for audio/mp4 so Safari does not emit fragmented fMP4 chunks, and reuses injected stream", async () => {
    supportedMimes = new Set(["audio/mp4"]);
    const getUserMediaSpy = vi.fn();
    const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getUserMedia: getUserMediaSpy } },
      configurable: true,
    });
    try {

    const injectedStream = {
      getTracks: () => [{ stop: vi.fn(), addEventListener: vi.fn() }],
    } as unknown as MediaStream;

    const handle = await startNativeAudioCapture({ stream: injectedStream });
    expect(getUserMediaSpy).not.toHaveBeenCalled();
    expect(startCalls).toEqual([undefined]);

    const res = await handle.stop();
    expect(res.mimeType).toBe("audio/mp4");
    expect(res.bytes.byteLength).toBe(64);
    } finally {
      if (origNavDesc) Object.defineProperty(globalThis, "navigator", origNavDesc);
    }
  });

  it("uses 250ms timeslice for non-MP4 WebM Opus captures", async () => {
    supportedMimes = new Set(["audio/webm;codecs=opus"]);
    const injectedStream = {
      getTracks: () => [{ stop: vi.fn(), addEventListener: vi.fn() }],
    } as unknown as MediaStream;

    const handle = await startNativeAudioCapture({ stream: injectedStream });
    expect(startCalls).toEqual([250]);
    await handle.stop();
  });
});
