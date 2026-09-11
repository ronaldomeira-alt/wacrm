import { describe, it, expect } from 'vitest';
import { buildConversationalSystemPrompt } from './prompt-builder';
import type { AiConfig } from './types';

function makeConfig(): AiConfig {
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
  } as AiConfig;
}

describe('Parte 6 — price/data lock while a property is provisional', () => {
  it('never releases price for a provisional property, even at stage "pronto"', () => {
    const prompt = buildConversationalSystemPrompt({
      config: makeConfig(),
      mode: 'auto_reply',
      property: { id: 'p1', name: 'Residencial Aprendendo', stage: 'Pronto para Morar', status: 'provisorio' },
      propertyKnowledge: ['[Origem: Visão do Corretor]\nO valor mencionado em conversa foi R$ 350.000.'],
    });

    expect(prompt).not.toContain('PERMITIDO PARA IMÓVEL PRONTO');
    expect(prompt).toContain('PREÇO É DADO DINÂMICO E VOCÊ NUNCA INFORMA AO CLIENTE');
    expect(prompt).toContain('Em aprendizagem');
    expect(prompt).toContain('NENHUM dado sobre ele é considerado confirmado');
  });

  it('still allows the "pronto" price exception for an active (non-provisional) property', () => {
    const prompt = buildConversationalSystemPrompt({
      config: makeConfig(),
      mode: 'auto_reply',
      property: { id: 'p2', name: 'Puerto Ventura', stage: 'Pronto para Morar', status: 'ativo' },
      propertyKnowledge: ['[Origem: Ficha Técnica]\nValor a partir de R$ 400.000.'],
    });

    expect(prompt).toContain('PERMITIDO PARA IMÓVEL PRONTO');
    expect(prompt).not.toContain('Em aprendizagem');
  });

  it('defaults to the strict price rule when status is absent (backward compatible)', () => {
    const prompt = buildConversationalSystemPrompt({
      config: makeConfig(),
      mode: 'auto_reply',
      property: { id: 'p3', name: 'Avant Home', stage: 'Lançamento' },
      propertyKnowledge: [],
    });

    expect(prompt).toContain('PREÇO É DADO DINÂMICO E VOCÊ NUNCA INFORMA AO CLIENTE');
    expect(prompt).not.toContain('Em aprendizagem');
  });
});
