import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { executeConversationalTurn } from './conversation-engine';
import { buildConversationalSystemPrompt } from './prompt-builder';
import { formatChunkOrigin, retrievePropertyKnowledge } from './knowledge';
import type { AiConfig } from './types';

const h = vi.hoisted(() => ({
  generateOpenAi: vi.fn(),
  generateAnthropic: vi.fn(),
  embedTexts: vi.fn(),
}));

vi.mock('./providers/openai', () => ({
  generateOpenAi: h.generateOpenAi,
}));

vi.mock('./providers/anthropic', () => ({
  generateAnthropic: h.generateAnthropic,
}));

vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}));

function makeMockConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 8,
    handoffAgentId: null,
    embeddingsApiKey: 'sk-embed',
    identityName: 'Equipe de Atendimento',
    toneStyle: 'consultative_warm',
    teamPresentation: 'Somos a equipe de atendimento do Ronaldo e da Thatianna.',
    globalNeverRules: 'NUNCA passar valores por m².',
    businessHoursStart: '08:00',
    businessHoursEnd: '18:00',
    businessDays: [1, 2, 3, 4, 5],
    offHoursInstructions: 'Avisar que responderemos no primeiro horário da manhã seguinte.',
    safetyMessageLimit: 8,
    ...overrides,
  };
}

