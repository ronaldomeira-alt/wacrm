import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const mockGetCurrentAccount = vi.fn();

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: () => mockGetCurrentAccount(),
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 500 }),
}));

function buildMockSupabase(fixtures: {
  suggestions: Array<Record<string, unknown>>;
  conversations?: Array<Record<string, unknown>>;
  deals?: Array<Record<string, unknown>>;
  intelligence?: Array<Record<string, unknown>>;
  tags?: Array<Record<string, unknown>>;
  pipelines?: Array<Record<string, unknown>>;
  projections?: Array<Record<string, unknown>>;
  matches?: Array<Record<string, unknown>>;
}) {
  return {
    from: (table: string) => {
      const state: {
        eqFilters: Record<string, unknown>;
        inFilters: Record<string, unknown[]>;
        rangeFrom: number;
        rangeTo: number;
      } = {
        eqFilters: {},
        inFilters: {},
        rangeFrom: 0,
        rangeTo: 999,
      };

      const resolveRows = () => {
        let rows: Array<Record<string, unknown>> = [];
        if (table === 'ai_suggestions') rows = [...fixtures.suggestions];
        else if (table === 'conversations') rows = [...(fixtures.conversations || [])];
        else if (table === 'deals') rows = [...(fixtures.deals || [])];
        else if (table === 'lead_intelligence') rows = [...(fixtures.intelligence || [])];
        else if (table === 'contact_tags') rows = [...(fixtures.tags || [])];
        else if (table === 'pipelines') rows = [...(fixtures.pipelines || [])];
        else if (table === 'property_match_projections') rows = [...(fixtures.projections || [])];
        else if (table === 'lead_property_matches') rows = [...(fixtures.matches || [])];

        for (const [k, v] of Object.entries(state.eqFilters)) {
          rows = rows.filter((r) => r[k] === v);
        }
        for (const [k, arr] of Object.entries(state.inFilters)) {
          const set = new Set(arr);
          rows = rows.filter((r) => set.has(r[k]));
        }

        if (table === 'ai_suggestions') {
          rows = rows.slice(state.rangeFrom, state.rangeTo + 1);
        }
        return { data: rows, error: null };
      };

      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          state.eqFilters[k] = v;
          return chain;
        },
        in: (k: string, arr: unknown[]) => {
          state.inFilters[k] = arr;
          return chain;
        },
        order: () => chain,
        range: (from: number, to: number) => {
          state.rangeFrom = from;
          state.rangeTo = to;
          return Promise.resolve(resolveRows());
        },
        then: (resolve: (val: unknown) => void) => resolve(resolveRows()),
      };

      return chain;
    },
  };
}

