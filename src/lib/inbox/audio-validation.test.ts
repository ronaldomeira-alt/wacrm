import { describe, expect, it } from "vitest";
import {
  computeByteTimeDomainRms,
  inspectOggContainer,
  validateCapturedAudio,
} from "./audio-validation";

function makeSyntheticOgg(payloadBytes: number, eos = true): Uint8Array {
  // Single valid Ogg page framing ("OggS", 1 segment of up to 255 bytes or multiple segments)
  const segments: number[] = [];
  let remaining = payloadBytes;
  while (remaining > 0 && segments.length < 255) {
    const chunk = Math.min(255, remaining);
    segments.push(chunk);
    remaining -= chunk;
  }
  const actualPayload = segments.reduce((a, b) => a + b, 0);
  const out = new Uint8Array(27 + segments.length + actualPayload);
  out[0] = 0x4f;
  out[1] = 0x67;
  out[2] = 0x67;
  out[3] = 0x53;
  out[4] = 0x00;
  out[5] = eos ? 0x04 : 0x00;
  out[26] = segments.length;
  for (let i = 0; i < segments.length; i++) {
    out[27 + i] = segments[i];
  }
  return out;
}

describe("audio-validation", () => {
  it("inspects valid OggS framing and EOS flag", () => {
    const bytes = makeSyntheticOgg(900, true);
    expect(inspectOggContainer(bytes)).toEqual({
      hasOggMagic: true,
      pageCount: 1,
      hasEosPage: true,
    });
  });

  it("rejects empty or truncated captures and oversize files", () => {
    const tiny = makeSyntheticOgg(100, true);
    expect(
      validateCapturedAudio({
        bytes: tiny,
        mimeType: "audio/ogg",
        durationMs: 2500,
        maxBytes: 16 * 1024 * 1024,
      }).ok,
    ).toBe(false);

    const normal = makeSyntheticOgg(1200, true);
    const tooBig = validateCapturedAudio({
      bytes: normal,
      mimeType: "audio/ogg",
      durationMs: 2500,
      maxBytes: 500,
    });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.reason).toBe("file-too-large");
  });

  it("detects silent iOS interrupted mic streams when rmsPeak stays digital zero", () => {
    const normal = makeSyntheticOgg(1200, true);
    const silentBuffer = new Uint8Array(128).fill(128);
    expect(computeByteTimeDomainRms(silentBuffer)).toBe(0);

    const res = validateCapturedAudio({
      bytes: normal,
      mimeType: "audio/ogg",
      durationMs: 2500,
      rmsPeak: 0,
      analyserSamples: 5,
      maxBytes: 16 * 1024 * 1024,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("silent-capture-interrupted");

    // Non-silent speech waveform passes
    const loud = validateCapturedAudio({
      bytes: normal,
      mimeType: "audio/ogg",
      durationMs: 2500,
      rmsPeak: 0.08,
      analyserSamples: 5,
      maxBytes: 16 * 1024 * 1024,
    });
    expect(loud.ok).toBe(true);
  });
});
