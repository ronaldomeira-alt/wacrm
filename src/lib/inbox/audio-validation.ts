export interface OggInspectionResult {
  hasOggMagic: boolean;
  pageCount: number;
  hasEosPage: boolean;
}

export interface CapturedAudioValidationInput {
  bytes: Uint8Array;
  mimeType: string;
  durationMs: number;
  rmsPeak?: number;
  analyserSamples?: number;
  maxBytes: number;
}

export type CapturedAudioValidationResult =
  | {
      ok: true;
      hasOggMagic: boolean;
      hasEosPage: boolean;
      pageCount: number;
    }
  | {
      ok: false;
      reason:
        | "empty-file"
        | "file-too-large"
        | "invalid-ogg-header"
        | "silent-capture-interrupted";
      hasOggMagic: boolean;
      hasEosPage: boolean;
      pageCount: number;
      detail: string;
    };

export const MIN_AUDIO_BYTES = 200;
export const MIN_AUDIO_BYTES_1S = 800;
export const MIN_RMS_PEAK = 0.0003;
export const MIN_ANALYSER_SAMPLES_FOR_SILENCE = 3;

/**
 * Parses Ogg page framing (`OggS` magic, version, header_type_flag `0x04` EOS,
 * segment table) in O(pages) without allocations. Never throws on malformed input.
 */
export function inspectOggContainer(bytes: Uint8Array): OggInspectionResult {
  if (bytes.byteLength < 27) {
    const hasMagic =
      bytes.byteLength >= 4 &&
      bytes[0] === 0x4f &&
      bytes[1] === 0x67 &&
      bytes[2] === 0x67 &&
      bytes[3] === 0x53;
    return { hasOggMagic: hasMagic, pageCount: 0, hasEosPage: false };
  }

  let offset = 0;
  let pageCount = 0;
  let hasOggMagic = false;
  let hasEosPage = false;

  while (offset + 27 <= bytes.byteLength && pageCount < 20_000) {
    if (
      bytes[offset] !== 0x4f ||
      bytes[offset + 1] !== 0x67 ||
      bytes[offset + 2] !== 0x67 ||
      bytes[offset + 3] !== 0x53
    ) {
      break;
    }
    if (offset === 0) hasOggMagic = true;
    pageCount += 1;

    const headerTypeFlag = bytes[offset + 5];
    if ((headerTypeFlag & 0x04) !== 0) {
      hasEosPage = true;
    }

    const segmentCount = bytes[offset + 26];
    const headerLen = 27 + segmentCount;
    if (offset + headerLen > bytes.byteLength) break;

    let bodyLen = 0;
    for (let i = 0; i < segmentCount; i++) {
      bodyLen += bytes[offset + 27 + i];
    }
    const nextOffset = offset + headerLen + bodyLen;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  return { hasOggMagic, pageCount, hasEosPage };
}

/**
 * Computes normalized RMS amplitude `[0..1]` from time-domain byte samples (`0..255` centered at 128).
 */
export function computeByteTimeDomainRms(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const centered = (samples[i] - 128) / 128;
    sumSq += centered * centered;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Validates captured voice-note bytes before local persistence or send authorization.
 */
export function validateCapturedAudio(
  input: CapturedAudioValidationInput,
): CapturedAudioValidationResult {
  const { bytes, mimeType, durationMs, rmsPeak, analyserSamples = 0, maxBytes } = input;
  const isOgg = mimeType.toLowerCase().includes("ogg") || mimeType.toLowerCase().includes("opus");
  const ogg = isOgg
    ? inspectOggContainer(bytes)
    : { hasOggMagic: false, pageCount: 0, hasEosPage: false };

  if (bytes.byteLength < MIN_AUDIO_BYTES) {
    return {
      ok: false,
      reason: "empty-file",
      ...ogg,
      detail: `Captured audio too small (${bytes.byteLength} bytes)`,
    };
  }

  if (durationMs >= 1000 && bytes.byteLength < MIN_AUDIO_BYTES_1S) {
    return {
      ok: false,
      reason: "empty-file",
      ...ogg,
      detail: `Captured audio truncated (${bytes.byteLength} bytes for ${durationMs}ms)`,
    };
  }

  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      reason: "file-too-large",
      ...ogg,
      detail: `Captured audio exceeds max size (${bytes.byteLength} > ${maxBytes})`,
    };
  }

  if (isOgg && !ogg.hasOggMagic) {
    return {
      ok: false,
      reason: "invalid-ogg-header",
      ...ogg,
      detail: "Missing OggS container header",
    };
  }

  if (
    typeof rmsPeak === "number" &&
    analyserSamples >= MIN_ANALYSER_SAMPLES_FOR_SILENCE &&
    rmsPeak <= MIN_RMS_PEAK
  ) {
    return {
      ok: false,
      reason: "silent-capture-interrupted",
      ...ogg,
      detail: `Silent digital mic stream detected (rmsPeak=${rmsPeak.toFixed(6)})`,
    };
  }

  return {
    ok: true,
    ...ogg,
  };
}
