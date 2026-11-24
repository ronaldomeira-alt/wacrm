import { describe, it, expect } from 'vitest';
import {
  buildTemplateSnapshot,
  normalizeTemplateSendParams,
  resolveTemplateButtonUrl,
} from './template-snapshot';
import type { MessageTemplate } from '@/types';

const sampleTemplate: MessageTemplate = {
  id: 'tpl-1',
  user_id: 'user-1',
  name: 'match_imovel_personalizado',
  category: 'Marketing',
  language: 'pt_BR',
  header_type: undefined,
  header_content: undefined,
  body_text:
    'Olá, {{1}}! Tudo bem?\n\nEncontrei uma opção de imóvel {{2}} que pode combinar com o que você está procurando.\n\nSeparei os detalhes para você conferir. Depois me conta o que achou!',
  footer_text: undefined,
  buttons: [
    {
      type: 'URL',
      text: 'Ver imóvel',
      url: 'https://ronaldomeira.com.br/imovel/{{1}}',
      example: 'dev-bd1ac8a946d4bfb0',
    },
  ],
  status: 'APPROVED',
  meta_template_id: '1709178834005309',
  created_at: '2026-11-23T04:14:29.360Z',
};

describe('template-snapshot', () => {
  it('resolves dynamic URL button suffixes and falls back to example', () => {
    expect(
      resolveTemplateButtonUrl(
        'https://ronaldomeira.com.br/imovel/{{1}}',
        'dev-b5f7b575d7bf6c8a',
        'dev-fallback'
      )
    ).toBe('https://ronaldomeira.com.br/imovel/dev-b5f7b575d7bf6c8a');

    expect(
      resolveTemplateButtonUrl(
        'https://ronaldomeira.com.br/imovel/{{1}}',
        undefined,
        'dev-fallback'
      )
    ).toBe('https://ronaldomeira.com.br/imovel/dev-fallback');

    expect(
      resolveTemplateButtonUrl('https://ronaldomeira.com.br/static', 'ignored')
    ).toBe('https://ronaldomeira.com.br/static');
  });

  it('normalizes structured templateMessageParams and legacy templateParams', () => {
    const normalized = normalizeTemplateSendParams(
      {
        body: ['Sandra', 'de 1 quarto no bairro Bessa (Amares)'],
        buttonParams: { '0': 'dev-b5f7b575d7bf6c8a' },
      },
      ['ignored']
    );
    expect(normalized.body).toEqual([
      'Sandra',
      'de 1 quarto no bairro Bessa (Amares)',
    ]);
    expect(normalized.buttonParams).toEqual({ 0: 'dev-b5f7b575d7bf6c8a' });

    const legacy = normalizeTemplateSendParams(undefined, ['João', 'no Bessa']);
    expect(legacy.body).toEqual(['João', 'no Bessa']);
  });

  it('builds a faithful historical snapshot with substituted body, URL button, and property', () => {
    const snapshot = buildTemplateSnapshot({
      template: sampleTemplate,
      params: {
        body: ['Sandra', 'de 1 quarto no bairro Bessa (Amares)'],
        buttonParams: { 0: 'dev-b5f7b575d7bf6c8a' },
      },
      property: {
        id: 'prop-1',
        title: 'Amares',
        public_url: 'https://ronaldomeira.com.br/imovel/dev-b5f7b575d7bf6c8a',
        match_id: 'match-1',
      },
      renderedAt: '2026-11-24T18:41:37.583Z',
    });

    expect(snapshot.template_name).toBe('match_imovel_personalizado');
    expect(snapshot.meta_template_id).toBe('1709178834005309');
    expect(snapshot.body_text).toBe(
      'Olá, Sandra! Tudo bem?\n\nEncontrei uma opção de imóvel de 1 quarto no bairro Bessa (Amares) que pode combinar com o que você está procurando.\n\nSeparei os detalhes para você conferir. Depois me conta o que achou!'
    );
    expect(snapshot.buttons).toEqual([
      {
        type: 'URL',
        text: 'Ver imóvel',
        url: 'https://ronaldomeira.com.br/imovel/dev-b5f7b575d7bf6c8a',
      },
    ]);
    expect(snapshot.property).toEqual({
      id: 'prop-1',
      title: 'Amares',
      public_url: 'https://ronaldomeira.com.br/imovel/dev-b5f7b575d7bf6c8a',
      match_id: 'match-1',
    });
    expect(snapshot.rendered_at).toBe('2026-11-24T18:41:37.583Z');
  });

  it('preserves text/media headers, footers, phone, copy_code, and quick_reply buttons', () => {
    const richTemplate: MessageTemplate = {
      ...sampleTemplate,
      header_type: 'text',
      header_content: 'Novidade para {{1}}',
      footer_text: 'Ronaldo Meira Imóveis',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Quero agendar' },
        { type: 'PHONE_NUMBER', text: 'Ligar agora', phone_number: '+5583999999999' },
        { type: 'COPY_CODE', text: 'Copiar código', example: 'VIP2026' },
      ],
    };

    const snapshot = buildTemplateSnapshot({
      template: richTemplate,
      params: {
        headerText: 'Sandra',
        body: ['Sandra', 'no Bessa'],
      },
    });

    expect(snapshot.header_type).toBe('text');
    expect(snapshot.header_text).toBe('Novidade para Sandra');
    expect(snapshot.footer_text).toBe('Ronaldo Meira Imóveis');
    expect(snapshot.buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Quero agendar' },
      { type: 'PHONE_NUMBER', text: 'Ligar agora', phone_number: '+5583999999999' },
      { type: 'COPY_CODE', text: 'Copiar código', code: 'VIP2026' },
    ]);
  });
});
