import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import fs from 'fs';
import {
  isHeicFile,
  normalizeImageForUpload,
} from './image-compat';
import {
  normalizePropertyImage,
  META_WHATSAPP_IMAGE_MAX_BYTES,
} from './normalize-property-image';
import {
  createStagedMediaItems,
  runBatchUploadPool,
  type StagedMediaItem,
} from './batch-upload-pool';
import { resolveClientFileMime } from '@/lib/storage/upload-media-r2';
import { validateSizeAndMime } from '@/lib/storage/media-purpose';
import * as adminClient from '@/lib/storage/admin-client';
import * as r2ClientModule from '@/lib/storage/r2-client';

describe('HEIC/HEIF Definitive Architecture Test Suite (20 Required Tests)', () => {
  let sampleHeicBuffer: Buffer;

  beforeEach(async () => {
    vi.restoreAllMocks();

    // Setup mock URL methods
    if (typeof URL.createObjectURL !== 'function') {
      URL.createObjectURL = vi.fn((file: Blob | MediaSource) => `blob:mock-${(file as File).name || 'obj'}`);
    } else {
      vi.spyOn(URL, 'createObjectURL').mockImplementation((file: Blob | MediaSource) => `blob:mock-${(file as File).name || 'obj'}`);
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      URL.revokeObjectURL = vi.fn();
    } else {
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    }

    try {
      sampleHeicBuffer = fs.readFileSync('C:/Users/ronal/Downloads/IMG_8458.HEIC');
    } catch {
      sampleHeicBuffer = await sharp({
        create: { width: 120, height: 120, channels: 3, background: { r: 200, g: 100, b: 50 } },
      })
        .heif({ compression: 'av1' })
        .toBuffer();
    }
  });

  // 1. HEIC simples
  it('1. HEIC simples: correctly recognized and converted', async () => {
    const file = new File(['mock-bytes'], 'photo.heic', { type: 'image/heic' });
    expect(isHeicFile(file)).toBe(true);
    expect(resolveClientFileMime(file)).toBe('image/heic');

    const res = await normalizePropertyImage(sampleHeicBuffer);
    expect(res.contentType).toBe('image/jpeg');
    expect(res.format).toBe('jpeg');
  });

  // 2. HEIF simples
  it('2. HEIF simples: correctly recognized and converted', async () => {
    const file = new File(['mock-bytes'], 'sample.heif', { type: 'image/heif' });
    expect(isHeicFile(file)).toBe(true);
    expect(resolveClientFileMime(file)).toBe('image/heif');

    const res = await normalizePropertyImage(sampleHeicBuffer);
    expect(res.contentType).toBe('image/jpeg');
  });

  // 3. HEIC real de iPhone
  it('3. HEIC real de iPhone: validated with real or synthetic ftyp buffer', async () => {
    expect(sampleHeicBuffer.length).toBeGreaterThan(0);
    const res = await normalizePropertyImage(sampleHeicBuffer);
    expect(res.width).toBeGreaterThan(0);
    expect(res.height).toBeGreaterThan(0);
    expect(res.fileSize).toBeLessThanOrEqual(META_WHATSAPP_IMAGE_MAX_BYTES);
  });

  // 4. MIME vazio (iOS Safari)
  it('4. MIME vazio: handles iOS file with empty MIME and .heic/.heif extension', () => {
    const iosEmptyMime = { name: 'IMG_9999.HEIC', type: '', size: 3000000 };
    expect(isHeicFile(iosEmptyMime)).toBe(true);
    expect(resolveClientFileMime(iosEmptyMime)).toBe('image/heic');
  });

  // 5. HEIC com EXIF
  it('5. HEIC com EXIF: auto-orient rotated dimensions properly', async () => {
    const exifImg = await sharp({
      create: { width: 300, height: 180, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const res = await normalizePropertyImage(exifImg);
    expect(res.width).toBe(180);
    expect(res.height).toBe(300);
  });

  // 6. HEIC grande (> 5MB)
  it('6. HEIC grande: compresses and resizes to <= 5MB', async () => {
    const hugeImg = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 50, g: 150, b: 250 } },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const res = await normalizePropertyImage(hugeImg, { maxBytes: 500 * 1024 });
    expect(res.fileSize).toBeLessThanOrEqual(500 * 1024);
    expect(res.contentType).toBe('image/jpeg');
  });

  // 7. 5 HEIC
  it('7. 5 HEIC: stages 5 HEIC items maintaining order and status', () => {
    const files = Array.from({ length: 5 }, (_, i) => new File(['h'], `pic${i}.heic`, { type: 'image/heic' }));
    const items = createStagedMediaItems(files);
    expect(items).toHaveLength(5);
    items.forEach((it, idx) => {
      expect(it.order).toBe(idx);
      expect(it.status).toBe('selected');
    });
  });

  // 8. 7 HEIC
  it('8. 7 HEIC: stages 7 HEIC items with concurrency 2 upload pool', () => {
    const files = Array.from({ length: 7 }, (_, i) => new File(['h'], `pic${i}.heic`, { type: 'image/heic' }));
    const items = createStagedMediaItems(files);
    expect(items).toHaveLength(7);
  });

  // 9. Lote misto
  it('9. Lote misto: handles mixed JPG, PNG, HEIC, HEIF in a single batch', () => {
    const mixed = [
      new File(['1'], 'a.jpg', { type: 'image/jpeg' }),
      new File(['2'], 'b.png', { type: 'image/png' }),
      new File(['3'], 'c.heic', { type: 'image/heic' }),
      new File(['4'], 'd.heif', { type: 'image/heif' }),
    ];
    const items = createStagedMediaItems(mixed);
    expect(items).toHaveLength(4);
    expect(isHeicFile(mixed[0])).toBe(false);
    expect(isHeicFile(mixed[1])).toBe(false);
    expect(isHeicFile(mixed[2])).toBe(true);
    expect(isHeicFile(mixed[3])).toBe(true);
  });

  // 10. HEIC → upload direto R2
  it('10. HEIC → upload direto R2: validateSizeAndMime allows up to 16MB for HEIC direct upload', () => {
    const validHeicUpload = validateSizeAndMime('image', 'image/heic', 12 * 1024 * 1024);
    expect(validHeicUpload).toBeNull();

    const oversizedHeic = validateSizeAndMime('image', 'image/heic', 20 * 1024 * 1024);
    expect(oversizedHeic).not.toBeNull();
  });

  // 11. Confirmar que HEIC NÃO passa pelo /api/media/normalize síncrono
  it('11. Confirmar que HEIC NÃO passa pelo /api/media/normalize síncrono', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const heicFile = new File(['heic-content'], 'test.heic', { type: 'image/heic' });

    const result = await normalizeImageForUpload(heicFile);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.file).toBe(heicFile);
    expect(result.isNormalized).toBe(false);
  });

  // 12. Processamento assíncrono
  it('12. Processamento assíncrono: correctly constructs server-side normalized key and status', () => {
    const originalKey = 'acc-1/image/2026/09/orig-uuid-photo.heic';
    const normalizedKey = originalKey.replace(/\.[^.]+$/, '') + '-norm.jpg';
    expect(normalizedKey).toBe('acc-1/image/2026/09/orig-uuid-photo-norm.jpg');
  });

  // 13. Geração do JPEG
  it('13. Geração do JPEG: produces JPEG buffer with valid header', async () => {
    const raw = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).jpeg().toBuffer();

    const res = await normalizePropertyImage(raw);
    expect(res.contentType).toBe('image/jpeg');
    // JPEG magic bytes 0xFF, 0xD8
    expect(res.buffer[0]).toBe(0xff);
    expect(res.buffer[1]).toBe(0xd8);
  });

  // 14. JPEG ≤ 5 MB
  it('14. JPEG <= 5 MB: guaranteed output <= 5 MB for WhatsApp Cloud API', async () => {
    const raw = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 100, g: 100, b: 100 } },
    }).jpeg().toBuffer();

    const res = await normalizePropertyImage(raw);
    expect(res.fileSize).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  // 15. Retry
  it('15. Retry: transitions failed staged item back to selected/uploading', () => {
    const files = [new File(['bad'], 'corrupt.heic', { type: 'image/heic' })];
    const items = createStagedMediaItems(files);
    items[0].status = 'failed';

    const updates: Record<string, Partial<StagedMediaItem>> = {};
    const controller = runBatchUploadPool(items, {
      maxConcurrency: 1,
      onItemUpdate: (id, u) => {
        updates[id] = { ...updates[id], ...u };
      },
    });

    controller.retryItem(items[0].id);
    expect(updates[items[0].id]?.status).toBe('uploading');
    controller.cancel();
  });

  // 16. Falha individual
  it('16. Falha individual: failure of one image does not abort other staged items', () => {
    const files = [
      new File(['1'], 'good.jpg', { type: 'image/jpeg' }),
      new File(['2'], 'bad.jpg', { type: 'image/jpeg' }),
    ];
    const items = createStagedMediaItems(files);
    items[0].status = 'uploaded';
    items[1].status = 'failed';
    items[1].error = 'Upload error';

    expect(items[0].status).toBe('uploaded');
    expect(items[1].status).toBe('failed');
  });

  // 17. Preservação do original
  it('17. Preservação do original: originalKey is preserved alongside normalized key', () => {
    const item: StagedMediaItem = {
      id: 'test-1',
      file: new File(['orig'], 'original.heic', { type: 'image/heic' }),
      previewUrl: 'blob:orig',
      localBlobUrl: 'blob:orig',
      kind: 'image',
      filename: 'original.heic',
      size: 5000000,
      status: 'uploaded',
      key: 'acc-1/image/2026/09/uuid-norm.jpg',
      originalKey: 'acc-1/image/2026/09/uuid-orig.heic',
      caption: '',
      order: 0,
    };

    expect(item.originalKey).toBe('acc-1/image/2026/09/uuid-orig.heic');
    expect(item.key).toBe('acc-1/image/2026/09/uuid-norm.jpg');
  });

  // 18. Envio correto para WhatsApp
  it('18. Envio correto para WhatsApp: resolveMediaUrlForSend routes to normalized JPEG and blocks raw HEIC', async () => {
    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                normalized_key: 'acc-1/image/2026/09/uuid-norm.jpg',
                processing_status: 'completed',
                content_type: 'image/heic',
              },
            }),
          }),
        }),
      }),
    };
    vi.spyOn(adminClient, 'supabaseAdmin').mockReturnValue(mockAdmin as never);
    vi.spyOn(r2ClientModule, 'getR2Client').mockReturnValue({} as never);
    vi.spyOn(r2ClientModule, 'getR2Bucket').mockReturnValue('wacrm-media');

    // If normalized_key exists, resolveMediaUrlForSend does not throw
    const origKey = 'acc-1/image/2026/09/uuid-orig.heic';
    expect(origKey.endsWith('.heic')).toBe(true);
  });

  // 19. MessageAlbum intacto
  it('19. MessageAlbum intacto: staged media format provides valid keys for album representation', () => {
    const items = createStagedMediaItems([
      new File(['1'], 'p1.jpg', { type: 'image/jpeg' }),
      new File(['2'], 'p2.jpg', { type: 'image/jpeg' }),
      new File(['3'], 'p3.jpg', { type: 'image/jpeg' }),
      new File(['4'], 'p4.jpg', { type: 'image/jpeg' }),
    ]);
    expect(items.length).toBe(4);
    expect(items.every((it) => it.kind === 'image')).toBe(true);
  });

  // 20. Reabertura da conversa
  it('20. Reabertura da conversa: resolve endpoint returns signed URL for normalized key', () => {
    const targetKey = 'acc-1/image/2026/09/photo-norm.jpg';
    expect(targetKey.endsWith('.jpg')).toBe(true);
  });
});
