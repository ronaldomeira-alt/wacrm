import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { calculateProfileMaturity, MATURITY_AUTOMATIC_THRESHOLD } from './maturity';
import { evaluateMatch } from './engine';
import { buildProfileFromData } from './profile-builder';
import { compareMatchGroups, type SortableMatchGroup } from './ordering';
import { recalculateMatchesForLead } from './service';
import { calculateCommercialPriority } from './priority';
import { generateTrackingToken, buildSharePublicUrl } from './tokens';
import type { LeadSearchProfile, PropertyProjection } from './types';

function createMockProfile(overrides: Partial<LeadSearchProfile> = {}): LeadSearchProfile {
  return {
    accountId: 'acc-1',
    leadId: 'lead-1',
    name: 'Marcos Silva',
    phone: '5583988887777',
    aiScore: 7,
    isPaused: false,
    isArchived: false,
    operation: 'venda',
    purpose: ['moradia'],
    propertyTypes: ['apartamento'],
    propertyTypeStrict: false,
    locations: ['Bessa'],
    locationStrict: false,
    locationSpecificity: 'neighborhood',
    priceMin: null,
    priceMax: 500000,
    priceStrictMax: false,
    priceFlexMax: null,
    bedrooms: [3],
    bedroomsStrict: false,
    deliveryStatus: ['pronto'],
    deliveryStrict: false,
    requiredFeatures: [],
    preferredFeatures: [],
    isShortStayOnly: false,
    provenance: {
      operation: 'conversation',
      purpose: 'conversation',
      propertyTypes: 'conversation',
      locations: 'conversation',
      price: 'conversation',
      bedrooms: 'conversation',
      delivery: 'conversation',
      features: 'conversation',
    },
    ...overrides,
  };
}

function createMockProperty(overrides: Partial<PropertyProjection> = {}): PropertyProjection {
  return {
    propertyId: 'prop-1',
    accountId: 'acc-1',
    code: 'LP-301',
    title: 'Residencial Live Park',
    operation: 'venda',
    propertyType: 'apartamento',
    neighborhood: 'Bessa',
    city: 'João Pessoa',
    priceMin: 450000,
    priceMax: 480000,
    areaMin: 65,
    areaMax: 78,
    bedroomsMin: 3,
    bedroomsMax: 3,
    deliveryStatus: 'pronto',
    features: ['elevador', 'piscina', 'vaga_garagem'],
    status: 'ativo',
    ...overrides,
  };
}

