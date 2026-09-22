import { describe, it, expect, vi } from 'vitest'
import { isVideoFile, preparePropertyVideo, PROPERTY_VIDEO_MAX_BYTES } from './prepare-property-video'

function makeFile(name: string, type: string, sizeBytes: number): File {
  // Real content doesn't matter for these tests — only the reported
  // `.size`, which a Blob derives from its actual byte length, so we
  // allocate a buffer of the requested size instead of faking the field.
  const buf = new Uint8Array(sizeBytes)
  return new File([buf], name, { type })
}

type ShouldTranscodeMock = ReturnType<typeof vi.fn<(file: File) => Promise<boolean>>>
type ConvertMock = ReturnType<
  typeof vi.fn<
    (file: File, onProgress?: (ratio: number) => void, options?: { fullCodecString?: string; forceTranscode?: boolean }) => Promise<File>
  >
>
type IsUnsafeMock = ReturnType<typeof vi.fn<(file: File) => Promise<boolean>>>

/** Baseline stub deps for tests that don't care about the WhatsApp
 *  profile probe specifically — always reports "already safe" so only
 *  shouldTranscodeVideo drives the decision, same as before this probe
 *  existed. Individual tests override `isUnsafeForWhatsApp` when they
 *  need to exercise that path. */
function makeDeps(overrides: {
  shouldTranscodeVideo?: ShouldTranscodeMock
  convertMovToMp4ViaWebCodecs?: ConvertMock
  isUnsafeForWhatsApp?: IsUnsafeMock
}) {
  return {
    shouldTranscodeVideo: overrides.shouldTranscodeVideo ?? vi.fn(async () => false),
    convertMovToMp4ViaWebCodecs: overrides.convertMovToMp4ViaWebCodecs ?? vi.fn(async (f: File) => f),
    isUnsafeForWhatsApp: overrides.isUnsafeForWhatsApp ?? vi.fn(async () => false),
  }
}