describe('Auditoria Corretiva — 8 Cenários de Teste Obrigatórios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.embedTexts.mockResolvedValue([[0.1, 0.2]]);
  });

  // Teste 1: Draft endpoint / executeConversationalTurn com mode: 'draft'
  it('1. Draft Mode: executeConversationalTurn runs with mode "draft" and returns structured response', async () => {
    h.generateOpenAi.mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'Olá! Como posso ajudar você hoje?',
        transfer_required: false,
        boundary_type: null,
        reason: 'Atendimento consultivo inicial',
        context_summary: 'Dúvida geral',
        suggested_next_action: null,
      }),
      usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 },
    });

    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as unknown as SupabaseClient;

    const result = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: makeMockConfig(),
      messages: [{ role: 'user', content: 'Olá' }],
      mode: 'draft',
    });

    expect(result.responseText).toBe('Olá! Como posso ajudar você hoje?');
    expect(result.handoff).toBe(false);
    expect(result.decision.reason).toBe('Atendimento consultivo inicial');
  });

  // Teste 2: RAG Separação entre Conhecimento Global e do Empreendimento
  it('2. RAG Separation: retrievePropertyKnowledge separates propertyChunks and globalChunks', async () => {
    const rpcMock = vi.fn().mockImplementation((name, args) => {
      if (name === 'match_property_ai_knowledge_semantic') {
        expect(args.p_property_id).toBe('prop-live-park');
        return Promise.resolve({
          data: [
            { id: 'chunk-1', content: 'Ficha técnica do Live Park: piscina e churrasqueira', is_global: false },
            { id: 'chunk-2', content: 'Regra de comissão da imobiliária', is_global: true },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    });

    const db = {
      rpc: rpcMock,
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ count: 5, error: null }),
          in: vi.fn().mockResolvedValue({
            data: [
              { id: 'chunk-1', property_id: 'prop-live-park', ai_knowledge_documents: { source_type: 'pdf_book', title: 'Book Live Park' } },
              { id: 'chunk-2', property_id: null, ai_knowledge_documents: { source_type: 'global_faq', title: 'FAQ' } },
            ],
            error: null,
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await retrievePropertyKnowledge(
      db,
      'acc-1',
      makeMockConfig(),
      'prop-live-park',
      'lazer e comissão',
    );

    expect(result.propertyChunks).toHaveLength(1);
    expect(result.propertyChunks[0]).toContain('[Origem: Ficha Técnica]');
    expect(result.propertyChunks[0]).toContain('Ficha técnica do Live Park');

    expect(result.globalChunks).toHaveLength(1);
    expect(result.globalChunks[0]).toContain('[Origem: Conhecimento Global]');
    expect(result.globalChunks[0]).toContain('Regra de comissão da imobiliária');

    expect(result.allChunks).toHaveLength(2);
  });

  // Teste 3: Isolamento estrito entre empreendimentos (Sem vazamento de dados de outro empreendimento)
  it('3. Property Isolation: queries strictly pass target property_id to database RPC', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: [], error: null });

    const db = {
      rpc: rpcMock,
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ count: 10, error: null }),
        }),
      }),
    } as unknown as SupabaseClient;

    await retrievePropertyKnowledge(
      db,
      'acc-1',
      makeMockConfig(),
      'prop-alpha',
      'detalhes da torre',
    );

    expect(rpcMock).toHaveBeenCalledWith(
      'match_property_ai_knowledge_semantic',
      expect.objectContaining({
        p_property_id: 'prop-alpha',
        p_account_id: 'acc-1',
      }),
    );
  });

  // Teste 4: Conhecimento do Empreendimento e Global coexistem no prompt quando empreendimento é selecionado
  it('4. Coexistence: Both section 8 (property) and section 9 (global) appear in prompt when property selected', () => {
    const prompt = buildConversationalSystemPrompt({
      config: makeMockConfig(),
      mode: 'auto_reply',
      property: { id: 'p1', name: 'Live Park', stage: 'Em Obras' },
      propertyKnowledge: ['[Origem: Ficha Técnica]\nPiscina no 20º andar'],
      globalKnowledge: ['[Origem: Conhecimento Global]\nHorário de atendimento telefônico até 19h'],
    });

    expect(prompt).toContain('=== 8. CONHECIMENTO ESPECÍFICO DO EMPREENDIMENTO (ISOLAMENTO ESTRITO) ===');
    expect(prompt).toContain('Live Park');
    expect(prompt).toContain('[Fragmento 1]');
    expect(prompt).toContain('[Origem: Ficha Técnica]');
    expect(prompt).toContain('Piscina no 20º andar');

    expect(prompt).toContain('=== 9. CONHECIMENTO GLOBAL (INFORMAÇÕES TRANSVERSAIS VÁLIDAS PARA QUALQUER ATENDIMENTO) ===');
    expect(prompt).toContain('[Global 1]');
    expect(prompt).toContain('[Origem: Conhecimento Global]');
    expect(prompt).toContain('Horário de atendimento telefônico até 19h');
  });

  // Teste 5: Conhecimento Global opera normalmente quando nenhum empreendimento é selecionado
  it('5. Global knowledge active when property is null', () => {
    const prompt = buildConversationalSystemPrompt({
      config: makeMockConfig(),
      mode: 'auto_reply',
      property: null,
      propertyKnowledge: [],
      globalKnowledge: ['[Origem: Conhecimento Global]\nSomos especialistas em imóveis no litoral'],
    });

    expect(prompt).toContain('=== 8. CONHECIMENTO DO EMPREENDIMENTO ===');
    expect(prompt).toContain('Nenhum empreendimento específico foi identificado ainda.');
    expect(prompt).toContain('=== 9. CONHECIMENTO GLOBAL (INFORMAÇÕES TRANSVERSAIS VÁLIDAS PARA QUALQUER ATENDIMENTO) ===');
    expect(prompt).toContain('Somos especialistas em imóveis no litoral');
  });

  // Teste 6: Tags de origem formatadas com precisão semântica
  it('6. Semantic Origin Tags formatting logic', () => {
    const tagBook = formatChunkOrigin('Área de 85m²', false, 'pdf_book', 'Book Oficial');
    expect(tagBook).toBe('[Origem: Ficha Técnica]\nÁrea de 85m²');

    const tagSubj = formatChunkOrigin('Excelente ventilação sul', false, 'subjective_text', 'Visão do Corretor');
    expect(tagSubj).toBe('[Origem: Visão do Corretor]\nExcelente ventilação sul');

    const tagGlobal = formatChunkOrigin('Política de privacidade da imobiliária', true, null, null);
    expect(tagGlobal).toBe('[Origem: Conhecimento Global]\nPolítica de privacidade da imobiliária');
  });

  // Teste 7: Exceções de Comportamento funcionam como sobreposições pontuais
  it('7. Exception behavior acts as point override with global hierarchy intact', () => {
    const prompt = buildConversationalSystemPrompt({
      config: makeMockConfig(),
      mode: 'auto_reply',
      property: { id: 'p1', name: 'Reserva Imperial', stage: 'Pronto' },
      propertyKnowledge: [],
      propertyStyleInstructions: ['Neste empreendimento, enfatizar a proximidade com o parque.'],
    });

    expect(prompt).toContain('=== 8. CONHECIMENTO ESPECÍFICO DO EMPREENDIMENTO (ISOLAMENTO ESTRITO) ===');
    expect(prompt).toContain('EXCEÇÕES DE COMPORTAMENTO DESTE EMPREENDIMENTO (PRIORIDADE PONTUAL: sobrepõem apenas a regra ou diretriz global específica');
    expect(prompt).toContain('Neste empreendimento, enfatizar a proximidade com o parque.');
    // Global behavior still intact
    expect(prompt).toContain('=== 4. FRONTEIRAS RÍGIDAS');
    expect(prompt).toContain('NUNCA passar valores por m²');
  });

  // Teste 8: Execução integrada do turno conversacional completo
  it('8. Full integrated turn execution with isolated knowledge and structured decision output', async () => {
    h.generateOpenAi.mockResolvedValueOnce({
      text: JSON.stringify({
        response_text: 'O Live Park conta com piscina aquecida no rooftop e academia com vista para o parque.',
        transfer_required: false,
        boundary_type: null,
        reason: 'Informações de lazer autorizadas pela Ficha Técnica',
        context_summary: 'Dúvida sobre itens de lazer do Live Park',
        suggested_next_action: null,
      }),
      usage: { promptTokens: 200, completionTokens: 45, totalTokens: 245 },
    });

    const db = {
      from: vi.fn().mockImplementation((table: string) => ({
        select: vi.fn().mockImplementation(() => ({
          eq: vi.fn().mockImplementation(() => {
            const queryObj: Record<string, unknown> = {
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    table === 'properties'
                      ? { id: 'prop-1', name: 'Live Park' }
                      : { stage: 'em_obras', response_style_instructions: ['Destacar lazer'] },
                  error: null,
                }),
              in: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'c1',
                    property_id: 'prop-1',
                    ai_knowledge_documents: { source_type: 'pdf_book', title: 'Book' },
                  },
                ],
                error: null,
              }),
            };
            // Allow awaiting the .eq() directly for count query
            return Object.assign(Promise.resolve({ count: 2, error: null }), queryObj);
          }),
          in: vi.fn().mockResolvedValue({
            data: [
              {
                id: 'c1',
                property_id: 'prop-1',
                ai_knowledge_documents: { source_type: 'pdf_book', title: 'Book' },
              },
            ],
            error: null,
          }),
        })),
      })),
      rpc: vi.fn().mockResolvedValue({
        data: [{ id: 'c1', content: 'Piscina aquecida no rooftop', is_global: false }],
        error: null,
      }),
    } as unknown as SupabaseClient;

    const turn = await executeConversationalTurn({
      db,
      accountId: 'acc-1',
      config: makeMockConfig(),
      propertyId: 'prop-1',
      messages: [{ role: 'user', content: 'Quais as comodidades de lazer?' }],
      mode: 'auto_reply',
    });

    expect(turn.responseText).toContain('piscina aquecida');
    expect(turn.handoff).toBe(false);
    expect(turn.retrievedKnowledgeCount).toBe(1);
    expect(turn.retrievedKnowledge[0]).toContain('[Origem: Ficha Técnica]');
    expect(turn.systemPrompt).toContain('Live Park');
  });
});
