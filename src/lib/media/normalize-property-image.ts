import sharp, { type Sharp } from 'sharp'
import decodeHeic from 'heic-decode'

export const META_WHATSAPP_IMAGE_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
export const MAX_UPLOAD_INPUT_BYTES = 16 * 1024 * 1024 // 16 MB

export interface NormalizeImageResult {
  buffer: Buffer
  blob: Blob
  contentType: 'image/jpeg' | 'image/png'
  format: 'jpeg' | 'png'
  fileSize: number
  width: number
  height: number
  originalFormat?: string
}

export interface NormalizeImageOptions {
  maxBytes?: number
  quality?: number
  maxWidth?: number
  maxHeight?: number
}

// Supported input formats (extensions and mime types)
export const SUPPORTED_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
  'avif',
] as const

export const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/x-ms-bmp',
  'image/tiff',
  'image/x-tiff',
  'image/heic',
  'image/heif',
  'image/avif',
] as const

/**
 * Checks if a filename has a supported image extension.
 */
export function isSupportedImageFilename(filename: string): boolean {
  if (!filename || typeof filename !== 'string') return false
  const match = filename.match(/\.([^.]+)$/)
  if (!match) return false
  const ext = match[1].toLowerCase()
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * Checks if a MIME type is in the supported image list.
 */
export function isSupportedImageMime(mimeType?: string | null): boolean {
  if (!mimeType) return false
  const cleanMime = mimeType.toLowerCase().split(';')[0].trim()
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(cleanMime)
}

/**
 * Converts various buffer/typed array types to a standard clean Node Buffer.
 */
function toBuffer(input: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
}

/**
 * Detects if a buffer contains a HEIF/HEIC image by inspecting the ISO BMFF ftyp box.
 */
export function isHeicBuffer(buffer: Buffer | Uint8Array): boolean {
  if (buffer.length < 12) return false
  // Check 'ftyp' at offset 4
  const isFtyp =
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  if (!isFtyp) return false

  const brandMajor = String.fromCharCode(
    buffer[8],
    buffer[9],
    buffer[10],
    buffer[11],
  ).toLowerCase().trim()

  // AVIF is natively handled by sharp, not heic-decode
  if (brandMajor === 'avif' || brandMajor === 'avis') return false

  const heicBrands = ['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']
  return heicBrands.includes(brandMajor)
}

/**
 * Normalizes any supported input image to a Meta WhatsApp Cloud API compliant
 * JPEG (or PNG if preserving transparency) image <= 5MB.
 *
 * Applies:
 * - EXIF orientation correction (sharp.rotate())
 * - Decoding of HEIC, HEIF, TIFF, WEBP, GIF, BMP, AVIF, PNG, JPEG
 * - Resizing if dimensions are huge (> 4096px)
 * - Compression & quality reduction loop if file exceeds maxBytes (default 5MB)
 * - Sanitization (strips malicious payloads/scripts embedded in raw buffers)
 */
export async function normalizePropertyImage(
  input: Buffer | Uint8Array | ArrayBuffer,
  options: NormalizeImageOptions = {},
): Promise<NormalizeImageResult> {
  const maxBytes = options.maxBytes ?? META_WHATSAPP_IMAGE_MAX_BYTES
  const initialQuality = options.quality ?? 85
  const maxDimension = Math.max(options.maxWidth ?? 3840, options.maxHeight ?? 3840)

  const rawBuffer = toBuffer(input)

  if (rawBuffer.length === 0) {
    throw new Error('Arquivo de imagem vazio ou corrompido.')
  }

  let pipeline: Sharp
  let metadata: { format?: string; width?: number; height?: number; hasAlpha?: boolean }
  let originalFormat = 'jpeg'
  let decodedHeicRaw: { data: Uint8ClampedArray | Uint8Array; width: number; height: number } | null = null

  if (isHeicBuffer(rawBuffer)) {
    try {
      const { data, width, height } = await decodeHeic({ buffer: rawBuffer })
      decodedHeicRaw = { data, width, height }
      pipeline = sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
      metadata = { format: 'heif', width, height, hasAlpha: false }
      originalFormat = 'heif'
    } catch (err) {
      throw new Error(
        `Formato de imagem não reconhecido ou arquivo inválido: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    pipeline = sharp(rawBuffer, { unlimited: true })
    try {
      metadata = await pipeline.metadata()
    } catch (err) {
      throw new Error(
        `Formato de imagem não reconhecido ou arquivo inválido: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!metadata.format) {
      throw new Error('Não foi possível identificar o formato da imagem.')
    }

    originalFormat = metadata.format
    // Auto-rotate according to EXIF orientation
    pipeline = pipeline.rotate()
  }

  // Determine target format:
  // Meta Cloud API supports image/jpeg and image/png.
  // We use PNG only if the original image has alpha transparency and is <= maxBytes.
  // In almost all property photo cases, JPEG provides far better compression and ensures <= 5MB.
  const hasAlpha = Boolean(metadata.hasAlpha)
  const preferPng = hasAlpha && (metadata.format === 'png' || metadata.format === 'webp')

  // Limit maximum dimension to 3840px (4K) to avoid giant memory usage while maintaining crisp quality
  if (
    metadata.width &&
    metadata.height &&
    (metadata.width > maxDimension || metadata.height > maxDimension)
  ) {
    pipeline = pipeline.resize({
      width: metadata.width > metadata.height ? maxDimension : undefined,
      height: metadata.height >= metadata.width ? maxDimension : undefined,
      fit: 'inside',
      withoutEnlargement: true,
    })
  }

  // First attempt: try producing the target format with high quality
  let currentBuffer: Buffer
  let currentFormat: 'jpeg' | 'png' = 'jpeg'

  if (preferPng) {
    try {
      currentBuffer = await pipeline
        .clone()
        .png({ compressionLevel: 9, effort: 7 })
        .toBuffer()
      currentFormat = 'png'
    } catch {
      // Fallback to jpeg if PNG fails
      currentBuffer = await pipeline
        .clone()
        .jpeg({ quality: initialQuality, mozjpeg: true })
        .toBuffer()
      currentFormat = 'jpeg'
    }
  } else {
    currentBuffer = await pipeline
      .clone()
      .jpeg({ quality: initialQuality, mozjpeg: true })
      .toBuffer()
    currentFormat = 'jpeg'
  }

  // If buffer exceeds maxBytes, compress down iteratively with JPEG
  if (currentBuffer.length > maxBytes) {
    currentFormat = 'jpeg'
    const qualitySteps = [80, 70, 60, 50, 40, 30]
    let resizedDimension = Math.min(maxDimension, 2560)

    for (const q of qualitySteps) {
      if (decodedHeicRaw) {
        currentBuffer = await sharp(Buffer.from(decodedHeicRaw.data), {
          raw: {
            width: decodedHeicRaw.width,
            height: decodedHeicRaw.height,
            channels: 4,
          },
        })
          .resize({
            width: resizedDimension,
            height: resizedDimension,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: q, mozjpeg: true })
          .toBuffer()
      } else {
        currentBuffer = await sharp(rawBuffer, { unlimited: true })
          .rotate()
          .resize({
            width: resizedDimension,
            height: resizedDimension,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: q, mozjpeg: true })
          .toBuffer()
      }

      if (currentBuffer.length <= maxBytes) {
        break
      }

      // If still too large, reduce dimensions further
      if (resizedDimension > 1600) {
        resizedDimension = 1600
      } else if (resizedDimension > 1200) {
        resizedDimension = 1200
      }
    }

    if (currentBuffer.length > maxBytes) {
      throw new Error(
        `Não foi possível comprimir a imagem para menos de ${(maxBytes / (1024 * 1024)).toFixed(0)}MB.`,
      )
    }
  }

  // Final metadata read for accurate width/height
  const finalMeta = await sharp(currentBuffer).metadata()
  const targetContentType = currentFormat === 'png' ? 'image/png' : 'image/jpeg'

  // Construct a brand new detached ArrayBuffer / Uint8Array to eliminate any SharedArrayBuffer / buffer pool slicing issues in fetch/undici
  const cleanArrayBuffer = new ArrayBuffer(currentBuffer.byteLength)
  const cleanUint8 = new Uint8Array(cleanArrayBuffer)
  cleanUint8.set(
    new Uint8Array(
      currentBuffer.buffer,
      currentBuffer.byteOffset,
      currentBuffer.byteLength,
    ),
  )
  const cleanBuffer = Buffer.from(cleanArrayBuffer)
  const cleanBlob = new Blob([cleanUint8], { type: targetContentType })

  return {
    buffer: cleanBuffer,
    blob: cleanBlob,
    contentType: targetContentType,
    format: currentFormat,
    fileSize: cleanBuffer.length,
    width: finalMeta.width ?? 0,
    height: finalMeta.height ?? 0,
    originalFormat,
  }
}
