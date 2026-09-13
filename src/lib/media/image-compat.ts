export function isHeicFile(file: { name?: string; type?: string }): boolean {
  const ext = file.name?.split('.').pop()?.toLowerCase();
  const type = file.type?.toLowerCase().trim();
  return (
    type === 'image/heic' ||
    type === 'image/heif' ||
    ext === 'heic' ||
    ext === 'heif'
  );
}

export function isWebpFile(file: { name?: string; type?: string }): boolean {
  const ext = file.name?.split('.').pop()?.toLowerCase();
  const type = file.type?.toLowerCase().trim();
  return type === 'image/webp' || ext === 'webp';
}

export function shouldNormalizeImage(file: { name?: string; type?: string; size: number }): boolean {
  if (isHeicFile(file)) return true;
  if (isWebpFile(file)) return true;
  if (file.size > 5 * 1024 * 1024) return true;
  return false;
}

export interface NormalizeImageForUploadResult {
  file: File;
  originalKey?: string;
  isNormalized: boolean;
}

/**
 * Validates an image file for upload:
 * - HEIC/HEIF / WebP -> handled by direct R2 upload + server-side async normalization
 * - Standard JPEG / PNG <= 5MB -> preserved as original without unnecessary canvas re-encoding
 */
export async function normalizeImageForUpload(
  file: File,
): Promise<NormalizeImageForUploadResult> {
  // Preserve original file directly without client-side canvas re-encoding
  // (avoids inflating bytes and wasting mobile CPU/battery)
  return {
    file,
    isNormalized: false,
  };
}
