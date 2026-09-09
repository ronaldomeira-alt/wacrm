import { describe, expect, it } from "vitest";
import { hasExifRotation, autoOrientImage } from "./auto-orient-image";

function createMockJpegWithExifOrientation(orientation: number, endian: "LE" | "BE" = "LE"): ArrayBuffer {
  const isLE = endian === "LE";
  const tiffHeader = [
    ...(isLE ? [0x49, 0x49] : [0x4d, 0x4d]), // 'II' or 'MM'
    ...(isLE ? [0x2a, 0x00] : [0x00, 0x2a]), // 42
    ...(isLE ? [0x08, 0x00, 0x00, 0x00] : [0x00, 0x00, 0x00, 0x08]), // offset to IFD0
  ];

  const ifd0 = [
    ...(isLE ? [0x01, 0x00] : [0x00, 0x01]), // 1 entry
    // Tag 0x0112
    ...(isLE ? [0x12, 0x01] : [0x01, 0x12]),
    // Type SHORT (3)
    ...(isLE ? [0x03, 0x00] : [0x00, 0x03]),
    // Count 1
    ...(isLE ? [0x01, 0x00, 0x00, 0x00] : [0x00, 0x00, 0x00, 0x01]),
    // Value (2 bytes left-justified in 4-byte slot per TIFF spec)
    ...(isLE
      ? [orientation & 0xff, (orientation >> 8) & 0xff, 0x00, 0x00]
      : [(orientation >> 8) & 0xff, orientation & 0xff, 0x00, 0x00]),
    // Next IFD offset
    0x00, 0x00, 0x00, 0x00,
  ];

  const exifPayload = [
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    ...tiffHeader,
    ...ifd0,
  ];

  const app1Length = exifPayload.length + 2; // includes 2 bytes for length itself
  const app1 = [
    0xff, 0xe1,
    (app1Length >> 8) & 0xff, app1Length & 0xff,
    ...exifPayload,
  ];

  const jpegBytes = [
    0xff, 0xd8, // SOI
    ...app1,
    0xff, 0xd9, // EOI
  ];

  return new Uint8Array(jpegBytes).buffer as ArrayBuffer;
}

describe("hasExifRotation", () => {
  it("returns false for non-JPEG file types", async () => {
    const png = new File([new Uint8Array([1, 2, 3]).buffer as ArrayBuffer], "test.png", { type: "image/png" });
    expect(await hasExifRotation(png)).toBe(false);

    const mp4 = new File([new Uint8Array([1, 2, 3]).buffer as ArrayBuffer], "test.mp4", { type: "video/mp4" });
    expect(await hasExifRotation(mp4)).toBe(false);
  });

  it("returns false for corrupt or truncated JPEG files", async () => {
    const truncated = new File([new Uint8Array([0xff, 0xd8]).buffer as ArrayBuffer], "trunc.jpg", { type: "image/jpeg" });
    expect(await hasExifRotation(truncated)).toBe(false);

    const randomBytes = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03]).buffer as ArrayBuffer], "random.jpg", {
      type: "image/jpeg",
    });
    expect(await hasExifRotation(randomBytes)).toBe(false);
  });

  it("returns false when JPEG has no EXIF marker", async () => {
    const simpleJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer as ArrayBuffer;
    const file = new File([simpleJpeg], "simple.jpg", { type: "image/jpeg" });
    expect(await hasExifRotation(file)).toBe(false);
  });

  it("returns false for EXIF Orientation = 1 (Normal / standard)", async () => {
    const bytes = createMockJpegWithExifOrientation(1, "LE");
    const file = new File([bytes], "normal-le.jpg", { type: "image/jpeg" });
    expect(await hasExifRotation(file)).toBe(false);

    const bytesBE = createMockJpegWithExifOrientation(1, "BE");
    const fileBE = new File([bytesBE], "normal-be.jpg", { type: "image/jpeg" });
    expect(await hasExifRotation(fileBE)).toBe(false);
  });

  it("returns true for EXIF Orientation = 6 (Rotate 90 CW, portrait smartphone photo)", async () => {
    const bytesLE = createMockJpegWithExifOrientation(6, "LE");
    const fileLE = new File([bytesLE], "phone-portrait-le.jpg", { type: "image/jpeg" });
    expect(await hasExifRotation(fileLE)).toBe(true);

    const bytesBE = createMockJpegWithExifOrientation(6, "BE");
    const fileBE = new File([bytesBE], "phone-portrait-be.jpg", { type: "image/jpeg" });
    expect(await hasExifRotation(fileBE)).toBe(true);
  });

  it("returns true for EXIF Orientation = 3 (180 deg) and 8 (Rotate 270 CW)", async () => {
    const bytes3 = createMockJpegWithExifOrientation(3, "LE");
    expect(await hasExifRotation(new File([bytes3], "upside-down.jpg", { type: "image/jpeg" }))).toBe(true);

    const bytes8 = createMockJpegWithExifOrientation(8, "LE");
    expect(await hasExifRotation(new File([bytes8], "rot-270.jpg", { type: "image/jpeg" }))).toBe(true);
  });
});

describe("autoOrientImage", () => {
  it("returns identical file reference when no rotation is needed", async () => {
    const png = new File([new Uint8Array([1, 2, 3]).buffer as ArrayBuffer], "test.png", { type: "image/png" });
    const result = await autoOrientImage(png);
    expect(result).toBe(png);
  });

  it("returns identical file reference for JPEG with orientation 1", async () => {
    const bytes = createMockJpegWithExifOrientation(1);
    const file = new File([bytes], "normal.jpg", { type: "image/jpeg" });
    const result = await autoOrientImage(file);
    expect(result).toBe(file);
  });
});
