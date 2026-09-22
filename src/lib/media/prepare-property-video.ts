/**
 * Orchestration wrapper for the property media gallery's video slot.
 *
 * Reuses the EXISTING transcode infra from `transcode-mov-webcodecs.ts`
 * (WebCodecs/mediabunny, ffmpeg.wasm fallback) unmodified — this file
 * adds no encoding logic of its own. It only:
 *
 *   1. Decides whether the picked file needs transcoding at all
 *      (`shouldTranscodeVideo` — skips already-compatible MP4s, e.g. a
 *      video exported from a PC, so "no re-encode when not needed").
 *   2. Runs the existing transcoder when it does.
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
  convertMovToMp4ViaWebCodecs: (file: File) => Promise<File>;
}

/**
 * Prepares a picked video file for upload to the `property-media`
 * bucket: transcodes it ONLY if the existing infra says it needs it,
 * then enforces the 16 MB final-file ceiling. Throws a user-facing
 * message (surfaced via toast by the caller, same convention as
 * `uploadAccountMedia`/`convertMovToMp4`) when the file can't be made
 * to fit.
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

  let output = file;
  const needsTranscode = await shouldTranscodeVideo(output);
  if (needsTranscode) {
    output = await convertMovToMp4ViaWebCodecs(output);
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
