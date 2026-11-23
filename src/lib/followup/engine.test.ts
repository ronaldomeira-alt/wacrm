import { describe, expect, it } from 'vitest';
import {
  calculateFollowupCommercialPriority,
  classifyFollowupTimingAndType,
  compareFollowupItems,
  extractInterestProperty,
  extractLeadPrimaryNeed,
  filterFollowupItems,
  matchesFollowupDateFilter,
  resolveFollowupDateFilterRange,
  type EnrichedFollowupItem,
} from './engine';
import type { AiSuggestion } from '@/types';

function makeFollowupItem(overrides: Partial<EnrichedFollowupItem> = {}): EnrichedFollowupItem {
  const id = overrides.suggestion?.id || 'sugg-1';
  const createdAt = overrides.suggestionCreatedAt || '2026-11-23T14:00:00.000Z';
  const suggestion: AiSuggestion = {
    id,
    account_id: 'acc-1',
    contact_id: 'contact-1',
    conversation_id: 'conv-1',
    category: 'followup',
    title: 'Demonstrou interesse no Avant Home e está sem responder.',
    description: 'Retomar contato oferecendo informações atualizadas.',
    status: 'pending',
    created_at: createdAt,
    updated_at: createdAt,
    payload: {
      score: 85,
      stage_name: 'Interesse',
      hours_since_contact: 72,
      reason: 'Demonstrou interesse no Avant Home e está sem responder.',
      approach_summary: 'Retomar contato oferecendo informações atualizadas.',
    },
    ...(overrides.suggestion || {}),
  };

  return {
    suggestion,
    contact: {
      id: 'contact-1',
      name: 'Marina Costa',
      phone: '5583999887766',
      avatar_url: null,
      ai_score: 8,
      ai_score_reason: 'Alta intenção',
      has_purchased: false,
      is_personal_whatsapp: false,
      ...(overrides.contact || {}),
    },
    stageId: 'stage-interesse',
    stageName: 'Interesse',
    stageColor: '#10b981',
    opportunityType: 'resumption',
    profileMaturity: 80,
    aiScore: 8,
    confidenceScore: 85,
    commercialPriorityScore: 81.8,
    priorityTier: 'high',
    suggestionCreatedAt: createdAt,
    suggestionDayKeySp: '2026-11-23',
    suggestionSignificantUpdatedAt: null,
    lastCommunicationAt: '2026-11-20T14:00:00.000Z',
    hoursSinceLastCommunication: 72,
    neverContacted: false,
    reason: 'Demonstrou interesse no Avant Home e está sem responder.',
    approachSummary: 'Retomar contato oferecendo informações atualizadas.',
    interestProperty: 'Avant Home',
    primaryNeed: 'Studio em Bessa (Investimento)',
    lastMessagePreview: 'Vou analisar a planta e te retorno.',
    compatiblePropertiesCount: 0,
    compatibleProperties: [],
    ...overrides,
  };
}

