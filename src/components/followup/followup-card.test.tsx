import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FollowupCard } from './followup-card';
import { CENTRAL_IA_SUGGESTION_CATEGORIES } from '@/lib/ai-suggestion-status';
import type { EnrichedFollowupItem } from '@/lib/followup/engine';
import type { AiSuggestion } from '@/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/followup',
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'pt-BR',
}));

function makeItem(overrides: Partial<EnrichedFollowupItem> = {}): EnrichedFollowupItem {
  const createdAt = '2026-11-23T12:00:00.000Z';
  const suggestion: AiSuggestion = {
    id: 'sugg-123',
    account_id: 'acc-1',
    contact_id: 'lead-123',
    conversation_id: 'conv-123',
    category: 'followup',
    title: 'Demonstrou interesse no Avant Home, buscava uma opção para locação por temporada e está há 15 dias sem responder.',
    description: 'Retomar contato verificando se ainda busca unidade no Bessa.',
    status: 'pending',
    created_at: createdAt,
    updated_at: createdAt,
    payload: {
      score: 88,
      stage_name: 'Interesse',
      hours_since_contact: 360,
      reason:
        'Demonstrou interesse no Avant Home, buscava uma opção para locação por temporada e está há 15 dias sem responder.',
      approach_summary: 'Retomar contato verificando se ainda busca unidade no Bessa.',
    },
    ...(overrides.suggestion || {}),
  };

  return {
    suggestion,
    contact: {
      id: 'lead-123',
      name: 'Fernanda Oliveira',
      phone: '5583988776655',
      avatar_url: null,
      ai_score: 9,
      ai_score_reason: 'Interesse claro no Avant Home',
      has_purchased: false,
      is_personal_whatsapp: false,
      ...(overrides.contact || {}),
    },
    stageId: 'st-1',
    stageName: 'Interesse',
    stageColor: '#10b981',
    opportunityType: 'resumption',
    profileMaturity: 85,
    aiScore: 9,
    confidenceScore: 88,
    commercialPriorityScore: 89.8,
    priorityTier: 'high',
    suggestionCreatedAt: createdAt,
    suggestionDayKeySp: '2026-11-23',
    suggestionSignificantUpdatedAt: null,
    lastCommunicationAt: '2026-11-08T12:00:00.000Z',
    hoursSinceLastCommunication: 360,
    neverContacted: false,
    reason:
      'Demonstrou interesse no Avant Home, buscava uma opção para locação por temporada e está há 15 dias sem responder.',
    approachSummary: 'Retomar contato verificando se ainda busca unidade no Bessa.',
    interestProperty: 'Avant Home',
    primaryNeed: 'Studio em Bessa (Locação por temporada)',
    lastMessagePreview: 'Gostei bastante do Avant Home.',
    compatiblePropertiesCount: 2,
    compatibleProperties: [
      {
        matchId: 'm-1',
        propertyId: 'p-1',
        title: 'Avant Home Bessa',
        neighborhood: 'Bessa',
        city: 'João Pessoa',
        operation: 'venda',
        priceMin: 490000,
        priceMax: 550000,
        bedroomsMin: 1,
        deliveryStatus: 'lancamento',
        matchScore: 94,
        commercialPriority: 88,
        matchStatus: 'novo',
        reasons: ['Localização no Bessa', 'Tipologia Studio'],
      },
    ],
    ...overrides,
  };
}

describe('Navegação Lateral e Central de IA (Seções 2 e 14)', () => {
  it('posiciona a entrada independente Follow-up imediatamente abaixo de Match e acima de Pipeline no Sidebar', () => {
    const sidebarSource = readFileSync(
      join(process.cwd(), 'src/components/layout/sidebar.tsx'),
      'utf8'
    );

    const matchIdx = sidebarSource.indexOf('href: "/match"');
    const followupIdx = sidebarSource.indexOf('href: "/followup"');
    const pipelinesIdx = sidebarSource.indexOf('href: "/pipelines"');

    expect(matchIdx).toBeGreaterThan(-1);
    expect(followupIdx).toBeGreaterThan(matchIdx);
    expect(pipelinesIdx).toBeGreaterThan(followupIdx);
  });

  it('remove apenas a categoria followup da Central de IA mantendo Movimentações de pipeline e Aprendizados pendentes', () => {
    expect(CENTRAL_IA_SUGGESTION_CATEGORIES).not.toContain('followup');
    expect(CENTRAL_IA_SUGGESTION_CATEGORIES).toContain('pipeline_move');
    expect(CENTRAL_IA_SUGGESTION_CATEGORIES).toContain('learning');
    expect(CENTRAL_IA_SUGGESTION_CATEGORIES).toContain('action');
    expect(CENTRAL_IA_SUGGESTION_CATEGORIES).toContain('inconsistency');
  });
});

