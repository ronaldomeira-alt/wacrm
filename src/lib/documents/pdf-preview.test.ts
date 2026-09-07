import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { renderPdfPreview } from "./pdf-preview";

describe("renderPdfPreview", () => {
  it("returns null on invalid buffer without throwing", async () => {
    const invalidBuffer = Buffer.from("not-a-valid-pdf");
    const result = await renderPdfPreview(invalidBuffer);
    expect(result).toBeNull();
  });

  it("renders a valid PDF to JPEG thumbnail with correct metadata", async () => {
    const pdfPath = resolve(process.cwd(), "test-small.pdf");
    if (!existsSync(pdfPath)) {
      return;
    }
    const buffer = readFileSync(pdfPath);
    const result = await renderPdfPreview(buffer);

    expect(result).not.toBeNull();
    expect(result?.pageCount).toBeGreaterThan(0);
    expect(result?.contentType).toBe("image/jpeg");
    expect(result?.thumbnail).toBeInstanceOf(Buffer);
    expect(result!.thumbnail.length).toBeGreaterThan(0);

    // Verify JPEG magic bytes: FF D8 FF
    expect(result!.thumbnail[0]).toBe(0xff);
    expect(result!.thumbnail[1]).toBe(0xd8);
    expect(result!.thumbnail[2]).toBe(0xff);
  });

  it("successfully processes large PDFs without NAPI or Turbopack errors", async () => {
    const pdfPath = resolve(process.cwd(), "test-large.pdf");
    if (!existsSync(pdfPath)) {
      return;
    }
    const buffer = readFileSync(pdfPath);
    const result = await renderPdfPreview(buffer);

    expect(result).not.toBeNull();
    expect(result?.pageCount).toBeGreaterThan(0);
    expect(result?.contentType).toBe("image/jpeg");
    expect(result?.thumbnail.length).toBeGreaterThan(0);
    // Ensure the JPEG size is compact (< 400 KB) despite the large PDF (14.7 MB)
    expect(result!.thumbnail.length).toBeLessThan(400 * 1024);
  });
});
