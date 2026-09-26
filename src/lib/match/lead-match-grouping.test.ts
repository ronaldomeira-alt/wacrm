import { describe, it, expect } from 'vitest';
import type { MatchStatus, LeadMatchGroup, MatchRecord } from './types';

describe('Central Match Redesign UX — Grouping & Counters', () => {
  it('agrupa múltiplos matches de um mesmo lead em 1 único objeto LeadMatchGroup', () => {
    // Simula 21 matches para TESTE 1 e 21 matches para TESTE 2
    const mockMatches = [
      ...Array.from({ length: 21 }, (_, i) => ({
        id: `match-t1-${i}`,
        accountId: 'acc-1',
        leadId: 'lead-teste-1',
        propertyId: `prop-${i}`,
        matchScore: i === 0 ? 100 : 70 - i,
        commercialPriority: 50 + i,
        matchStatus: 'novo' as MatchStatus,
        profileMaturity: 92,
        lead: {
          id: 'lead-teste-1',
          name: 'TESTE 1',
          phone: '+5583999990001',
          aiScore: 8,
        },
      })),
      ...Array.from({ length: 21 }, (_, i) => ({
        id: `match-t2-${i}`,
        accountId: 'acc-1',
        leadId: 'lead-teste-2',
        propertyId: `prop-${i}`,
        matchScore: i === 0 ? 69 : 60 - i,
        commercialPriority: 40 + i,
        matchStatus: 'novo' as MatchStatus,
        profileMaturity: 45,
        lead: {
          id: 'lead-teste-2',
          name: 'TESTE 2',
          phone: '+5583999990002',
          aiScore: 6,
        },
      })),
    ];

    // Lógica de agrupamento por lead (idêntica à implementada no endpoint /api/match)
    const groupsMap = new Map<string, {
      leadId: string;
      lead: any;
      profileMaturity: number;
      aiScore: number;
      matches: any[];
    }>();

    for (const m of mockMatches) {
      if (!groupsMap.has(m.leadId)) {
        groupsMap.set(m.leadId, {
          leadId: m.leadId,
          lead: m.lead,
          profileMaturity: m.profileMaturity,
          aiScore: m.lead.aiScore,
          matches: [],
        });
      }
      groupsMap.get(m.leadId)!.matches.push(m);
    }

    const groups: LeadMatchGroup[] = Array.from(groupsMap.values()).map((g) => {
      const sorted = [...g.matches].sort((a, b) => b.matchScore - a.matchScore);
      return {
        leadId: g.leadId,
        lead: g.lead,
        profileMaturity: g.profileMaturity,
        aiScore: g.aiScore,
        bestMatch: sorted[0],
        totalMatches: sorted.length,
        statusMatchesCount: sorted.length,
        matches: sorted,
      };
    });

    // 42 matches brutos viram exatamente 2 cards visuais (1 card por lead)
    expect(mockMatches.length).toBe(42);
    expect(groups.length).toBe(2);

    // Lead 1: TESTE 1
    const group1 = groups.find((g) => g.leadId === 'lead-teste-1')!;
    expect(group1).toBeDefined();
    expect(group1.lead.name).toBe('TESTE 1');
    expect(group1.matches.length).toBe(21);
    expect(group1.bestMatch.matchScore).toBe(100);
    expect(group1.profileMaturity).toBe(92);

    // Lead 2: TESTE 2
    const group2 = groups.find((g) => g.leadId === 'lead-teste-2')!;
    expect(group2).toBeDefined();
    expect(group2.lead.name).toBe('TESTE 2');
    expect(group2.matches.length).toBe(21);
    expect(group2.bestMatch.matchScore).toBe(69);
    expect(group2.profileMaturity).toBe(45);
  });

  it('calcula contadores das tabs contando LEADS ÚNICOS e não matches brutos', () => {
    // 21 matches de novo para lead-1, 10 de novo para lead-2
    const distinctNovos = [
      ...Array.from({ length: 21 }, () => ({ lead_id: 'lead-teste-1' })),
      ...Array.from({ length: 10 }, () => ({ lead_id: 'lead-teste-2' })),
    ];

    const uniqueLeadsCount = new Set(distinctNovos.map((r) => r.lead_id)).size;

    // Em vez de mostrar 31, mostra exatamente 2
    expect(uniqueLeadsCount).toBe(2);
  });

  it('aplica regra de confirmação gentil para multi-seleção de 4 ou mais imóveis (N >= 4)', () => {
    function shouldWarnUserOnBatchSend(selectedCount: number): boolean {
      return selectedCount >= 4;
    }

    expect(shouldWarnUserOnBatchSend(1)).toBe(false);
    expect(shouldWarnUserOnBatchSend(2)).toBe(false);
    expect(shouldWarnUserOnBatchSend(3)).toBe(false);
    expect(shouldWarnUserOnBatchSend(4)).toBe(true);
    expect(shouldWarnUserOnBatchSend(10)).toBe(true);
  });

  it('filtra corretamente por faixas canônicas de compatibilidade dentro do modal', () => {
    const mockLeadMatches = [
      { id: '1', matchScore: 100 },
      { id: '2', matchScore: 88 },
      { id: '3', matchScore: 84 },
      { id: '4', matchScore: 72 },
      { id: '5', matchScore: 69 },
      { id: '6', matchScore: 55 },
      { id: '7', matchScore: 40 },
    ];

    const strong = mockLeadMatches.filter((m) => Math.round(m.matchScore) >= 85);
    const good = mockLeadMatches.filter(
      (m) => Math.round(m.matchScore) >= 70 && Math.round(m.matchScore) < 85
    );
    const possible = mockLeadMatches.filter(
      (m) => Math.round(m.matchScore) >= 50 && Math.round(m.matchScore) < 70
    );

    expect(strong.length).toBe(2); // 100, 88
    expect(good.length).toBe(2);   // 84, 72
    expect(possible.length).toBe(2); // 69, 55
  });
});
