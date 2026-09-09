/**
 * Detects if a JPEG File contains an EXIF Orientation tag other than 1 (Normal).
 * Pure byte-level scanner — zero dependencies, fast (~0.1ms).
 */
export async function hasExifRotation(file: File): Promise<boolean> {
  if (file.type !== "image/jpeg" && file.type !== "image/jpg") {
    return false;
  }
  try {
    const slice = file.slice(0, 128 * 1024);
    const bytes = new Uint8Array(await slice.arrayBuffer());
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;

    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2) break;

      if (marker === 0xe1 && offset + 10 <= bytes.length) {
        const isExif =
          bytes[offset + 4] === 0x45 &&
          bytes[offset + 5] === 0x78 &&
          bytes[offset + 6] === 0x69 &&
          bytes[offset + 7] === 0x66 &&
          bytes[offset + 8] === 0x00 &&
          bytes[offset + 9] === 0x00;

        if (isExif) {
          const tiffOffset = offset + 10;
          if (tiffOffset + 8 > bytes.length) return false;
          const isLittleEndian = bytes[tiffOffset] === 0x49 && bytes[tiffOffset + 1] === 0x49;
          const isBigEndian = bytes[tiffOffset] === 0x4d && bytes[tiffOffset + 1] === 0x4d;
          if (!isLittleEndian && !isBigEndian) return false;

          const readUint16 = (o: number) =>
            isLittleEndian ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1];
          const readUint32 = (o: number) =>
            isLittleEndian
              ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
              : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;

          const firstIfdOffset = readUint32(tiffOffset + 4);
          let ifdOffset = tiffOffset + firstIfdOffset;
          if (ifdOffset + 2 > bytes.length) return false;

          const entriesCount = readUint16(ifdOffset);
          ifdOffset += 2;

          for (let i = 0; i < entriesCount; i++) {
            const entryOffset = ifdOffset + i * 12;
            if (entryOffset + 12 > bytes.length) break;
            const tag = readUint16(entryOffset);
            if (tag === 0x0112) {
              const orientationVal = readUint16(entryOffset + 8);
              return orientationVal > 1;
            }
          }
          return false;
        }
      }
      offset += 2 + length;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Normalizes an image File's orientation so its physical pixel matrix matches
 * its visual orientation. Uses the browser's hardware-accelerated
 * `createImageBitmap({ imageOrientation: "from-image" })`.
 *
 * If the image does NOT have EXIF rotation (or is not a JPEG), returns the original
 * File untouched with zero overhead.
 */
export async function autoOrientImage(file: File): Promise<File> {
  const needsRotation = await hasExifRotation(file);
  if (!needsRotation) {
    return file;
  }

  if (typeof window === "undefined" || typeof createImageBitmap !== "function") {
    return file;
  }

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const width = bitmap.width;
    const height = bitmap.height;

    let blob: Blob | null = null;

    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close();
        return file;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      blob = await canvas.convertToBlob({
        type: file.type || "image/jpeg",
        quality: 0.95,
      });
    } else if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close();
        return file;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, file.type || "image/jpeg", 0.95),
      );
    } else {
      bitmap.close();
      return file;
    }

    if (!blob) return file;

    return new File([blob], file.name, {
      type: file.type || "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    // Non-fatal: if canvas/bitmap fails, proceed with original file
    return file;
  }
}
