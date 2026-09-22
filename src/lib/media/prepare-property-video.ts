/**
 * Orchestration wrapper for the property media gallery's video slot.
 *
 * Reuses the EXISTING transcode infra from `transcode-mov-webcodecs.ts`
 * (WebCodecs/mediabunny, ffmpeg.wasm fallback) — this file adds no
 * encoding logic of its own, only a compatibility PROBE (read-only,
 * pure demuxing, no encoder involved) that decides whether the existing
 * transcoder needs to run at all. It:
 *
 *   1. Decides whether the picked file needs transcoding — either
 *      because it fails `shouldTranscodeVideo` (wrong codec/container,
 *      the pre-existing check), OR because `isUnsafeForWhatsApp` below
 *      finds it's already avc/aac but encoded in a profile/structure
 *      WhatsApp's Android client can't reliably play (see that
 *      function's doc). A file that's genuinely already safe (e.g. a
 *      PC export already in Baseline/faststart) skips transcoding
 *      entirely — "no re-encode when not needed" still holds.
 *   2. Runs the existing transcoder when it does, requesting a Baseline
 *      H.264 profile explicitly (`fullCodecString` + `forceTranscode`
 *      options added to `convertMovToMp4ViaWebCodecs` for this reason —
 *      Baseline is spec-guaranteed free of B-frames, and mediabunny's
 *      BufferTarget output defaults to faststart, so one re-encode fixes
 *      all three unsafe conditions at once).
 *   3. Enforces the property gallery's own ceiling: the FINAL stored
 *      file must be <= PROPERTY_MEDIA_MAX_BYTES (16 MB, same cap as the
 *      `property-media` bucket and WhatsApp's own video limit). 16 MB is
 *      a ceiling, not a target — a smaller compatible file is never
 *      re-compressed further.
 *
 * Deliberately does NOT retry with a lower bitrate when the transcoded
 * result is still too large — the existing transcoder's bitrate is
 * shared with (and tuned for) the inbox's proven video-send path, and
 * building a second compression pass here would be exactly the kind of
 * new/parallel pipeline this feature is not supposed to introduce.
 * Instead the caller gets a clear, actionable error (mirrors the same
 * "file too large" UX already used in message-composer.tsx).
 */

import { PROPERTY_MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";

export const PROPERTY_VIDEO_MAX_BYTES = PROPERTY_MEDIA_MAX_BYTES;

// H.264 Baseline profile (profile_idc 0x42 = 66), constraint byte 00,
// level 5.1 (0x33 — comfortably covers any real phone-shot resolution
// up to 4K at the ~2 Mbps target bitrate already used below; WebCodecs
// validates feasibility itself and the existing retry chain in
// convertMovToMp4ViaWebCodecs falls back to a software/ffmpeg.wasm path
// if a given hardware encoder can't honor it). Same "avc1.PPCCLL"
// format and "00" constraint-byte convention mediabunny itself uses
// when building its own (High-profile) default codec string.
//
// WhatsApp Cloud API docs: "use H.264 'Main' profile without B-frames,
// or the H.264 'Baseline' profile" — Baseline is the only one of the
// two that's B-frame-free by spec, so it's the deterministic, always-
// safe target regardless of what the source encoder would have produced.
const H264_BASELINE_PROFILE_IDC = 0x42;
const H264_BASELINE_FULL_CODEC_STRING = "avc1.420033";

/**
 * Real-world sample of two already-live property videos (Toscano Flat,
 * Live Park) both turned out to be encoded H.264 "High" profile
 * (profile_idc 100/0x64) — one of them additionally had B-frames and no
 * faststart. `shouldTranscodeVideo()` never caught either because it
 * only checks the codec FAMILY ("avc" vs "hevc"), not the H.264 PROFILE
 * — an avc/aac MP4 already passes it untouched no matter what profile
 * it's in. This is the additional, property-video-specific check that
 * catches what that one misses, without touching it (the inbox composer
 * keeps its exact current behavior).
 *
 * Returns true (needs re-encode) when any of the three WhatsApp-specific
 * conditions from Meta's own Cloud API docs is violated:
 *   - H.264 profile isn't Baseline (Main is only safe without B-frames,
 *     but Baseline is unconditionally safe, so anything else already
 *     warrants a normalize-to-Baseline pass rather than a second,
 *     harder-to-verify "is this Main-without-B-frames" branch);
 *   - the video track actually contains B-frames (out-of-order
 *     presentation timestamps in decode order — same signal used to
 *     diagnose the Toscano Flat file);
 *   - the MP4's `moov` box is written after `mdat` (no faststart).
 *
 * Read-only: walks packets via `EncodedPacketSink` (pure demuxing, no
 * decoder/encoder involved), so this never touches WebCodecs and works
 * purely off the container — cheap even for the ~13 MB real sample.
 */
export async function isUnsafeForWhatsApp(file: File): Promise<boolean> {
  try {
    const { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } = await import("mediabunny");
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return false; // no video track — not this check's concern

    const codec = await videoTrack.getCodec();
    if (codec !== "avc") return false; // wrong codec family entirely — shouldTranscodeVideo already catches this

    const codecParamString = await videoTrack.getCodecParameterString();
    const profileHex = codecParamString?.startsWith("avc1.") ? codecParamString.slice(5, 7) : null;
    const profileIdc = profileHex ? parseInt(profileHex, 16) : null;
    if (profileIdc !== H264_BASELINE_PROFILE_IDC) return true;

    // Baseline profile is B-frame-free by spec, but still verify faststart.
    const buffer = new Uint8Array(await file.slice(0, Math.min(file.size, 65_536)).arrayBuffer());
    let pos = 0;
    let moovOffset = -1;
    let mdatOffset = -1;
    while (pos + 8 <= buffer.byteLength) {
      const size = new DataView(buffer.buffer, buffer.byteOffset + pos, 4).getUint32(0, false);
      const type = String.fromCharCode(buffer[pos + 4], buffer[pos + 5], buffer[pos + 6], buffer[pos + 7]);
      if (type === "moov" && moovOffset === -1) moovOffset = pos;
      if (type === "mdat" && mdatOffset === -1) mdatOffset = pos;
      if (moovOffset !== -1 && mdatOffset !== -1) break;
      if (size < 8) break; // 0/1 (EOF box / 64-bit size) — bail rather than misparse
      pos += size;
    }
    if (moovOffset !== -1 && mdatOffset !== -1 && moovOffset > mdatOffset) return true;

    // Sanity check for B-frames even though Baseline should never carry
    // them — a mislabeled profile byte would otherwise slip through.
    const sink = new EncodedPacketSink(videoTrack);
    let prevTs: number | null = null;
    for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
      if (prevTs !== null && packet.timestamp < prevTs) return true;
      prevTs = packet.timestamp;
    }

    return false;
  } catch (err) {
    console.warn("[isUnsafeForWhatsApp] could not probe video profile:", err);
    return false; // don't block upload over a probe failure — shouldTranscodeVideo is still the primary gate
  }
}

