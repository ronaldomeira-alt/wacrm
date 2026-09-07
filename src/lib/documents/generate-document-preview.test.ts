import { describe, it, expect } from "vitest";
import { looksLikePdf } from "./generate-document-preview";

describe("looksLikePdf", () => {
  it("detects application/pdf mime type", () => {
    expect(looksLikePdf("application/pdf", null)).toBe(true);
    expect(looksLikePdf("application/pdf", "file.txt")).toBe(true);
  });

  it("detects .pdf extensions case-insensitively", () => {
    expect(looksLikePdf(null, "document.pdf")).toBe(true);
    expect(looksLikePdf(null, "DOCUMENT.PDF")).toBe(true);
    expect(looksLikePdf(null, "report.Pdf")).toBe(true);
  });

  it("rejects non-pdf files", () => {
    expect(looksLikePdf("image/png", "image.png")).toBe(false);
    expect(looksLikePdf("application/vnd.ms-excel", "sheet.xlsx")).toBe(false);
    expect(looksLikePdf(null, "archive.zip")).toBe(false);
    expect(looksLikePdf(null, null)).toBe(false);
  });
});
