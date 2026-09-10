import { logError } from '@/lib/observability/log';

export interface ExtractedPdf {
  pageCount: number;
  text: string;
  pages: { pageNumber: number; text: string }[];
}

/**
 * Extract plain text from a PDF Buffer server-side using pdfjs-dist.
 * Preserves page structure, trims whitespace, and cleans up basic noise.
 * Returns null if the buffer is empty or not a valid PDF.
 */
export async function extractTextFromPdf(pdfBuffer: Buffer): Promise<ExtractedPdf | null> {
  if (!pdfBuffer || pdfBuffer.length === 0) return null;

  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      useSystemFonts: true,
      disableFontFace: true,
    });

    const doc = await loadingTask.promise;
    const numPages = doc.numPages;
    const pages: { pageNumber: number; text: string }[] = [];
    const fullTextParts: string[] = [];

    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      
      const pageText = textContent.items
        .map((item) => {
          if ('str' in item && typeof (item as { str?: unknown }).str === 'string') {
            return (item as { str: string }).str;
          }
          return '';
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (pageText) {
        pages.push({ pageNumber: i, text: pageText });
        fullTextParts.push(`[Página ${i}]\n${pageText}`);
      }
    }

    const fullText = fullTextParts.join('\n\n');

    return {
      pageCount: numPages,
      text: fullText,
      pages,
    };
  } catch (err) {
    logError('pdf_extract.failed', err);
    return null;
  }
}
