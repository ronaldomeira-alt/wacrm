import { describe, expect, it } from 'vitest';
import { extractTextFromPdf } from './pdf-extract';

describe('extractTextFromPdf', () => {
  it('returns null for empty buffer', async () => {
    const res = await extractTextFromPdf(Buffer.from([]));
    expect(res).toBeNull();
  });

  it('returns null for invalid non-pdf buffer', async () => {
    const res = await extractTextFromPdf(Buffer.from('not a pdf'));
    expect(res).toBeNull();
  });
});
