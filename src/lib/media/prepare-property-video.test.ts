import { describe, it, expect, vi } from 'vitest'
import { isVideoFile, preparePropertyVideo, PROPERTY_VIDEO_MAX_BYTES } from './prepare-property-video'

function makeFile(name: string, type: string, sizeBytes: number): File {
  // Real content doesn't matter for these tests — only the reported
  // `.size`, which a Blob derives from its actual byte length, so we
  // allocate a buffer of the requested size instead of faking the field.
  const buf = new Uint8Array(sizeBytes)
  return new File([buf], name, { type })
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
    // Test 1: valid video upload that's already WhatsApp-compatible —
    // shouldTranscodeVideo says no, so the existing transcoder must NOT
    // be invoked at all ("PC: MP4 já compatível... evita conversão desnecessária").
    it('skips transcoding when the existing infra says the file is already compatible', async () => {
      const file = makeFile('already-compatible.mp4', 'video/mp4', 2 * 1024 * 1024)
      const shouldTranscodeVideo = vi.fn().mockResolvedValue(false)
      const convertMovToMp4ViaWebCodecs = vi.fn()

      const result = await preparePropertyVideo(file, { shouldTranscodeVideo, convertMovToMp4ViaWebCodecs })

      expect(shouldTranscodeVideo).toHaveBeenCalledWith(file)
      expect(convertMovToMp4ViaWebCodecs).not.toHaveBeenCalled()
      expect(result).toBe(file)
    })

    // Test 2 + 3: incompatible video (e.g. iPhone MOV/HEVC) — the EXISTING
    // transcoder is called (and only it), and its output is what's
    // returned as the final file to upload.
    it('transcodes via the existing infra when needed, and returns its output as the final file', async () => {
      const original = makeFile('IMG_1234.MOV', 'video/quicktime', 20 * 1024 * 1024)
      const transcoded = makeFile('IMG_1234.mp4', 'video/mp4', 10 * 1024 * 1024)
      const shouldTranscodeVideo = vi.fn().mockResolvedValue(true)
      const convertMovToMp4ViaWebCodecs = vi.fn().mockResolvedValue(transcoded)

      const result = await preparePropertyVideo(original, { shouldTranscodeVideo, convertMovToMp4ViaWebCodecs })

      expect(convertMovToMp4ViaWebCodecs).toHaveBeenCalledTimes(1)
      expect(convertMovToMp4ViaWebCodecs).toHaveBeenCalledWith(original)
      expect(result).toBe(transcoded)
      expect(result.type).toBe('video/mp4')
    })

    // Test 4: final file at/under the 16 MB ceiling is accepted as-is —
    // 16 MB is a ceiling, never a target, so a comfortably smaller file
    // must not be touched further.
    it('accepts a final file under the 16 MB ceiling without further action', async () => {
      const file = makeFile('short-clip.mp4', 'video/mp4', 8 * 1024 * 1024)
      const shouldTranscodeVideo = vi.fn().mockResolvedValue(false)
      const convertMovToMp4ViaWebCodecs = vi.fn()

      const result = await preparePropertyVideo(file, { shouldTranscodeVideo, convertMovToMp4ViaWebCodecs })
      expect(result.size).toBeLessThanOrEqual(PROPERTY_VIDEO_MAX_BYTES)
      expect(result).toBe(file)
    })

    // Test 5: transcoded result STILL exceeds 16 MB — must throw a clear,
    // actionable error instead of silently uploading an over-limit file
    // or attempting a second (unsupported, out-of-scope) compression pass.
    it('throws a clear error when the transcoded result is still over 16 MB', async () => {
      const original = makeFile('long-tour.mov', 'video/quicktime', 40 * 1024 * 1024)
      const stillTooBig = makeFile('long-tour.mp4', 'video/mp4', 18 * 1024 * 1024)
      const shouldTranscodeVideo = vi.fn().mockResolvedValue(true)
      const convertMovToMp4ViaWebCodecs = vi.fn().mockResolvedValue(stillTooBig)

      await expect(
        preparePropertyVideo(original, { shouldTranscodeVideo, convertMovToMp4ViaWebCodecs }),
      ).rejects.toThrow(/16 MB/)
    })
  })
})