describe('Follow-up Date Filters & America/Sao_Paulo Timezone Boundaries (Seção 6)', () => {
  // Referência: Segunda-feira, 23/11/2026 às 14:30 BRT (-03:00) == 2026-11-23T17:30:00.000Z
  const nowSp = new Date('2026-11-23T17:30:00.000Z');

  it('respeita os limites exatos do dia em America/Sao_Paulo para "today" e "yesterday"', () => {
    const todayRange = resolveFollowupDateFilterRange('today', nowSp);
    const yesterdayRange = resolveFollowupDateFilterRange('yesterday', nowSp);

    // 22/11/2026 às 23:30 BRT == 2026-11-23T02:30:00.000Z (ainda é ONTEM em São Paulo, embora já seja dia 23 em UTC)
    const lateYesterdaySp = '2026-11-23T02:30:00.000Z';
    // 23/11/2026 às 00:05 BRT == 2026-11-23T03:05:00.000Z (já é HOJE em São Paulo)
    const earlyTodaySp = '2026-11-23T03:05:00.000Z';

    expect(matchesFollowupDateFilter(lateYesterdaySp, todayRange)).toBe(false);
    expect(matchesFollowupDateFilter(lateYesterdaySp, yesterdayRange)).toBe(true);

    expect(matchesFollowupDateFilter(earlyTodaySp, todayRange)).toBe(true);
    expect(matchesFollowupDateFilter(earlyTodaySp, yesterdayRange)).toBe(false);
  });

  it('calcula corretamente "7d" (Últimos 7 dias — filtro padrão inicial) e "30d"', () => {
    const range7d = resolveFollowupDateFilterRange('7d', nowSp);
    // 23/11 (hoje) - 6 dias = 17/11/2026 00:00 BRT (2026-11-17T03:00:00.000Z)
    expect(range7d.startDayKeySp).toBe('2026-11-17');
    expect(range7d.endDayKeySp).toBe('2026-11-23');

    expect(matchesFollowupDateFilter('2026-11-17T03:00:00.000Z', range7d)).toBe(true);
    expect(matchesFollowupDateFilter('2026-11-17T02:59:59.000Z', range7d)).toBe(false);

    const range30d = resolveFollowupDateFilterRange('30d', nowSp);
    expect(range30d.startDayKeySp).toBe('2026-10-25');
    expect(range30d.endDayKeySp).toBe('2026-11-23');
  });

  it('calcula corretamente "this_week", "this_month", "custom" e "all"', () => {
    // Quarta-feira 25/11/2026 15:00Z -> Segunda-feira da mesma semana é 23/11/2026
    const wednesday = new Date('2026-11-25T15:00:00.000Z');
    const weekRange = resolveFollowupDateFilterRange('this_week', wednesday);
    expect(weekRange.startDayKeySp).toBe('2026-11-23');
    expect(weekRange.endDayKeySp).toBe('2026-11-25');

    const monthRange = resolveFollowupDateFilterRange('this_month', wednesday);
    expect(monthRange.startDayKeySp).toBe('2026-11-01');
    expect(monthRange.endDayKeySp).toBe('2026-11-25');

    const customRange = resolveFollowupDateFilterRange(
      'custom',
      wednesday,
      '2026-10-10',
      '2026-10-15'
    );
    expect(matchesFollowupDateFilter('2026-10-10T03:00:00.000Z', customRange)).toBe(true);
    expect(matchesFollowupDateFilter('2026-10-16T02:59:59.000Z', customRange)).toBe(true);
    expect(matchesFollowupDateFilter('2026-10-16T03:00:01.000Z', customRange)).toBe(false);

    const allRange = resolveFollowupDateFilterRange('all', wednesday);
    expect(matchesFollowupDateFilter('2025-01-01T00:00:00.000Z', allRange)).toBe(true);
  });
});

describe('Opportunity Classification & Need/Interest Extraction (Seção 4)', () => {
  it('identifica explicitamente leads nunca contatados vs retomada de contato', () => {
    const never = classifyFollowupTimingAndType({
      lastMessageAt: null,
      lastMessageText: null,
      aiReplyCount: 0,
      payloadHoursSinceContact: null,
      stageName: 'Novo Lead',
    });
    expect(never.neverContacted).toBe(true);
    expect(never.opportunityType).toBe('first_contact');
    expect(never.hoursSinceLastCommunication).toBeNull();

    const resumption = classifyFollowupTimingAndType({
      lastMessageAt: '2026-11-20T12:00:00.000Z',
      lastMessageText: 'Quero saber mais detalhes',
      aiReplyCount: 2,
      stageName: 'Qualificação',
      nowMs: new Date('2026-11-23T12:00:00.000Z').getTime(),
    });
    expect(resumption.neverContacted).toBe(false);
    expect(resumption.opportunityType).toBe('resumption');
    expect(resumption.hoursSinceLastCommunication).toBe(72);
  });

  it('extrai empreendimento de interesse e necessidade principal sem chamar IA', () => {
    const need = extractLeadPrimaryNeed({
      summary: {
        property_type: ['Studio'],
        bedrooms: [1],
        location: ['Bessa'],
        purpose: ['Locação por temporada'],
      },
    });
    expect(need).toBe('Studio 1 quarto em Bessa (Locação por temporada)');

    const interestProp = extractInterestProperty({
      reasonText: 'Demonstrou interesse no Avant Home e pediu tabela.',
      knownPropertyNames: ['Live Park', 'Avant Home', 'Puerto Ventura'],
    });
    expect(interestProp).toBe('Avant Home');
  });
});