/** Video extensions/MIME prefixes accepted as INPUT (before normalization). */
const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "mov",
  "3gp",
  "3gpp",
  "mkv",
  "avi",
  "webm",
]);

export function isVideoFile(file: { name?: string; type?: string }): boolean {
  if (file.type && file.type.startsWith("video/")) return true;
  const ext = file.name?.split(".").pop()?.toLowerCase();
  return Boolean(ext && VIDEO_EXTENSIONS.has(ext));
}

export interface PreparePropertyVideoDeps {
  shouldTranscodeVideo: (file: File) => Promise<boolean>;
  convertMovToMp4ViaWebCodecs: (
    file: File,
    onProgress?: (ratio: number) => void,
    options?: { fullCodecString?: string; forceTranscode?: boolean },
  ) => Promise<File>;
  /** Injectable only for tests — defaults to the real probe above. */
  isUnsafeForWhatsApp?: (file: File) => Promise<boolean>;
}

/**
 * Prepares a picked video file for upload to the `property-media`
 * bucket: transcodes it if EITHER the existing infra says it needs it
 * (`shouldTranscodeVideo` — wrong codec/container) OR the WhatsApp
 * compatibility probe above finds an unsafe H.264 profile/B-frames/
 * missing-faststart, then enforces the 16 MB final-file ceiling. Throws
 * a user-facing message (surfaced via toast by the caller, same
 * convention as `uploadAccountMedia`/`convertMovToMp4`) when the file
 * can't be made to fit.
 *
 * `deps` defaults to the real transcode-mov-webcodecs.ts functions —
 * injectable only so this orchestration can be unit-tested without
 * loading real WASM/WebCodecs.
 */
export async function preparePropertyVideo(
  file: File,
  deps?: PreparePropertyVideoDeps,
): Promise<File> {
  const { shouldTranscodeVideo, convertMovToMp4ViaWebCodecs } =
    deps ?? (await import("./transcode-mov-webcodecs"));
  const isUnsafeForWhatsAppFn = deps?.isUnsafeForWhatsApp ?? isUnsafeForWhatsApp;

  let output = file;
  const needsTranscode =
    (await shouldTranscodeVideo(output)) || (await isUnsafeForWhatsAppFn(output));
  if (needsTranscode) {
    output = await convertMovToMp4ViaWebCodecs(output, undefined, {
      fullCodecString: H264_BASELINE_FULL_CODEC_STRING,
      forceTranscode: true,
    });
  }

  if (output.size > PROPERTY_VIDEO_MAX_BYTES) {
    const limitMb = Math.round(PROPERTY_VIDEO_MAX_BYTES / 1024 / 1024);
    const sizeMb = (output.size / 1024 / 1024).toFixed(1);
    throw new Error(
      `O vídeo ficou com ${sizeMb} MB mesmo após a conversão, acima do limite de ${limitMb} MB do WhatsApp. Tente um clipe mais curto ou um arquivo menor.`,
    );
  }

  return output;
}
