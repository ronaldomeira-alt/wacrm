import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import {
  normalizePropertyImage,
  isSupportedImageFilename,
  isSupportedImageMime,
  META_WHATSAPP_IMAGE_MAX_BYTES,
} from './normalize-property-image'

describe('Image Normalization Utility for Property Media', () => {
  it('identifies supported image filenames correctly', () => {
    expect(isSupportedImageFilename('foto.jpg')).toBe(true)
    expect(isSupportedImageFilename('foto.JPEG')).toBe(true)
    expect(isSupportedImageFilename('foto.png')).toBe(true)
    expect(isSupportedImageFilename('foto.webp')).toBe(true)
    expect(isSupportedImageFilename('foto.gif')).toBe(true)
    expect(isSupportedImageFilename('foto.bmp')).toBe(true)
    expect(isSupportedImageFilename('foto.tiff')).toBe(true)
    expect(isSupportedImageFilename('foto.tif')).toBe(true)
    expect(isSupportedImageFilename('foto.heic')).toBe(true)
    expect(isSupportedImageFilename('foto.heif')).toBe(true)
    expect(isSupportedImageFilename('foto.avif')).toBe(true)

    // Unsupported / non-images
    expect(isSupportedImageFilename('documento.pdf')).toBe(false)
    expect(isSupportedImageFilename('video.mp4')).toBe(false)
    expect(isSupportedImageFilename('script.js')).toBe(false)
    expect(isSupportedImageFilename('')).toBe(false)
  })

  it('identifies supported MIME types correctly', () => {
    expect(isSupportedImageMime('image/jpeg')).toBe(true)
    expect(isSupportedImageMime('image/png')).toBe(true)
    expect(isSupportedImageMime('image/webp')).toBe(true)
    expect(isSupportedImageMime('image/gif')).toBe(true)
    expect(isSupportedImageMime('image/bmp')).toBe(true)
    expect(isSupportedImageMime('image/tiff')).toBe(true)
    expect(isSupportedImageMime('image/heic')).toBe(true)
    expect(isSupportedImageMime('image/heif')).toBe(true)
    expect(isSupportedImageMime('image/avif')).toBe(true)

    // Case and params insensitive
    expect(isSupportedImageMime('IMAGE/JPEG; charset=utf-8')).toBe(true)

    // Unsupported
    expect(isSupportedImageMime('application/pdf')).toBe(false)
    expect(isSupportedImageMime('video/mp4')).toBe(false)
    expect(isSupportedImageMime(null)).toBe(false)
  })

  it('normalizes a standard JPEG image into a valid JPEG <= 5MB', async () => {
    const rawJpeg = await sharp({
      create: { width: 500, height: 400, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer()

    const result = await normalizePropertyImage(rawJpeg)

    expect(result.contentType).toBe('image/jpeg')
    expect(result.format).toBe('jpeg')
    expect(result.width).toBe(500)
    expect(result.height).toBe(400)
    expect(result.fileSize).toBeLessThanOrEqual(META_WHATSAPP_IMAGE_MAX_BYTES)
    expect(result.fileSize).toBe(result.buffer.length)
  })

  it('normalizes a PNG image preserving transparency when small', async () => {
    const rawPng = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer()

    const result = await normalizePropertyImage(rawPng)

    expect(result.contentType).toBe('image/png')
    expect(result.format).toBe('png')
    expect(result.width).toBe(200)
    expect(result.height).toBe(200)
    expect(result.fileSize).toBeLessThanOrEqual(META_WHATSAPP_IMAGE_MAX_BYTES)
  })

  it('normalizes WEBP, TIFF, and GIF images into Meta WhatsApp Cloud API compliant formats', async () => {
    // WEBP
    const rawWebp = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .webp()
      .toBuffer()

    const webpRes = await normalizePropertyImage(rawWebp)
    expect(webpRes.contentType).toBe('image/jpeg')
    expect(webpRes.fileSize).toBeLessThanOrEqual(META_WHATSAPP_IMAGE_MAX_BYTES)

    // TIFF
    const rawTiff = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .tiff()
      .toBuffer()

    const tiffRes = await normalizePropertyImage(rawTiff)
    expect(tiffRes.contentType).toBe('image/jpeg')
    expect(tiffRes.fileSize).toBeLessThanOrEqual(META_WHATSAPP_IMAGE_MAX_BYTES)

    // GIF
    const rawGif = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 255, g: 255, b: 0 } },
    })
      .gif()
      .toBuffer()

    const gifRes = await normalizePropertyImage(rawGif)
    expect(gifRes.contentType).toBe('image/jpeg')
    expect(gifRes.fileSize).toBeLessThanOrEqual(META_WHATSAPP_IMAGE_MAX_BYTES)
  })

  it('compresses an oversized image to be strictly <= maxBytes (5MB)', async () => {
    // Create a large 4K image with complex noise/patterns
    const rawLarge = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 120, g: 80, b: 40 } },
    })
      .png({ compressionLevel: 0 }) // uncompressed, large
      .toBuffer()

    const result = await normalizePropertyImage(rawLarge, { maxBytes: 100 * 1024 }) // Test strict 100KB limit

    expect(result.fileSize).toBeLessThanOrEqual(100 * 1024)
    expect(result.contentType).toBe('image/jpeg')
  })

  it('rejects corrupted or empty buffers', async () => {
    const emptyBuf = Buffer.alloc(0)
    await expect(normalizePropertyImage(emptyBuf)).rejects.toThrow('vazio ou corrompido')

    const corruptBuf = Buffer.from('not an image at all, just plain text')
    await expect(normalizePropertyImage(corruptBuf)).rejects.toThrow('não reconhecido ou arquivo inválido')
  })
})
