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
  messages?: Array<Record<string, unknown>>;
  deals?: Array<Record<string, unknown>>;
  intelligence?: Array<Record<string, unknown>>;
  tags?: Array<Record<string, unknown>>;
  pipelines?: Array<Record<string, unknown>>;
  projections?: Array<Record<string, unknown>>;
  matches?: Array<Record<string, unknown>>;
  contacts?: Array<Record<string, unknown>>;
  adMappings?: Array<Record<string, unknown>>;
  followupPlans?: Array<Record<string, unknown>>;
  propertyShares?: Array<Record<string, unknown>>;
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
        else if (table === 'messages') rows = [...(fixtures.messages || [])];
        else if (table === 'deals') rows = [...(fixtures.deals || [])];
        else if (table === 'lead_intelligence') rows = [...(fixtures.intelligence || [])];
        else if (table === 'contact_tags') rows = [...(fixtures.tags || [])];
        else if (table === 'pipelines') rows = [...(fixtures.pipelines || [])];
        else if (table === 'property_match_projections') rows = [...(fixtures.projections || [])];
        else if (table === 'lead_property_matches') rows = [...(fixtures.matches || [])];
        else if (table === 'contacts') rows = [...(fixtures.contacts || [])];
        else if (table === 'property_ad_mappings') rows = [...(fixtures.adMappings || [])];
        else if (table === 'followup_plans') rows = [...(fixtures.followupPlans || [])];
        else if (table === 'property_shares') rows = [...(fixtures.propertyShares || [])];

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

