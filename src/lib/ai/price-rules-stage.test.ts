import { describe, it, expect } from 'vitest';
import { buildConversationalSystemPrompt } from './prompt-builder';
import type { AiConfig } from './types';

const BASE_CONFIG: AiConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
  enabled: true,
  autoReplyEnabled: true,
};

describe('Conversational AI — Stage-Based Price Rules', () => {
  it('1. blocks price disclosure for pre_lancamento (Pré-Lançamento)', () => {
    const prompt = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: {
        id: 'prop-1',
        name: 'Residencial Aurora',
        stage: 'pre_lancamento',
      },
      propertyKnowledge: ['Apartamentos de 2 quartos no Bessa. Tabela estimada R$ 450.000.'],
    });

    expect(prompt).toContain('PREÇO É DADO DINÂMICO E VOCÊ NUNCA INFORMA AO CLIENTE');
    expect(prompt).toContain('Para empreendimentos em Pré-Lançamento, Lançamento ou com status não identificado, NUNCA informe preços');
    expect(prompt).not.toContain('EXCEÇÃO PARA IMÓVEL PRONTO');
  });

  it('2. blocks price disclosure for lancamento (Lançamento)', () => {
    const prompt = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: {
        id: 'prop-2',
        name: 'Avant Home',
        stage: 'Lançamento',
      },
      propertyKnowledge: ['Studios compactos em Intermares.'],
    });

    expect(prompt).toContain('PREÇO É DADO DINÂMICO E VOCÊ NUNCA INFORMA AO CLIENTE');
    expect(prompt).toContain('Para empreendimentos em Pré-Lançamento, Lançamento ou com status não identificado, NUNCA informe preços');
    expect(prompt).not.toContain('EXCEÇÃO PARA IMÓVEL PRONTO');
  });

  it('3. blocks price disclosure when property stage is undefined/null or missing', () => {
    const promptWithoutStage = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: {
        id: 'prop-3',
        name: 'Empreendimento Sem Estagio',
        stage: null,
      },
    });

    expect(promptWithoutStage).toContain('PREÇO É DADO DINÂMICO E VOCÊ NUNCA INFORMA AO CLIENTE');
    expect(promptWithoutStage).not.toContain('EXCEÇÃO PARA IMÓVEL PRONTO');

    const promptWithoutProperty = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: null,
    });

    expect(promptWithoutProperty).toContain('PREÇO É DADO DINÂMICO E VOCÊ NUNCA INFORMA AO CLIENTE');
    expect(promptWithoutProperty).not.toContain('EXCEÇÃO PARA IMÓVEL PRONTO');
  });

  it('4. permits price disclosure for pronto / Pronto para Morar when present in knowledge', () => {
    const promptPronto = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: {
        id: 'prop-4',
        name: 'Puerto Ventura',
        stage: 'Pronto para Morar',
      },
      propertyKnowledge: [
        'Unidade 402 pronta para morar com vista mar. Preço: R$ 680.000,00. Condomínio: R$ 550,00.',
      ],
    });

    expect(promptPronto).toContain('1. PREÇO E VALORES (PERMITIDO PARA IMÓVEL PRONTO SE PRESENTE NO CONHECIMENTO):');
    expect(promptPronto).toContain('EXCEÇÃO PARA IMÓVEL PRONTO: Este empreendimento está no estágio PRONTO');
    expect(promptPronto).toContain('Você PODE informar o preço/valor do imóvel ao cliente com naturalidade quando ele perguntar, DESDE QUE o preço esteja expressamente disponível no conhecimento/contexto autorizado');
    expect(promptPronto).toContain('Se o preço NÃO constar no material/conhecimento autorizado deste empreendimento, você NUNCA deve inventar, estimar ou supor valores');
    expect(promptPronto).not.toContain('PREÇO É DADO DINÂMICO E VOCÊ NUNCA INFORMA AO CLIENTE');
  });

  it('5. supports raw "pronto" code value in stage', () => {
    const promptRawPronto = buildConversationalSystemPrompt({
      config: BASE_CONFIG,
      mode: 'auto_reply',
      property: {
        id: 'prop-5',
        name: 'Edifício Cabo Branco',
        stage: 'pronto',
      },
      propertyKnowledge: ['Valor de venda: R$ 520.000.'],
    });

    expect(promptRawPronto).toContain('1. PREÇO E VALORES (PERMITIDO PARA IMÓVEL PRONTO SE PRESENTE NO CONHECIMENTO):');
    expect(promptRawPronto).toContain('Você PODE informar o preço/valor do imóvel ao cliente com naturalidade');
  });
});
