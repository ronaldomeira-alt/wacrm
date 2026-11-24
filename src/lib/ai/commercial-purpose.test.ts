import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildConversationalSystemPrompt,
  resolvePropertyCommercialPurpose,
} from './prompt-builder';
import { isReadyForPriceDisclosure } from './security-guard';
import { generateOpenCodeGo } from './providers/opencode-go';
import type { AiConfig } from './types';

const baseConfig: AiConfig = {
  provider: 'opencode_go',
  model: 'deepseek-v4.1-flash',
  apiKey: 'test-key',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 10,
  handoffAgentId: null,
  embeddingsApiKey: null,
  identityName: 'Clara',
  toneStyle: 'consultive',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolvePropertyCommercialPurpose', () => {
  it('prioritizes explicit structured purpose fields over name or text', () => {
    expect(
      resolvePropertyCommercialPurpose({
        property: { id: '1', name: 'Residencial X', purpose: 'locacao_anual' },
      }),
    ).toBe('locacao_anual');

    expect(
      resolvePropertyCommercialPurpose({
        property: { id: '2', name: 'Flat Mar - Locação', modality: 'venda' },
      }),
    ).toBe('venda');

    expect(
      resolvePropertyCommercialPurpose({
        property: { id: '3', name: 'Flat Sol', transactionType: 'temporada' },
      }),
    ).toBe('locacao_temporada');
  });

  it('detects Santa Maria and São Miguel Arcanjo as locacao_anual via Book/Visão do Corretor even without "- Locação" in name', () => {
    expect(
      resolvePropertyCommercialPurpose({
        property: {
          id: 'sm',
          name: 'Santa Maria',
          stage: 'Pronto',
          rawStage: 'pronto',
          bookExtractedText:
            '# CONHECIMENTO DO IMÓVEL — FLAT PARA LOCAÇÃO EM INTERMARES\nAluguel mensal: R$ 2.500\nPrazo de locação: exclusivamente anual, com contrato de 12 meses.',
        },
      }),
    ).toBe('locacao_anual');

    expect(
      resolvePropertyCommercialPurpose({
        property: {
          id: 'sma',
          name: 'São Miguel Arcanjo',
          stage: 'Pronto',
          rawStage: 'pronto',
          bookExtractedText: '# MEMÓRIA ESPECÍFICA — IMÓVEL PARA LOCAÇÃO\nContrato de 12 meses.',
        },
      }),
    ).toBe('locacao_anual');
  });

  it('detects sale flats pitched for Airbnb ROI (Avant Home) as venda, NOT rental', () => {
    expect(
      resolvePropertyCommercialPurpose({
        property: {
          id: 'ah',
          name: 'Avant Home',
          stage: 'Pronto',
          rawStage: 'pronto',
          bookExtractedText:
            '[Ficha Técnica - Avant Home]\n- Estágio: Pronto para morar / Aluguel por temporada\n- Investimento: R$ 270.000,00\n- Diária estimada no Airbnb: R$ 250 a R$ 350',
        },
      }),
    ).toBe('venda');
  });

  it('detects seasonal rental (temporada) when property itself is rented short-stay', () => {
    expect(
      resolvePropertyCommercialPurpose({
        property: {
          id: 't1',
          name: 'Flat Beira Mar',
          stage: 'Pronto',
          rawStage: 'pronto',
          bookExtractedText: 'Imóvel para locação por temporada em Tambaú. Diárias a partir de R$ 320.',
        },
      }),
    ).toBe('locacao_temporada');
  });

  it('returns desconhecida instead of assuming venda when no purpose signal exists', () => {
    expect(
      resolvePropertyCommercialPurpose({
        property: {
          id: 'unk',
          name: 'Edifício Horizonte',
          stage: 'Pronto',
          rawStage: 'pronto',
          bookExtractedText: 'Apartamento com 2 quartos no Bessa, a 300m do mar.',
        },
      }),
    ).toBe('desconhecida');
  });
});

