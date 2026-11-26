import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mockNav = {
  searchParams: new URLSearchParams(),
  replace: vi.fn(),
  role: 'admin' as 'owner' | 'admin' | 'agent' | 'viewer',
};

const mountedSections = new Set<string>();
let lastProvidersProps: Record<string, unknown> | null = null;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockNav.replace }),
  useSearchParams: () => mockNav.searchParams,
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountRole: mockNav.role }),
}));

vi.mock('./ai-overview-panel', () => ({
  AiOverviewPanel: () => {
    mountedSections.add('overview');
    return React.createElement('div', { 'data-testid': 'section-overview' }, 'OVERVIEW');
  },
}));
vi.mock('./property-knowledge-list', () => ({
  PropertyKnowledgeList: () => {
    mountedSections.add('knowledge-properties');
    return React.createElement('div', null, 'PROPERTIES');
  },
}));
vi.mock('./global-knowledge-section', () => ({
  GlobalKnowledgeSection: () => {
    mountedSections.add('knowledge-global');
    return React.createElement('div', null, 'GLOBAL');
  },
}));
vi.mock('./ai-behavior-settings', () => ({
  AiBehaviorSettings: () => {
    mountedSections.add('behavior');
    return React.createElement('div', null, 'BEHAVIOR');
  },
}));
vi.mock('./ai-playground', () => ({
  AiPlayground: () => {
    mountedSections.add('playground');
    return React.createElement('div', null, 'PLAYGROUND');
  },
}));
vi.mock('./ai-evolution-dashboard', () => ({
  AiEvolutionDashboard: () => {
    mountedSections.add('evolution');
    return React.createElement('div', null, 'EVOLUTION');
  },
}));
vi.mock('./ai-suggestions-panel', () => ({
  AiSuggestionsPanel: ({ contactFilter }: { contactFilter?: string | null }) => {
    mountedSections.add('suggestions');
    return React.createElement('div', null, `SUGGESTIONS:${contactFilter ?? 'none'}`);
  },
}));
vi.mock('./ai-providers', () => ({
  AiProvidersPanel: (props: Record<string, unknown>) => {
    mountedSections.add('providers');
    lastProvidersProps = props;
    return React.createElement('div', null, 'PROVIDERS');
  },
}));
vi.mock('./ai-credentials-panel', () => ({
  AiCredentialsPanel: () => {
    mountedSections.add('credentials');
    return React.createElement('div', null, 'CREDENTIALS');
  },
}));
vi.mock('./ai-usage', () => ({
  AiUsageCard: () => {
    mountedSections.add('usage');
    return React.createElement('div', null, 'USAGE');
  },
}));

import { UnifiedAiHub } from './unified-ai-hub';

describe('UnifiedAiHub (on-demand mounting, RBAC, credentials separation)', () => {
  beforeEach(() => {
    mountedSections.clear();
    lastProvidersProps = null;
    mockNav.searchParams = new URLSearchParams();
    mockNav.role = 'admin';
  });

  it('mounts ONLY the active section on demand (never inactive tabs)', () => {
    mockNav.searchParams = new URLSearchParams('tab=playground');
    const html = renderToStaticMarkup(<UnifiedAiHub isPreview />);

    expect(html).toContain('PLAYGROUND');
    expect(Array.from(mountedSections)).toEqual(['playground']);
  });

  it('passes hideCredentialInputs=true and onGoToCredentials to AiProvidersPanel (Decision 4)', () => {
    mockNav.searchParams = new URLSearchParams('tab=providers');
    const html = renderToStaticMarkup(<UnifiedAiHub />);

    expect(html).toContain('PROVIDERS');
    expect(Array.from(mountedSections)).toEqual(['providers']);
    expect(lastProvidersProps?.hideCredentialInputs).toBe(true);
    expect(typeof lastProvidersProps?.onGoToCredentials).toBe('function');
  });

  it('hides Infrastructure group and blocks direct ?tab=providers for agent/viewer roles', () => {
    mockNav.role = 'agent';
    mockNav.searchParams = new URLSearchParams('tab=providers');
    const html = renderToStaticMarkup(<UnifiedAiHub />);

    expect(html).not.toContain('INFRAESTRUTURA');
    expect(html).not.toContain('PROVIDERS');
    expect(html).toContain('OVERVIEW');
    expect(Array.from(mountedSections)).toEqual(['overview']);
  });

  it('preserves ?contact= deep-link from Inbox by routing to Suggestions with contactFilter', () => {
    mockNav.searchParams = new URLSearchParams('contact=contact-123');
    const html = renderToStaticMarkup(<UnifiedAiHub />);

    expect(html).toContain('SUGGESTIONS:contact-123');
    expect(Array.from(mountedSections)).toEqual(['suggestions']);
  });
});
