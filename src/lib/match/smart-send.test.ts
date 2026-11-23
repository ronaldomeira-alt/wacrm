import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiConfig, ChatMessage } from '@/lib/ai/types';
import {
  buildDeterministicApprovedTemplateSelection,
  buildMatchPropertyPrompts,
  ensurePublicUrlInDraft,
  generateMatchPropertyMessage,
  resolveValidatedPublicPropertyUrl,
  selectApprovedMatchTemplate,
  selectCommercialTemplateAngle,
  type SmartSendMatchContext,
} from './smart-send';
import {
  evaluateSessionWindowFromTimestamp,
  renderApprovedTemplatePreview,
  validateApprovedTemplateSubmission,
} from '@/lib/whatsapp/session-window';
import type { MessageTemplate } from '@/types';

function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'sk-test-123',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  };
}

function makeContext(overrides: Partial<SmartSendMatchContext> = {}): SmartSendMatchContext {
  return {
    lead: {
      leadId: 'lead-1',
      leadName: 'Maria Fernanda',
      aiScore: 8,
      tags: ['Bessa', '3 quartos'],
      intelligenceSummary: {
        budget: 'R$ 650.000',
        neighborhoods: ['Bessa'],
      },
    },
    property: {
      propertyId: 'prop-1',
      code: 'AP-302',
      title: 'Residencial Brisa do Bessa',
      operation: 'venda',
      propertyType: 'apartamento',
      neighborhood: 'Bessa',
      city: 'João Pessoa',
      priceMin: 620000,
      priceMax: 680000,
      areaMin: 88,
      bedroomsMin: 3,
      deliveryStatus: 'pronto',
      features: ['varanda gourmet', 'elevador'],
    },
    publicUrl: 'https://ronaldomeira.com.br/imovel/brisa-do-bessa',
    matchScore: 94,
    matchReasons: ['Região exata: Bessa', 'Dentro do orçamento'],
    priorSharesCount: 0,
    priorSharedTitles: [],
    lastMessageAt: '2026-11-22T20:00:00Z',
    nowMs: new Date('2026-11-22T22:00:00Z').getTime(),
    ...overrides,
  };
}