describe('FollowupCard — Estrutura Visual, Indicadores e Ações (Seções 4, 5, 9 e 14)', () => {
  it('renderiza identificação completa, etapa do pipeline, tipo da oportunidade, motivo, empreendimento, confiança, maturidade e score IA', () => {
    const html = renderToStaticMarkup(
      React.createElement(FollowupCard, {
        item: makeItem(),
        onUpdateStatus: vi.fn(),
      })
    );

    expect(html).toContain('Fernanda Oliveira');
    expect(html).toContain('5583988776655');
    expect(html).toContain('Interesse');
    expect(html).toContain('Retomada de contato');
    expect(html).toContain('85%');
    expect(html).toContain('9/10');
    expect(html).toContain('88% confiança');
    expect(html).toContain('Avant Home');
    expect(html).not.toContain('Necessidade principal');
    expect(html).toContain('está há 15 dias sem responder');
    expect(html).toContain('2 imóveis compatíveis no Match');
  });

  it('exibe explicitamente a condição "Nunca contatado" e badge "Primeiro contato" para leads sem histórico de comunicação', () => {
    const html = renderToStaticMarkup(
      React.createElement(FollowupCard, {
        item: makeItem({
          neverContacted: true,
          lastCommunicationAt: null,
          hoursSinceLastCommunication: null,
          opportunityType: 'first_contact',
        }),
        onUpdateStatus: vi.fn(),
      })
    );

    expect(html).toContain('data-testid="followup-never-contacted"');
    expect(html).toContain('Nunca contatado');
    expect(html).toContain('Primeiro contato');
  });

  it('renderiza os três botões do rodapé alinhados na ordem IGNORAR | ACEITAR | ENVIAR com destaque verde em Enviar', () => {
    const html = renderToStaticMarkup(
      React.createElement(FollowupCard, {
        item: makeItem(),
        onUpdateStatus: vi.fn(),
      })
    );

    const footerIdx = html.indexOf('data-testid="followup-card-footer-actions"');
    expect(footerIdx).toBeGreaterThan(-1);
    const footerHtml = html.slice(footerIdx);

    const ignoreIdx = footerHtml.indexOf('Ignorar');
    const acceptIdx = footerHtml.indexOf('Aceitar');
    const sendIdx = footerHtml.indexOf('Enviar');

    expect(ignoreIdx).toBeGreaterThan(-1);
    expect(acceptIdx).toBeGreaterThan(ignoreIdx);
    expect(sendIdx).toBeGreaterThan(acceptIdx);
    expect(footerHtml).toContain('grid-cols-3');
    expect(footerHtml).toContain('bg-emerald-600');
  });

  it('exibe botão Restaurar para sugestões no estado ignorado', () => {
    const item = makeItem();
    item.suggestion.status = 'ignored';

    const html = renderToStaticMarkup(
      React.createElement(FollowupCard, {
        item,
        onUpdateStatus: vi.fn(),
      })
    );

    expect(html).toContain('Restaurar');
    expect(html).not.toContain('data-testid="followup-card-footer-actions"');
  });

  it('preserva o comportamento dos botões Ignorar, Aceitar e Enviar (abrindo o modal sem envio automático) e a responsividade mobile/desktop', () => {
    const cardSource = readFileSync(
      join(process.cwd(), 'src/components/followup/followup-card.tsx'),
      'utf8'
    );
    const pageSource = readFileSync(
      join(process.cwd(), 'src/app/(dashboard)/followup/page.tsx'),
      'utf8'
    );
    const dialogSource = readFileSync(
      join(process.cwd(), 'src/components/ai-hub/followup-dialog.tsx'),
      'utf8'
    );

    // 1. Ações dos 3 botões no FollowupCard
    expect(cardSource).toContain("handleStatusAction('ignored')");
    expect(cardSource).toContain("handleStatusAction('approved')");
    expect(cardSource).toContain('onClick={handleOpenSendModal}');
    expect(cardSource).toContain('setFollowupOpen(true)');
    expect(cardSource).not.toContain('/api/whatsapp/send');

    // 2. Preservação integral dos fluxos redesenhados do FollowupDialog (review, prepare_free, prepare_template, template_blocked)
    expect(dialogSource).toContain("step === 'review'");
    expect(dialogSource).toContain("step === 'prepare_free'");
    expect(dialogSource).toContain("step === 'prepare_template'");
    expect(dialogSource).toContain("step === 'template_blocked'");
    expect(dialogSource).toContain('FOLLOWUP_REQUIRED_TEMPLATE_NAME');
    expect(dialogSource).toContain('data-testid="followup-dialog-compatible-properties"');

    // 3. Responsividade: grid de 3 colunas no desktop, 2 intermediárias, 1 no mobile + limitação visual de textos
    expect(pageSource).toContain('grid-cols-1 md:grid-cols-2 lg:grid-cols-3');
    expect(cardSource).toContain('line-clamp-4');
    expect(cardSource).toContain('grid-cols-3 gap-2');

    // 4. Fila padrão sincronizada com o Dashboard ('all'), sem banner burocrático antigo, e miniaturas reais no modal
    expect(pageSource).toContain("DEFAULT_DATE_FILTER: FollowupDateFilter = 'all'");
    expect(pageSource).not.toContain('followup-older-pending-banner');
    expect(pageSource).not.toContain('cujo cliente falou em');
    expect(pageSource).toContain('Ontem não tivemos nenhuma sugestão de follow-up.');
    expect(pageSource).toContain('Hoje ainda não temos sugestões de follow-up.');
    expect(dialogSource).toContain('data-testid="followup-property-thumbnail-img"');
    expect(dialogSource).toContain('Imóveis selecionados para recomendar');
  });

  it('exibe discretamente o estado real da janela de atendimento de 24h (Janela aberta, Janela prestes a encerrar, Template necessário)', () => {
    const htmlClosingSoon = renderToStaticMarkup(
      React.createElement(FollowupCard, {
        item: makeItem({
          sessionWindow: {
            status: 'closing_soon',
            windowOpen: true,
            closingSoon: true,
            templateRequired: false,
            remainingMs: 2 * 60 * 60 * 1000,
            remainingLabel: '2h restantes',
            isCtwaLead: true,
            ctwaFreeBenefitActive: true,
            ctwaFreeBenefitExpiresAt: null,
            ctwaFreeBenefitRemainingLabel: 'CTWA gratuito: 40h restantes',
          },
        }),
        onUpdateStatus: vi.fn(),
      })
    );
    expect(htmlClosingSoon).toContain('Janela prestes a encerrar');
    expect(htmlClosingSoon).toContain('2h restantes');
    expect(htmlClosingSoon).toContain('CTWA gratuito: 40h restantes');

    const htmlExpired = renderToStaticMarkup(
      React.createElement(FollowupCard, {
        item: makeItem({
          sessionWindow: {
            status: 'expired',
            windowOpen: false,
            closingSoon: false,
            templateRequired: true,
            remainingMs: 0,
            remainingLabel: null,
            isCtwaLead: false,
            ctwaFreeBenefitActive: false,
            ctwaFreeBenefitExpiresAt: null,
            ctwaFreeBenefitRemainingLabel: null,
          },
        }),
        onUpdateStatus: vi.fn(),
      })
    );
    expect(htmlExpired).toContain('Template necessário');
  });

  it('Etapa 2 — exibe último contato em dias completos (ex.: 86h -> "Há 3 dias", nunca "há 86 horas") e valida layout responsivo Desktop (+50% largura, cards lado a lado) e PWA iPhone', () => {
    const html86h = renderToStaticMarkup(
      React.createElement(FollowupCard, {
        item: makeItem({
          lastCustomerMessageAt: undefined,
          lastCommunicationAt: null,
          hoursSinceLastCommunication: 86,
          hoursSinceLastCustomerMessage: 86,
          neverContacted: false,
        }),
        onUpdateStatus: vi.fn(),
      })
    );
    expect(html86h).toContain('Há 3 dias');
    expect(html86h).not.toContain('86h');
    expect(html86h).not.toContain('86 horas');

    const dialogSource = readFileSync(
      join(process.cwd(), 'src/components/ai-hub/followup-dialog.tsx'),
      'utf8'
    );

    // Desktop +50% largura (sm:max-w-2xl md:max-w-3xl lg:max-w-4xl) e PWA iPhone sem overflow horizontal + safe area
    expect(dialogSource).toContain('sm:max-w-2xl md:max-w-3xl lg:max-w-4xl');
    expect(dialogSource).toContain('w-[calc(100vw-1rem)] max-w-full');
    expect(dialogSource).toContain('overflow-x-hidden');
    expect(dialogSource).toContain('env(safe-area-inset-bottom)');

    // Cards de imóveis lado a lado no desktop e empilhados na PWA iPhone, exibindo metragem (m²), quartos, valor e % compatível
    expect(dialogSource).toContain('grid-cols-1 md:grid-cols-3');
    expect(dialogSource).toContain('grid-cols-1 md:grid-cols-2');
    expect(dialogSource).toContain('data-testid="followup-property-area-badge"');
    expect(dialogSource).toContain('data-testid="followup-property-bedrooms-badge"');
    expect(dialogSource).toContain('data-testid="followup-property-score-badge"');
    expect(dialogSource).toContain('data-testid="followup-dialog-last-contact"');
    expect(dialogSource).not.toContain('Necessidade principal');
    expect(dialogSource).not.toContain('Sugestão de abordagem');
  });
});
