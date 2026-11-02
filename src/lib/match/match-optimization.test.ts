import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recalculateMatchesForProperty, recalculateMatchesForLead } from './service';
import { isMatchRelevantProjectionChange } from './change-detection';

describe('Otimização do Mecanismo de Match e Redução de Egress', () => {
  const accountId = 'acc-opt-001';
  const propertyId = 'prop-opt-100';
  const contactId = 'lead-opt-500';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. recalculateMatchesForProperty executa consultas e upsert em lote sem N+1 queries', async () => {
    let upsertPayload: unknown = null;
    let contactsQueryCount = 0;
    let intelligenceQueryCount = 0;
    let tagsQueryCount = 0;
    let conversationsQueryCount = 0;

    const mockPropertyRow = {
      id: 'proj-1',
      property_id: propertyId,
      account_id: accountId,
      code: 'AP-101',
      title: 'Residencial Cabo Branco',
      operation: 'venda',
      property_type: 'apartamento',
      neighborhood: 'Cabo Branco',
      city: 'João Pessoa',
      price_min: 500000,
      price_max: 600000,
      area_min: 70,
      area_max: 90,
      bedrooms_min: 2,
      bedrooms_max: 3,
      delivery_status: 'pronto',
      delivery_deadline: null,
      features: ['piscina', 'elevador'],
      cover_url: 'https://img.test/capa.jpg',
      public_url: 'https://imoveis.test/p/101',
      status: 'ativo',
    };

    const mockContacts = [
      {
        id: 'lead-1',
        account_id: accountId,
        name: 'Carlos Oliveira',
        phone: '5583999990001',
        ai_score: 85,
        paused_at: null,
        archived_at: null,
      },
      {
        id: 'lead-2',
        account_id: accountId,
        name: 'Mariana Santos',
        phone: '5583999990002',
        ai_score: 90,
        paused_at: null,
        archived_at: null,
      },
    ];

    const mockIntelligence = [
      {
        contact_id: 'lead-1',
        summary: {
          purpose: ['Moradia'],
          property_type: ['Apartamento'],
          location: ['Cabo Branco'],
          price_max: 700000,
          bedrooms: [2, 3],
          features: ['piscina'],
        },
      },
      {
        contact_id: 'lead-2',
        summary: {
          purpose: ['Investimento'],
          property_type: ['Apartamento'],
          location: ['Manaíra'], // Bairro diferente
          price_max: 400000, // Preço abaixo
          bedrooms: [1],
        },
      },
    ];

    const mockTags = [
      {
        contact_id: 'lead-1',
        source: 'conversation',
        originally_from_ctwa: false,
        tags: { id: 'tag-1', name: 'Apartamento', category: 'Tipo de imóvel' },
      },
      {
        contact_id: 'lead-1',
        source: 'conversation',
        originally_from_ctwa: false,
        tags: { id: 'tag-2', name: 'Cabo Branco', category: 'Bairro' },
      },
    ];

    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'property_match_projections') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: mockPropertyRow,
              error: null,
            }),
          };
        }

        if (table === 'contacts') {
          contactsQueryCount++;
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            returns: vi.fn().mockResolvedValue({
              data: mockContacts,
              error: null,
            }),
          };
        }

        if (table === 'lead_intelligence') {
          intelligenceQueryCount++;
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({
              data: mockIntelligence,
              error: null,
            }),
          };
        }

        if (table === 'contact_tags') {
          tagsQueryCount++;
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({
              data: mockTags,
              error: null,
            }),
          };
        }

        if (table === 'conversations') {
          conversationsQueryCount++;
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          };
        }

        if (table === 'lead_property_matches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            upsert: vi.fn((payload) => {
              upsertPayload = payload;
              return Promise.resolve({ error: null });
            }),
            in: vi.fn().mockReturnThis(),
          };
        }

        return {};
      }),
    } as unknown as SupabaseClient;

    const result = await recalculateMatchesForProperty(mockDb, accountId, propertyId);

    // Valida que foram executadas exatamente consultas em lote únicas (sem N queries por lead)
    expect(contactsQueryCount).toBe(1);
    expect(intelligenceQueryCount).toBe(1);
    expect(tagsQueryCount).toBe(1);
    expect(conversationsQueryCount).toBe(1);

    // Avaliou lead-1 com sucesso (lead-2 incompatível por localização e preço)
    expect(result.totalLeadsEvaluated).toBe(1);

    // O upsert foi em lote (array com 1 elemento correspondente ao lead compatível)
    expect(Array.isArray(upsertPayload)).toBe(true);
    const batch = upsertPayload as Array<{ lead_id: string; property_id: string; match_score: number }>;
    expect(batch.length).toBe(1);
    expect(batch[0].lead_id).toBe('lead-1');
    expect(batch[0].property_id).toBe(propertyId);
    expect(batch[0].match_score).toBeGreaterThanOrEqual(70);
  });

  it('2. recalculateMatchesForProperty respeita supressão permanente gravada pelo corretor', async () => {
    let upsertPayload: unknown = null;

    const mockPropertyRow = {
      id: 'proj-1',
      property_id: propertyId,
      account_id: accountId,
      code: 'AP-101',
      title: 'Residencial Cabo Branco',
      operation: 'venda',
      property_type: 'apartamento',
      neighborhood: 'Cabo Branco',
      city: 'João Pessoa',
      price_min: 500000,
      price_max: 600000,
      area_min: 70,
      area_max: 90,
      bedrooms_min: 2,
      bedrooms_max: 3,
      delivery_status: 'pronto',
      delivery_deadline: null,
      features: ['piscina'],
      status: 'ativo',
    };

    const mockContacts = [
      {
        id: 'lead-suppressed',
        account_id: accountId,
        name: 'Lead Que Descartou',
        phone: '5583999990001',
        ai_score: 80,
        paused_at: null,
        archived_at: null,
      },
    ];

    const mockIntelligence = [
      {
        contact_id: 'lead-suppressed',
        summary: {
          purpose: ['Moradia'],
          property_type: ['Apartamento'],
          location: ['Cabo Branco'],
          price_max: 700000,
          bedrooms: [2],
        },
      },
    ];

    const mockExistingMatches = [
      {
        lead_id: 'lead-suppressed',
        suppressed: true, // Já foi descartado pelo corretor!
        match_status: 'arquivado',
        origin: 'match_automatico',
      },
    ];

    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'property_match_projections') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: mockPropertyRow, error: null }),
          };
        }
        if (table === 'contacts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            returns: vi.fn().mockResolvedValue({ data: mockContacts, error: null }),
          };
        }
        if (table === 'lead_intelligence') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: mockIntelligence, error: null }),
          };
        }
        if (table === 'contact_tags') {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === 'lead_property_matches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            upsert: vi.fn((payload) => {
              upsertPayload = payload;
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient;

    // Simula retorno do match pré-existente suprimido
    (mockDb.from as any).mockImplementation((table: string) => {
      if (table === 'property_match_projections') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: mockPropertyRow, error: null }),
        };
      }
      if (table === 'contacts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          returns: vi.fn().mockResolvedValue({ data: mockContacts, error: null }),
        };
      }
      if (table === 'lead_intelligence') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: mockIntelligence, error: null }),
        };
      }
      if (table === 'contact_tags') {
        return {
          select: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }
      if (table === 'conversations') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }
      if (table === 'lead_property_matches') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockImplementation((col: string) => {
            if (col === 'property_id') {
              return Promise.resolve({ data: mockExistingMatches, error: null });
            }
            return {
              eq: vi.fn().mockResolvedValue({ data: mockExistingMatches, error: null }),
            };
          }),
          upsert: vi.fn((payload) => {
            upsertPayload = payload;
            return Promise.resolve({ error: null });
          }),
        };
      }
      return {};
    });

    const result = await recalculateMatchesForProperty(mockDb, accountId, propertyId);

    // O lead suprimido foi ignorado
    expect(result.totalLeadsEvaluated).toBe(0);
    expect(upsertPayload).toBeNull();
  });

  it('3. recalculateMatchesForLead grava matches em lote único (batch upsert)', async () => {
    let upsertCallCount = 0;
    let upsertPayload: unknown = null;

    const mockContact = {
      id: contactId,
      account_id: accountId,
      name: 'Roberta Lima',
      phone: '5583988887777',
      ai_score: 95,
      paused_at: null,
      archived_at: null,
    };

    const mockIntelligence = {
      summary: {
        purpose: ['Moradia'],
        property_type: ['Apartamento'],
        location: ['Tambaú', 'Cabo Branco'],
        price_max: 900000,
        bedrooms: [3],
      },
    };

    const mockProjections = [
      {
        id: 'p1',
        property_id: 'prop-1',
        account_id: accountId,
        title: 'Edifício Tambaú Master',
        operation: 'venda',
        property_type: 'apartamento',
        neighborhood: 'Tambaú',
        city: 'João Pessoa',
        price_min: 750000,
        price_max: 850000,
        bedrooms_min: 3,
        bedrooms_max: 3,
        delivery_status: 'pronto',
        status: 'ativo',
      },
      {
        id: 'p2',
        property_id: 'prop-2',
        account_id: accountId,
        title: 'Residencial Cabo Branco Top',
        operation: 'venda',
        property_type: 'apartamento',
        neighborhood: 'Cabo Branco',
        city: 'João Pessoa',
        price_min: 800000,
        price_max: 890000,
        bedrooms_min: 3,
        bedrooms_max: 4,
        delivery_status: 'pronto',
        status: 'ativo',
      },
    ];

    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'contacts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: mockContact, error: null }),
          };
        }
        if (table === 'lead_intelligence') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: mockIntelligence, error: null }),
          };
        }
        if (table === 'contact_tags') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            returns: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === 'property_match_projections') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation((col: string, val: string) => {
              if (col === 'status') {
                return Promise.resolve({ data: mockProjections, error: null });
              }
              return {
                eq: vi.fn().mockResolvedValue({ data: mockProjections, error: null }),
              };
            }),
          };
        }
        if (table === 'lead_property_matches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation((col: string) => {
              if (col === 'lead_id') {
                return Promise.resolve({ data: [], error: null });
              }
              return {
                eq: vi.fn().mockResolvedValue({ data: [], error: null }),
              };
            }),
            upsert: vi.fn((payload) => {
              upsertCallCount++;
              upsertPayload = payload;
              return Promise.resolve({ error: null });
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient;

    const result = await recalculateMatchesForLead(mockDb, accountId, contactId);

    // Verificou que ambos os imóveis foram compatíveis
    expect(result.matchesCreatedOrUpdated).toBe(2);

    // CRUCIAL: Exatamente 1 única chamada ao upsert HTTP em lote, em vez de 2 requisições isoladas!
    expect(upsertCallCount).toBe(1);
    expect(Array.isArray(upsertPayload)).toBe(true);
    expect((upsertPayload as unknown[]).length).toBe(2);
  });

  describe('Detecção de Mudança Relevante de Projeção (Eliminação de Tempestade de Recálculos)', () => {
    const baseProj = {
      status: 'ativo',
      operation: 'venda',
      property_type: 'apartamento',
      neighborhood: 'Cabo Branco',
      city: 'João Pessoa',
      price_min: 500000,
      price_max: 600000,
      area_min: 70,
      area_max: 90,
      bedrooms_min: 2,
      bedrooms_max: 3,
      delivery_status: 'pronto',
      delivery_deadline: null,
      features: ['piscina', 'elevador'],
      cover_url: 'https://cdn.meus-imoveis.com/capa1.jpg',
      public_url: 'https://meus-imoveis.com/p/1',
      title: 'Residencial Cabo Branco',
      code: 'AP-101',
    };

    it('4. Retorna false quando apenas campos cosméticos ou não-match são alterados (fotos, links, título, código, descrições)', () => {
      const cosmeticChange = {
        ...baseProj,
        cover_url: 'https://cdn.meus-imoveis.com/nova-capa.jpg',
        public_url: 'https://meus-imoveis.com/p/novo-link',
        title: 'Residencial Cabo Branco - Atualizado',
        code: 'AP-101-REV',
      };

      expect(isMatchRelevantProjectionChange(baseProj, cosmeticChange)).toBe(false);
    });

    it('5. Retorna true quando preço é alterado', () => {
      const priceChange = {
        ...baseProj,
        price_min: 550000,
      };
      expect(isMatchRelevantProjectionChange(baseProj, priceChange)).toBe(true);
    });

    it('6. Retorna true quando bairro é alterado', () => {
      const neighborhoodChange = {
        ...baseProj,
        neighborhood: 'Manaíra',
      };
      expect(isMatchRelevantProjectionChange(baseProj, neighborhoodChange)).toBe(true);
    });

    it('7. Retorna true quando status muda (ex: ativo -> inativo)', () => {
      const statusChange = {
        ...baseProj,
        status: 'inativo',
      };
      expect(isMatchRelevantProjectionChange(baseProj, statusChange)).toBe(true);
    });

    it('8. Retorna true quando tipologia ou quartos são alterados', () => {
      const bedroomChange = {
        ...baseProj,
        bedrooms_max: 4,
      };
      expect(isMatchRelevantProjectionChange(baseProj, bedroomChange)).toBe(true);
    });

    it('9. Retorna true quando características (features) são adicionadas ou removidas', () => {
      const featuresChange = {
        ...baseProj,
        features: ['piscina', 'elevador', 'academia'],
      };
      expect(isMatchRelevantProjectionChange(baseProj, featuresChange)).toBe(true);
    });
  });
});
