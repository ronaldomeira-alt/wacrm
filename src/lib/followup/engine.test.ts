import { describe, expect, it } from 'vitest';
import {
  buildObjectiveFollowupRecommendation,
  buildPersonalizedCommercialReason,
  calculateFollowupCommercialPriority,
  canReactivateFollowupSuggestion,
  classifyFollowupTimingAndType,
  classifyRejectionPermanence,
  compareFollowupItems,
  detectPendingTeamCommitment,
  evaluateFollowupCommercialEligibility,
  evaluateFollowupSessionWindow,
  extractInterestProperty,
  extractLeadPrimaryNeed,
  filterFollowupItems,
  formatNaturalElapsedContactPtBr,
  formatNeighborhoodWithPrepositionPtBr,
  matchesFollowupDateFilter,
  reconcileFollowupReasonAndApproach,
  resolveFollowupDateFilterRange,
  summarizeConversationMessages,
  type EnrichedFollowupItem,
} from './engine';
import type { AiSuggestion } from '@/types';

function makeFollowupItem(overrides: Partial<EnrichedFollowupItem> = {}): EnrichedFollowupItem {
  const id = overrides.suggestion?.id || 'sugg-1';
  const createdAt = overrides.suggestionCreatedAt || '2026-11-23T14:00:00.000Z';
  const lastCustomerMessageAt =
    overrides.lastCustomerMessageAt !== undefined
      ? overrides.lastCustomerMessageAt
      : (overrides.lastCommunicationAt ?? createdAt);
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
    lastCustomerMessageAt,
    customerDayKeySp: overrides.customerDayKeySp ?? overrides.suggestionDayKeySp ?? '2026-11-23',
    lastBusinessMessageAt: overrides.lastBusinessMessageAt ?? '2026-11-20T15:00:00.000Z',
    lastInteractionAt: overrides.lastInteractionAt ?? lastCustomerMessageAt,
    suggestionCreatedAt: createdAt,
    suggestionDayKeySp: '2026-11-23',
    suggestionSignificantUpdatedAt: null,
    lastCommunicationAt: lastCustomerMessageAt,
    hoursSinceLastCommunication: 72,
    hoursSinceLastCustomerMessage: 72,
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

describe('Follow-up Date Filters & America/Sao_Paulo Timezone Boundaries (Seções 1, 2 e 12)', () => {
  // Referência: Segunda-feira, 23/11/2026 às 14:30 BRT (-03:00) == 2026-11-23T17:30:00.000Z
  const nowSp = new Date('2026-11-23T17:30:00.000Z');

  it('respeita os limites exatos do dia em America/Sao_Paulo para "today", "yesterday", "day_before_yesterday" e "3d"', () => {
    const todayRange = resolveFollowupDateFilterRange('today', nowSp);
    const yesterdayRange = resolveFollowupDateFilterRange('yesterday', nowSp);
    const dayBeforeRange = resolveFollowupDateFilterRange('day_before_yesterday', nowSp);
    const threeDaysRange = resolveFollowupDateFilterRange('3d', nowSp);

    // 22/11/2026 às 23:30 BRT == 2026-11-23T02:30:00.000Z (ainda é ONTEM em São Paulo, embora já seja dia 23 em UTC)
    const lateYesterdaySp = '2026-11-23T02:30:00.000Z';
    // 23/11/2026 às 00:05 BRT == 2026-11-23T03:05:00.000Z (já é HOJE em São Paulo)
    const earlyTodaySp = '2026-11-23T03:05:00.000Z';
    // 21/11/2026 às 15:00 BRT == 2026-11-21T18:00:00.000Z (ANTEONTEM em São Paulo)
    const dayBeforeYesterdaySp = '2026-11-21T18:00:00.000Z';

    expect(matchesFollowupDateFilter(lateYesterdaySp, todayRange)).toBe(false);
    expect(matchesFollowupDateFilter(lateYesterdaySp, yesterdayRange)).toBe(true);

    expect(matchesFollowupDateFilter(earlyTodaySp, todayRange)).toBe(true);
    expect(matchesFollowupDateFilter(earlyTodaySp, yesterdayRange)).toBe(false);

    expect(matchesFollowupDateFilter(dayBeforeYesterdaySp, dayBeforeRange)).toBe(true);
    expect(matchesFollowupDateFilter(lateYesterdaySp, dayBeforeRange)).toBe(false);

    expect(matchesFollowupDateFilter(dayBeforeYesterdaySp, threeDaysRange)).toBe(true);
    expect(matchesFollowupDateFilter(lateYesterdaySp, threeDaysRange)).toBe(true);
    expect(matchesFollowupDateFilter(earlyTodaySp, threeDaysRange)).toBe(true);
  });

  it('NÃO inclui no filtro "Ontem" (ou "7d") uma sugestão criada hoje às 00h01 para cliente que falou em 07/11 (16 dias atrás)', () => {
    const staleLeadSuggestedToday = makeFollowupItem({
      suggestion: { id: 'stale-07-11', status: 'pending' } as AiSuggestion,
      suggestionCreatedAt: '2026-11-23T03:01:00.000Z', // 00:01 BRT de hoje (23/11)
      suggestionDayKeySp: '2026-11-23',
      lastCustomerMessageAt: '2026-11-07T18:30:00.000Z', // Última fala do cliente em 07/11
      customerDayKeySp: '2026-11-07',
      lastCommunicationAt: '2026-11-07T18:30:00.000Z',
    });

    // Filtro padrão ('yesterday') -> não entra!
    const inYesterday = filterFollowupItems([staleLeadSuggestedToday], {
      status: 'pending',
      dateFilter: 'yesterday',
      now: nowSp,
    });
    expect(inYesterday).toHaveLength(0);

    // Filtro 'today' -> não entra!
    const inToday = filterFollowupItems([staleLeadSuggestedToday], {
      status: 'pending',
      dateFilter: 'today',
      now: nowSp,
    });
    expect(inToday).toHaveLength(0);

    // Filtro '7d' -> não entra!
    const in7d = filterFollowupItems([staleLeadSuggestedToday], {
      status: 'pending',
      dateFilter: '7d',
      now: nowSp,
    });
    expect(in7d).toHaveLength(0);

    // Filtro 'all' -> preservado no histórico!
    const inAll = filterFollowupItems([staleLeadSuggestedToday], {
      status: 'pending',
      dateFilter: 'all',
      now: nowSp,
    });
    expect(inAll).toHaveLength(1);
  });

  it('INCLUI no filtro padrão "Ontem" um cliente que escreveu ontem (22/11), mesmo que a sugestão tenha sido criada hoje (23/11) e mesmo que uma automação tenha enviado mensagem hoje', () => {
    const customerSpokeYesterday = makeFollowupItem({
      suggestion: { id: 'yesterday-lead', status: 'pending' } as AiSuggestion,
      suggestionCreatedAt: '2026-11-23T11:00:00.000Z', // Sugestão criada hoje
      suggestionDayKeySp: '2026-11-23',
      lastCustomerMessageAt: '2026-11-22T19:15:00.000Z', // Cliente falou ontem às 16:15 BRT
      customerDayKeySp: '2026-11-22',
      lastBusinessMessageAt: '2026-11-23T14:10:00.000Z', // Automação enviou msg hoje
      lastInteractionAt: '2026-11-23T14:10:00.000Z',
    });

    // Chama filterFollowupItems sem passar dateFilter para validar que o padrão agora é 'yesterday'
    const defaultFiltered = filterFollowupItems([customerSpokeYesterday], {
      status: 'pending',
      now: nowSp,
    });
    expect(defaultFiltered).toHaveLength(1);
    expect(defaultFiltered[0].suggestion.id).toBe('yesterday-lead');
  });

  it('calcula corretamente "7d", "30d", "this_week", "this_month", "custom" e "all"', () => {
    const range7d = resolveFollowupDateFilterRange('7d', nowSp);
    expect(range7d.startDayKeySp).toBe('2026-11-17');
    expect(range7d.endDayKeySp).toBe('2026-11-23');

    expect(matchesFollowupDateFilter('2026-11-17T03:00:00.000Z', range7d)).toBe(true);
    expect(matchesFollowupDateFilter('2026-11-17T02:59:59.000Z', range7d)).toBe(false);

    const range30d = resolveFollowupDateFilterRange('30d', nowSp);
    expect(range30d.startDayKeySp).toBe('2026-10-25');
    expect(range30d.endDayKeySp).toBe('2026-11-23');

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

describe('Separação de Mensagens de Entrada/Saída, Classificação e Reconciliação de Texto (Seções 1, 4, 8 e 12)', () => {
  it('separa mensagens do cliente vs empresa, exclui eventos técnicos/sistema e ignora convite automático do Instagram como atendimento comercial', () => {
    const stats = summarizeConversationMessages([
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'Olá! Gostaria de saber valores do Mahal no Bessa.',
        created_at: '2026-11-22T14:00:00.000Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        content_type: 'unsupported',
        content_text: '[Unsupported message type: unsupported]',
        created_at: '2026-11-23T12:00:00.000Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'system',
        content_type: 'system',
        content_text: 'Conversa atribuída',
        created_at: '2026-11-23T13:00:00.000Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'bot',
        content_type: 'text',
        content_text:
          'Aproveitando aqui a nossa conversa, me segue também no Instagram. Clica aqui: https://www.instagram.com/ronaldomeiracorretor/',
        created_at: '2026-11-23T14:10:00.000Z',
      },
    ]);

    expect(stats.customerMessageCount).toBe(1);
    expect(stats.lastCustomerMessageAt).toBe('2026-11-22T14:00:00.000Z');
    expect(stats.lastCustomerText).toBe('Olá! Gostaria de saber valores do Mahal no Bessa.');
    // O convite automático do Instagram e os eventos de sistema não contam como atendimento comercial
    expect(stats.businessMessageCount).toBe(0);
    expect(stats.lastBusinessMessageAt).toBeNull();
  });

  it('classifica como "first_contact" (Primeiro contato) um lead que escreveu para a empresa mas nunca recebeu resposta comercial', () => {
    const unreadInbound = classifyFollowupTimingAndType({
      lastCustomerMessageAt: '2026-11-22T15:00:00.000Z',
      lastBusinessMessageAt: null,
      customerMessageCount: 2,
      businessMessageCount: 0,
      stageName: 'Qualificação', // Mesmo que a etapa não seja "Novo Lead"
      nowMs: new Date('2026-11-23T15:00:00.000Z').getTime(),
    });

    expect(unreadInbound.neverContacted).toBe(false);
    expect(unreadInbound.opportunityType).toBe('first_contact');
    expect(unreadInbound.contactState).toBe('first_contact');
    expect(unreadInbound.awaitingBusinessReply).toBe(true);
    expect(unreadInbound.hoursSinceLastCustomerMessage).toBe(24);
  });

  it('reconcilia textos contraditórios quando há histórico real de respostas da empresa mas a sugestão antiga dizia "nunca contatado"', () => {
    const reconciled = reconcileFollowupReasonAndApproach({
      rawReason:
        'Lead novo no pipeline, nunca contatado, e já se passaram 16 dias sem nenhuma tentativa de contato.',
      rawApproachSummary: 'Fazer primeiro contato.',
      opportunityType: 'resumption',
      contactState: 'resumption',
      neverContacted: false,
      interestProperty: 'Mahal',
      primaryNeed: 'Studio em Bessa',
      lastCustomerText: 'Qual o valor das unidades do Mahal?',
      lastBusinessText: 'Enviei as informações iniciais do empreendimento.',
    });

    expect(reconciled.reason).not.toMatch(/nunca contatad/i);
    expect(reconciled.reason).toContain('Mahal');
    expect(reconciled.reason).toContain('perguntou sobre valores');
    expect(reconciled.approachSummary).toContain('Retomar a conversa');

    const objective = buildObjectiveFollowupRecommendation({
      opportunityType: 'resumption',
      contactState: 'resumption',
      interestProperty: 'Avant Home',
      primaryNeed: 'Studio 1 quarto em Bessa',
      lastCustomerText: 'Quais os valores?',
      lastBusinessText: 'Segue apresentação inicial.',
    });
    expect(objective.reason).toContain('Avant Home');
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

describe('Janela de Atendimento de 24h vs. Benefício Gratuito CTWA de 72h (Seções 5 e 12)', () => {
  const nowMs = new Date('2026-11-23T15:00:00.000Z').getTime();

  it('distingue janela de 24h aberta, prestes a encerrar (<= 6h) e encerrada, sem confundir com a gratuidade CTWA de 72h', () => {
    // 1. Cliente falou há 10h -> Janela aberta (14h restantes)
    const openWin = evaluateFollowupSessionWindow({
      lastCustomerMessageAt: new Date(nowMs - 10 * 60 * 60 * 1000).toISOString(),
      isCtwaLead: true,
      ctwaFepExpiresAt: new Date(nowMs + 50 * 60 * 60 * 1000).toISOString(),
      nowMs,
    });
    expect(openWin.status).toBe('open');
    expect(openWin.windowOpen).toBe(true);
    expect(openWin.closingSoon).toBe(false);
    expect(openWin.templateRequired).toBe(false);
    expect(openWin.ctwaFreeBenefitActive).toBe(true);

    // 2. Cliente falou há 21h -> Janela prestes a encerrar (3h restantes <= 6h)
    const closingSoonWin = evaluateFollowupSessionWindow({
      lastCustomerMessageAt: new Date(nowMs - 21 * 60 * 60 * 1000).toISOString(),
      isCtwaLead: true,
      ctwaFepExpiresAt: new Date(nowMs + 39 * 60 * 60 * 1000).toISOString(),
      nowMs,
    });
    expect(closingSoonWin.status).toBe('closing_soon');
    expect(closingSoonWin.windowOpen).toBe(true);
    expect(closingSoonWin.closingSoon).toBe(true);
    expect(closingSoonWin.templateRequired).toBe(false);

    // 3. Cliente falou há 30h, mas CTWA de 72h ainda está ativo (42h restantes):
    //    Texto livre NÃO é permitido (templateRequired = true), apesar da gratuidade CTWA!
    const expired24hButCtwaFree = evaluateFollowupSessionWindow({
      lastCustomerMessageAt: new Date(nowMs - 30 * 60 * 60 * 1000).toISOString(),
      isCtwaLead: true,
      ctwaFepExpiresAt: new Date(nowMs + 42 * 60 * 60 * 1000).toISOString(),
      nowMs,
    });
    expect(expired24hButCtwaFree.status).toBe('expired');
    expect(expired24hButCtwaFree.windowOpen).toBe(false);
    expect(expired24hButCtwaFree.templateRequired).toBe(true);
    expect(expired24hButCtwaFree.ctwaFreeBenefitActive).toBe(true);
  });
});

describe('Priorização Comercial Real e Ordenação (Seções 3 e 12)', () => {
  it('garante que um comprador qualificado (alta maturidade e interesse real) supere um lead de baixa maturidade mesmo que a IA tenha 98% de confiança no lead fraco', () => {
    const lowMaturityHighConfidence = calculateFollowupCommercialPriority({
      confidenceScore: 98,
      aiScore: 2,
      profileMaturity: 20,
      hasInterestProperty: false,
      hasPrimaryNeed: false,
      stageName: 'Novo Lead',
    });

    const qualifiedBuyerModerateConfidence = calculateFollowupCommercialPriority({
      confidenceScore: 65,
      aiScore: 8,
      profileMaturity: 80,
      hasInterestProperty: true,
      hasPrimaryNeed: true,
      stageName: 'Interesse',
    });

    expect(qualifiedBuyerModerateConfidence.score).toBeGreaterThan(
      lowMaturityHighConfidence.score + 30
    );
    expect(qualifiedBuyerModerateConfidence.tier).toBe('high');
    expect(lowMaturityHighConfidence.tier).toBe('normal');
  });

  const itemRecentLow = makeFollowupItem({
    suggestion: { id: 'recent-low' } as AiSuggestion,
    lastCustomerMessageAt: '2026-11-23T10:00:00.000Z',
    customerDayKeySp: '2026-11-23',
    commercialPriorityScore: 55,
    confidenceScore: 60,
    aiScore: 5,
    profileMaturity: 50,
    hoursSinceLastCommunication: 48,
    neverContacted: false,
  });

  const itemRecentHigh = makeFollowupItem({
    suggestion: { id: 'recent-high' } as AiSuggestion,
    lastCustomerMessageAt: '2026-11-23T08:00:00.000Z',
    customerDayKeySp: '2026-11-23',
    commercialPriorityScore: 88,
    confidenceScore: 92,
    aiScore: 9,
    profileMaturity: 85,
    hoursSinceLastCommunication: 96,
    neverContacted: false,
  });

  const itemOlderUltraHigh = makeFollowupItem({
    suggestion: { id: 'older-ultra' } as AiSuggestion,
    lastCustomerMessageAt: '2026-11-21T15:00:00.000Z',
    customerDayKeySp: '2026-11-21',
    commercialPriorityScore: 95,
    confidenceScore: 98,
    aiScore: 10,
    profileMaturity: 95,
    hoursSinceLastCommunication: 240,
    neverContacted: false,
  });

  const itemNeverContacted = makeFollowupItem({
    suggestion: { id: 'never-contacted' } as AiSuggestion,
    lastCustomerMessageAt: '2026-11-22T12:00:00.000Z',
    customerDayKeySp: '2026-11-22',
    commercialPriorityScore: 70,
    confidenceScore: 75,
    aiScore: 6,
    profileMaturity: 40,
    hoursSinceLastCommunication: null,
    neverContacted: true,
    opportunityType: 'first_contact',
  });

  it('ordena no modo padrão "recent_priority" primeiro pela data da última mensagem do cliente (dia SP) e depois por prioridade comercial', () => {
    const list = [itemOlderUltraHigh, itemRecentLow, itemRecentHigh];
    list.sort((a, b) => compareFollowupItems(a, b, 'recent_priority'));
    expect(list.map((i) => i.suggestion.id)).toEqual([
      'recent-high',
      'recent-low',
      'older-ultra',
    ]);
  });

  it('ordena no modo "window_closing_soon" priorizando janelas de 24h abertas mais próximas de fechar', () => {
    const closingIn1h = makeFollowupItem({
      suggestion: { id: 'win-1h' } as AiSuggestion,
      commercialPriorityScore: 60,
      sessionWindow: {
        status: 'closing_soon',
        windowOpen: true,
        closingSoon: true,
        templateRequired: false,
        remainingMs: 1 * 60 * 60 * 1000,
        remainingLabel: '1h restante',
        isCtwaLead: true,
        ctwaFreeBenefitActive: true,
        ctwaFreeBenefitExpiresAt: null,
        ctwaFreeBenefitRemainingLabel: null,
      },
    });
    const closingIn12h = makeFollowupItem({
      suggestion: { id: 'win-12h' } as AiSuggestion,
      commercialPriorityScore: 90,
      sessionWindow: {
        status: 'open',
        windowOpen: true,
        closingSoon: false,
        templateRequired: false,
        remainingMs: 12 * 60 * 60 * 1000,
        remainingLabel: '12h restantes',
        isCtwaLead: true,
        ctwaFreeBenefitActive: true,
        ctwaFreeBenefitExpiresAt: null,
        ctwaFreeBenefitRemainingLabel: null,
      },
    });
    const closedWin = makeFollowupItem({
      suggestion: { id: 'win-closed' } as AiSuggestion,
      commercialPriorityScore: 99,
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
    });

    const list = [closedWin, closingIn12h, closingIn1h];
    list.sort((a, b) => compareFollowupItems(a, b, 'window_closing_soon'));
    expect(list.map((i) => i.suggestion.id)).toEqual(['win-1h', 'win-12h', 'win-closed']);
  });

  it('ordena por "priority_desc", "maturity_desc", "ai_score_desc" e "longest_without_contact"', () => {
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

    const byLongest = [itemNeverContacted, itemRecentLow, itemOlderUltraHigh, itemRecentHigh].sort(
      (a, b) => compareFollowupItems(a, b, 'longest_without_contact')
    );
    expect(byLongest.map((i) => i.suggestion.id)).toEqual([
      'older-ultra',
      'recent-high',
      'recent-low',
      'never-contacted',
    ]);
  });
});

describe('Combinação de Filtros e Grande Volume de Registros (Seções 8, 10 e 12)', () => {
  const now = new Date('2026-11-23T15:00:00.000Z');

  it('combina busca por nome/telefone, período da última mensagem do cliente, janela, etapa, maturidade, score IA, tipo e status', () => {
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
        lastCustomerMessageAt: '2026-11-22T14:00:00.000Z',
        sessionWindow: evaluateFollowupSessionWindow({
          lastCustomerMessageAt: '2026-11-22T20:00:00.000Z',
          nowMs: now.getTime(),
        }),
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
        lastCustomerMessageAt: '2026-11-22T14:00:00.000Z',
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
        lastCustomerMessageAt: '2026-10-01T14:00:00.000Z',
      }),
    ];

    const filtered = filterFollowupItems(items, {
      status: 'pending',
      dateFilter: 'yesterday',
      windowFilter: 'open',
      search: 'Roberto',
      stage: 'Interesse',
      maturityBand: 'ready',
      minAiScore: 7,
      opportunityType: 'resumption',
      now,
    });

    expect(filtered.map((i) => i.suggestion.id)).toEqual(['match-all']);

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
});

describe('Etapa 2 — Formatação Natural de Tempo, Transcrição de Áudio e Contexto Comercial Unificado (Seções 2, 3, 8 e 9)', () => {
  it('formata o tempo decorrido desde o último contato em minutos/horas (< 24h) e em dias completos (>= 24h, ex.: 86h -> "Há 3 dias")', () => {
    const nowMs = new Date('2026-11-23T15:00:00.000Z').getTime();

    // Menos de 1 hora (45 minutos)
    expect(
      formatNaturalElapsedContactPtBr({
        lastContactAt: new Date(nowMs - 45 * 60 * 1000).toISOString(),
        nowMs,
      })
    ).toBe('Há 45 minutos');

    // Menos de 24 horas (2 horas)
    expect(formatNaturalElapsedContactPtBr(2)).toBe('Há 2 horas');
    expect(formatNaturalElapsedContactPtBr(1)).toBe('Há 1 hora');

    // 24 horas ou mais -> dias completos (nunca "há 86 horas")
    expect(formatNaturalElapsedContactPtBr(24)).toBe('Há 1 dia');
    expect(formatNaturalElapsedContactPtBr(86)).toBe('Há 3 dias');
    expect(formatNaturalElapsedContactPtBr(86)).not.toContain('86');
    expect(formatNaturalElapsedContactPtBr(288)).toBe('Há 12 dias');
  });

  it('considera transcrição de áudio (transcript_text) tanto de clientes quanto de corretores no histórico real', () => {
    const stats = summarizeConversationMessages([
      {
        conversation_id: 'conv-vilela',
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'Gostaria de saber os valores',
        created_at: '2026-11-18T23:45:36.000Z',
      },
      {
        conversation_id: 'conv-vilela',
        sender_type: 'agent',
        content_type: 'audio',
        content_text: null,
        transcript_text: 'Bom dia Vilela! Temos unidades a partir de R$ 350 mil no Mahal Resort.',
        media_url: 'https://cdn.example.com/audio.ogg',
        created_at: '2026-11-19T11:06:16.000Z',
      },
    ]);

    expect(stats.customerMessageCount).toBe(1);
    expect(stats.businessMessageCount).toBe(1);
    expect(stats.agentMessageCount).toBe(1);
    expect(stats.lastBusinessText).toContain('unidades a partir de R$ 350 mil');
  });

  it('constrói motivo comercial unificado natural para cliente com plantas maiores confirmadas (50 a 75 m² no Bessa) com preposição correta e sem jargão burocrático', () => {
    const reason = buildPersonalizedCommercialReason({
      contactName: 'Aldeci',
      stageName: 'Qualificação',
      interestProperty: 'Mahal Resort',
      isCtwaOrigin: true,
      lastCustomerText: 'Maior, com certeza',
      compatiblePropertiesCount: 3,
      opportunityType: 'resumption',
      contactState: 'resumption',
      profile: {
        operation: 'venda',
        purpose: ['Moradia'],
        propertyTypes: ['Apartamento'],
        locations: ['Bessa'],
        prefersLargerPlans: true,
        largerPlansSource: 'customer_declared',
        areaMin: 50,
        areaMax: 75,
      },
    });

    expect(reason).toContain('Aldeci');
    expect(reason).toContain('Mahal Resort');
    expect(reason).toContain('50 a 75 m²');
    expect(reason).toContain('no Bessa');
    expect(reason).not.toContain('em Bessa');
    expect(reason).toContain('três opções compatíveis');
    expect(reason).not.toMatch(/Lead demonstrou interesse inicial/i);
    expect(reason).not.toMatch(/Próximo passo pendente/i);
    expect(reason).not.toMatch(/Necessidade principal identificada/i);
    expect(reason).not.toMatch(/Ausência de registro de desinteresse/i);
  });

  it('Etapa 3 — preposições de bairros, caso Vilela com sugestão não confirmada pela equipe, compromisso pendente de Alex/Sirleida, cooldown 6h em janela aberta e reativação inteligente', () => {
    // 1. Preposições corretas
    expect(formatNeighborhoodWithPrepositionPtBr('Bessa')).toBe('no Bessa');
    expect(formatNeighborhoodWithPrepositionPtBr('Intermares')).toBe('em Intermares');
    expect(formatNeighborhoodWithPrepositionPtBr('Manaíra')).toBe('em Manaíra');
    expect(formatNeighborhoodWithPrepositionPtBr('Cabo Branco')).toBe('no Cabo Branco');
    expect(formatNeighborhoodWithPrepositionPtBr('Tambaú')).toBe('em Tambaú');

    // 2. Caso Vilela: equipe apresentou possibilidade de plantas maiores sem confirmação do cliente
    const vilelaReason = buildPersonalizedCommercialReason({
      contactName: 'Vilela',
      interestProperty: 'Mahal Resort',
      isCtwaOrigin: true,
      lastCustomerText: 'Gostaria de saber os valores',
      compatiblePropertiesCount: 3,
      profile: {
        operation: 'venda',
        purpose: ['moradia', 'investimento'],
        propertyTypes: ['flat'],
        locations: ['Bessa'],
        prefersLargerPlans: false,
        largerPlansSource: 'team_suggested',
      },
    });
    expect(vilelaReason).toContain('Vilela chegou pelo Mahal Resort');
    expect(vilelaReason).toContain('no Bessa');
    expect(vilelaReason).toContain('para moradia e investimento');
    expect(vilelaReason).toContain('Apresentamos a possibilidade de plantas maiores, mas ainda não confirmou qual configuração prefere');
    expect(vilelaReason).not.toContain('em Bessa');

    // 2b. Caso Alex Diniz & Sirleida: quartos/orçamento declarados superam team_suggested e fechamento é neutro em gênero
    const alexReason = buildPersonalizedCommercialReason({
      contactName: 'Alex Diniz',
      interestProperty: 'Mahal Resort',
      isCtwaOrigin: true,
      hasPendingCommitment: true,
      compatiblePropertiesCount: 3,
      profile: {
        operation: 'venda',
        propertyTypes: ['apartamento'],
        bedrooms: [2, 3],
        priceMin: 400000,
        priceMax: 600000,
        locations: [],
        prefersLargerPlans: false,
        largerPlansSource: 'team_suggested',
      },
    });
    expect(alexReason).toContain('Alex procura um apartamento de 2 ou 3 quartos');
    expect(alexReason).toContain('entre R$ 400 mil e R$ 600 mil');
    expect(alexReason).toContain('Você ficou de enviar algumas opções');
    expect(alexReason).toContain('para apresentar agora');
    expect(alexReason).not.toContain('para ele');
    expect(alexReason).not.toContain('ainda não confirmou qual configuração prefere');

    // 3. Compromisso pendente em múltiplas mensagens comerciais recentes (ex.: Alex e Sirleida)
    const commitment = detectPendingTeamCommitment({
      recentBusinessTexts: ['Tem preferência de bairro?', 'Deixa eu ver outro e te mando'],
      lastBusinessMessageAt: '2026-11-17T13:55:37.000Z',
      hasSharedPropertiesAfterLastBusiness: false,
    });
    expect(commitment.hasPendingCommitment).toBe(true);

    // 4. Cooldown de atendimento humano (Seção 19):
    // - < 6h bloqueia mesmo com janela aberta (sem compromisso pendente)
    // - >= 6h com janela de 24h aberta e sem envio recente de imóvel -> LIBERA!
    // - >= 6h e < 12h com janela encerrada -> BLOQUEIA pelo cooldown de 12h
    const nowMs = new Date('2026-11-23T18:00:00.000Z').getTime();
    const agent3hAgo = new Date(nowMs - 3 * 60 * 60 * 1000).toISOString();
    const agent8hAgo = new Date(nowMs - 8 * 60 * 60 * 1000).toISOString();
    const cust10hAgo = new Date(nowMs - 10 * 60 * 60 * 1000).toISOString();

    const baseArgs = {
      profile: {
        operation: 'venda' as const,
        isShortStayOnly: false,
        isArchived: false,
        isPaused: false,
      },
      compatibleSalePropertiesCount: 3,
      profileMaturity: 70,
      aiScore: 7,
      lastCustomerMessageAt: cust10hAgo,
      nowMs,
    };

    expect(
      evaluateFollowupCommercialEligibility({
        ...baseArgs,
        lastAgentMessageAt: agent3hAgo,
        windowOpen: true,
      }).reasons
    ).toContain('active_human_attendance');

    expect(
      evaluateFollowupCommercialEligibility({
        ...baseArgs,
        lastAgentMessageAt: agent8hAgo,
        windowOpen: true,
      }).eligible
    ).toBe(true);

    expect(
      evaluateFollowupCommercialEligibility({
        ...baseArgs,
        lastAgentMessageAt: agent8hAgo,
        windowOpen: false,
        teamCooldownHours: 12,
      }).reasons
    ).toContain('active_human_attendance');

    // 5. Reativação inteligente: rejeição temporária por falta de estoque pode reativar quando surge imóvel; locação/desinteresse nunca reativa
    expect(classifyRejectionPermanence(['no_compatible_sale_properties'])).toBe('temporary');
    expect(classifyRejectionPermanence(['rental_only'])).toBe('permanent');
    expect(classifyRejectionPermanence(['customer_disinterest'])).toBe('permanent');

    expect(
      canReactivateFollowupSuggestion({
        previousRejectionReasons: ['no_compatible_sale_properties'],
        currentEligibility: { eligible: true, reasons: [], operation: 'venda' },
        hasStockOrProfileChange: true,
      })
    ).toBe(true);

    expect(
      canReactivateFollowupSuggestion({
        previousRejectionReasons: ['customer_disinterest'],
        currentEligibility: { eligible: true, reasons: [], operation: 'venda' },
        hasStockOrProfileChange: true,
      })
    ).toBe(false);
  });
});