describe('Ordenação por Recência e Prioridade Comercial (Seção 7)', () => {
  const itemRecentLow = makeFollowupItem({
    suggestion: { id: 'recent-low' } as AiSuggestion,
    suggestionCreatedAt: '2026-11-23T10:00:00.000Z',
    suggestionDayKeySp: '2026-11-23',
    commercialPriorityScore: 55,
    confidenceScore: 60,
    aiScore: 5,
    profileMaturity: 50,
    hoursSinceLastCommunication: 48,
    neverContacted: false,
  });

  const itemRecentHigh = makeFollowupItem({
    suggestion: { id: 'recent-high' } as AiSuggestion,
    suggestionCreatedAt: '2026-11-23T08:00:00.000Z',
    suggestionDayKeySp: '2026-11-23',
    commercialPriorityScore: 88,
    confidenceScore: 92,
    aiScore: 9,
    profileMaturity: 85,
    hoursSinceLastCommunication: 96,
    neverContacted: false,
  });

  const itemOlderUltraHigh = makeFollowupItem({
    suggestion: { id: 'older-ultra' } as AiSuggestion,
    suggestionCreatedAt: '2026-11-21T15:00:00.000Z',
    suggestionDayKeySp: '2026-11-21',
    commercialPriorityScore: 95,
    confidenceScore: 98,
    aiScore: 10,
    profileMaturity: 95,
    hoursSinceLastCommunication: 240,
    neverContacted: false,
  });

  const itemNeverContacted = makeFollowupItem({
    suggestion: { id: 'never-contacted' } as AiSuggestion,
    suggestionCreatedAt: '2026-11-22T12:00:00.000Z',
    suggestionDayKeySp: '2026-11-22',
    commercialPriorityScore: 70,
    confidenceScore: 75,
    aiScore: 6,
    profileMaturity: 40,
    hoursSinceLastCommunication: null,
    neverContacted: true,
    opportunityType: 'first_contact',
  });

  it('ordena no modo padrão "recent_priority" primeiro por recência (dia SP) e depois por prioridade comercial dentro do dia', () => {
    const list = [itemOlderUltraHigh, itemRecentLow, itemRecentHigh];
    list.sort((a, b) => compareFollowupItems(a, b, 'recent_priority'));
    expect(list.map((i) => i.suggestion.id)).toEqual([
      'recent-high',
      'recent-low',
      'older-ultra',
    ]);
  });

  it('ordena por maior prioridade geral ("priority_desc"), maior maturidade ("maturity_desc") e maior score IA ("ai_score_desc")', () => {
    const list = [itemRecentLow, itemRecentHigh, itemOlderUltraHigh];

    const byPriority = [...list].sort((a, b) => compareFollowupItems(a, b, 'priority_desc'));
    expect(byPriority.map((i) => i.suggestion.id)).toEqual([
      'older-ultra',
      'recent-high',
      'recent-low',
    ]);

    const byMaturity = [...list].sort((a, b) => compareFollowupItems(a, b, 'maturity_desc'));
    expect(byMaturity.map((i) => i.suggestion.id)).toEqual([
      'older-ultra',
      'recent-high',
      'recent-low',
    ]);

    const byAiScore = [...list].sort((a, b) => compareFollowupItems(a, b, 'ai_score_desc'));
    expect(byAiScore.map((i) => i.suggestion.id)).toEqual([
      'older-ultra',
      'recent-high',
      'recent-low',
    ]);
  });

  it('ordena por "longest_without_contact" priorizando maior tempo real sem contato e tratando separadamente leads nunca contatados', () => {
    const list = [itemNeverContacted, itemRecentLow, itemOlderUltraHigh, itemRecentHigh];
    list.sort((a, b) => compareFollowupItems(a, b, 'longest_without_contact'));

    // Leads com histórico real vêm primeiro (240h -> 96h -> 48h), e nunca contatados ficam separados ao final
    expect(list.map((i) => i.suggestion.id)).toEqual([
      'older-ultra',
      'recent-high',
      'recent-low',
      'never-contacted',
    ]);
  });
});