describe('GET /api/followup — Paginação, Contadores, 193+ Sugestões e Integração com Match', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserva contadores totais de 193 sugestões pendentes enquanto filtra e pagina os últimos 7 dias (padrão)', async () => {
    const now = new Date();
    const recentIso = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oldIso = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const futureSnoozeIso = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();

    // 40 sugestões recentes (últimos 7 dias) + 153 sugestões antigas (> 7 dias) = 193 pendentes ativas
    // + 1 sugestão adiada (snoozed_until no futuro) + 5 realizadas ('done') + 3 aceitas ('approved')
    const suggestions: Array<Record<string, unknown>> = [];

    for (let i = 0; i < 193; i++) {
      const isRecent = i < 40;
      const contactId = `contact-${i + 1}`;
      suggestions.push({
        id: `sugg-${i + 1}`,
        account_id: 'acc-1',
        contact_id: contactId,
        conversation_id: `conv-${i + 1}`,
        category: 'followup',
        title: `Motivo comercial para o lead ${i + 1}`,
        description: 'Retomar contato com abordagem consultiva',
        status: 'pending',
        snoozed_until: null,
        created_at: isRecent ? recentIso : oldIso,
        updated_at: isRecent ? recentIso : oldIso,
        payload: {
          score: 70 + (i % 25),
          stage_name: i % 2 === 0 ? 'Interesse' : 'Qualificação',
          hours_since_contact: 72,
          reason: `Motivo comercial para o lead ${i + 1}`,
          approach_summary: 'Retomar contato com abordagem consultiva',
        },
        contact: {
          id: contactId,
          name: `Lead ${i + 1}`,
          phone: `558399000${String(i + 1).padStart(4, '0')}`,
          ai_score: (i % 10) + 1,
          has_purchased: false,
          is_personal_whatsapp: false,
        },
      });
    }

    // 1 sugestão snoozed para o futuro (não deve inflar as 193 pendentes visíveis)
    suggestions.push({
      id: 'sugg-snoozed',
      account_id: 'acc-1',
      contact_id: 'contact-snoozed',
      conversation_id: 'conv-snoozed',
      category: 'followup',
      title: 'Sugestão adiada',
      status: 'pending',
      snoozed_until: futureSnoozeIso,
      created_at: recentIso,
      updated_at: recentIso,
      payload: { score: 80 },
      contact: { id: 'contact-snoozed', name: 'Lead Adiado', phone: '5583900000000', ai_score: 5 },
    });

    // 3 aceitas e 5 realizadas no histórico
    for (let i = 0; i < 3; i++) {
      suggestions.push({
        id: `sugg-approved-${i}`,
        account_id: 'acc-1',
        contact_id: `contact-ap-${i}`,
        category: 'followup',
        title: 'Sugestão aceita',
        status: 'approved',
        created_at: oldIso,
        updated_at: oldIso,
        payload: { score: 80 },
        contact: { id: `contact-ap-${i}`, name: `Lead Aceito ${i}`, phone: '5583911111111' },
      });
    }
    for (let i = 0; i < 5; i++) {
      suggestions.push({
        id: `sugg-done-${i}`,
        account_id: 'acc-1',
        contact_id: `contact-dn-${i}`,
        category: 'followup',
        title: 'Sugestão realizada',
        status: 'done',
        created_at: oldIso,
        updated_at: oldIso,
        payload: { score: 90 },
        contact: { id: `contact-dn-${i}`, name: `Lead Realizado ${i}`, phone: '5583922222222' },
      });
    }

    const mockSupabase = buildMockSupabase({
      suggestions,
      projections: [
        {
          property_id: 'prop-bessa-1',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Avant Home Bessa',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 480000,
          price_max: 550000,
          bedrooms_min: 1,
          delivery_status: 'lancamento',
          public_url: 'https://ronaldomeira.com.br/imovel/avant-home',
        },
      ],
      matches: [
        {
          id: 'match-lead-1',
          account_id: 'acc-1',
          lead_id: 'contact-1',
          property_id: 'prop-bessa-1',
          match_score: 93,
          commercial_priority: 85,
          match_status: 'novo',
          suppressed: false,
          score_breakdown: { reasons: ['Studio no Bessa'] },
        },
      ],
    });

    mockGetCurrentAccount.mockResolvedValue({
      supabase: mockSupabase,
      accountId: 'acc-1',
      userId: 'user-1',
      role: 'owner',
    });

    // 1. Consulta padrão: status=pending, date_filter=7d, page=1, page_size=36
    const req7d = new Request('http://localhost/api/followup?status=pending&date_filter=7d&page=1');
    const res7d = await GET(req7d);
    expect(res7d.status).toBe(200);
    const body7d = await res7d.json();

    expect(body7d.counts.pending).toBe(193);
    expect(body7d.counts.approved).toBe(3);
    expect(body7d.counts.done).toBe(5);
    expect(body7d.counts.filteredInPeriod).toBe(40);
    expect(body7d.pagination.totalItems).toBe(40);
    expect(body7d.pagination.pageSize).toBe(36);
    expect(body7d.pagination.totalPages).toBe(2);
    expect(body7d.items).toHaveLength(36);

    // Verifica hidratação de imóveis compatíveis do Match para o contact-1 caso esteja na página
    const contact1Item = body7d.items.find(
      (it: { contact: { id: string } }) => it.contact.id === 'contact-1'
    );
    if (contact1Item) {
      expect(contact1Item.compatiblePropertiesCount).toBe(1);
      expect(contact1Item.compatibleProperties[0].title).toBe('Avant Home Bessa');
      expect(contact1Item.compatibleProperties[0].matchScore).toBe(93);
    }

    // 2. Consulta de todas as datas: date_filter=all retorna todas as 193 pendentes paginadas
    const reqAll = new Request(
      'http://localhost/api/followup?status=pending&date_filter=all&page=1'
    );
    const resAll = await GET(reqAll);
    const bodyAll = await resAll.json();

    expect(bodyAll.counts.pending).toBe(193);
    expect(bodyAll.pagination.totalItems).toBe(193);
    expect(bodyAll.pagination.totalPages).toBe(6); // ceil(193 / 36) = 6
    expect(bodyAll.items).toHaveLength(36);
  });

  it('não sugere imóveis incompatíveis quando a operação do lead (ex.: locação/temporada) diverge do imóvel', async () => {
    const nowIso = new Date().toISOString();
    const mockSupabase = buildMockSupabase({
      suggestions: [
        {
          id: 'sugg-rent-1',
          account_id: 'acc-1',
          contact_id: 'contact-rent',
          conversation_id: 'conv-rent',
          category: 'followup',
          title: 'Lead busca locação por temporada',
          status: 'pending',
          created_at: nowIso,
          updated_at: nowIso,
          payload: { score: 82, reason: 'Lead busca locação por temporada' },
          contact: { id: 'contact-rent', name: 'Lucas Temporada', phone: '5583988887777', ai_score: 7 },
        },
      ],
      intelligence: [
        {
          contact_id: 'contact-rent',
          summary: {
            purpose: ['locação por temporada', 'aluguel'],
            property_type: ['flat'],
            location: ['Bessa'],
          },
        },
      ],
      projections: [
        {
          property_id: 'prop-sale-only',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Edifício Venda Exclusiva',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 700000,
          price_max: 800000,
        },
      ],
      matches: [
        {
          id: 'match-incompatible',
          account_id: 'acc-1',
          lead_id: 'contact-rent',
          property_id: 'prop-sale-only',
          match_score: 90,
          commercial_priority: 80,
          match_status: 'novo',
          suppressed: false,
        },
      ],
    });

    mockGetCurrentAccount.mockResolvedValue({
      supabase: mockSupabase,
      accountId: 'acc-1',
      userId: 'user-1',
      role: 'owner',
    });

    const res = await GET(new Request('http://localhost/api/followup?status=pending&date_filter=7d'));
    const body = await res.json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0].compatiblePropertiesCount).toBe(0);
    expect(body.items[0].compatibleProperties).toEqual([]);
  });
});