function fakeDbWithMessages(rows: Array<{ sender_type: string; content_type: string; content_text: string }>, shouldError = false): SupabaseClient {
  const builder = {
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    in() {
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    then(resolve: (value: { data: unknown; error: unknown }) => void) {
      if (shouldError) {
        resolve({ data: null, error: new Error('db failure') });
      } else {
        resolve({ data: rows, error: null });
      }
    },
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe('resolveValidatedPublicPropertyUrl', () => {
  it('resolve path relativo /imovel/... usando o host público padrão', () => {
    const res = resolveValidatedPublicPropertyUrl('/imovel/live-park-bessa', null, 'https://ronaldomeira.com.br');
    expect(res.url).toBe('https://ronaldomeira.com.br/imovel/live-park-bessa');
  });

  it('utiliza fallback de public_page_id quando public_url vier nulo', () => {
    const res = resolveValidatedPublicPropertyUrl(null, 'vela-e-mar-flat', 'https://ronaldomeira.com.br');
    expect(res.url).toBe('https://ronaldomeira.com.br/imovel/vela-e-mar-flat');
  });

  it('preserva link HTTPS externo válido', () => {
    const res = resolveValidatedPublicPropertyUrl('https://meusimoveis.com.br/imoveis/bessa-101');
    expect(res.url).toBe('https://meusimoveis.com.br/imoveis/bessa-101');
  });

  it('rejeita ausência de link público', () => {
    const res = resolveValidatedPublicPropertyUrl(null, null);
    expect(res.url).toBeNull();
    expect(res.error).toContain('não está cadastrado');
  });

  it('bloqueia links apontando para rotas administrativas internas do CRM', () => {
    for (const bad of [
      '/dashboard/properties/123',
      'https://crmronaldomeira.com/inbox?c=1',
      'https://crmronaldomeira.com/match?property_id=1',
      '/settings/ai',
      '/api/match/share',
    ]) {
      const res = resolveValidatedPublicPropertyUrl(bad);
      expect(res.url).toBeNull();
      expect(res.error).toContain('rota interna');
    }
  });

  it('bloqueia links contendo parâmetros privados ou protocolos inválidos', () => {
    expect(resolveValidatedPublicPropertyUrl('https://ronaldomeira.com.br/imovel/x?token=abc').url).toBeNull();
    expect(resolveValidatedPublicPropertyUrl('https://ronaldomeira.com.br/imovel/x?auth=123').url).toBeNull();
    expect(resolveValidatedPublicPropertyUrl('javascript:alert(1)').url).toBeNull();
  });
});

describe('selectCommercialTemplateAngle', () => {
  const sampleHistory: ChatMessage[] = [
    { role: 'user', content: 'Quero um 3 quartos no Bessa até 650 mil' },
  ];

  it('escolhe nova_opcao_comparativa quando cliente já recebeu imóveis antes', () => {
    const angle = selectCommercialTemplateAngle(makeContext({ priorSharesCount: 1 }), sampleHistory);
    expect(angle.id).toBe('nova_opcao_comparativa');
  });

  it('escolhe continuidade_negociacao quando há histórico recente (<= 48h)', () => {
    const angle = selectCommercialTemplateAngle(makeContext(), sampleHistory);
    expect(angle.id).toBe('continuidade_negociacao');
  });

  it('escolhe retomada_conversa quando há histórico antigo (> 48h)', () => {
    const angle = selectCommercialTemplateAngle(
      makeContext({
        lastMessageAt: '2026-11-10T10:00:00Z',
        nowMs: new Date('2026-11-22T22:00:00Z').getTime(),
      }),
      sampleHistory
    );
    expect(angle.id).toBe('retomada_conversa');
  });

  it('escolhe apresentacao_objetiva quando não há histórico nem motivos específicos', () => {
    const angle = selectCommercialTemplateAngle(makeContext({ matchReasons: [] }), []);
    expect(angle.id).toBe('apresentacao_objetiva');
  });
});

describe('buildMatchPropertyPrompts', () => {
  it('omite preço autorizado e reforça sigilo de valores/construtora quando imóvel NÃO está pronto', () => {
    const ctx = makeContext({
      property: {
        ...makeContext().property,
        deliveryStatus: 'planta',
        deliveryDeadline: 'Dez/2028',
      },
    });
    const angle = selectCommercialTemplateAngle(ctx, []);
    const { systemPrompt, userPrompt } = buildMatchPropertyPrompts(ctx, [], angle);

    expect(systemPrompt).toContain('NÃO está classificado como "pronto"');
    expect(systemPrompt).toContain('NUNCA revele ou mencione nome de construtora');
    expect(systemPrompt).toContain('Não há mensagens anteriores registradas');
    expect(userPrompt).toContain('"faixa_valor_autorizada": null');
    expect(userPrompt).not.toContain('620.000');
  });

  it('inclui faixa de preço oficial quando imóvel é pronto e aplica regra de locação quando aplicável', () => {
    const ctx = makeContext({
      property: {
        ...makeContext().property,
        operation: 'locacao',
        deliveryStatus: 'pronto',
        priceMin: 3200,
        priceMax: 3200,
      },
    });
    const angle = selectCommercialTemplateAngle(ctx, [{ role: 'user', content: 'Busco flat para morar' }]);
    const { systemPrompt, userPrompt } = buildMatchPropertyPrompts(ctx, [{ role: 'user', content: 'Busco flat para morar' }], angle);

    expect(systemPrompt).toContain('REGRA DE LOCAÇÃO');
    expect(userPrompt).toContain('3.200');
  });
});

describe('generateMatchPropertyMessage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gera mensagem contextual pela IA e anexa link público se modelo omitir', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Oi Maria Fernanda! Separei essa opção no Bessa para você conferir.' } }],
          usage: { prompt_tokens: 120, completion_tokens: 25, total_tokens: 145 },
        }),
      })
    );

    const db = fakeDbWithMessages([
      { sender_type: 'customer', content_type: 'text', content_text: 'Procuro ap no Bessa' },
    ]);

    const res = await generateMatchPropertyMessage({
      db,
      config: makeConfig(),
      conversationId: 'conv-1',
      context: makeContext(),
    });

    expect(res.generatedBy).toBe('ai');
    expect(res.text).toContain('https://ronaldomeira.com.br/imovel/brisa-do-bessa');
    expect(res.usedHistoryCount).toBe(1);
    expect(res.usage?.totalTokens ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('usa fallback determinístico seguro sem preço para imóvel na planta quando IA falha ou está inativa', async () => {
    const db = fakeDbWithMessages([], true);
    const ctxPlanta = makeContext({
      property: {
        ...makeContext().property,
        deliveryStatus: 'em_construcao',
      },
    });

    const resNoAi = await generateMatchPropertyMessage({
      db,
      config: null,
      conversationId: 'conv-1',
      context: ctxPlanta,
    });

    expect(resNoAi.generatedBy).toBe('fallback');
    expect(resNoAi.fallbackReason).toBe('ai_unavailable');
    expect(resNoAi.text).toContain('Residencial Brisa do Bessa');
    expect(resNoAi.text).toContain(ctxPlanta.publicUrl);
    expect(resNoAi.text).not.toContain('620');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network timeout')));
    const resErr = await generateMatchPropertyMessage({
      db,
      config: makeConfig(),
      conversationId: 'conv-1',
      context: makeContext(),
    });
    expect(resErr.generatedBy).toBe('fallback');
    expect(resErr.fallbackReason).toBe('ai_error');
    expect(resErr.text).toContain(makeContext().publicUrl);
  });

  it('ensurePublicUrlInDraft não duplica o link se já estiver presente', () => {
    const url = 'https://ronaldomeira.com.br/imovel/abc';
    const text = `Veja esse imóvel:\n${url}`;
    expect(ensurePublicUrlInDraft(text, url)).toBe(text);
  });
});

