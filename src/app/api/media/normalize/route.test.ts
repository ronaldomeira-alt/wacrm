import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import sharp from 'sharp';

let callerRole = 'agent';
const insertedRows: Array<Record<string, unknown>> = [];

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        const b: Record<string, unknown> = {};
        const chain = () => b;
        b.select = vi.fn(chain);
        b.eq = vi.fn(chain);
        b.maybeSingle = vi.fn(async () => ({
          data: { account_id: 'acct-A', account_role: callerRole },
          error: null,
        }));
        return b;
      }
      if (table === 'accounts') {
        const b: Record<string, unknown> = {};
        const chain = () => b;
        b.select = vi.fn(chain);
        b.eq = vi.fn(chain);
        b.maybeSingle = vi.fn(async () => ({ data: { id: 'acct-A', name: 'Acme' }, error: null }));
        return b;
      }
      if (table === 'media_objects') {
        const b: Record<string, unknown> = {};
        b.insert = vi.fn((row: Record<string, unknown>) => {
          insertedRows.push(row);
          return { then: (resolve: (v: unknown) => unknown) => resolve({ error: null }) };
        });
        return b;
      }
      throw new Error('Unexpected table: ' + table);
    }),
  })),
}));

vi.mock('@/lib/storage/r2-client', () => ({
  getR2Client: vi.fn(() => ({
    send: vi.fn(async () => ({})),
  })),
  getR2Bucket: vi.fn(() => 'wacrm-media'),
}));

import { POST } from './route';

describe('POST /api/media/normalize', () => {
  beforeEach(() => {
    insertedRows.length = 0;
    callerRole = 'agent';
    __resetRateLimitForTests();
    vi.clearAllMocks();
  });

  it('rejects callers with insufficient role', async () => {
    callerRole = 'user';
    const form = new FormData();
    form.append('file', new Blob(['fake'], { type: 'image/jpeg' }));

    const res = await POST(new Request('http://localhost/api/media/normalize', {
      method: 'POST',
      body: form,
    }));

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('rejects missing file', async () => {
    const form = new FormData();
    const res = await POST(new Request('http://localhost/api/media/normalize', {
      method: 'POST',
      body: form,
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Arquivo ausente');
  });

  it('normalizes a JPEG image and returns image/jpeg buffer', async () => {
    const rawJpeg = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 50, g: 100, b: 150 } },
    })
      .jpeg()
      .toBuffer();

    const form = new FormData();
    form.append('file', new Blob([rawJpeg], { type: 'image/jpeg' }), 'test.jpg');

    const res = await POST(new Request('http://localhost/api/media/normalize', {
      method: 'POST',
      body: form,
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Image-Width')).toBe('200');
    expect(res.headers.get('X-Image-Height')).toBe('150');

    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it('normalizes a WebP image to JPEG', async () => {
    const rawWebp = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 0 } },
    })
      .webp()
      .toBuffer();

    const form = new FormData();
    form.append('file', new Blob([rawWebp], { type: 'image/webp' }), 'test.webp');

    const res = await POST(new Request('http://localhost/api/media/normalize', {
      method: 'POST',
      body: form,
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });
});
