"use client";

import { computeByteTimeDomainRms } from "./audio-validation";

export interface NativeRecorderStopResult {
  bytes: Uint8Array;
  mimeType: string;
  rmsPeak: number;
  analyserSamples: number;
}

export interface NativeRecorderHandle {
  mimeType: string;
  stream: MediaStream;
  sampleRms: () => number;
  stop: () => Promise<NativeRecorderStopResult>;
  close: () => void;
}

export function isNativeMediaRecorderSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

export function pickBestNativeAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  const candidates = [
    "audio/ogg;codecs=opus",
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {}
  }
  return "";
}

/**
 * Hardware-accelerated native `MediaRecorder` fallback (no WASM / no AudioWorklet),
 * primarily for iOS Lockdown Mode or platforms where `opus-recorder` initialization fails.
 */
export async function startNativeAudioCapture(options?: {
  onTrackEnded?: () => void;
  onError?: (err: unknown) => void;
}): Promise<NativeRecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });

  const preferredMime = pickBestNativeAudioMimeType();
  const recorder = preferredMime
    ? new MediaRecorder(stream, { mimeType: preferredMime })
    : new MediaRecorder(stream);

  const chunks: Blob[] = [];
  let rmsPeak = 0;
  let analyserSamples = 0;
  let closed = false;

  // Passive RMS monitor (no Proxy on AudioContext)
  let ctx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let sampleBuf: Uint8Array<ArrayBuffer> | null = null;

  try {
    if (typeof AudioContext !== "undefined") {
      ctx = new AudioContext();
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      sampleBuf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      source.connect(analyser);
    }
  } catch {
    // Non-fatal: continue recording without analyser if AudioContext is restricted
  }

  const sampleRms = () => {
    if (!analyser || !sampleBuf) return rmsPeak;
    try {
      analyser.getByteTimeDomainData(sampleBuf);
      const rms = computeByteTimeDomainRms(sampleBuf);
      analyserSamples += 1;
      if (rms > rmsPeak) rmsPeak = rms;
    } catch {}
    return rmsPeak;
  };

  for (const track of stream.getTracks()) {
    track.addEventListener("ended", () => {
      options?.onTrackEnded?.();
    });
  }

  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) {
      chunks.push(ev.data);
    }
  };
  recorder.onerror = (ev) => {
    options?.onError?.(ev);
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      source?.disconnect();
    } catch {}
    try {
      analyser?.disconnect();
    } catch {}
    if (ctx) {
      void ctx.close().catch(() => {});
      ctx = null;
    }
    for (const tr of stream.getTracks()) {
      try {
        tr.stop();
      } catch {}
    }
  };

  recorder.start(250);

  return {
    mimeType: (recorder.mimeType || preferredMime || "audio/mp4").split(";")[0].toLowerCase().trim(),
    stream,
    sampleRms,
    stop: async () => {
      sampleRms();
      if (recorder.state !== "inactive") {
        await new Promise<void>((resolve, reject) => {
          const onStop = () => {
            recorder.removeEventListener("stop", onStop);
            recorder.removeEventListener("error", onErr);
            resolve();
          };
          const onErr = (e: Event) => {
            recorder.removeEventListener("stop", onStop);
            recorder.removeEventListener("error", onErr);
            reject(e);
          };
          recorder.addEventListener("stop", onStop);
          recorder.addEventListener("error", onErr);
          try {
            recorder.stop();
          } catch (err) {
            resolve();
            void err;
          }
        });
      }
      cleanup();
      const baseMime = (recorder.mimeType || preferredMime || "audio/mp4")
        .split(";")[0]
        .toLowerCase()
        .trim();
      const fullBlob = new Blob(chunks, { type: baseMime });
      const arr = await fullBlob.arrayBuffer();
      return {
        bytes: new Uint8Array(arr),
        mimeType: baseMime,
        rmsPeak,
        analyserSamples,
      };
    },
    close: cleanup,
  };
}