describe('prepare-property-video', () => {
  describe('isVideoFile', () => {
    it('recognizes common video MIME types and extensions', () => {
      expect(isVideoFile({ name: 'clip.mp4', type: 'video/mp4' })).toBe(true)
      expect(isVideoFile({ name: 'clip.mov', type: 'video/quicktime' })).toBe(true)
      expect(isVideoFile({ name: 'clip.mov', type: '' })).toBe(true) // Android/desktop sometimes report empty type
      expect(isVideoFile({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false)
    })
  })

  describe('preparePropertyVideo', () => {
    // Test: a video that's already WhatsApp-safe (right codec family
    // AND right H.264 profile/faststart) must not be touched at all —
    // "no re-encode when not needed" still holds after the Part 1 fix.
    it('skips transcoding when the file is already compatible AND already safe for WhatsApp', async () => {
      const file = makeFile('already-safe.mp4', 'video/mp4', 2 * 1024 * 1024)
      const deps = makeDeps({})

      const result = await preparePropertyVideo(file, deps)

      expect(deps.shouldTranscodeVideo).toHaveBeenCalledWith(file)
      expect(deps.isUnsafeForWhatsApp).toHaveBeenCalledWith(file)
      expect(deps.convertMovToMp4ViaWebCodecs).not.toHaveBeenCalled()
      expect(result).toBe(file)
    })

    // Test: wrong codec/container (e.g. iPhone MOV/HEVC) — the EXISTING
    // transcoder is called (and only it), now explicitly requesting the
    // Baseline profile so the output is normalized, not just re-muxed.
    it('transcodes via the existing infra when shouldTranscodeVideo says so, requesting Baseline profile', async () => {
      const original = makeFile('IMG_1234.MOV', 'video/quicktime', 20 * 1024 * 1024)
      const transcoded = makeFile('IMG_1234.mp4', 'video/mp4', 10 * 1024 * 1024)
      const deps = makeDeps({
        shouldTranscodeVideo: vi.fn().mockResolvedValue(true),
        convertMovToMp4ViaWebCodecs: vi.fn().mockResolvedValue(transcoded),
      })

      const result = await preparePropertyVideo(original, deps)

      expect(deps.convertMovToMp4ViaWebCodecs).toHaveBeenCalledTimes(1)
      expect(deps.convertMovToMp4ViaWebCodecs).toHaveBeenCalledWith(
        original,
        undefined,
        expect.objectContaining({ fullCodecString: expect.stringMatching(/^avc1\.42/), forceTranscode: true }),
      )
      expect(result).toBe(transcoded)
      expect(result.type).toBe('video/mp4')
    })

    // Test (the actual Toscano Flat / Live Park bug): container and codec
    // FAMILY are already fine (avc/aac, already .mp4) — shouldTranscodeVideo
    // alone would say "no re-encode needed" — but the file is H.264 High
    // profile with B-frames, which isUnsafeForWhatsApp must catch, and it
    // must still be routed through the existing transcoder with the
    // Baseline override.
    it('transcodes an already-avc/aac MP4 that is H.264 High profile with B-frames (the Toscano Flat bug)', async () => {
      const original = makeFile('kelly 2.mp4', 'video/mp4', 13 * 1024 * 1024)
      const normalized = makeFile('kelly 2.mp4', 'video/mp4', 9 * 1024 * 1024)
      const deps = makeDeps({
        shouldTranscodeVideo: vi.fn().mockResolvedValue(false), // codec family already avc/aac
        isUnsafeForWhatsApp: vi.fn().mockResolvedValue(true), // but High profile + B-frames
        convertMovToMp4ViaWebCodecs: vi.fn().mockResolvedValue(normalized),
      })

      const result = await preparePropertyVideo(original, deps)

      expect(deps.isUnsafeForWhatsApp).toHaveBeenCalledWith(original)
      expect(deps.convertMovToMp4ViaWebCodecs).toHaveBeenCalledTimes(1)
      expect(deps.convertMovToMp4ViaWebCodecs).toHaveBeenCalledWith(
        original,
        undefined,
        expect.objectContaining({ forceTranscode: true }),
      )
      expect(result).toBe(normalized)
    })

    // Test: same scenario but for the Live Park file — High profile,
    // faststart present, no B-frames in the sampled packets. Still not
    // Baseline, so isUnsafeForWhatsApp must flag it too (profile alone is
    // enough — "não basta verificar somente MP4/H.264").
    it('transcodes an already-avc/aac MP4 that is H.264 High profile even without B-frames (the Live Park case)', async () => {
      const original = makeFile('livepark.mp4', 'video/mp4', 3 * 1024 * 1024)
      const normalized = makeFile('livepark.mp4', 'video/mp4', 2 * 1024 * 1024)
      const deps = makeDeps({
        shouldTranscodeVideo: vi.fn().mockResolvedValue(false),
        isUnsafeForWhatsApp: vi.fn().mockResolvedValue(true),
        convertMovToMp4ViaWebCodecs: vi.fn().mockResolvedValue(normalized),
      })

      const result = await preparePropertyVideo(original, deps)

      expect(deps.convertMovToMp4ViaWebCodecs).toHaveBeenCalledTimes(1)
      expect(result).toBe(normalized)
    })

    // Test: final file at/under the 16 MB ceiling is accepted as-is —
    // 16 MB is a ceiling, never a target, so a comfortably smaller,
    // already-safe file must not be touched further.
    it('accepts a final file under the 16 MB ceiling without further action', async () => {
      const file = makeFile('short-clip.mp4', 'video/mp4', 8 * 1024 * 1024)
      const deps = makeDeps({})

      const result = await preparePropertyVideo(file, deps)
      expect(result.size).toBeLessThanOrEqual(PROPERTY_VIDEO_MAX_BYTES)
      expect(result).toBe(file)
    })

    // Test: transcoded result STILL exceeds 16 MB — must throw a clear,
    // actionable error instead of silently uploading an over-limit file
    // or attempting a second (unsupported, out-of-scope) compression pass.
    it('throws a clear error when the normalized result is still over 16 MB', async () => {
      const original = makeFile('long-tour.mov', 'video/quicktime', 40 * 1024 * 1024)
      const stillTooBig = makeFile('long-tour.mp4', 'video/mp4', 18 * 1024 * 1024)
      const deps = makeDeps({
        shouldTranscodeVideo: vi.fn().mockResolvedValue(true),
        convertMovToMp4ViaWebCodecs: vi.fn().mockResolvedValue(stillTooBig),
      })

      await expect(preparePropertyVideo(original, deps)).rejects.toThrow(/16 MB/)
    })
  })
})
