import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildDeterministicFollowupTemplateSelection,
  doesTemplateSupportPublicUrl,
  selectFollowupTemplate,
} from './followup-message';
import type { AiConfig } from './types';
import type { MessageTemplate } from '@/types';

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  };
}

function template(overrides: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 'tpl-1',
    user_id: 'user-1',
    name: 'followup_generic',
    category: 'Marketing',
    language: 'pt_BR',
    body_text: 'Olá {{1}}, {{2}}',
    status: 'APPROVED',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeDb(templates: MessageTemplate[]): SupabaseClient {
  const builder = {
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    then(resolve: (v: { data: MessageTemplate[]; error: null }) => void) {
      resolve({ data: templates, error: null });
    },
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

function okResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

const args = { contactName: 'Maria Silva', reason: 'Sumiu após perguntar preço', approachSummary: 'Retomar oferta' };

describe('selectFollowupTemplate', () => {
  it('returns null immediately when the account has no approved templates', async () => {
    const db = fakeDb([]);
    const res = await selectFollowupTemplate(db, 'account-1', config(), args);
    expect(res.selection).toBeNull();
    expect(res.usage).toBeNull();
  });

  it('accepts a valid selection matching the template variable count', async () => {
    const tpl = template();
    const db = fakeDb([tpl]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          JSON.stringify({ template_id: 'tpl-1', body_values: ['Maria', 'temos novidades'] }),
        ),
      ),
    );

    const res = await selectFollowupTemplate(db, 'account-1', config(), args);
    expect(res.selection?.template.id).toBe('tpl-1');
    expect(res.selection?.values.body).toEqual(['Maria', 'temos novidades']);
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('rejects a template_id the model invented (not in the approved list)', async () => {
    const db = fakeDb([template()]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(JSON.stringify({ template_id: 'tpl-does-not-exist', body_values: ['a', 'b'] })),
      ),
    );
    const res = await selectFollowupTemplate(db, 'account-1', config(), args);
    expect(res.selection).toBeNull();
  });

  it('rejects a variable-count mismatch instead of sending a malformed template', async () => {
    const db = fakeDb([template()]); // needs 2 body vars
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(JSON.stringify({ template_id: 'tpl-1', body_values: ['only-one'] })),
      ),
    );
    const res = await selectFollowupTemplate(db, 'account-1', config(), args);
    expect(res.selection).toBeNull();
  });

  it('rejects a blank body value even when the count matches', async () => {
    const db = fakeDb([template()]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(JSON.stringify({ template_id: 'tpl-1', body_values: ['Maria', '   '] })),
      ),
    );
    const res = await selectFollowupTemplate(db, 'account-1', config(), args);
    expect(res.selection).toBeNull();
  });

  it('requires a header value when the template has a text header variable', async () => {
    const tpl = template({ header_type: 'text', header_content: 'Oi {{1}}' });
    const db = fakeDb([tpl]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(JSON.stringify({ template_id: 'tpl-1', body_values: ['Maria', 'ok'] })),
      ),
    );
    const res = await selectFollowupTemplate(db, 'account-1', config(), args);
    expect(res.selection).toBeNull();
  });

  it('accepts a filled header value', async () => {
    const tpl = template({ header_type: 'text', header_content: 'Oi {{1}}' });
    const db = fakeDb([tpl]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse(
          JSON.stringify({
            template_id: 'tpl-1',
            body_values: ['Maria', 'ok'],
            header_value: 'Maria',
          }),
        ),
      ),
    );
    const res = await selectFollowupTemplate(db, 'account-1', config(), args);
    expect(res.selection?.values.headerText).toBe('Maria');
  });

  it('returns null (never throws) when the model output is not valid JSON', async () => {
    const db = fakeDb([template()]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('not json')));
    const res = await selectFollowupTemplate(db, 'account-1', config(), args);
    expect(res.selection).toBeNull();
  });

  it('usa fallback determinístico quando allowDeterministicFallback=true e a IA falha ou retorna JSON inválido', async () => {
    const tpl1Var = template({
      id: 'tpl-1var',
      name: 'retorno_novidades_portfolio',
      body_text: 'Oi, {{1}}! Tudo bem? Consegui reunir algumas opções para você.',
    });
    const tpl2Var = template({
      id: 'tpl-2var',
      name: 'oportunidade_alinhada',
      body_text: 'Oi, {{1}}! Apareceu algo bem alinhado com {{2}}. Me chama aqui.',
    });
    const db = fakeDb([tpl1Var, tpl2Var]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('invalid json output')));

    // Com imóvel selecionado -> prioriza template de 2 variáveis preenchendo nome e contexto do imóvel
    const withProp = await selectFollowupTemplate(db, 'account-1', config(), {
      ...args,
      allowDeterministicFallback: true,
      selectedProperty: {
        propertyId: 'prop-1',
        title: 'Mahal Bessa',
        neighborhood: 'Bessa',
        propertyType: 'Studio',
        publicUrl: 'https://ronaldomeira.com.br/imovel/dev-mahal',
      },
    });
    expect(withProp.selection).not.toBeNull();
    expect(withProp.selection?.template.id).toBe('tpl-2var');
    expect(withProp.selection?.values.body[0]).toBe('Maria');
    expect(withProp.selection?.values.body[1]).toContain('Mahal Bessa');

    // Sem empreendimento ou necessidade específica -> prioriza template de 1 variável (apenas nome)
    const withoutTopic = buildDeterministicFollowupTemplateSelection([tpl1Var, tpl2Var], {
      contactName: 'Carlos Eduardo',
      reason: 'Lead parado há dias',
      approachSummary: null,
    });
    expect(withoutTopic).not.toBeNull();
    expect(withoutTopic?.template.id).toBe('tpl-1var');
    expect(withoutTopic?.values.body).toEqual(['Carlos']);
    expect(doesTemplateSupportPublicUrl(tpl1Var)).toBe(false);
  });
});