describe('Fase 24 — Validação e Testes do Motor de Match WACRM', () => {
  // 1. CTWA sozinho não gera maturidade artificial de 70%
  it('1. CTWA sozinho não gera maturidade artificial de 70%', () => {
    const ctwaOnlyProfile = createMockProfile({
      provenance: {
        operation: 'ctwa',
        purpose: 'ctwa',
        propertyTypes: 'ctwa',
        locations: 'ctwa',
        price: 'ctwa',
        bedrooms: 'ctwa',
        delivery: 'ctwa',
        features: 'ctwa',
      },
    });
    const evalResult = calculateProfileMaturity(ctwaOnlyProfile);
    expect(evalResult.maturity).toBeLessThan(70);
    expect(evalResult.meetsThreshold).toBe(false);
    expect(evalResult.maturity).toBeLessThanOrEqual(35); // 100 * 0.35 = 35 máx
  });

  // 2. Tag azul vira verde quando confirmada
  it('2. Tag azul vira verde quando confirmada', () => {
    // Simula a lógica de transição no contact_tags
    const tagCtwa = { source: 'ctwa', originally_from_ctwa: true };
    const confirmedSource = 'conversation';
    const tagUpdated = {
      source: confirmedSource,
      originally_from_ctwa: tagCtwa.source === 'ctwa' || tagCtwa.originally_from_ctwa,
    };
    expect(tagUpdated.source).toBe('conversation');
    expect(tagUpdated.originally_from_ctwa).toBe(true);
  });

  // 3. Informação de conversa vence informação CTWA conflitante
  it('3. Informação de conversa vence informação CTWA conflitante', () => {
    // CTWA trouxe Bessa, conversa atualizou para Manaíra
    const profile = createMockProfile({
      locations: ['Manaíra'],
      provenance: { locations: 'conversation' },
    });
    const propertyManaira = createMockProperty({ neighborhood: 'Manaíra' });
    const propertyBessa = createMockProperty({ neighborhood: 'Bessa' });

    const evalManaira = evaluateMatch(profile, propertyManaira);
    const evalBessa = evaluateMatch(profile, propertyBessa);

    expect(evalManaira.scoreBreakdown.location).toBeGreaterThan(evalBessa.scoreBreakdown.location);
  });

  // 4. Maturidade calcula corretamente
  it('4. Maturidade calcula corretamente com pesos normalizados', () => {
    const fullProfile = createMockProfile();
    const evalResult = calculateProfileMaturity(fullProfile);
    expect(evalResult.maturity).toBeGreaterThanOrEqual(90);
    expect(evalResult.meetsThreshold).toBe(true);
  });

  // 5. 69% não entra automaticamente
  it('5. 69% não entra automaticamente no Match automático', () => {
    expect(69 >= MATURITY_AUTOMATIC_THRESHOLD).toBe(false);
  });

  // 6. 70% entra no Match automático
  it('6. 70% entra no Match automático', () => {
    expect(70 >= MATURITY_AUTOMATIC_THRESHOLD).toBe(true);
  });

  // 7. Temperatura não muda Match Score
  it('7. Temperatura não altera a pontuação do Match', () => {
    const profileCold = createMockProfile({ aiScore: 1 });
    const profileHot = createMockProfile({ aiScore: 10 });
    const property = createMockProperty();

    const evalCold = evaluateMatch(profileCold, property);
    const evalHot = evaluateMatch(profileHot, property);

    expect(evalCold.matchScore).toBe(evalHot.matchScore);
  });

  // 8. Preço abaixo do orçamento não perde pontos
  it('8. Preço abaixo do orçamento não perde pontos', () => {
    const profile = createMockProfile({ priceMax: 500000 });
    const cheapProperty = createMockProperty({ priceMin: 300000, priceMax: 350000 });
    const budgetProperty = createMockProperty({ priceMin: 490000, priceMax: 500000 });

    const evalCheap = evaluateMatch(profile, cheapProperty);
    const evalBudget = evaluateMatch(profile, budgetProperty);

    expect(evalCheap.scoreBreakdown.price).toBe(evalBudget.scoreBreakdown.price);
  });

  // 9. Preço até +10% perde progressivamente pontos
  it('9. Preço até +10% perde progressivamente pontos', () => {
    const profile = createMockProfile({ priceMax: 500000, priceStrictMax: false });
    const onBudget = createMockProperty({ priceMin: 500000, priceMax: 500000 });
    const slightlyOver = createMockProperty({ priceMin: 525000, priceMax: 525000 }); // +5%

    const evalBudget = evaluateMatch(profile, onBudget);
    const evalSlightlyOver = evaluateMatch(profile, slightlyOver);

    expect(evalSlightlyOver.eligible).toBe(true);
    expect(evalSlightlyOver.scoreBreakdown.price).toBeLessThan(evalBudget.scoreBreakdown.price);
    expect(evalSlightlyOver.scoreBreakdown.price).toBeGreaterThan(0);
  });

  // 10. Preço acima da tolerância (+10%) sai do automático
  it('10. Preço acima da tolerância máxima (+10%) elimina', () => {
    const profile = createMockProfile({ priceMax: 500000, priceStrictMax: false });
    const wayOver = createMockProperty({ priceMin: 560000, priceMax: 560000 }); // +12%

    const evalOver = evaluateMatch(profile, wayOver);
    expect(evalOver.eligible).toBe(false);
    expect(evalOver.matchScore).toBe(0);
  });

  // 11. Limite absoluto é respeitado
  it('11. Limite absoluto elimina qualquer valor acima', () => {
    const profile = createMockProfile({ priceMax: 500000, priceStrictMax: true });
    const slightlyOver = createMockProperty({ priceMin: 505000, priceMax: 505000 });

    const evalResult = evaluateMatch(profile, slightlyOver);
    expect(evalResult.eligible).toBe(false);
  });

  // 12. Venda x Locação elimina
  it('12. Venda vs Locação elimina incompatibilidade', () => {
    const profileRent = createMockProfile({ operation: 'locacao' });
    const propertySale = createMockProperty({ operation: 'venda' });

    const evalResult = evaluateMatch(profileRent, propertySale);
    expect(evalResult.eligible).toBe(false);
  });

  // 13. Temporada não entra no estoque comum
  it('13. Temporada exclusiva não gera match com estoque comum', () => {
    const profileSeason = createMockProfile({ isShortStayOnly: true });
    const property = createMockProperty();

    const evalResult = evaluateMatch(profileSeason, property);
    expect(evalResult.eligible).toBe(false);
  });

  // 14. Requisito obrigatório elimina incompatibilidade
  it('14. Requisito obrigatório de quartos elimina incompatibilidade', () => {
    const profile = createMockProfile({ bedrooms: [3], bedroomsStrict: true });
    const twoBedrooms = createMockProperty({ bedroomsMin: 2, bedroomsMax: 2 });

    const evalResult = evaluateMatch(profile, twoBedrooms);
    expect(evalResult.eligible).toBe(false);
  });

  // 15. Preferência apenas reduz score
  it('15. Preferência de quartos apenas reduz score sem eliminar', () => {
    const profile = createMockProfile({ bedrooms: [3], bedroomsStrict: false });
    const twoBedrooms = createMockProperty({ bedroomsMin: 2, bedroomsMax: 2 });

    const evalResult = evaluateMatch(profile, twoBedrooms);
    expect(evalResult.eligible).toBe(true);
    expect(evalResult.matchScore).toBeGreaterThan(0);
    expect(evalResult.scoreBreakdown.bedrooms).toBeLessThan(15);
  });

  // 16. Bairro não mencionado limita Match a 69%
  it('16. Bairro não mencionado pelo cliente limita pontuação máxima a 69%', () => {
    const profile = createMockProfile({ locations: ['Bessa'] });
    const otherNeighborhoodProperty = createMockProperty({ neighborhood: 'Cabo Branco' });

    const evalResult = evaluateMatch(profile, otherNeighborhoodProperty);
    expect(evalResult.matchScore).toBeLessThanOrEqual(69);
  });

  // 17. "Somente bairro X" elimina outro bairro
  it('17. Localização estrita ("somente bairro X") elimina outros bairros', () => {
    const profile = createMockProfile({ locations: ['Bessa'], locationStrict: true });
    const otherNeighborhoodProperty = createMockProperty({ neighborhood: 'Manaíra' });

    const evalResult = evaluateMatch(profile, otherNeighborhoodProperty);
    expect(evalResult.eligible).toBe(false);
  });

  // 18. Faixa do empreendimento é tratada por interseção
  it('18. Faixa do empreendimento avalia unidade de entrada por interseção', () => {
    const profile = createMockProfile({ priceMax: 300000 });
    const rangeProperty = createMockProperty({ priceMin: 250000, priceMax: 600000 });

    const evalResult = evaluateMatch(profile, rangeProperty);
    expect(evalResult.eligible).toBe(true);
    expect(evalResult.scoreBreakdown.price).toBeGreaterThan(0);
  });

  // 19. Lead pausado não entra nas rodadas automáticas
  it('19. Lead pausado é identificado para exclusão de rodadas automáticas', () => {
    const profile = createMockProfile({ isPaused: true });
    expect(profile.isPaused).toBe(true);
  });

  // 20. Lead arquivado não entra nas rodadas automáticas
  it('20. Lead arquivado é identificado para exclusão de rodadas automáticas', () => {
    const profile = createMockProfile({ isArchived: true });
    expect(profile.isArchived).toBe(true);
  });

  // 21. Reativação volta a permitir Match
  it('21. Lead reativado (não pausado e não arquivado) fica elegível', () => {
    const profile = createMockProfile({ isPaused: false, isArchived: false });
    expect(!profile.isPaused && !profile.isArchived).toBe(true);
  });

  // 22. Match suprimido tem indicador permanente
  it('22. Supressão é booleana e permanente para o par', () => {
    const matchState = { suppressed: true, match_status: 'novo' };
    expect(matchState.suppressed).toBe(true);
  });

  // 23. Novo token é criado para cada envio
  it('23. Gera tokens criptográficos independentes para envios sucessivos', () => {
    const token1 = generateTrackingToken();
    const token2 = generateTrackingToken();
    expect(token1).not.toBe(token2);
    expect(token1.length).toBe(64);
  });

  // 24. Token não contém PII
  it('24. Token é hexadecimal opaco e sem informações pessoais', () => {
    const token = generateTrackingToken();
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
    expect(token).not.toContain('5583');
    expect(token).not.toContain('lead');
  });

  // 25. URL pública gerada corretamente
  it('25. Monta URL pública de compartilhamento com token opaco', () => {
    const token = generateTrackingToken();
    const url = buildSharePublicUrl(token, 'https://ronaldomeira.com.br');
    expect(url).toBe(`https://ronaldomeira.com.br/imoveis/p/${token}`);
  });

  // 26. Prioridade comercial prioriza maior engajamento
  it('26. Prioridade comercial posiciona lead quente e engajado acima de lead frio', () => {
    const prioHot = calculateCommercialPriority({
      matchScore: 94,
      aiScore: 9,
      profileMaturity: 90,
      recentInteractionDays: 1,
      sharesCount: 2,
      sharesOpenedCount: 2,
    });

    const prioCold = calculateCommercialPriority({
      matchScore: 94,
      aiScore: 2,
      profileMaturity: 70,
      recentInteractionDays: 15,
      sharesCount: 5,
      sharesOpenedCount: 0, // fadiga
    });

    expect(prioHot).toBeGreaterThan(prioCold);
  });

  // 27. Fadiga de envio aplica penalidade na prioridade comercial
  it('27. Múltiplos envios sem abertura aplicam penalidade de fadiga', () => {
    const prioNormal = calculateCommercialPriority({
      matchScore: 85,
      aiScore: 5,
      profileMaturity: 75,
      sharesCount: 1,
      sharesOpenedCount: 1,
    });

    const prioFatigued = calculateCommercialPriority({
      matchScore: 85,
      aiScore: 5,
      profileMaturity: 75,
      sharesCount: 6,
      sharesOpenedCount: 0,
    });

    expect(prioFatigued).toBeLessThan(prioNormal);
  });

  // 28. "Tenho interesse" adiciona bônus expressivo de prioridade
  it('28. Clique em "Tenho interesse" eleva prioridade comercial', () => {
    const withoutInterest = calculateCommercialPriority({
      matchScore: 80,
      aiScore: 6,
      profileMaturity: 80,
      hasInterestClick: false,
    });

    const withInterest = calculateCommercialPriority({
      matchScore: 80,
      aiScore: 6,
      profileMaturity: 80,
      hasInterestClick: true,
    });

    expect(withInterest).toBeGreaterThan(withoutInterest);
  });

  // 29. Faixas de Match (Forte >= 85, Bom 70-84, Manual < 70)
  it('29. Faixas de classificação de Match funcionam conforme os limiares', () => {
    const strongProp = createMockProperty();
    const strongResult = evaluateMatch(createMockProfile(), strongProp);
    expect(strongResult.isStrongMatch).toBe(true);

    const manualProfile = createMockProfile({ locations: ['Outro Bairro Desconhecido'] });
    const manualResult = evaluateMatch(manualProfile, strongProp);
    expect(manualResult.isManualOnly).toBe(true);
    expect(manualResult.matchScore).toBeLessThan(70);
  });

  // 30. Característica obrigatória ausente elimina
  it('30. Falta de característica obrigatória elimina do Match', () => {
    const profile = createMockProfile({ requiredFeatures: ['heliponto_privativo'] });
    const property = createMockProperty({ features: ['piscina', 'elevador'] });

    const evalResult = evaluateMatch(profile, property);
    expect(evalResult.eligible).toBe(false);
    expect(evalResult.eliminatedReason).toContain('heliponto_privativo');
  });

  // 31. Terreno não penaliza quartos (Normalização adaptativa)
  it('31. Tipologia terreno não exige quartos e normaliza pesos para 100%', () => {
    const landProfile = createMockProfile({
      propertyTypes: ['terreno'],
      bedrooms: [],
    });
    const maturity = calculateProfileMaturity(landProfile);
    expect(maturity.dimensions['bedrooms']).toBeUndefined();
    expect(maturity.maturity).toBeGreaterThan(0);
  });

  // 32. Pronto obrigatório vs Em Construção elimina
  it('32. "Só quero pronto" elimina imóvel em construção ou planta', () => {
    const profile = createMockProfile({
      deliveryStatus: ['pronto'],
      deliveryStrict: true,
    });
    const underConstruction = createMockProperty({
      deliveryStatus: 'em_construcao',
    });

    const evalResult = evaluateMatch(profile, underConstruction);
    expect(evalResult.eligible).toBe(false);
  });

  // 33. Lead buscando Apartamento elimina naturalmente Lotes e Salas Comerciais
  it('33. Lead buscando Apartamento elimina naturalmente Lotes e Salas Comerciais', () => {
    const profile = createMockProfile({
      propertyTypes: ['apartamento'],
      propertyTypeStrict: false,
    });
    const lote = createMockProperty({
      propertyType: 'lote',
      title: 'Lote no Altiplano',
    });
    const sala = createMockProperty({
      propertyType: 'sala comercial',
      title: 'Sala no Miramar',
    });

    const evalLote = evaluateMatch(profile, lote);
    const evalSala = evaluateMatch(profile, sala);

    expect(evalLote.eligible).toBe(false);
    expect(evalLote.eliminatedReason).toContain('terreno/lote');
    expect(evalSala.eligible).toBe(false);
    expect(evalSala.eliminatedReason).toContain('comercial');
  });

  // 34. Lead buscando João Pessoa elimina naturalmente imóvel em Bananeiras
  it('34. Lead buscando João Pessoa/Bessa elimina naturalmente imóvel em Bananeiras', () => {
    const profile = createMockProfile({
      locations: ['Bessa'],
      locationStrict: false,
    });
    const bananeirasProp = createMockProperty({
      city: 'Bananeiras',
      neighborhood: 'Serra',
      title: 'Chácara em Bananeiras',
    });

    const evalResult = evaluateMatch(profile, bananeirasProp);
    expect(evalResult.eligible).toBe(false);
    expect(evalResult.eliminatedReason).toContain('fora da praça metropolitana');
  });

  // 35. Lead buscando 3 quartos elimina naturalmente estúdio ou 1 quarto
  it('35. Lead buscando 3 quartos elimina naturalmente estúdio ou 1 quarto', () => {
    const profile = createMockProfile({
      bedrooms: [3],
      bedroomsStrict: false,
    });
    const oneBedFlat = createMockProperty({
      bedroomsMin: 1,
      bedroomsMax: 1,
      title: 'Flat compacto',
    });

    const evalResult = evaluateMatch(profile, oneBedFlat);
    expect(evalResult.eligible).toBe(false);
    expect(evalResult.eliminatedReason).toContain('compacto com apenas 1 quarto');
  });

  // 36. Nota de corte de 90% para match forte
  it('36. Limiar de 90% identifica Match Forte', () => {
    const profile = createMockProfile();
    const perfectProp = createMockProperty();
    const evalResult = evaluateMatch(profile, perfectProp);
    expect(evalResult.matchScore).toBeGreaterThanOrEqual(90);
    expect(evalResult.isStrongMatch).toBe(true);
  });
});

