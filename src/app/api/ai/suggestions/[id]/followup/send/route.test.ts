import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const mockRequireRole = vi.fn();
const mockGetConversationSessionStatus = vi.fn();
const mockSendMessageToConversation = vi.fn();

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 500 }),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(JSON.stringify({ error: 'Rate limited' }), { status: 429 }),
  RATE_LIMITS: { send: {} },
}));

vi.mock('@/lib/whatsapp/session-window', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp/session-window')>(
    '@/lib/whatsapp/session-window'
  );
  return {
    ...actual,
    getConversationSessionStatus: (...args: unknown[]) =>
      mockGetConversationSessionStatus(...args),
  };
});

vi.mock('@/lib/whatsapp/send-message', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp/send-message')>(
    '@/lib/whatsapp/send-message'
  );
  return {
    ...actual,
    sendMessageToConversation: (...args: unknown[]) => mockSendMessageToConversation(...args),
  };
});

vi.mock('@/lib/match/service', () => ({
  updateMatchStatus: vi.fn().mockResolvedValue(undefined),
}));

function makeDb(opts: {
  templateStatus?: string;
  projectionOperation?: string;
  projectionStatus?: string;
} = {}) {
  const updates: Array<{ table: string; data: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; data: Record<string, unknown> }> = [];

  const templateRow = opts.templateStatus
    ? {
        id: 'tpl-match-1',
        account_id: 'acc-1',
        name: 'match_imovel_personalizado',
        language: 'pt_BR',
        category: 'Marketing',
        status: opts.templateStatus,
        header_type: null,
        header_content: null,
        body_text:
          'Olá, {{1}}! Tudo bem?\n\nEncontrei uma opção de imóvel {{2}} que pode combinar com o que você está procurando.\n\nSeparei os detalhes para você conferir. Depois me conta o que achou!',
        buttons: [
          {
            type: 'URL',
            text: 'Ver imóvel',
            url: 'https://ronaldomeira.com.br/imovel/{{1}}',
            example: 'dev-bd1ac8a946d4bfb0',
          },
        ],
      }
    : null;

  const db = {
    updates,
    inserts,
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        maybeSingle: () => {
          if (table === 'ai_suggestions') {
            return Promise.resolve({
              data: {
                id: 'sugg-1',
                category: 'followup',
                status: 'pending',
                contact_id: 'contact-1',
                conversation_id: 'conv-1',
                payload: {},
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update: (data: Record<string, unknown>) => {
          updates.push({ table, data });
          return chain;
        },
        insert: (data: Record<string, unknown>) => {
          inserts.push({ table, data });
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (val: unknown) => void) => {
          if (table === 'property_match_projections') {
            return resolve({
              data: [
                {
                  property_id: 'p-1',
                  status: opts.projectionStatus ?? 'ativo',
                  operation: opts.projectionOperation ?? 'venda',
                },
              ],
              error: null,
            });
          }
          if (table === 'message_templates') {
            return resolve({
              data: templateRow ? [templateRow] : [],
              error: null,
            });
          }
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };

  return db;
}

describe('POST /api/ai/suggestions/[id]/followup/send — Janela Aberta, Template Exclusivo e Segurança', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('permite selecionar e enviar múltiplos imóveis quando a janela de 24h está aberta e conclui o follow-up', async () => {
    const db = makeDb({ templateStatus: 'APPROVED' });
    mockRequireRole.mockResolvedValue({ supabase: db, accountId: 'acc-1', userId: 'user-1' });
    mockGetConversationSessionStatus.mockResolvedValue({ windowOpen: true, remainingMs: 3600000 });
    mockSendMessageToConversation.mockResolvedValue({ messageId: 'msg-1', whatsappMessageId: 'wamid-1' });

    const req = new Request('http://localhost/api/ai/suggestions/sugg-1/followup/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'free',
        text: 'Oi Luzinete! Separei duas opções no Bessa:\nhttps://ronaldomeira.com.br/imovel/dev-1\nhttps://ronaldomeira.com.br/imovel/dev-2',
        client_ref: 'ref-multi-1',
        selectedProperties: [
          { propertyId: 'p-1', matchId: 'm-1', title: 'Residencial A', operation: 'venda', publicUrl: 'https://ronaldomeira.com.br/imovel/dev-1' },
          { propertyId: 'p-2', matchId: 'm-2', title: 'Residencial B', operation: 'venda', publicUrl: 'https://ronaldomeira.com.br/imovel/dev-2' },
        ],
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'sugg-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.sent_properties).toEqual(['p-1', 'p-2']);

    const doneUpdate = db.updates.find((u) => u.table === 'ai_suggestions');
    expect(doneUpdate?.data.status).toBe('done');
    expect((doneUpdate?.data.payload as Record<string, unknown>).realized_manual).toBe(false);
    expect((doneUpdate?.data.payload as Record<string, unknown>).realized_properties).toHaveLength(2);
  });

  it('bloqueia envio livre com 409 window_expired quando a janela encerrou durante a preparação (sem concluir)', async () => {
    const db = makeDb({ templateStatus: 'APPROVED' });
    mockRequireRole.mockResolvedValue({ supabase: db, accountId: 'acc-1', userId: 'user-1' });
    mockGetConversationSessionStatus.mockResolvedValue({ windowOpen: false, remainingMs: 0 });

    const req = new Request('http://localhost/api/ai/suggestions/sugg-1/followup/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'free',
        text: 'Oi Luzinete!',
        selectedProperties: [
          { propertyId: 'p-1', title: 'Residencial A', operation: 'venda', publicUrl: 'https://ronaldomeira.com.br/imovel/dev-1' },
        ],
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'sugg-1' }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('window_expired');
    expect(mockSendMessageToConversation).not.toHaveBeenCalled();
    expect(db.updates.filter((u) => u.table === 'ai_suggestions')).toHaveLength(0);
  });

  it('usa exclusivamente o template match_imovel_personalizado fora da janela com exatamente 1 imóvel e preenche variáveis + botão URL', async () => {
    const db = makeDb({ templateStatus: 'APPROVED' });
    mockRequireRole.mockResolvedValue({ supabase: db, accountId: 'acc-1', userId: 'user-1' });
    mockGetConversationSessionStatus.mockResolvedValue({ windowOpen: false, remainingMs: 0 });
    mockSendMessageToConversation.mockResolvedValue({ messageId: 'msg-tpl-1', whatsappMessageId: 'wamid-tpl-1' });

    const req = new Request('http://localhost/api/ai/suggestions/sugg-1/followup/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'template',
        template_name: 'match_imovel_personalizado',
        body_values: ['Luzinete', 'de 2 quartos no bairro Bessa (Mahal)'],
        selectedProperties: [
          { propertyId: 'p-1', matchId: 'm-1', title: 'Mahal', operation: 'venda', publicUrl: 'https://ronaldomeira.com.br/imovel/dev-bd1ac8a946d4bfb0' },
        ],
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'sugg-1' }) });
    expect(res.status).toBe(200);
    expect(mockSendMessageToConversation).toHaveBeenCalledWith(
      db,
      'acc-1',
      expect.objectContaining({
        messageType: 'template',
        contentText: expect.stringContaining('Luzinete'),
        templateName: 'match_imovel_personalizado',
        templateLanguage: 'pt_BR',
        templateMessageParams: {
          body: ['Luzinete', 'de 2 quartos no bairro Bessa (Mahal)'],
          buttonParams: { 0: 'dev-bd1ac8a946d4bfb0' },
        },
        templateProperty: {
          id: 'p-1',
          title: 'Mahal',
          public_url: 'https://ronaldomeira.com.br/imovel/dev-bd1ac8a946d4bfb0',
          match_id: 'm-1',
        },
      })
    );
  });

  it('bloqueia qualquer outro template (ex.: recomendacao_personalizada) e bloqueia quando match_imovel_personalizado não está APPROVED', async () => {
    const dbPending = makeDb({ templateStatus: 'PENDING' });
    mockRequireRole.mockResolvedValue({ supabase: dbPending, accountId: 'acc-1', userId: 'user-1' });
    mockGetConversationSessionStatus.mockResolvedValue({ windowOpen: false, remainingMs: 0 });

    const wrongTplReq = new Request('http://localhost/api/ai/suggestions/sugg-1/followup/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'template',
        template_name: 'recomendacao_personalizada',
        body_values: ['Luzinete', 'Bessa'],
        selectedProperties: [
          { propertyId: 'p-1', title: 'Mahal', operation: 'venda', publicUrl: 'https://ronaldomeira.com.br/imovel/dev-1' },
        ],
      }),
    });
    const wrongRes = await POST(wrongTplReq, { params: Promise.resolve({ id: 'sugg-1' }) });
    expect(wrongRes.status).toBe(422);

    const pendingTplReq = new Request('http://localhost/api/ai/suggestions/sugg-1/followup/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'template',
        template_name: 'match_imovel_personalizado',
        body_values: ['Luzinete', 'Bessa'],
        selectedProperties: [
          { propertyId: 'p-1', title: 'Mahal', operation: 'venda', publicUrl: 'https://ronaldomeira.com.br/imovel/dev-1' },
        ],
      }),
    });
    const pendingRes = await POST(pendingTplReq, { params: Promise.resolve({ id: 'sugg-1' }) });
    expect(pendingRes.status).toBe(422);
    expect((await pendingRes.json()).code).toBe('template_not_approved');
    expect(mockSendMessageToConversation).not.toHaveBeenCalled();
  });

  it('bloqueia envio de múltiplos imóveis quando a janela está encerrada e bloqueia imóveis de locação', async () => {
    const db = makeDb({ templateStatus: 'APPROVED' });
    mockRequireRole.mockResolvedValue({ supabase: db, accountId: 'acc-1', userId: 'user-1' });
    mockGetConversationSessionStatus.mockResolvedValue({ windowOpen: false, remainingMs: 0 });

    const multiClosedReq = new Request('http://localhost/api/ai/suggestions/sugg-1/followup/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'template',
        template_name: 'match_imovel_personalizado',
        body_values: ['Luzinete', 'Bessa'],
        selectedProperties: [
          { propertyId: 'p-1', title: 'A', operation: 'venda', publicUrl: 'https://ronaldomeira.com.br/imovel/dev-1' },
          { propertyId: 'p-2', title: 'B', operation: 'venda', publicUrl: 'https://ronaldomeira.com.br/imovel/dev-2' },
        ],
      }),
    });
    const multiClosedRes = await POST(multiClosedReq, { params: Promise.resolve({ id: 'sugg-1' }) });
    expect(multiClosedRes.status).toBe(422);

    const rentalReq = new Request('http://localhost/api/ai/suggestions/sugg-1/followup/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'free',
        text: 'Oi!',
        selectedProperties: [
          { propertyId: 'p-1', title: 'Flat Aluguel', operation: 'locacao', publicUrl: 'https://ronaldomeira.com.br/imovel/dev-loc' },
        ],
      }),
    });
    const rentalRes = await POST(rentalReq, { params: Promise.resolve({ id: 'sugg-1' }) });
    expect(rentalRes.status).toBe(422);
    expect((await rentalRes.json()).code).toBe('sale_only_violation');
  });

  it('não conclui o follow-up se o envio para a Meta falhar', async () => {
    const db = makeDb({ templateStatus: 'APPROVED' });
    mockRequireRole.mockResolvedValue({ supabase: db, accountId: 'acc-1', userId: 'user-1' });
    mockGetConversationSessionStatus.mockResolvedValue({ windowOpen: true, remainingMs: 3600000 });
    mockSendMessageToConversation.mockRejectedValue(new Error('Meta API timeout'));

    const req = new Request('http://localhost/api/ai/suggestions/sugg-1/followup/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'free',
        text: 'Oi George!',
        selectedProperties: [
          { propertyId: 'p-1', title: 'Residencial A', operation: 'venda', publicUrl: 'https://ronaldomeira.com.br/imovel/dev-1' },
        ],
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'sugg-1' }) });
    expect(res.status).toBe(500);
    expect(db.updates.filter((u) => u.table === 'ai_suggestions')).toHaveLength(0);
  });
});
