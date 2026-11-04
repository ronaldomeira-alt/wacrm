// ============================================================
// WACRM MCP Tools — Unit Tests for 5 Commercial Read Tools
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { executeObterCandidatosFollowup } from './tools/candidatos-followup';
import { executeObterContextoComercial } from './tools/contexto-comercial';
import { executeObterContextoRecente } from './tools/contexto-recente';
import { executeBuscarMatches } from './tools/buscar-matches';
import { executeConsultarEstado } from './tools/consultar-estado';
import type { McpContext } from './types';

describe('WACRM MCP Tools Unit Tests', () => {
  const context: McpContext = {
    accountId: 'f8d2ae51-e393-4a74-a432-ddab0610837e',
    authMethod: 'token',
  };

  it('1. obter_candidatos_followup_matinal: processa leads com atendimento humano sem excluí-los', async () => {
    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'conv-1',
                  contact_id: 'lead-1',
                  status: 'open',
                  assigned_agent_id: 'agent-1',
                  last_message_text: 'Olá Thatianna, vi a opção do Bessa',
                  last_message_at: new Date().toISOString(),
                  unread_count: 1,
                  ai_autoreply_disabled: true, // ATENDIMENTO HUMANO
                  needs_review: false,
                  contacts: {
                    id: 'lead-1',
                    name: 'Carlos Oliveira',
                    phone: '5583999991111',
                    ai_score: 8,
                    paused_at: null,
                    archived_at: null,
                  },
                },
              ],
              error: null,
            }),
          };
        }
        if (table === 'lead_intelligence') {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({
              data: [
                {
                  contact_id: 'lead-1',
                  summary: { purpose: ['investimento'], location: ['Bessa'] },
                  last_analyzed_at: new Date().toISOString(),
                },
              ],
            }),
          };
        }
        if (table === 'action_items' || table === 'appointments' || table === 'property_shares' || table === 'deals') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({ data: [] }),
          };
        }
        if (table === 'profiles') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({
              data: [{ id: 'agent-1', full_name: 'Thatianna Oliveira', email: 'thatiannaoliveira@hotmail.com' }],
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      }),
    } as any;

    const res = await executeObterCandidatosFollowup(mockDb, context, { limite: 10 });
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.candidatos).toHaveLength(1);

    const candidato = (res.structuredContent?.candidatos as any[])[0];
    expect(candidato.lead_id).toBe('lead-1');
    expect(candidato.atendimento_humano_ativo).toBe(true);
    expect(candidato.responsavel.nome).toBe('Thatianna Oliveira');
    expect(candidato.autorizacao_disparo_exigida).toContain('Thatianna');
  });

  it('2. obter_contexto_comercial_lead: retorna resumo da Clara e detecta desatualização se há nova mensagem', async () => {
    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'contacts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'lead-2',
                name: 'Juliana Paes',
                phone: '5583988882222',
                ai_score: 7,
                ai_score_reason: 'Demonstrou forte interesse em flats',
                paused_at: null,
                archived_at: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'conv-2',
                status: 'open',
                last_message_at: '2026-11-04T12:00:00Z', // Mensagem MAIS NOVA que a análise
              },
            }),
          };
        }
        if (table === 'lead_intelligence') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                summary: {
                  purpose: ['investimento'],
                  property_type: ['Flat'],
                  location: ['Intermares'],
                  price_max: 350000,
                  notes: 'Busca rentabilidade de temporada',
                },
                last_analyzed_at: '2026-11-04T10:00:00Z', // 2 horas antes
              },
            }),
          };
        }
        if (table === 'messages') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockResolvedValue({ count: 2 }),
          };
        }
        // Defaults para deals, action_items, appointments, property_shares
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    } as any;

    const res = await executeObterContextoComercial(mockDb, context, { lead_id: 'lead-2' });
    expect(res.structuredContent?.ok).toBe(true);

    const intel = res.structuredContent?.resumo_inteligencia as any;
    expect(intel.status).toBe('desatualizado');
    expect(intel.mensagens_novas_pendentes_analise).toBe(2);
    expect(intel.orcamento.maximo).toBe(350000);
    expect(intel.tipologia).toContain('Flat');
  });

  it('3. obter_contexto_recente: diferencia cliente, clara e atendente humano', async () => {
    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'conv-3' } }),
          };
        }
        if (table === 'messages') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'm3',
                  sender_type: 'agent',
                  content_type: 'text',
                  content_text: 'Bom dia! Sou a Thatianna.',
                  private: false,
                  created_at: '2026-11-04T09:02:00Z',
                },
                {
                  id: 'm2',
                  sender_type: 'bot',
                  content_type: 'text',
                  content_text: 'Olá! Sou a Clara.',
                  private: false,
                  created_at: '2026-11-04T09:01:00Z',
                },
                {
                  id: 'm1',
                  sender_type: 'customer',
                  content_type: 'text',
                  content_text: 'Olá, gostaria de saber sobre flats.',
                  private: false,
                  created_at: '2026-11-04T09:00:00Z',
                },
              ],
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      }),
    } as any;

    const res = await executeObterContextoRecente(mockDb, context, { lead_id: 'lead-3', limite: 5 });
    expect(res.structuredContent?.ok).toBe(true);

    const msgs = res.structuredContent?.mensagens as any[];
    expect(msgs).toHaveLength(3);
    expect(msgs[0].origem).toBe('cliente');
    expect(msgs[1].origem).toBe('clara');
    expect(msgs[2].origem).toBe('atendente_humano');
  });

  it('4. buscar_matches_lead: retorna correspondências e código Meus Imóveis sem recalcular', async () => {
    const builder: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'match-1',
            property_id: 'prop-uuid-1',
            match_score: 92,
            score_breakdown: { reasons: ['Bairro e tipologia compatíveis'], price: 25 },
            match_status: 'novo',
            suppressed: false,
            property_match_projections: {
              id: 'prop-proj-1',
              code: 'alliance-solar-bessa',
              title: 'Solar do Bessa',
              operation: 'venda',
              property_type: 'apartamento',
              neighborhood: 'Bessa',
              price_min: 345000,
              status: 'ativo',
            },
          },
        ],
      }),
    };
    const mockDb = {
      from: vi.fn(() => builder),
    } as any;

    const res = await executeBuscarMatches(mockDb, context, { lead_id: 'lead-4' });
    expect(res.structuredContent?.ok).toBe(true);
    const matches = res.structuredContent?.matches as any[];
    expect(matches).toHaveLength(1);
    expect(matches[0].codigo_meus_imoveis).toBe('alliance-solar-bessa');
    expect(matches[0].score).toBe(92);
    expect(matches[0].imovel.link_previa_meus_imoveis).toBe('https://ronaldomeira.com.br/imovel/alliance-solar-bessa');
  });

  it('5. consultar_estado_lead: retorna estado operacional e validação de bloqueios', async () => {
    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'contacts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'lead-5',
                name: 'Mariana Lima',
                phone: '5583977773333',
                ai_score: 6,
                paused_at: null,
                archived_at: null,
              },
            }),
          };
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'conv-5',
                status: 'open',
                needs_review: true,
                unread_count: 0,
                last_message_at: '2026-11-04T15:00:00Z',
              },
            }),
          };
        }
        const genericBuilder: any = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
        genericBuilder.then = (resolve: any) => Promise.resolve({ data: [] }).then(resolve);
        return genericBuilder;
      }),
    } as any;

    const res = await executeConsultarEstado(mockDb, context, { lead_id: 'lead-5' });
    expect(res.structuredContent?.ok).toBe(true);
    const estado = res.structuredContent as any;
    expect(estado.supervisao.needs_review).toBe(true);
    expect(estado.bloqueios_e_cadencia.pausado_manualmente).toBe(false);
  });
});
