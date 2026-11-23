import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadAiConfig: vi.fn(),
  generateMatchPropertyMessage: vi.fn(),
  logAiUsage: vi.fn(),
  checkRateLimit: vi.fn(),
  supabaseFrom: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: unknown) =>
    Response.json({ error: (err as Error).message || 'internal error' }, { status: 500 })
  ),
}));

vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 60, windowMs: 60_000 } },
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: vi.fn(() => Response.json({ error: 'Rate limited' }, { status: 429 })),
}));

vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: mocks.loadAiConfig,
}));

vi.mock('@/lib/ai/usage', () => ({
  logAiUsage: mocks.logAiUsage,
}));

vi.mock('@/lib/match/smart-send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/match/smart-send')>();
  return {
    ...actual,
    generateMatchPropertyMessage: mocks.generateMatchPropertyMessage,
  };
});

import { POST } from './route';

function makeQuery(result: { data?: unknown; error?: unknown } = { data: null, error: null }) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  for (const method of ['select', 'eq', 'in', 'is', 'order', 'limit', 'maybeSingle', 'single']) {
    q[method] = vi.fn(chain);
  }
  q.then = (resolve: (val: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null });
  return q;
}

describe('POST /api/match/prepare-send', () => {
  const insertMock = vi.fn();
  const updateMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockReturnValue({ success: true, remaining: 59, reset: Date.now() + 60_000, limit: 60 });
    mocks.requireRole.mockResolvedValue({
      supabase: { from: mocks.supabaseFrom },
      accountId: 'acc-1',
      userId: 'user-1',
      role: 'agent',
    });
    mocks.loadAiConfig.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-123',
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: false,
      autoReplyMaxPerConversation: 3,
      handoffAgentId: null,
      embeddingsApiKey: null,
    });
    mocks.generateMatchPropertyMessage.mockResolvedValue({
      text: 'Oi Ana! Confira este imóvel: https://ronaldomeira.com.br/imovel/bessa-1',
      templateAngle: 'continuidade_negociacao',
      templateLabel: 'Continuidade de negociação',
      generatedBy: 'ai',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      usedHistoryCount: 2,
    });
  });

  function setupTables(overrides: {
    contact?: unknown;
    conversation?: unknown;
    projection?: unknown[];
    priorShares?: unknown[];
    matchRow?: unknown;
    latestCustomerMessage?: unknown;
    templates?: unknown[];
  } = {}) {
    mocks.supabaseFrom.mockImplementation((table: string) => {
      if (table === 'contacts') {
        return {
          ...makeQuery({ data: overrides.contact !== undefined ? overrides.contact : { id: 'lead-1', name: 'Ana', phone: '558399999999', ai_score: 8 } }),
          insert: insertMock,
          update: updateMock,
        };
      }
      if (table === 'conversations') {
        return makeQuery({
          data:
            overrides.conversation !== undefined
              ? overrides.conversation
              : { id: 'conv-1', last_message_at: '2026-11-22T20:00:00Z', created_at: '2026-11-20T10:00:00Z' },
        });
      }
      if (table === 'property_match_projections') {
        return makeQuery({
          data:
            overrides.projection !== undefined
              ? overrides.projection
              : [
                  {
                    property_id: 'prop-1',
                    account_id: 'acc-1',
                    title: 'Live Park Bessa',
                    operation: 'venda',
                    property_type: 'apartamento',
                    neighborhood: 'Bessa',
                    city: 'João Pessoa',
                    price_min: 550000,
                    price_max: 590000,
                    bedrooms_min: 3,
                    delivery_status: 'pronto',
                    features: ['piscina'],
                    public_url: 'https://ronaldomeira.com.br/imovel/bessa-1',
                    status: 'ativo',
                  },
                ],
        });
      }
      if (table === 'property_shares') {
        return {
          ...makeQuery({ data: overrides.priorShares ?? [] }),
          insert: insertMock,
        };
      }
      if (table === 'lead_property_matches') {
        return {
          ...makeQuery({
            data:
              overrides.matchRow !== undefined
                ? overrides.matchRow
                : { id: 'match-1', match_status: 'novo', sent_at: null, match_score: 93, score_breakdown: { reasons: ['Bairro exato'] } },
          }),
          update: updateMock,
        };
      }
      if (table === 'lead_intelligence') {
        return makeQuery({ data: { summary: { neighborhoods: ['Bessa'] } } });
      }
      if (table === 'contact_tags') {
        return makeQuery({ data: [] });
      }
      if (table === 'messages') {
        return makeQuery({
          data:
            overrides.latestCustomerMessage !== undefined
              ? overrides.latestCustomerMessage
              : { created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
        });
      }
      if (table === 'message_templates') {
        return makeQuery({
          data:
            overrides.templates !== undefined
              ? overrides.templates
              : [
                  {
                    id: 'tpl-1',
                    account_id: 'acc-1',
                    name: 'oportunidade_alinhada',
                    language: 'pt_BR',
                    category: 'MARKETING',
                    status: 'APPROVED',
                    header_type: null,
                    header_content: null,
                    body_text:
                      'Oi, {{1}}! Tudo certo? Apareceu algo bem alinhado com {{2}}. Acho que vale você dar uma olhada. Me chama aqui.',
                    footer_text: null,
                    buttons: [],
                  },
                ],
        });
      }
      return makeQuery({ data: null });
    });
  }

  it('retorna 400 quando faltam lead_id ou property_id', async () => {
    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({ lead_id: 'lead-1' }),
      })
    );
    expect(res.status).toBe(400);
  });

  it('retorna 404 quando lead não existe', async () => {
    setupTables({ contact: null });
    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({ lead_id: 'lead-404', property_id: 'prop-1' }),
      })
    );
    expect(res.status).toBe(404);
  });

  it('retorna 404 quando conversa no Inbox não é localizada para o lead', async () => {
    setupTables({ conversation: null });
    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({ lead_id: 'lead-1', property_id: 'prop-1' }),
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('Conversa não localizada');
  });

  it('retorna 409 quando imóvel está indisponível no cadastro', async () => {
    setupTables({
      projection: [{ property_id: 'prop-1', title: 'Inativo', status: 'inativo' }],
    });
    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({ lead_id: 'lead-1', property_id: 'prop-1' }),
      })
    );
    expect(res.status).toBe(409);
  });

  it('retorna 422 quando link público está ausente ou aponta para rota interna', async () => {
    setupTables({
      projection: [
        {
          property_id: 'prop-1',
          title: 'Sem Link',
          status: 'ativo',
          public_url: null,
        },
      ],
    });
    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({ lead_id: 'lead-1', property_id: 'prop-1' }),
      })
    );
    expect(res.status).toBe(422);
  });

  it('detecta envio anterior sem chamar IA nem gravar no banco até confirmação', async () => {
    setupTables({
      priorShares: [{ id: 'share-1', sent_at: '2026-11-20T12:00:00Z', channel: 'whatsapp_inbox' }],
    });
    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({ lead_id: 'lead-1', property_id: 'prop-1' }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresConfirmation).toBe(true);
    expect(body.duplicateInfo.alreadySent).toBe(true);
    expect(mocks.generateMatchPropertyMessage).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('gera rascunho com force_resend=true sem marcar como enviado nem inserir property_shares', async () => {
    setupTables({
      priorShares: [{ id: 'share-1', sent_at: '2026-11-20T12:00:00Z', channel: 'whatsapp_inbox' }],
    });
    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({ lead_id: 'lead-1', property_id: 'prop-1', force_resend: true }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresConfirmation).toBe(false);
    expect(body.conversationId).toBe('conv-1');
    expect(body.draftText).toContain('https://ronaldomeira.com.br/imovel/bessa-1');
    expect(body.duplicateInfo.alreadySent).toBe(true);
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('deriva o link público pelo cover_url do inventário quando public_url vier null na projeção', async () => {
    setupTables({
      projection: [
        {
          property_id: '7a0837a5-0000-426c-a1b2-c3d4e5f60000',
          account_id: 'acc-1',
          title: 'Apartamento no Bessa',
          operation: 'venda',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 703826,
          price_max: 703826,
          bedrooms_min: 3,
          delivery_status: 'pronto',
          features: ['piscina'],
          cover_url:
            'https://pub-e28ab031048d44b2aa8b1846c6e6fdc6.r2.dev/properties/dev-bd1ac8a946d4bfb0/photos/1792052710048-86bcf060.jpg',
          public_url: null,
          status: 'ativo',
        },
      ],
    });
    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({
          lead_id: 'lead-1',
          property_id: '7a0837a5-0000-426c-a1b2-c3d4e5f60000',
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('free');
    expect(body.sessionWindowOpen).toBe(true);
    expect(body.publicUrl).toBe('https://ronaldomeira.com.br/imovel/dev-bd1ac8a946d4bfb0');
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('quando janela de 24h está encerrada, bloqueia texto livre e prepara template aprovado com variáveis preenchidas', async () => {
    setupTables({
      latestCustomerMessage: {
        created_at: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
      },
    });
    // Força fallback determinístico do seletor de template aprovado (config null)
    mocks.loadAiConfig.mockResolvedValueOnce(null);

    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({ lead_id: 'lead-1', property_id: 'prop-1' }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('template');
    expect(body.sessionWindowOpen).toBe(false);
    expect(body.draftText).toBeNull();
    expect(body.template).toBeTruthy();
    expect(body.template.name).toBe('oportunidade_alinhada');
    expect(body.template.values.body).toEqual([
      'Ana',
      'o que você procura em Bessa (apartamento)',
    ]);
    expect(body.template.previewText).toContain(
      'Oi, Ana! Tudo certo? Apareceu algo bem alinhado com o que você procura em Bessa (apartamento).'
    );
    expect(mocks.generateMatchPropertyMessage).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('quando janela de 24h está encerrada e não há template aprovado compatível, retorna mode=no_template sem texto livre', async () => {
    setupTables({
      latestCustomerMessage: null,
      templates: [
        {
          id: 'tpl-rejected',
          account_id: 'acc-1',
          name: 'oportunidade_rejeitada',
          language: 'pt_BR',
          category: 'MARKETING',
          status: 'REJECTED',
          body_text: 'Oi {{1}}',
        },
        {
          id: 'tpl-boleto',
          account_id: 'acc-1',
          name: 'cobranca_boleto',
          language: 'pt_BR',
          category: 'UTILITY',
          status: 'APPROVED',
          body_text: 'Seu boleto {{1}} venceu.',
        },
      ],
    });
    mocks.loadAiConfig.mockResolvedValueOnce(null);

    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({ lead_id: 'lead-1', property_id: 'prop-1' }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('no_template');
    expect(body.sessionWindowOpen).toBe(false);
    expect(body.draftText).toBeNull();
    expect(body.template).toBeNull();
    expect(body.noTemplateReason).toMatch(/janela de atendimento de 24 horas está encerrada/i);
    expect(mocks.generateMatchPropertyMessage).not.toHaveBeenCalled();
  });

  it('quando cliente volta a responder (< 24h), janela reabre e mensagem livre volta a ser permitida', async () => {
    setupTables({
      latestCustomerMessage: {
        created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      },
    });

    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({ lead_id: 'lead-1', property_id: 'prop-1' }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('free');
    expect(body.sessionWindowOpen).toBe(true);
    expect(body.draftText).toContain('https://ronaldomeira.com.br/imovel/bessa-1');
    expect(mocks.generateMatchPropertyMessage).toHaveBeenCalledTimes(1);
  });

  it('bloqueia compartilhamento de imóvel de locação no Match (409)', async () => {
    setupTables({
      projection: [
        {
          property_id: 'prop-rent-1',
          account_id: 'acc-1',
          title: 'Flat Locação Intermares',
          operation: 'locacao',
          property_type: 'flat',
          neighborhood: 'Intermares',
          status: 'ativo',
          public_url: 'https://ronaldomeira.com.br/imovel/flat-rent',
        },
      ],
    });

    const res = await POST(
      new Request('http://localhost/api/match/prepare-send', {
        method: 'POST',
        body: JSON.stringify({ lead_id: 'lead-1', property_id: 'prop-rent-1' }),
      })
    );

    expect(res.status).toBe(409);
  });
});
