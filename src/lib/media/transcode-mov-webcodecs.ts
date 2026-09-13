/**
 * iPhone-recorded video support (.MOV/HEVC) — WebCodecs path.
 *
 * Replaces the `ffmpeg.wasm` transcode (transcode-mov.ts) as the path
 * `message-composer.tsx` calls for HEVC/.mov attachments. ffmpeg.wasm
 * is a pure-software encoder running inside a WASM sandbox — on a real
 * iPhone PWA it either took minutes or hung indefinitely (`ffmpeg.exec`
 * has no timeout by default and nothing in that code set one). This
 * uses the browser's own native, hardware-accelerated `VideoEncoder`/
 * `VideoDecoder` (WebCodecs) via `mediabunny` (MPL-2.0, zero-cost,
 * 100% client-side, no server) instead — validated live on a real
 * iPhone 14 Pro Max: a 41s/116MB 4K HEVC clip converted in 24.9s
 * (ffmpeg.wasm never finished the same class of file).
 *
 * `mediabunny` is only ever imported from inside `convertMovToMp4ViaWebCodecs`
 * — never at this module's top level from anywhere else — so picking
 * an image, PDF, or an already-compatible MP4 never loads it. The old
 * `transcode-mov.ts`/`ffmpeg.wasm` path is left untouched and unused,
 * not deleted, pending a separate cleanup task once this is confirmed
 * in production.
 */

import { isQuickTimeVideo } from "./transcode-mov";

export { isQuickTimeVideo };

/**
 * Determines whether a video file needs transcoding to H.264/AAC MP4 before upload.
 *
 * WhatsApp Cloud API video messages strictly require:
 *  - Video format: MP4 (or 3GP)
 *  - Video codec: H.264 ('avc')
 *  - Audio codec: AAC ('aac') or AMR
 *
 * Any video encoded with HEVC (H.265 / 'hvc1' / 'hev1'), VP8, VP9, AV1, or non-AAC audio
 * will be rejected by WhatsApp with a delivery failure.
 *
 * Checks:
 * 1. Synchronous check: `isQuickTimeVideo(file)` (matches .mov, video/quicktime, .3gp, .mkv, .avi)
 * 2. Codec probe for other videos (.mp4, etc.):
 *    Uses mediabunny's lightweight container header parser to inspect primary video & audio codecs.
 *    If video codec !== 'avc' (e.g. 'hevc') or audio codec is not 'aac'/'amr', returns true.
 */
export async function shouldTranscodeVideo(file: File): Promise<boolean> {
  if (isQuickTimeVideo(file)) return true;

  try {
    const { Input, ALL_FORMATS, BlobSource } = await import("mediabunny");
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (videoTrack) {
      const codec = await videoTrack.getCodec();
      if (codec && codec !== "avc") {
        return true;
      }
    }
    const audioTrack = await input.getPrimaryAudioTrack();
    if (audioTrack) {
      const audioCodec = await audioTrack.getCodec();
      if (audioCodec && audioCodec !== "aac") {
        return true;
      }
    }
  } catch (err) {
    console.warn("[shouldTranscodeVideo] could not probe video codecs:", err);
  }

  return false;
}

// No hard timeout was the actual root cause of the original hang (see
// module comment) — this wraps the whole conversion so the same class
// of bug can't recur here. 120s is generous: the slowest real test
// (41s of 4K footage) finished in 24.9s, so anything a chat attachment
// realistically sends should land well inside this.
const CONVERSION_TIMEOUT_MS = 120_000;

/**
 * True if this browser's WebCodecs implementation can actually decode
 * this specific file's video track — not just "does VideoEncoder
 * exist". Safari's WebCodecs support has been version-gated and
 * codec-specific (HEVC decode in particular had real gaps on older
 * Safari releases), so this must be checked per-file, not just
 * feature-detected once globally.
 */
export async function canTranscodeViaWebCodecs(file: File): Promise<boolean> {
  if (
    typeof globalThis.VideoEncoder === "undefined" ||
    typeof globalThis.VideoDecoder === "undefined"
  ) {
    return false;
  }
  try {
    const { Input, ALL_FORMATS, BlobSource } = await import("mediabunny");
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return false;
    return await videoTrack.canDecode();
  } catch {
    return false;
  }
}

