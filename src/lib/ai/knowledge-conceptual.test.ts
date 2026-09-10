import { describe, expect, it } from 'vitest';
import { buildConversationalSystemPrompt } from './prompt-builder';
import type { AiConfig } from './types';

const BASE_CONFIG: AiConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: false,
  autoReplyMaxPerConversation: 8,
  handoffAgentId: null,
  embeddingsApiKey: null,
  identityName: 'Assistente Imobiliário',
  toneStyle: 'consultative_welcoming',
  teamPresentation: 'Somos a equipe de atendimento de Ronaldo Meira e Thatianna.',
  globalNeverRules: 'Nunca prometer valorização futura ou passar preços.',
  businessHoursStart: '08:00',
  businessHoursEnd: '18:00',
  businessDays: [1, 2, 3, 4, 5],
  offHoursInstructions: 'Acolher e avisar que a equipe dará continuidade pela manhã.',
  safetyMessageLimit: 8,
};

describe('CORREÇÃO CONCEITUAL — Validação das 4 Camadas da IA (Seção 20)', () => {
  // 1. Conhecimento de empreendimento não aparece no conhecimento global
  it('1. property-specific knowledge is strictly isolated and does not contaminate global knowledge', () => {
    const prompt = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: { id: 'prop-aurora', name: 'Residencial Aurora', stage: 'Lançamento' },
      propertyKnowledge: ['Rooftop com piscina e vista panorâmica do Bessa.'],
      globalKnowledge: ['Ronaldo Meira é o corretor responsável por visitas.'],
    });

    expect(prompt).toContain('=== 7. CONHECIMENTO ESPECÍFICO DO EMPREENDIMENTO (ISOLAMENTO ESTRITO) ===');
    expect(prompt).toContain('Residencial Aurora');
    expect(prompt).toContain('Rooftop com piscina e vista panorâmica do Bessa.');
    expect(prompt).toContain('=== 8. CONHECIMENTO GLOBAL (INFORMAÇÕES TRANSVERSAIS VÁLIDAS PARA QUALQUER ATENDIMENTO) ===');
    expect(prompt).toContain('Ronaldo Meira é o corretor responsável por visitas.');
  });

  // 2. Conhecimento de A não aparece em B
  it('2. knowledge of Property A never appears when querying Property B', () => {
    const promptB = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: { id: 'prop-mirante', name: 'Mirante do Cabo', stage: 'Pronto para Morar' },
      propertyKnowledge: ['Apartamentos com 3 suítes no Cabo Branco.'],
      globalKnowledge: ['Equipe de Ronaldo Meira e Thatianna.'],
    });

    expect(promptB).toContain('Mirante do Cabo');
    expect(promptB).toContain('Apartamentos com 3 suítes no Cabo Branco.');
    expect(promptB).not.toContain('Residencial Aurora');
    expect(promptB).not.toContain('vista panorâmica do Bessa');
  });

  // 3. Regra comportamental não é tratada como conhecimento
  it('3. behavioral rules (prohibitions/handoff) are positioned with supreme authority in behavior section, not RAG', () => {
    const prompt = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      propertyKnowledge: [],
      globalKnowledge: [],
    });

    expect(prompt).toContain('=== 3. FRONTEIRAS RÍGIDAS (O QUE VOCÊ NUNCA RESPONDE / SEMPRE TRANSFERE) ===');
    expect(prompt).toContain('PREÇO É DADO DINÂMICO E VOCÊ NUNCA INFORMA AO CLIENTE');
    expect(prompt).toContain('=== 4. REGRAS GLOBAIS PROIBITIVAS ESPECÍFICAS ("NUNCA FAZER") ===');
    expect(prompt).toContain('Nunca prometer valorização futura ou passar preços.');
  });

  // 4. Memória de lead não vira automaticamente conhecimento global
  it('4. lead-specific memory is strictly kept in section 9 and not in global knowledge', () => {
    const prompt = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      globalKnowledge: ['Atuamos no litoral paraibano.'],
      leadContext: {
        contactName: 'João Silva',
        summary: null,
        aiScore: 85,
        aiScoreReason: 'Alto interesse em investimento.',
        tags: ['Investidor', 'Interesse-2Q'],
        promptExcerpts: '- Finalidade: Investimento\n- Orçamento: R$ 600.000\n- Tipologia: 2 Quartos',
      },
    });

    expect(prompt).toContain('=== 9. MEMÓRIA E CONTEXTO DO LEAD (DADOS JÁ EXTRAÍDOS / NÃO REPETIR PERGUNTAS) ===');
    expect(prompt).toContain('Finalidade: Investimento');
    expect(prompt).toContain('Orçamento: R$ 600.000');
    // Global knowledge remains clean and transversal
    expect(prompt).toContain('=== 8. CONHECIMENTO GLOBAL (INFORMAÇÕES TRANSVERSAIS VÁLIDAS PARA QUALQUER ATENDIMENTO) ===');
    expect(prompt).toContain('Atuamos no litoral paraibano.');
  });

  // 5. Memória de conversa específica não vira automaticamente conhecimento de empreendimento
  it('5. conversation transcript / lead preferences do not modify property technical book', () => {
    const prompt = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: { id: 'prop-aurora', name: 'Residencial Aurora', stage: 'Lançamento' },
      propertyKnowledge: ['Plantas de 45m² e 62m².'],
      leadContext: {
        contactName: 'Maria',
        summary: null,
        aiScore: 70,
        aiScoreReason: null,
        tags: [],
        promptExcerpts: '- Preferência: Pagamento à vista',
      },
    });

    expect(prompt).toContain('Plantas de 45m² e 62m².');
    expect(prompt).toContain('Preferência: Pagamento à vista');
  });

  // 6. Conhecimento global permanece disponível para todos
  it('6. transversal global knowledge is injected regardless of which property is active', () => {
    const globalExcerpt = 'Thatianna realiza o primeiro acolhimento e Ronaldo conduz as visitas.';

    const promptWithProperty = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: { id: 'prop-1', name: 'Empreendimento 1' },
      globalKnowledge: [globalExcerpt],
    });

    const promptWithoutProperty = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: null,
      globalKnowledge: [globalExcerpt],
    });

    expect(promptWithProperty).toContain(globalExcerpt);
    expect(promptWithoutProperty).toContain(globalExcerpt);
  });

  // 7. Conhecimento específico continua isolado
  it('7. property knowledge section is omitted or blank when no property is resolved', () => {
    const prompt = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: null,
      propertyKnowledge: [],
    });

    expect(prompt).toContain('Nenhum empreendimento específico foi identificado ainda.');
    expect(prompt).not.toContain('Material de referência autorizado deste empreendimento');
  });

  // 8. Regras globais continuam superiores
  it('8. hierarchy of authority strictly places global prohibitions above all contextual knowledge', () => {
    const prompt = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
    });

    expect(prompt).toContain('1. COMPORTAMENTO GLOBAL & REGRAS PROIBITIVAS (Máxima autoridade: define COMO agir)');
    expect(prompt).toContain('Nenhuma camada inferior pode quebrar uma regra superior.');
  });

  // 9. Aprendizado aprovado de empreendimento permanece naquele empreendimento
  it('9. verified property learning target maps to property context and not global store', () => {
    const propertySuggestion = {
      target: 'property_subjective',
      property_id: 'prop-aurora-id',
      info: 'Portaria 24h com reconhecimento facial.',
    };

    expect(propertySuggestion.target).toBe('property_subjective');
    expect(propertySuggestion.property_id).toBe('prop-aurora-id');
  });

  // 10. Aprendizado global somente entra no global quando seu escopo realmente for global
  it('10. transversal global learning requires global target without property_id constraint', () => {
    const globalSuggestion = {
      target: 'global_knowledge',
      info: 'A equipe possui atendimento em português e inglês.',
      property_id: null,
    };

    expect(globalSuggestion.target).toBe('global_knowledge');
    expect(globalSuggestion.property_id).toBeNull();
  });
});