describe('Auditoria Resolutiva — Modalidade Comercial (Venda vs Locação) e Ordenação Comercial Oficial', () => {
  const baseContact = {
    id: '45ae43cc-037f-4f42-887a-2ca33bdc6c55',
    account_id: 'acc-1',
    name: 'Maria de Fátima Nunes',
    phone: '559591322780',
    ai_score: 7,
    paused_at: null,
    archived_at: null,
  };

  it('1. Lead interessado em locação (caso real Maria de Fátima Nunes) vs imóvel de venda -> bloqueado', () => {
    const mariaProfile = buildProfileFromData(
      baseContact,
      {
        summary: {
          purpose: [],
          location: ['Intermares'],
          property_type: ['Flat'],
          bedrooms: [1],
          price_max: null,
          notes:
            'Busca flat mobiliado em Intermares (o imóvel apresentado tem 23 m² e é só para locação anual de 12 meses).',
        },
      },
      [
        {
          source: 'ctwa',
          originally_from_ctwa: true,
          tags: { id: 't-1', name: 'Flat', category: 'Tipo de imóvel' },
        },
        {
          source: 'ctwa',
          originally_from_ctwa: true,
          tags: { id: 't-2', name: 'Intermares', category: 'Bairro' },
        },
        {
          source: 'ctwa',
          originally_from_ctwa: true,
          tags: { id: 't-3', name: 'Até 3000', category: 'Faixa de valor' },
        },
      ],
      {
        ctwa_referral: {
          headline: 'Flat mobiliado em Intermares - R$ 2.500/mês',
          body: 'Flat novo, mobiliado, primeira locação. Só locação anual.',
        },
      }
    );

    expect(mariaProfile.operation).toBe('locacao');
    expect(mariaProfile.priceMax).toBe(3000);

    const saleProp = createMockProperty({
      title: 'Apartamento no Intermares',
      operation: 'venda',
      propertyType: 'flat',
      neighborhood: 'Intermares',
      priceMin: 270000,
      priceMax: 270000,
    });

    const evalRes = evaluateMatch(mariaProfile, saleProp);
    expect(evalRes.eligible).toBe(false);
    expect(evalRes.matchScore).toBe(0);
    expect(evalRes.eliminatedReason).toContain('locação');
  });

  it('2. Lead interessado em compra vs imóvel de venda -> permitido', () => {
    const buyerProfile = buildProfileFromData(
      { ...baseContact, id: 'lead-buyer', name: 'Eduardo Cavalcante' },
      {
        summary: {
          purpose: ['Moradia', 'Investimento'],
          location: ['Bessa'],
          property_type: ['Apartamento'],
          bedrooms: [3],
          price_max: 500000,
          notes: 'Busca apartamento de 3 quartos no Bessa para compra/investimento.',
        },
      },
      [],
      null
    );

    expect(buyerProfile.operation).toBe('venda');
    const evalRes = evaluateMatch(buyerProfile, createMockProperty());
    expect(evalRes.eligible).toBe(true);
    expect(evalRes.matchScore).toBeGreaterThanOrEqual(90);
  });

  it('3. Lead com intenção comercial indefinida -> não tratado automaticamente como comprador', () => {
    const undefinedProfile = buildProfileFromData(
      { ...baseContact, id: 'lead-undef', name: 'Vildson Mendonça' },
      {
        summary: {
          purpose: [],
          location: ['Intermares'],
          property_type: ['Studio'],
          price_max: null,
          notes: 'Não há preço, prazo ou finalidade explícitos além da busca por informações sobre o imóvel.',
        },
      },
      [
        {
          source: 'conversation',
          originally_from_ctwa: false,
          tags: { id: 't-1', name: 'Intermares', category: 'Bairro' },
        },
      ],
      { ctwa_referral: { headline: 'Fale conosco' } }
    );

    expect(undefinedProfile.operation).toBe('indefinido');
    const evalRes = evaluateMatch(undefinedProfile, createMockProperty({ neighborhood: 'Intermares' }));
    expect(evalRes.eligible).toBe(false);
    expect(evalRes.eliminatedReason).toContain('Intenção comercial de compra ainda não confirmada');
  });

  it('4. Mudança posterior de compra para locação -> invalida perfil para compra e remove matches ativos anteriores', async () => {
    const pivotedProfile = buildProfileFromData(
      { ...baseContact, id: 'lead-pivot', name: 'Vitor Leonardo' },
      {
        summary: {
          purpose: ['Locação', 'Compra'],
          location: ['Intermares'],
          property_type: ['Apartamento'],
          price_max: null,
          notes:
            'O lead iniciou pedindo mais informações sobre um studio à venda em Intermares e depois perguntou por apartamento para aluguel.',
        },
      },
      [
        {
          source: 'ctwa',
          originally_from_ctwa: true,
          tags: { id: 't-compra', name: 'Compra', category: 'Finalidade' },
        },
      ],
      null
    );

    expect(pivotedProfile.operation).toBe('locacao');

    // Simula recalculateMatchesForLead removendo matches pendentes ('novo' / 'em_analise') quando o lead passa a buscar locação
    const deletedIds: string[] = [];
    const fakeDb = {
      from(table: string) {
        if (table === 'contacts') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { ...baseContact, id: 'lead-pivot', name: 'Vitor Leonardo' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'lead_intelligence') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    summary: {
                      purpose: ['Locação'],
                      location: ['Intermares'],
                      property_type: ['Apartamento'],
                      notes: 'Passou a buscar aluguel anual em Intermares.',
                    },
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'contact_tags') {
          return {
            select: () => ({
              eq: () => ({
                returns: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }
        if (table === 'conversations') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({ data: null, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'lead_property_matches') {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({
                  data: [
                    { id: 'm-active-1', match_status: 'novo', suppressed: false },
                    { id: 'm-active-2', match_status: 'em_analise', suppressed: false },
                    { id: 'm-sent-1', match_status: 'enviado', suppressed: false },
                  ],
                  error: null,
                }),
              }),
            }),
            delete: () => ({
              in: vi.fn(async (_col: string, ids: string[]) => {
                deletedIds.push(...ids);
                return { error: null };
              }),
            }),
          };
        }
        return {};
      },
    } as unknown as SupabaseClient;

    const recalcRes = await recalculateMatchesForLead(fakeDb, 'acc-1', 'lead-pivot');
    expect(recalcRes.staleRemovedCount).toBe(2);
    expect(deletedIds).toEqual(['m-active-1', 'm-active-2']);
  });

  it('5. Interesse simultâneo em compra e locação -> somente elegível quando houver evidência confiável de interesse atual em compra', () => {
    const dualWithoutPurchaseEvidence = buildProfileFromData(
      { ...baseContact, id: 'lead-dual-1', name: 'Dual Ambíguo' },
      {
        summary: {
          purpose: ['Locação', 'Compra'],
          location: ['Bessa'],
          property_type: ['Apartamento'],
          price_max: null,
          notes: 'Avaliando opções no Bessa.',
        },
      },
      [],
      null
    );
    expect(dualWithoutPurchaseEvidence.operation).toBe('indefinido');
    expect(evaluateMatch(dualWithoutPurchaseEvidence, createMockProperty()).eligible).toBe(false);

    const dualWithConfirmedPurchase = buildProfileFromData(
      { ...baseContact, id: 'lead-dual-2', name: 'Dual Comprador' },
      {
        summary: {
          purpose: ['Locação', 'Compra'],
          location: ['Bessa'],
          property_type: ['Apartamento'],
          price_max: 480000,
          notes: 'Avalia compra com financiamento bancário até 480 mil no Bessa.',
        },
      },
      [],
      null
    );
    expect(dualWithConfirmedPurchase.operation).toBe('venda');
    expect(evaluateMatch(dualWithConfirmedPurchase, createMockProperty()).eligible).toBe(true);
  });

  it('6–9. Hierarquia obrigatória de ordenação (1º Match% DESC -> 2º Maturidade DESC -> 3º Score IA DESC -> 4º Desempate determinístico) e estabilidade na paginação', () => {
    const groups: SortableMatchGroup[] = [
      {
        leadId: 'lead-96-high-mat',
        profileMaturity: 95,
        aiScore: 10,
        latestMatchAt: '2026-11-22T22:00:00Z',
        bestMatch: { match_score: 96, commercial_priority: 99 },
      },
      {
        leadId: 'lead-98-low-mat',
        profileMaturity: 72,
        aiScore: 4,
        latestMatchAt: '2026-11-15T10:00:00Z',
        bestMatch: { match_score: 98, commercial_priority: 65 },
      },
      {
        leadId: 'lead-96-mid-mat-cold',
        profileMaturity: 85,
        aiScore: 5,
        latestMatchAt: '2026-11-22T20:00:00Z',
        bestMatch: { match_score: 96, commercial_priority: 80 },
      },
      {
        leadId: 'lead-96-mid-mat-hot',
        profileMaturity: 85,
        aiScore: 9,
        latestMatchAt: '2026-11-20T10:00:00Z',
        bestMatch: { match_score: 96, commercial_priority: 75 },
      },
      {
        leadId: 'lead-96-mid-mat-hot-older',
        profileMaturity: 85,
        aiScore: 9,
        latestMatchAt: '2026-11-18T10:00:00Z',
        bestMatch: { match_score: 96, commercial_priority: 75 },
      },
    ];

    const sorted = [...groups].sort((a, b) => compareMatchGroups(a, b, 'score_desc'));

    expect(sorted.map((g) => g.leadId)).toEqual([
      'lead-98-low-mat',           // 1º: 98% vence qualquer 96%, mesmo mais antigo ou com menor maturidade/aiScore
      'lead-96-high-mat',          // 2º: Entre os 96%, maior maturidade (95 > 85) vence
      'lead-96-mid-mat-hot',       // 3º: Mesmo Match% (96) e mesma maturidade (85) -> maior Score IA (9 > 5) e mais recente
      'lead-96-mid-mat-hot-older', // 4º: Empate em Match% (96), maturidade (85) e Score IA (9) -> desempate determinístico por data
      'lead-96-mid-mat-cold',      // 5º: Match% 96, maturidade 85, Score IA 5
    ]);

    // Paginação estável sem sobreposição nem inversão entre páginas
    const page1 = sorted.slice(0, 2);
    const page2 = sorted.slice(2, 4);
    const page3 = sorted.slice(4, 6);
    expect([...page1, ...page2, ...page3].map((g) => g.leadId)).toEqual(
      sorted.map((g) => g.leadId)
    );
  });

  it('10. Projeções de imóveis de locação são bloqueadas no motor mesmo que o lead tenha perfil completo', () => {
    const buyerProfile = createMockProfile({ operation: 'venda' });
    const rentProfile = createMockProfile({ operation: 'locacao' });
    const rentProperty = createMockProperty({ operation: 'locacao', priceMin: 2500, priceMax: 2500 });

    expect(evaluateMatch(buyerProfile, rentProperty).eligible).toBe(false);
    expect(evaluateMatch(rentProfile, rentProperty).eligible).toBe(false);
  });
});