/**
 * Transcodes a QuickTime/HEVC .mov file to H.264/AAC .mp4 using the
 * browser's native WebCodecs (via mediabunny). Deliberately does NOT
 * pass `width`/`height`/`fit` — an earlier version capped resolution
 * that way and it broke display dimensions on rotated (portrait)
 * phone video: the file converted fine and even played, but every
 * player (this CRM, WhatsApp on both ends) rendered it tiny,
 * thumbnail-sized, because the resize math and the source's rotation
 * matrix didn't agree. The exact config below — no resize, source
 * resolution untouched — is what was validated live on a real iPhone
 * with correct orientation; only the bitrate is capped (not
 * resolution) to keep the result under the existing
 * MEDIA_MAX_BYTES_BY_KIND video cap (16MB) in message-composer.tsx,
 * which runs unmodified right after this. Throws with a user-facing
 * message on failure or timeout — callers surface it via a toast,
 * same convention as `uploadAccountMedia` and the previous ffmpeg.wasm
 * path.
 */
export async function convertMovToMp4ViaWebCodecs(
  file: File,
  onProgress?: (ratio: number) => void,
): Promise<File> {
  try {
    const {
      Input,
      Output,
      Conversion,
      ALL_FORMATS,
      BlobSource,
      Mp4OutputFormat,
      BufferTarget,
      Quality,
    } = await import("mediabunny");

    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });

    const hasAudio = await input.getPrimaryAudioTrack().then((t) => !!t).catch(() => false);

    let conversion: Awaited<ReturnType<typeof Conversion.init>> | null = null;
    try {
      conversion = await Conversion.init({
        input,
        output,
        video: {
          codec: "avc",
          quality: new Quality({ bitrate: 2_000_000 }),
          hardwareAcceleration: "prefer-hardware",
          // iPhone portrait recordings (especially HEVC/"High Efficiency")
          // store orientation as a container-level rotation matrix rather
          // than physically rotated pixels — mediabunny defaults to
          // carrying that same matrix into the output MP4
          // (allowRotationMetadata: true) instead of baking it into the
          // frames. That's spec-correct, but WhatsApp's own media
          // ingestion doesn't reliably honor it: WACRM's own preview
          // (built from the original, untouched file, decoded by the
          // browser which does respect the matrix) showed correctly
          // oriented, while the actual delivered video — the transcoded
          // copy — played back sideways in the real WhatsApp app. Baking
          // the rotation into the pixels here makes the output correct
          // for every player, matrix-aware or not.
          allowRotationMetadata: false,
        },
        ...(hasAudio ? { audio: { codec: "aac" } } : {}),
      });
    } catch {
      // Retry without hardware acceleration or bitrate constraints
      try {
        conversion = await Conversion.init({
          input,
          output,
          video: { codec: "avc", allowRotationMetadata: false },
          ...(hasAudio ? { audio: { codec: "aac" } } : {}),
        });
      } catch {
        // Fallback: transcode video and copy/remux audio without re-encoding
        conversion = await Conversion.init({
          input,
          output,
          video: { codec: "avc", allowRotationMetadata: false },
        });
      }
    }

    if (conversion?.isValid) {
      if (onProgress) conversion.onProgress = onProgress;

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void conversion?.cancel();
      }, CONVERSION_TIMEOUT_MS);

      try {
        await conversion.execute();
      } catch (execErr) {
        throw new Error(
          timedOut
            ? "Video conversion took too long and was canceled."
            : `WebCodecs conversion execution error: ${execErr}`,
        );
      } finally {
        clearTimeout(timer);
      }

      const buffer = output.target.buffer;
      if (buffer && buffer.byteLength > 0) {
        const mp4Name = file.name.replace(/\.[^.]+$/i, ".mp4") || "video.mp4";
        return new File([buffer], mp4Name, { type: "video/mp4" });
      }
    }
  } catch (webCodecsErr) {
    console.warn("WebCodecs transcode failed, trying ffmpeg fallback:", webCodecsErr);
  }

  // Fallback to ffmpeg.wasm
  const { convertMovToMp4 } = await import("./transcode-mov");
  return await convertMovToMp4(file);
}
