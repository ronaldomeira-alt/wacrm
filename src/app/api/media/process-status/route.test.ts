import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';
import * as serverNorm from '@/lib/media/server-media-normalization';
import * as accountAuth from '@/lib/auth/account';

describe('POST /api/media/process-status', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unauthenticated requests', async () => {
    vi.spyOn(accountAuth, 'getCurrentAccount').mockRejectedValue(new Error('Unauthorized'));

    const req = new Request('http://localhost/api/media/process-status', {
      method: 'POST',
      body: JSON.stringify({ keys: ['key1'] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
  });

  it('returns statuses for valid keys', async () => {
    vi.spyOn(accountAuth, 'getCurrentAccount').mockResolvedValue({
      supabase: {} as never,
      account: { id: 'acc-1', name: 'Test' } as never,
      accountId: 'acc-1',
      userId: 'user-1',
      role: 'agent',
    });

    vi.spyOn(serverNorm, 'getMediaProcessingStatuses').mockResolvedValue({
      'key1': {
        key: 'key1',
        status: 'completed',
        normalizedKey: 'key1-norm.jpg',
        resolvedUrl: 'https://r2.example.com/key1-norm.jpg',
      },
    });

    const req = new Request('http://localhost/api/media/process-status', {
      method: 'POST',
      body: JSON.stringify({ keys: ['key1'] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.statuses.key1.status).toBe('completed');
    expect(data.statuses.key1.normalizedKey).toBe('key1-norm.jpg');
  });
});