describe('Regra de 24h e Seleção de Templates Aprovados do WhatsApp (Frente 2)', () => {
  const nowMs = new Date('2026-11-22T22:00:00Z').getTime();

  function makeTemplate(overrides: Partial<MessageTemplate> = {}): MessageTemplate {
    return {
      id: 'tpl-1',
      user_id: 'user-1',
      name: 'oportunidade_alinhada',
      language: 'pt_BR',
      category: 'Marketing',
      status: 'APPROVED',
      body_text:
        'Oi, {{1}}! Tudo certo? Apareceu algo bem alinhado com {{2}}. Acho que vale você dar uma olhada. Me chama aqui.',
      buttons: [],
      created_at: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  it('calcula janela de 24h corretamente (aberta < 24h, encerrada >= 24h ou sem mensagem do cliente)', () => {
    const openStatus = evaluateSessionWindowFromTimestamp('2026-11-22T10:00:00Z', nowMs);
    expect(openStatus.windowOpen).toBe(true);
    expect(openStatus.expired).toBe(false);

    const exact24hStatus = evaluateSessionWindowFromTimestamp('2026-11-21T22:00:00Z', nowMs);
    expect(exact24hStatus.windowOpen).toBe(false);
    expect(exact24hStatus.expired).toBe(true);

    const noCustomerMsgStatus = evaluateSessionWindowFromTimestamp(null, nowMs);
    expect(noCustomerMsgStatus.windowOpen).toBe(false);
    expect(noCustomerMsgStatus.expired).toBe(true);
  });

  it('preenche apenas as variáveis {{1}} e {{2}} sem jamais alterar o texto fixo do template aprovado', () => {
    const tpl = makeTemplate();
    const sel = buildDeterministicApprovedTemplateSelection([tpl], makeContext());

    expect(sel).not.toBeNull();
    expect(sel?.template.id).toBe('tpl-1');
    expect(sel?.values.body).toEqual([
      'Maria',
      'o que você procura em Bessa (apartamento)',
    ]);
    expect(sel?.previewText).toBe(
      'Oi, Maria! Tudo certo? Apareceu algo bem alinhado com o que você procura em Bessa (apartamento). Acho que vale você dar uma olhada. Me chama aqui.'
    );
  });

  it('mantém texto fixo 100% inalterado quando o template aprovado não possui variáveis', () => {
    const fixedTpl = makeTemplate({
      id: 'tpl-fixed',
      name: 'retorno_fixo',
      body_text: 'Olá! Temos novidades no seu perfil de busca em João Pessoa. Me chame quando puder.',
    });
    const sel = buildDeterministicApprovedTemplateSelection([fixedTpl], makeContext());

    expect(sel).not.toBeNull();
    expect(sel?.values.body).toEqual([]);
    expect(sel?.previewText).toBe(fixedTpl.body_text);
    expect(renderApprovedTemplatePreview(fixedTpl.body_text, [])).toBe(fixedTpl.body_text);
  });

  it('rejeita templates com status REJECTED, PAUSED ou PENDING e templates com variáveis faltantes', () => {
    const rejected = makeTemplate({ status: 'REJECTED' });
    const paused = makeTemplate({ status: 'PAUSED' });
    const pending = makeTemplate({ status: 'PENDING' });

    expect(validateApprovedTemplateSubmission(rejected, ['Maria', 'Bessa']).valid).toBe(false);
    expect(validateApprovedTemplateSubmission(paused, ['Maria', 'Bessa']).valid).toBe(false);
    expect(validateApprovedTemplateSubmission(pending, ['Maria', 'Bessa']).valid).toBe(false);
    expect(validateApprovedTemplateSubmission(makeTemplate(), ['Maria', '']).valid).toBe(false);
  });

  it('selectApprovedMatchTemplate ignora templates não aprovados/incompatíveis e retorna impedimento claro quando nenhum serve', async () => {
    const fakeDb = {
      from(table: string) {
        const b: Record<string, unknown> = {};
        const chain = () => b;
        for (const m of ['select', 'eq', 'in', 'order', 'limit']) b[m] = vi.fn(chain);
        b.then = (resolve: (val: unknown) => void) => {
          if (table === 'message_templates') {
            resolve({
              data: [
                makeTemplate({ id: 't-rej', status: 'REJECTED' }),
                makeTemplate({
                  id: 't-otp',
                  category: 'Authentication',
                  name: 'codigo_otp',
                  body_text: 'Seu código de verificação é {{1}}',
                }),
              ],
              error: null,
            });
          } else {
            resolve({ data: [], error: null });
          }
        };
        return b;
      },
    } as unknown as SupabaseClient;

    const res = await selectApprovedMatchTemplate({
      db: fakeDb,
      accountId: 'acc-1',
      config: null,
      conversationId: 'conv-1',
      context: makeContext(),
    });

    expect(res.selection).toBeNull();
    expect(res.generatedBy).toBe('none');
    expect(res.noTemplateReason).toMatch(/janela de atendimento de 24 horas está encerrada/i);
  });
});
