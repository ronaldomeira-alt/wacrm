import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  sendQualifiedLeadEvent: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  ),
}));

vi.mock('@/lib/whatsapp/meta-capi', () => ({
  sendQualifiedLeadEvent: mocks.sendQualifiedLeadEvent,
}));

import { POST } from './route';

const mockAccountId = 'acc-123';
const mockConvId = 'conv-456';

describe('POST /api/meta-capi/qualify-lead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({
      accountId: mockAccountId,
      supabase: {
        from: vi.fn(),
      },
    });
  });

  it('returns 400 when neither conversationId nor contactId is provided', async () => {
    const req = new Request('http://localhost/api/meta-capi/qualify-lead', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/conversationId ou contactId é obrigatório/);
  });

  it('triggers sendQualifiedLeadEvent and returns 200 on success with conversationId', async () => {
    mocks.sendQualifiedLeadEvent.mockResolvedValue({ sent: true });

    const req = new Request('http://localhost/api/meta-capi/qualify-lead', {
      method: 'POST',
      body: JSON.stringify({ conversationId: mockConvId }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.sent).toBe(true);
    expect(json.conversation_id).toBe(mockConvId);
    expect(mocks.sendQualifiedLeadEvent).toHaveBeenCalledWith(
      expect.anything(),
      mockAccountId,
      mockConvId
    );
  });

  it('returns 422 with friendly message when no_ctwa_clid', async () => {
    mocks.sendQualifiedLeadEvent.mockResolvedValue({
      sent: false,
      reason: 'no_ctwa_clid',
    });

    const req = new Request('http://localhost/api/meta-capi/qualify-lead', {
      method: 'POST',
      body: JSON.stringify({ conversationId: mockConvId }),
    });

    const res = await POST(req);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.reason).toBe('no_ctwa_clid');
    expect(json.error).toMatch(/não possui identificador de clique de anúncio/);
  });

  it('returns 422 when capi_not_configured', async () => {
    mocks.sendQualifiedLeadEvent.mockResolvedValue({
      sent: false,
      reason: 'capi_not_configured',
    });

    const req = new Request('http://localhost/api/meta-capi/qualify-lead', {
      method: 'POST',
      body: JSON.stringify({ conversationId: mockConvId }),
    });

    const res = await POST(req);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.reason).toBe('capi_not_configured');
    expect(json.error).toMatch(/Dataset da Meta Conversions API/);
  });
});