describe('buildConversationalSystemPrompt commercial purpose directives', () => {
  it('injects LOCAÇÃO ANUAL directive and suppresses morar/investir for Santa Maria', () => {
    const prompt = buildConversationalSystemPrompt({
      config: baseConfig,
      mode: 'auto_reply',
      isInitialContact: true,
      property: {
        id: 'sm',
        name: 'Santa Maria',
        stage: 'Pronto',
        rawStage: 'pronto',
        bookExtractedText:
          '# CONHECIMENTO DO IMÓVEL — FLAT PARA LOCAÇÃO EM INTERMARES\nPrazo de locação: exclusivamente anual, com contrato de 12 meses.',
      },
    });

    expect(prompt).toContain('REGRA CRÍTICA DE FINALIDADE (LOCAÇÃO ANUAL)');
    expect(prompt).not.toContain('Você busca para moradia ou pensa em investimento?');
  });

  it('does not assume venda when purpose is desconhecida', () => {
    const prompt = buildConversationalSystemPrompt({
      config: baseConfig,
      mode: 'auto_reply',
      isInitialContact: true,
      property: {
        id: 'unk',
        name: 'Edifício Horizonte',
        stage: 'Pronto',
        rawStage: 'pronto',
        bookExtractedText: 'Apartamento com 2 quartos no Bessa.',
      },
    });

    expect(prompt).toContain('FINALIDADE COMERCIAL A CONFIRMAR');
    expect(prompt).not.toContain('Você busca para moradia ou pensa em investimento?');
  });

  it('authorizes rental price disclosure without anticipating caução and treats 80% as flexible', () => {
    const prompt = buildConversationalSystemPrompt({
      config: baseConfig,
      mode: 'auto_reply',
      isInitialContact: false,
      property: {
        id: 'sm',
        name: 'Santa Maria',
        stage: 'Pronto',
        rawStage: 'pronto',
        bookExtractedText:
          '# CONHECIMENTO DO IMÓVEL — FLAT PARA LOCAÇÃO EM INTERMARES\nAluguel mensal: R$ 2.500\nPrazo de locação: exclusivamente anual, com contrato de 12 meses.',
      },
    });

    expect(prompt).toContain('NÃO antecipe informações sobre caução');
    expect(prompt).toContain('referência flexível (nunca obrigação mecânica)');
    expect(prompt).toContain('evite perguntar prematuramente quando ele pretende se mudar');
  });
});

describe('isReadyForPriceDisclosure', () => {
  it('allows official rent disclosure on non-provisional rental properties even without stage "pronto"', () => {
    expect(
      isReadyForPriceDisclosure({
        name: 'Santa Maria',
        stage: null,
        commercialPurpose: 'locacao_anual',
        status: 'ativo',
      }),
    ).toBe(true);

    expect(
      isReadyForPriceDisclosure({
        name: 'Santa Maria',
        stage: 'Pronto',
        commercialPurpose: 'locacao_anual',
        status: 'provisorio',
      }),
    ).toBe(false);

    expect(
      isReadyForPriceDisclosure({
        name: 'Live Park',
        stage: 'Pré-lançamento',
        commercialPurpose: 'venda',
        status: 'ativo',
      }),
    ).toBe(false);
  });
});

describe('generateOpenCodeGo reasoning_effort and JSON retry', () => {
  it('sends reasoning_effort: "none" by default for deepseek-v4.1-flash', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"response_text":"Sim, tem dois elevadores."}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200 },
      ),
    );

    await generateOpenCodeGo({
      apiKey: 'oc_sk_test',
      model: 'deepseek-v4.1-flash',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'tem elevador?' }],
      timeoutMs: 10000,
      structuredOutputRequired: true,
    });

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1]?.body as string) || '{}');
    expect(sentBody.reasoning_effort).toBe('none');
    expect(sentBody.response_format).toEqual({ type: 'json_object' });
  });

  it('retries without response_format when json_object returns empty content', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '' } }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"response_text":"Recuperado!"}' } }],
          }),
          { status: 200 },
        ),
      );

    const res = await generateOpenCodeGo({
      apiKey: 'oc_sk_test',
      model: 'deepseek-v4.1-flash',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'oi' }],
      timeoutMs: 10000,
      structuredOutputRequired: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1]?.body as string) || '{}');
    expect(retryBody.response_format).toBeUndefined();
    expect(res.text).toContain('Recuperado!');
  });
});