describe('GET /api/followup — Inteligência Comercial, Regra de Ouro (Vendas), Match e Sincronização', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bloqueia locação, operação desconhecida, contatos arquivados e leads sem imóvel compatível de venda', async () => {
    const recentIso = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();

    const mockDb = buildMockSupabase({
      suggestions: [
        // 1. Elegível de venda com imóvel compatível
        {
          id: 'sugg-venda',
          account_id: 'acc-1',
          contact_id: 'c-venda',
          conversation_id: 'conv-venda',
          category: 'followup',
          title: 'Interesse em compra no Bessa',
          status: 'pending',
          created_at: recentIso,
          payload: { score: 85, stage_name: 'Qualificação' },
          contact: { id: 'c-venda', name: 'George Silva', phone: '5583991111111', ai_score: 8, has_purchased: false },
        },
        // 2. Exclusivamente locação -> BLOQUEADO
        {
          id: 'sugg-locacao',
          account_id: 'acc-1',
          contact_id: 'c-locacao',
          conversation_id: 'conv-locacao',
          category: 'followup',
          title: 'Busca aluguel anual',
          status: 'pending',
          created_at: recentIso,
          payload: { score: 90, stage_name: 'Qualificação' },
          contact: { id: 'c-locacao', name: 'Lead Aluguel', phone: '5583992222222', ai_score: 9, has_purchased: false },
        },
        // 3. Operação desconhecida -> BLOQUEADO (não presumir venda)
        {
          id: 'sugg-indefinido',
          account_id: 'acc-1',
          contact_id: 'c-indefinido',
          conversation_id: 'conv-indefinido',
          category: 'followup',
          title: 'Conversa inicial vaga',
          status: 'pending',
          created_at: recentIso,
          payload: { score: 80, stage_name: 'Novo Lead' },
          contact: { id: 'c-indefinido', name: 'Lead Indefinido', phone: '5583993333333', ai_score: 6, has_purchased: false },
        },
        // 4. Comprador sem imóvel compatível no estoque -> BLOQUEADO
        {
          id: 'sugg-sem-match',
          account_id: 'acc-1',
          contact_id: 'c-sem-match',
          conversation_id: 'conv-sem-match',
          category: 'followup',
          title: 'Busca compra mas sem imóveis',
          status: 'pending',
          created_at: recentIso,
          payload: { score: 85, stage_name: 'Interesse' },
          contact: { id: 'c-sem-match', name: 'Lead Sem Match', phone: '5583994444444', ai_score: 7, has_purchased: false },
        },
        // 5. Contato arquivado -> BLOQUEADO
        {
          id: 'sugg-arquivado',
          account_id: 'acc-1',
          contact_id: 'c-arquivado',
          conversation_id: 'conv-arquivado',
          category: 'followup',
          title: 'Lead arquivado',
          status: 'pending',
          created_at: recentIso,
          payload: { score: 95, stage_name: 'Interesse' },
          contact: {
            id: 'c-arquivado',
            name: 'Lead Arquivado',
            phone: '5583995555555',
            ai_score: 9,
            has_purchased: false,
            archived_at: '2026-11-01T10:00:00.000Z',
          },
        },
      ],
      conversations: [
        { id: 'conv-venda', account_id: 'acc-1', contact_id: 'c-venda', last_message_at: recentIso },
        { id: 'conv-locacao', account_id: 'acc-1', contact_id: 'c-locacao', last_message_at: recentIso },
        { id: 'conv-indefinido', account_id: 'acc-1', contact_id: 'c-indefinido', last_message_at: recentIso },
        { id: 'conv-sem-match', account_id: 'acc-1', contact_id: 'c-sem-match', last_message_at: recentIso },
      ],
      messages: [
        { conversation_id: 'conv-venda', sender_type: 'customer', content_type: 'text', content_text: 'Quero comprar um ap 2 quartos no Bessa até 420 mil', created_at: recentIso },
        { conversation_id: 'conv-locacao', sender_type: 'customer', content_type: 'text', content_text: 'Quero alugar um ap no Bessa até 2500/mês', created_at: recentIso },
        { conversation_id: 'conv-indefinido', sender_type: 'customer', content_type: 'text', content_text: 'Oi, bom dia', created_at: recentIso },
        { conversation_id: 'conv-sem-match', sender_type: 'customer', content_type: 'text', content_text: 'Quero comprar uma cobertura em Tambaú', created_at: recentIso },
      ],
      intelligence: [
        { contact_id: 'c-venda', summary: { purpose: ['Compra'], property_type: ['Apartamento'], bedrooms: [2], location: ['Bessa'], price_max: 420000 } },
        { contact_id: 'c-locacao', summary: { purpose: ['Locação'], property_type: ['Apartamento'], location: ['Bessa'], price_max: 2500 } },
        { contact_id: 'c-indefinido', summary: {} },
        { contact_id: 'c-sem-match', summary: { purpose: ['Compra'], property_type: ['Cobertura'], location: ['Tambaú'], price_max: 900000 } },
      ],
      matches: [
        { id: 'm-1', account_id: 'acc-1', lead_id: 'c-venda', property_id: 'p-venda-1', match_score: 92, commercial_priority: 80, match_status: 'novo', suppressed: false, score_breakdown: { reasons: ['Bairro Bessa'] } },
        // Imóvel de locação associado ao lead de venda -> NUNCA deve ser recomendado
        { id: 'm-2', account_id: 'acc-1', lead_id: 'c-venda', property_id: 'p-locacao-1', match_score: 95, commercial_priority: 90, match_status: 'novo', suppressed: false, score_breakdown: { reasons: [] } },
        // Imóvel indisponível (status != ativo) -> NUNCA deve ser recomendado
        { id: 'm-3', account_id: 'acc-1', lead_id: 'c-venda', property_id: 'p-inativo-1', match_score: 99, commercial_priority: 95, match_status: 'novo', suppressed: false, score_breakdown: { reasons: [] } },
        { id: 'm-4', account_id: 'acc-1', lead_id: 'c-locacao', property_id: 'p-venda-1', match_score: 90, commercial_priority: 80, match_status: 'novo', suppressed: false, score_breakdown: { reasons: [] } },
        { id: 'm-5', account_id: 'acc-1', lead_id: 'c-indefinido', property_id: 'p-venda-1', match_score: 88, commercial_priority: 75, match_status: 'novo', suppressed: false, score_breakdown: { reasons: [] } },
      ],
      projections: [
        { property_id: 'p-venda-1', account_id: 'acc-1', status: 'ativo', operation: 'venda', title: 'Residencial Bessa Mar', property_type: 'apartamento', neighborhood: 'Bessa', city: 'João Pessoa', price_min: 390000, price_max: 410000, bedrooms_min: 2, public_url: 'https://ronaldomeira.com.br/imovel/dev-bessa-mar' },
        { property_id: 'p-locacao-1', account_id: 'acc-1', status: 'ativo', operation: 'locacao', title: 'Flat Aluguel Bessa', property_type: 'flat', neighborhood: 'Bessa', city: 'João Pessoa', price_min: 2200, price_max: 2500, public_url: 'https://ronaldomeira.com.br/imovel/dev-loc-1' },
        { property_id: 'p-inativo-1', account_id: 'acc-1', status: 'vendido', operation: 'venda', title: 'Imóvel Vendido', property_type: 'apartamento', neighborhood: 'Bessa', city: 'João Pessoa', price_min: 400000, price_max: 400000, public_url: 'https://ronaldomeira.com.br/imovel/dev-vendido' },
      ],
    });

    mockGetCurrentAccount.mockResolvedValue({ supabase: mockDb, accountId: 'acc-1' });

    const res = await GET(new Request('http://localhost/api/followup?status=pending&date_filter=all'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.counts.pending).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].contact.id).toBe('c-venda');
    expect(body.items[0].commercialOperation).toBe('venda');
    expect(body.items[0].compatibleProperties).toHaveLength(1);
    expect(body.items[0].compatibleProperties[0].propertyId).toBe('p-venda-1');
    expect(body.items[0].compatibleProperties[0].operation).toBe('venda');
    // Motivo comercial personalizado citando o nome do cliente e o contexto real
    expect(body.items[0].reason).toContain('George');
    expect(body.items[0].reason).toContain('Bessa');
  });

  it('identifica empreendimento pelo cadastro de anúncios (property_ad_mappings), nunca por texto promocional, e respeita restrições explícitas (sem flat/estúdio)', async () => {
    const recentIso = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();

    const mockDb = buildMockSupabase({
      suggestions: [
        {
          id: 'sugg-luzinete',
          account_id: 'acc-1',
          contact_id: 'c-luzinete',
          conversation_id: 'conv-luzinete',
          category: 'followup',
          title: 'Interesse no Bessa',
          status: 'pending',
          created_at: recentIso,
          payload: { score: 82, stage_name: 'Qualificação' },
          contact: { id: 'c-luzinete', name: 'Luzinete Souza', phone: '5583996666666', ai_score: 7, has_purchased: false },
        },
      ],
      conversations: [
        {
          id: 'conv-luzinete',
          account_id: 'acc-1',
          contact_id: 'c-luzinete',
          last_message_at: recentIso,
          ctwa_referral: {
            source_id: '120251982493060493',
            headline: 'Entrada apenas R$ 30 mil',
          },
        },
      ],
      messages: [
        {
          conversation_id: 'conv-luzinete',
          sender_type: 'customer',
          content_type: 'text',
          content_text: 'Busco 2 quartos no Bessa para comprar, não quero flat nem estúdio.',
          created_at: recentIso,
        },
      ],
      adMappings: [
        {
          account_id: 'acc-1',
          ad_source_id: '120251982493060493',
          ad_name: 'Mahal Resort',
          property_id: 'prop-mahal',
          properties: { name: 'Mahal' },
        },
      ],
      intelligence: [
        {
          contact_id: 'c-luzinete',
          summary: {
            purpose: ['Compra'],
            property_type: ['Apartamento'],
            bedrooms: [2],
            location: ['Bessa'],
            notes: 'Não quer flat nem estúdio',
          },
        },
      ],
      matches: [
        { id: 'm-flat', account_id: 'acc-1', lead_id: 'c-luzinete', property_id: 'p-flat', match_score: 96, commercial_priority: 90, match_status: 'novo', suppressed: false, score_breakdown: {} },
        { id: 'm-studio', account_id: 'acc-1', lead_id: 'c-luzinete', property_id: 'p-studio', match_score: 94, commercial_priority: 88, match_status: 'novo', suppressed: false, score_breakdown: {} },
        { id: 'm-apto', account_id: 'acc-1', lead_id: 'c-luzinete', property_id: 'p-apto', match_score: 91, commercial_priority: 85, match_status: 'novo', suppressed: false, score_breakdown: {} },
      ],
      projections: [
        { property_id: 'p-flat', account_id: 'acc-1', status: 'ativo', operation: 'venda', title: 'Bessa Flat', property_type: 'flat', neighborhood: 'Bessa', city: 'João Pessoa', price_min: 320000, price_max: 320000, public_url: 'https://ronaldomeira.com.br/imovel/dev-flat' },
        { property_id: 'p-studio', account_id: 'acc-1', status: 'ativo', operation: 'venda', title: 'Bessa Studio', property_type: 'studio', neighborhood: 'Bessa', city: 'João Pessoa', price_min: 310000, price_max: 310000, public_url: 'https://ronaldomeira.com.br/imovel/dev-studio' },
        { property_id: 'p-apto', account_id: 'acc-1', status: 'ativo', operation: 'venda', title: 'Residencial Praia do Bessa', property_type: 'apartamento', neighborhood: 'Bessa', city: 'João Pessoa', price_min: 410000, price_max: 410000, bedrooms_min: 2, public_url: 'https://ronaldomeira.com.br/imovel/dev-apto' },
      ],
    });

    mockGetCurrentAccount.mockResolvedValue({ supabase: mockDb, accountId: 'acc-1' });

    const res = await GET(new Request('http://localhost/api/followup?status=pending&date_filter=all'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    // Empreendimento identificado pelo cadastro estruturado, NUNCA "Entrada apenas R$ 30 mil"
    expect(item.interestProperty).toBe('Mahal');
    expect(item.interestProperty).not.toContain('30 mil');
    // Campo separado primaryNeed removido
    expect(item.primaryNeed).toBeNull();
    // Restrições explícitas respeitadas: flat e studio eliminados, apenas o apartamento mantido
    expect(item.compatibleProperties).toHaveLength(1);
    expect(item.compatibleProperties[0].propertyId).toBe('p-apto');
    expect(item.reason).toContain('Luzinete');
    expect(item.reason).toContain('flat');
    expect(item.reason).toContain('estúdio');
  });

  it('sincroniza Top 3 entre Dashboard e listagem padrão e prioriza leads recentes sobre antigos com Score IA alto', async () => {
    const now = Date.now();
    const h6Ago = new Date(now - 6 * 60 * 60 * 1000).toISOString();
    const h10Ago = new Date(now - 10 * 60 * 60 * 1000).toISOString();
    const d2Ago = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const d40Ago = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

    const leads = [
      { id: 'c-old-hot', name: 'Antigo Score 10', ai_score: 10, at: d40Ago },
      { id: 'c-today-high', name: 'Hoje Qualificado', ai_score: 8, at: h10Ago },
      { id: 'c-today-mid', name: 'Hoje Médio', ai_score: 6, at: h6Ago },
      { id: 'c-2d-high', name: 'Ontem Qualificado', ai_score: 9, at: d2Ago },
    ];

    const mockDb = buildMockSupabase({
      suggestions: leads.map((l) => ({
        id: `sugg-${l.id}`,
        account_id: 'acc-1',
        contact_id: l.id,
        conversation_id: `conv-${l.id}`,
        category: 'followup',
        title: 'Compra Bessa',
        status: 'pending',
        created_at: l.at,
        payload: { score: 80, stage_name: 'Interesse' },
        contact: { id: l.id, name: l.name, phone: '5583990000000', ai_score: l.ai_score, has_purchased: false },
      })),
      conversations: leads.map((l) => ({
        id: `conv-${l.id}`,
        account_id: 'acc-1',
        contact_id: l.id,
        last_message_at: l.at,
      })),
      messages: leads.map((l) => ({
        conversation_id: `conv-${l.id}`,
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'Quero comprar apartamento 2 quartos no Bessa',
        created_at: l.at,
      })),
      intelligence: leads.map((l) => ({
        contact_id: l.id,
        summary: { purpose: ['Compra'], property_type: ['Apartamento'], bedrooms: [2], location: ['Bessa'] },
      })),
      matches: leads.map((l) => ({
        id: `m-${l.id}`,
        account_id: 'acc-1',
        lead_id: l.id,
        property_id: 'p-1',
        match_score: 90,
        commercial_priority: 85,
        match_status: 'novo',
        suppressed: false,
        score_breakdown: {},
      })),
      projections: [
        {
          property_id: 'p-1',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Avant Home',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 400000,
          price_max: 420000,
          public_url: 'https://ronaldomeira.com.br/imovel/dev-avant',
        },
      ],
    });

    mockGetCurrentAccount.mockResolvedValue({ supabase: mockDb, accountId: 'acc-1' });

    const dashRes = await GET(
      new Request('http://localhost/api/followup?status=pending&date_filter=all&sort_by=recent_priority&page=1&page_size=3')
    );
    const listRes = await GET(
      new Request('http://localhost/api/followup?status=pending&date_filter=all&sort_by=recent_priority&page=1&page_size=36')
    );

    const dashBody = await dashRes.json();
    const listBody = await listRes.json();

    expect(dashBody.items).toHaveLength(3);
    expect(listBody.items).toHaveLength(4);

    // Dashboard e listagem padrão apresentam exatamente o mesmo Top 3
    expect(dashBody.items.map((i: { suggestion: { id: string } }) => i.suggestion.id)).toEqual(
      listBody.items.slice(0, 3).map((i: { suggestion: { id: string } }) => i.suggestion.id)
    );

    // Antigo com Score 10 NÃO toma a frente dos leads recentes qualificados
    expect(dashBody.items[0].contact.id).toBe('c-today-high');
    expect(dashBody.items[1].contact.id).toBe('c-today-mid');
    expect(dashBody.items[2].contact.id).toBe('c-2d-high');
    expect(listBody.items[3].contact.id).toBe('c-old-hot');
  });

  it('deduplica sugestões pendentes para o mesmo contato evitando duplicidades na fila ativa', async () => {
    const recentIso = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const mockDb = buildMockSupabase({
      suggestions: [
        {
          id: 'sugg-dup-1',
          account_id: 'acc-1',
          contact_id: 'c-1',
          conversation_id: 'conv-1',
          category: 'followup',
          title: 'Compra Bessa',
          status: 'pending',
          created_at: recentIso,
          payload: { score: 85 },
          contact: { id: 'c-1', name: 'Marcos', phone: '5583990000001', ai_score: 7, has_purchased: false },
        },
        {
          id: 'sugg-dup-2',
          account_id: 'acc-1',
          contact_id: 'c-1',
          conversation_id: 'conv-1',
          category: 'followup',
          title: 'Compra Bessa duplicada',
          status: 'pending',
          created_at: recentIso,
          payload: { score: 80 },
          contact: { id: 'c-1', name: 'Marcos', phone: '5583990000001', ai_score: 7, has_purchased: false },
        },
      ],
      conversations: [{ id: 'conv-1', account_id: 'acc-1', contact_id: 'c-1', last_message_at: recentIso }],
      messages: [{ conversation_id: 'conv-1', sender_type: 'customer', content_type: 'text', content_text: 'Quero comprar no Bessa', created_at: recentIso }],
      intelligence: [{ contact_id: 'c-1', summary: { purpose: ['Compra'], location: ['Bessa'] } }],
      matches: [{ id: 'm-1', account_id: 'acc-1', lead_id: 'c-1', property_id: 'p-1', match_score: 88, commercial_priority: 80, match_status: 'novo', suppressed: false, score_breakdown: {} }],
      projections: [{ property_id: 'p-1', account_id: 'acc-1', status: 'ativo', operation: 'venda', title: 'Mahal', property_type: 'apartamento', neighborhood: 'Bessa', city: 'João Pessoa', price_min: 400000, price_max: 400000, public_url: 'https://ronaldomeira.com.br/imovel/dev-mahal' }],
    });

    mockGetCurrentAccount.mockResolvedValue({ supabase: mockDb, accountId: 'acc-1' });
    const res = await GET(new Request('http://localhost/api/followup?status=pending&date_filter=all'));
    const body = await res.json();

    expect(body.counts.pending).toBe(1);
    expect(body.items).toHaveLength(1);
  });

  it('Etapa 2 — Caso real Vilela: elimina unidades incompatíveis de 19, 20 e 22 m², recomenda plantas maiores (50+ m²) no Bessa e unifica o motivo comercial', async () => {
    const h86Ago = new Date(Date.now() - 86 * 60 * 60 * 1000).toISOString();

    const mockDb = buildMockSupabase({
      suggestions: [
        {
          id: 'd7fd1473-add7-4f35-af72-1daebafa3183',
          account_id: 'acc-1',
          contact_id: '87265a11-946f-41a5-bf9b-5ea23600ce07',
          conversation_id: '5af1b0a1-69eb-4494-a726-f8c920418c9a',
          category: 'followup',
          title: 'Retomar contato com Vilela',
          status: 'pending',
          created_at: h86Ago,
          payload: { score: 85, stage_name: 'Qualificação', hours_since_contact: 86 },
          contact: {
            id: '87265a11-946f-41a5-bf9b-5ea23600ce07',
            name: 'Vilela',
            phone: '558491234625',
            ai_score: 7,
            has_purchased: false,
          },
        },
      ],
      conversations: [
        {
          id: '5af1b0a1-69eb-4494-a726-f8c920418c9a',
          account_id: 'acc-1',
          contact_id: '87265a11-946f-41a5-bf9b-5ea23600ce07',
          last_message_at: h86Ago,
          ctwa_referral: {
            source_id: '120252018175280493',
            headline: 'Rooftop com vista pro mar no Bessa',
          },
        },
      ],
      messages: [
        {
          conversation_id: '5af1b0a1-69eb-4494-a726-f8c920418c9a',
          sender_type: 'customer',
          content_type: 'text',
          content_text: 'Gostaria de saber os valores',
          created_at: h86Ago,
        },
      ],
      adMappings: [
        {
          account_id: 'acc-1',
          ad_source_id: '120252018175280493',
          ad_name: 'Mahal IMG2',
          property_id: 'prop-mahal',
          properties: { name: 'Mahal Resort' },
        },
      ],
      intelligence: [
        {
          contact_id: '87265a11-946f-41a5-bf9b-5ea23600ce07',
          summary: {
            purpose: ['Moradia', 'Investimento'],
            property_type: ['flat'],
            location: ['Bessa'],
            price_min: 350000,
            notes:
              'Lead iniciou contato interessado no Mahal Resort no Bessa para moradia e investimento. Solicitou valores e avalia plantas maiores (50 ou 75 m²).',
          },
        },
      ],
      matches: [
        // Matches antigos incompatíveis de 19, 20 e 22 m² que antes tinham 92%
        {
          id: 'm-19m',
          account_id: 'acc-1',
          lead_id: '87265a11-946f-41a5-bf9b-5ea23600ce07',
          property_id: 'p-19m',
          match_score: 92,
          commercial_priority: 90,
          match_status: 'novo',
          suppressed: false,
          score_breakdown: {},
        },
        {
          id: 'm-20m',
          account_id: 'acc-1',
          lead_id: '87265a11-946f-41a5-bf9b-5ea23600ce07',
          property_id: 'p-20m',
          match_score: 92,
          commercial_priority: 89,
          match_status: 'novo',
          suppressed: false,
          score_breakdown: {},
        },
        {
          id: 'm-22m-mixed',
          account_id: 'acc-1',
          lead_id: '87265a11-946f-41a5-bf9b-5ea23600ce07',
          property_id: 'p-22m-mixed',
          match_score: 92,
          commercial_priority: 88,
          match_status: 'novo',
          suppressed: false,
          score_breakdown: {},
        },
      ],
      projections: [
        {
          property_id: 'p-19m',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Studios e apartamentos de 1 quarto no Bessa',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 355000,
          price_max: 355000,
          bedrooms_min: 1,
          bedrooms_max: 1,
          area_min: 18.94,
          area_max: 18.94,
          public_url: 'https://ronaldomeira.com.br/imovel/orulo-19m',
        },
        {
          property_id: 'p-20m',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Park H2orizon',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 263900,
          price_max: 263900,
          bedrooms_min: 0,
          bedrooms_max: 0,
          area_min: 19.85,
          area_max: 19.85,
          public_url: 'https://ronaldomeira.com.br/imovel/orulo-20m',
        },
        {
          property_id: 'p-22m-mixed',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Apartamento Misto 22m a 63m com preço único de 22m',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 299012,
          price_max: 299012,
          bedrooms_min: 1,
          bedrooms_max: 2,
          area_min: 21.6,
          area_max: 63.3,
          public_url: 'https://ronaldomeira.com.br/imovel/orulo-84567',
        },
        {
          property_id: 'p-55m-real',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Apartamento no Bessa 55m²',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 519000,
          price_max: 548000,
          bedrooms_min: 2,
          bedrooms_max: 3,
          area_min: 54.7,
          area_max: 105.6,
          public_url: 'https://ronaldomeira.com.br/imovel/orulo-55m',
        },
      ],
    });

    mockGetCurrentAccount.mockResolvedValue({ supabase: mockDb, accountId: 'acc-1' });
    const res = await GET(new Request('http://localhost/api/followup?status=pending&date_filter=all'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    // Empreendimento identificado como Mahal Resort, nunca "Rooftop com vista pro mar no Bessa"
    expect(item.interestProperty).toBe('Mahal Resort');
    expect(item.interestProperty).not.toContain('Rooftop');
    // Unidades de 19, 20 e 22 m² foram eliminadas e substituídas pelo apartamento real de 54,7 m²
    expect(item.compatibleProperties).toHaveLength(1);
    expect(item.compatibleProperties[0].propertyId).toBe('p-55m-real');
    expect(item.compatibleProperties[0].areaMin).toBeGreaterThanOrEqual(50);
    // Motivo comercial unificado
    expect(item.reason).toContain('Vilela');
    expect(item.reason).toContain('Mahal Resort');
    expect(item.reason).toContain('50 a 75 m²');
  });
});
