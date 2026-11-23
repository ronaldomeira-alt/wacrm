import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LeadMatchGroup } from '@/lib/match/types';
import { LeadMatchCard } from './lead-match-card';

function makeGroup(overrides: Partial<LeadMatchGroup> = {}): LeadMatchGroup {
  return {
    leadId: 'lead-123',
    lead: {
      id: 'lead-123',
      name: 'Carlos Henrique',
      phone: '5583991234567',
      aiScore: 8,
    },
    profileMaturity: 85,
    aiScore: 8,
    totalMatches: 2,
    statusMatchesCount: 2,
    isUnread: false,
    isRecent: true,
    latestMatchAt: '2026-11-22T18:00:00Z',
    matches: [],
    bestMatch: {
      id: 'match-1',
      account_id: 'acc-1',
      lead_id: 'lead-123',
      property_id: 'prop-1',
      match_score: 95,
      match_status: 'novo',
      property: {
        propertyId: 'prop-1',
        title: 'Live Park Bessa',
        neighborhood: 'Bessa',
        city: 'João Pessoa',
        priceMin: 650000,
        coverUrl: null,
      },
    } as unknown as LeadMatchGroup['bestMatch'],
    ...overrides,
  };
}

function collectButtonElements(node: unknown, out: Array<React.ReactElement<{ onClick?: () => void; disabled?: boolean; children?: unknown }>> = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectButtonElements(child, out);
    return out;
  }
  const el = node as React.ReactElement<{ children?: unknown; onClick?: () => void; disabled?: boolean }>;
  if (el.type && (el.type === 'button' || (typeof el.type === 'function' && (el.type as { name?: string }).name === 'Button'))) {
    out.push(el);
  }
  if (el.props?.children) {
    collectButtonElements(el.props.children, out);
  }
  return out;
}

function textOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') {
    const el = node as React.ReactElement<{ children?: unknown }>;
    return textOf(el.props?.children);
  }
  return '';
}

describe('LeadMatchCard — Redesigned Actions & Semantics', () => {
  it('renderiza os três botões do rodapé na ordem obrigatória IGNORAR | ARQUIVAR | ENVIAR e sem "Em análise" no rodapé', () => {
    const html = renderToStaticMarkup(
      React.createElement(LeadMatchCard, {
        group: makeGroup(),
        activeTab: 'novo',
        onOpenModal: vi.fn(),
        onQuickAction: vi.fn(),
        onSmartSend: vi.fn(),
      })
    );

    const footerIdx = html.indexOf('data-testid="match-card-footer-actions"');
    expect(footerIdx).toBeGreaterThan(-1);
    const footerHtml = html.slice(footerIdx);

    const ignoreIdx = footerHtml.indexOf('Ignorar');
    const archiveIdx = footerHtml.indexOf('Arquivar');
    const sendIdx = footerHtml.indexOf('Enviar');

    expect(ignoreIdx).toBeGreaterThan(-1);
    expect(archiveIdx).toBeGreaterThan(ignoreIdx);
    expect(sendIdx).toBeGreaterThan(archiveIdx);
    expect(footerHtml).not.toContain('Em análise');
    expect(footerHtml).toContain('grid-cols-3');
  });

  it('preserva indicação discreta de estado "Em análise" fora do rodapé', () => {
    const html = renderToStaticMarkup(
      React.createElement(LeadMatchCard, {
        group: makeGroup(),
        activeTab: 'em_analise',
        onOpenModal: vi.fn(),
        onQuickAction: vi.fn(),
        onSmartSend: vi.fn(),
      })
    );

    expect(html).toContain('data-testid="match-in-analysis-badge"');
    const footerHtml = html.slice(html.indexOf('data-testid="match-card-footer-actions"'));
    expect(footerHtml).not.toContain('Em análise');
  });

  it('dispara os callbacks corretos para Ignorar, Arquivar e Enviar sem abrir modal', () => {
    const group = makeGroup();
    const onOpenModal = vi.fn();
    const onQuickAction = vi.fn();
    const onSmartSend = vi.fn();

    const tree = LeadMatchCard({
      group,
      activeTab: 'novo',
      onOpenModal,
      onQuickAction,
      onSmartSend,
    });

    const buttons = collectButtonElements(tree);
    const ignoreBtn = buttons.find((b) => textOf(b).includes('Ignorar'));
    const archiveBtn = buttons.find((b) => textOf(b).includes('Arquivar'));
    const sendBtn = buttons.find((b) => textOf(b).includes('Enviar'));

    expect(ignoreBtn).toBeDefined();
    expect(archiveBtn).toBeDefined();
    expect(sendBtn).toBeDefined();

    ignoreBtn?.props.onClick?.();
    expect(onQuickAction).toHaveBeenCalledWith(group, 'ignore', 'lead');

    archiveBtn?.props.onClick?.();
    expect(onQuickAction).toHaveBeenCalledWith(group, 'archive', 'lead');

    sendBtn?.props.onClick?.();
    expect(onSmartSend).toHaveBeenCalledWith(group);
    expect(onOpenModal).not.toHaveBeenCalled();
  });

  it('bloqueia cliques repetidos e exibe "Preparando" durante preparação assíncrona do envio', () => {
    const group = makeGroup();
    const tree = LeadMatchCard({
      group,
      activeTab: 'novo',
      preparingSendLeadId: 'lead-123',
      onOpenModal: vi.fn(),
      onQuickAction: vi.fn(),
      onSmartSend: vi.fn(),
    });

    const buttons = collectButtonElements(tree);
    const ignoreBtn = buttons.find((b) => textOf(b).includes('Ignorar'));
    const archiveBtn = buttons.find((b) => textOf(b).includes('Arquivar'));
    const sendBtn = buttons.find((b) => textOf(b).includes('Preparando'));

    expect(ignoreBtn?.props.disabled).toBe(true);
    expect(archiveBtn?.props.disabled).toBe(true);
    expect(sendBtn?.props.disabled).toBe(true);
  });

  it('mantém Restaurar para abas inativas (arquivado/ignorado)', () => {
    const html = renderToStaticMarkup(
      React.createElement(LeadMatchCard, {
        group: makeGroup(),
        activeTab: 'arquivado',
        onOpenModal: vi.fn(),
        onQuickAction: vi.fn(),
      })
    );

    expect(html).toContain('Restaurar');
    expect(html).not.toContain('data-testid="match-card-footer-actions"');
  });
});
