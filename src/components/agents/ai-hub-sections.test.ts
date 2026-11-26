import { describe, expect, it } from 'vitest';
import {
  AI_HUB_RAIL_GROUPS,
  AI_HUB_SECTION_META,
  AI_HUB_SECTIONS,
  getVisibleAiHubSections,
  resolveAiHubSection,
  UNIFIED_SUGGESTION_CATEGORIES,
} from './ai-hub-sections';

describe('ai-hub-sections (9 sections, RBAC, deep-links, Decision 3)', () => {
  it('defines the exact 9 approved sections across 2 groups', () => {
    expect(AI_HUB_SECTIONS).toEqual([
      'overview',
      'knowledge',
      'behavior',
      'playground',
      'evolution',
      'suggestions',
      'providers',
      'credentials',
      'usage',
    ]);
    expect(AI_HUB_RAIL_GROUPS.map((g) => g.label)).toEqual([
      'GESTÃO DA IA',
      'INFRAESTRUTURA',
    ]);

    const management = AI_HUB_SECTIONS.filter(
      (s) => AI_HUB_SECTION_META[s].group === 'management',
    );
    const infrastructure = AI_HUB_SECTIONS.filter(
      (s) => AI_HUB_SECTION_META[s].group === 'infrastructure',
    );
    expect(management).toEqual([
      'overview',
      'knowledge',
      'behavior',
      'playground',
      'evolution',
      'suggestions',
    ]);
    expect(infrastructure).toEqual(['providers', 'credentials', 'usage']);
  });

  it('excludes learning and followup from UNIFIED_SUGGESTION_CATEGORIES (Decision 3)', () => {
    expect(UNIFIED_SUGGESTION_CATEGORIES).toEqual([
      'pipeline_move',
      'action',
      'inconsistency',
      'other',
    ]);
    expect(UNIFIED_SUGGESTION_CATEGORIES).not.toContain('learning');
    expect(UNIFIED_SUGGESTION_CATEGORIES).not.toContain('followup');
  });

  it('routes ?contact= deep-links to suggestions when no explicit tab is given', () => {
    expect(
      resolveAiHubSection(null, { hasContactFilter: true, canAccessInfrastructure: false }),
    ).toBe('suggestions');
    expect(
      resolveAiHubSection(null, { hasContactFilter: false, canAccessInfrastructure: true }),
    ).toBe('overview');
  });

  it('enforces adminOnly restriction for Infrastructure sections', () => {
    for (const restricted of ['providers', 'credentials', 'usage'] as const) {
      expect(
        resolveAiHubSection(restricted, { canAccessInfrastructure: false }),
      ).toBe('overview');
      expect(
        resolveAiHubSection(restricted, { canAccessInfrastructure: true }),
      ).toBe(restricted);
    }

    expect(getVisibleAiHubSections(false)).toHaveLength(6);
    expect(getVisibleAiHubSections(true)).toHaveLength(9);
  });

  it('maps legacy tab aliases safely while respecting RBAC', () => {
    expect(resolveAiHubSection('setup', { canAccessInfrastructure: true })).toBe('credentials');
    expect(resolveAiHubSection('setup', { canAccessInfrastructure: false })).toBe('overview');
    expect(resolveAiHubSection('ai-agents', { canAccessInfrastructure: false })).toBe('overview');
    expect(resolveAiHubSection('unknown-tab', { canAccessInfrastructure: true })).toBe('overview');
  });
});