describe('Combinação de Filtros e Grande Volume de Registros (Seções 8, 10 e 14)', () => {
  const now = new Date('2026-11-23T15:00:00.000Z');

  it('combina busca por nome/telefone, período, etapa, maturidade, score IA, tipo e status sem sobrescrever', () => {
    const items: EnrichedFollowupItem[] = [
      makeFollowupItem({
        suggestion: { id: 'match-all', status: 'pending' } as AiSuggestion,
        contact: {
          id: 'c-1',
          name: 'Roberto Almeida',
          phone: '5583991112233',
          ai_score: 8,
          has_purchased: false,
          is_personal_whatsapp: false,
        },
        stageName: 'Interesse',
        profileMaturity: 75,
        aiScore: 8,
        opportunityType: 'resumption',
        suggestionCreatedAt: '2026-11-22T14:00:00.000Z',
      }),
      makeFollowupItem({
        suggestion: { id: 'wrong-stage', status: 'pending' } as AiSuggestion,
        contact: {
          id: 'c-2',
          name: 'Roberto Silva',
          phone: '5583991112244',
          ai_score: 8,
          has_purchased: false,
          is_personal_whatsapp: false,
        },
        stageName: 'Qualificação',
        profileMaturity: 75,
        aiScore: 8,
        opportunityType: 'resumption',
        suggestionCreatedAt: '2026-11-22T14:00:00.000Z',
      }),
      makeFollowupItem({
        suggestion: { id: 'old-date', status: 'pending' } as AiSuggestion,
        contact: {
          id: 'c-3',
          name: 'Roberto Antigo',
          phone: '5583991112255',
          ai_score: 9,
          has_purchased: false,
          is_personal_whatsapp: false,
        },
        stageName: 'Interesse',
        profileMaturity: 85,
        aiScore: 9,
        opportunityType: 'resumption',
        suggestionCreatedAt: '2026-10-01T14:00:00.000Z',
      }),
    ];

    const filtered = filterFollowupItems(items, {
      status: 'pending',
      dateFilter: '7d',
      search: 'Roberto',
      stage: 'Interesse',
      maturityBand: 'ready',
      minAiScore: 7,
      opportunityType: 'resumption',
      now,
    });

    expect(filtered.map((i) => i.suggestion.id)).toEqual(['match-all']);

    // Quando o usuário muda o filtro de data para 'all', o registro histórico de outubro aparece
    const allDates = filterFollowupItems(items, {
      status: 'pending',
      dateFilter: 'all',
      search: 'Roberto',
      stage: 'Interesse',
      maturityBand: 'ready',
      minAiScore: 7,
      opportunityType: 'resumption',
      now,
    });
    expect(allDates.map((i) => i.suggestion.id)).toEqual(['match-all', 'old-date']);
  });

  it('opera de forma rápida e determinística com mais de 200 sugestões acumuladas (ex.: 193+ pendentes)', () => {
    const bulk: EnrichedFollowupItem[] = Array.from({ length: 240 }, (_, idx) => {
      const isRecent = idx < 45;
      const day = isRecent ? '2026-11-22' : '2026-10-15';
      const prio = calculateFollowupCommercialPriority({
        confidenceScore: 55 + (idx % 45),
        aiScore: idx % 11,
        profileMaturity: (idx * 7) % 100,
        hasInterestProperty: idx % 2 === 0,
        hasPrimaryNeed: true,
        stageName: idx % 3 === 0 ? 'Interesse' : 'Qualificação',
      });
      return makeFollowupItem({
        suggestion: {
          id: `sugg-${String(idx).padStart(4, '0')}`,
          status: 'pending',
        } as AiSuggestion,
        suggestionCreatedAt: `${day}T12:00:00.000Z`,
        suggestionDayKeySp: day,
        commercialPriorityScore: prio.score,
        priorityTier: prio.tier,
      });
    });

    const recentFiltered = filterFollowupItems(bulk, {
      status: 'pending',
      dateFilter: '7d',
      now,
    });
    expect(recentFiltered).toHaveLength(45);

    const allFiltered = filterFollowupItems(bulk, {
      status: 'pending',
      dateFilter: 'all',
      now,
    });
    expect(allFiltered).toHaveLength(240);

    allFiltered.sort((a, b) => compareFollowupItems(a, b, 'recent_priority'));
    expect(allFiltered[0].suggestionDayKeySp).toBe('2026-11-22');
    expect(allFiltered[44].suggestionDayKeySp).toBe('2026-11-22');
    expect(allFiltered[45].suggestionDayKeySp).toBe('2026-10-15');
  });
});
