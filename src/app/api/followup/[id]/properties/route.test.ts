import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 500 }),
}));

type MockFixtures = {
  suggestions: Array<Record<string, unknown>>;
  conversations?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  intelligence?: Array<Record<string, unknown>>;
  tags?: Array<Record<string, unknown>>;
  matches?: Array<Record<string, unknown>>;
  propertyShares?: Array<Record<string, unknown>>;
  projections?: Array<Record<string, unknown>>;
};

function buildMockSupabase(fixtures: MockFixtures) {
  return {
    from: (table: string) => {
      const state: {
        eqFilters: Record<string, unknown>;
        limitCount: number | null;
      } = {
        eqFilters: {},
        limitCount: null,
      };

      const resolveRows = () => {
        let rows: Array<Record<string, unknown>> = [];
        if (table === 'ai_suggestions') rows = [...fixtures.suggestions];
        else if (table === 'conversations') rows = [...(fixtures.conversations || [])];
        else if (table === 'messages') rows = [...(fixtures.messages || [])];
        else if (table === 'lead_intelligence') rows = [...(fixtures.intelligence || [])];
        else if (table === 'contact_tags') rows = [...(fixtures.tags || [])];
        else if (table === 'lead_property_matches') rows = [...(fixtures.matches || [])];
        else if (table === 'property_shares') rows = [...(fixtures.propertyShares || [])];
        else if (table === 'property_match_projections') rows = [...(fixtures.projections || [])];

        for (const [k, v] of Object.entries(state.eqFilters)) {
          rows = rows.filter((r) => r[k] === v);
        }

        if (state.limitCount !== null) {
          rows = rows.slice(0, state.limitCount);
        }

        return rows;
      };

      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          state.eqFilters[k] = v;
          return chain;
        },
        order: () => chain,
        limit: (n: number) => {
          state.limitCount = n;
          return chain;
        },
        maybeSingle: () => {
          const rows = resolveRows();
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then: (resolve: (val: unknown) => void) =>
          resolve({ data: resolveRows(), error: null }),
      };

      return chain;
    },
  };
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/followup/[id]/properties — Expansão sob demanda (Ver mais imóveis)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('isola conta e retorna 404 para sugestão inexistente ou de outra categoria/conta', async () => {
    const supabase = buildMockSupabase({
      suggestions: [
        {
          id: 'sugg-other-acc',
          account_id: 'acc-other',
          category: 'followup',
          contact_id: 'lead-1',
          conversation_id: 'conv-1',
        },
        {
          id: 'sugg-wrong-cat',
          account_id: 'acc-1',
          category: 'reply',
          contact_id: 'lead-1',
          conversation_id: 'conv-1',
        },
      ],
    });
    mockRequireRole.mockResolvedValue({ supabase, accountId: 'acc-1' });

    const resOtherAcc = await GET(
      new Request('https://crmronaldomeira.com/api/followup/sugg-other-acc/properties'),
      makeParams('sugg-other-acc')
    );
    expect(resOtherAcc.status).toBe(404);

    const resWrongCat = await GET(
      new Request('https://crmronaldomeira.com/api/followup/sugg-wrong-cat/properties'),
      makeParams('sugg-wrong-cat')
    );
    expect(resWrongCat.status).toBe(404);

    const resMissing = await GET(
      new Request('https://crmronaldomeira.com/api/followup/non-existent/properties'),
      makeParams('non-existent')
    );
    expect(resMissing.status).toBe(404);
  });

  it('garante regra de ouro (somente venda ativa com URL pública válida) e nunca retorna locação/inativo/admin', async () => {
    const supabase = buildMockSupabase({
      suggestions: [
        {
          id: 'sugg-sale',
          account_id: 'acc-1',
          category: 'followup',
          contact_id: 'lead-alex',
          conversation_id: 'conv-alex',
          contact: { id: 'lead-alex', name: 'Alex Diniz', ai_score: 75 },
        },
        {
          id: 'sugg-rent',
          account_id: 'acc-1',
          category: 'followup',
          contact_id: 'lead-rent',
          conversation_id: 'conv-rent',
          contact: { id: 'lead-rent', name: 'Lead Locação', ai_score: 60 },
        },
      ],
      conversations: [
        { id: 'conv-alex', account_id: 'acc-1', contact_id: 'lead-alex', last_message_text: 'Quero comprar um apto no Bessa' },
        { id: 'conv-rent', account_id: 'acc-1', contact_id: 'lead-rent', last_message_text: 'Quero alugar um apartamento mensal' },
      ],
      messages: [
        {
          conversation_id: 'conv-alex',
          sender_type: 'customer',
          content_text: 'Procuro apartamento de 2 ou 3 quartos para comprar no Bessa de 400 mil a 600 mil',
        },
        {
          conversation_id: 'conv-rent',
          sender_type: 'customer',
          content_text: 'Preciso alugar um flat para temporada ou locação mensal',
        },
      ],
      intelligence: [
        {
          contact_id: 'lead-alex',
          summary: {
            purpose: ['Compra'],
            location: ['Bessa'],
            property_type: ['Apartamento'],
            bedrooms: [2, 3],
            price_min: 400000,
            price_max: 600000,
          },
        },
        {
          contact_id: 'lead-rent',
          summary: {
            purpose: ['Locação'],
            location: ['Bessa'],
          },
        },
      ],
      projections: [
        {
          property_id: 'prop-valid-sale',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Apartamento 3 Quartos no Bessa',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 520000,
          price_max: 550000,
          bedrooms_min: 3,
          bedrooms_max: 3,
          area_min: 72,
          area_max: 72,
          delivery_status: 'pronto',
          features: ['área gourmet'],
          public_url: 'https://crmronaldomeira.com/imovel/prop-valid-sale',
        },
        {
          property_id: 'prop-rental',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'locacao',
          title: 'Apartamento Locação no Bessa',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 2800,
          price_max: 2800,
          bedrooms_min: 2,
          bedrooms_max: 2,
          area_min: 65,
          area_max: 65,
          delivery_status: 'pronto',
          public_url: 'https://crmronaldomeira.com/imovel/prop-rental',
        },
        {
          property_id: 'prop-inactive',
          account_id: 'acc-1',
          status: 'vendido',
          operation: 'venda',
          title: 'Apartamento Vendido no Bessa',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 490000,
          price_max: 490000,
          bedrooms_min: 2,
          bedrooms_max: 2,
          area_min: 64,
          area_max: 64,
          delivery_status: 'pronto',
          public_url: 'https://crmronaldomeira.com/imovel/prop-inactive',
        },
        {
          property_id: 'prop-internal-url',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Apartamento URL Interna',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 500000,
          price_max: 500000,
          bedrooms_min: 2,
          bedrooms_max: 2,
          area_min: 66,
          area_max: 66,
          delivery_status: 'pronto',
          public_url: '/dashboard/properties/internal',
        },
      ],
    });
    mockRequireRole.mockResolvedValue({ supabase, accountId: 'acc-1' });

    const resSale = await GET(
      new Request('https://crmronaldomeira.com/api/followup/sugg-sale/properties'),
      makeParams('sugg-sale')
    );
    expect(resSale.status).toBe(200);
    const bodySale = (await resSale.json()) as {
      properties: Array<{ propertyId: string; operation: string; publicUrl: string }>;
      totalCount: number;
    };
    expect(bodySale.properties.map((p) => p.propertyId)).toEqual(['prop-valid-sale']);
    expect(bodySale.properties[0]?.operation).toBe('venda');
    expect(bodySale.properties[0]?.publicUrl).toContain('/imovel/prop-valid-sale');

    const resRent = await GET(
      new Request('https://crmronaldomeira.com/api/followup/sugg-rent/properties'),
      makeParams('sugg-rent')
    );
    expect(resRent.status).toBe(200);
    const bodyRent = (await resRent.json()) as {
      properties: unknown[];
      totalCount: number;
      hasMore: boolean;
    };
    expect(bodyRent.properties).toEqual([]);
    expect(bodyRent.totalCount).toBe(0);
    expect(bodyRent.hasMore).toBe(false);
  });

  it('respeita restrições declaradas (ex.: Sirleida flat >= 22m²) e pagina sem duplicar os 3 imóveis iniciais (exclude_ids)', async () => {
    const projections = [
      {
        property_id: 'flat-23',
        account_id: 'acc-1',
        status: 'ativo',
        operation: 'venda',
        title: 'Flat Vista Mar 23m² no Bessa',
        property_type: 'flat',
        neighborhood: 'Bessa',
        city: 'João Pessoa',
        price_min: 310000,
        price_max: 330000,
        bedrooms_min: 1,
        bedrooms_max: 1,
        area_min: 23,
        area_max: 25,
        delivery_status: 'pronto',
        features: ['varanda', 'vista do mar'],
        public_url: 'https://crmronaldomeira.com/imovel/flat-23',
      },
      {
        property_id: 'flat-25',
        account_id: 'acc-1',
        status: 'ativo',
        operation: 'venda',
        title: 'Flat Varanda Gourmet 25m² no Bessa',
        property_type: 'flat',
        neighborhood: 'Bessa',
        city: 'João Pessoa',
        price_min: 340000,
        price_max: 360000,
        bedrooms_min: 1,
        bedrooms_max: 1,
        area_min: 25,
        area_max: 27,
        delivery_status: 'pronto',
        features: ['varanda', 'vista do mar'],
        public_url: 'https://crmronaldomeira.com/imovel/flat-25',
      },
      {
        property_id: 'flat-28',
        account_id: 'acc-1',
        status: 'ativo',
        operation: 'venda',
        title: 'Flat Exclusivo 28m² no Bessa',
        property_type: 'flat',
        neighborhood: 'Bessa',
        city: 'João Pessoa',
        price_min: 380000,
        price_max: 390000,
        bedrooms_min: 1,
        bedrooms_max: 1,
        area_min: 28,
        area_max: 30,
        delivery_status: 'pronto',
        features: ['varanda', 'vista do mar'],
        public_url: 'https://crmronaldomeira.com/imovel/flat-28',
      },
      {
        property_id: 'flat-31',
        account_id: 'acc-1',
        status: 'ativo',
        operation: 'venda',
        title: 'Flat Amplo 31m² no Bessa',
        property_type: 'flat',
        neighborhood: 'Bessa',
        city: 'João Pessoa',
        price_min: 410000,
        price_max: 430000,
        bedrooms_min: 1,
        bedrooms_max: 1,
        area_min: 31,
        area_max: 33,
        delivery_status: 'pronto',
        features: ['varanda', 'vista do mar'],
        public_url: 'https://crmronaldomeira.com/imovel/flat-31',
      },
      {
        property_id: 'flat-34',
        account_id: 'acc-1',
        status: 'ativo',
        operation: 'venda',
        title: 'Flat Premium 34m² no Bessa',
        property_type: 'flat',
        neighborhood: 'Bessa',
        city: 'João Pessoa',
        price_min: 450000,
        price_max: 470000,
        bedrooms_min: 1,
        bedrooms_max: 1,
        area_min: 34,
        area_max: 36,
        delivery_status: 'pronto',
        features: ['varanda', 'vista do mar'],
        public_url: 'https://crmronaldomeira.com/imovel/flat-34',
      },
      {
        property_id: 'flat-36',
        account_id: 'acc-1',
        status: 'ativo',
        operation: 'venda',
        title: 'Flat Cobertura 36m² no Bessa',
        property_type: 'flat',
        neighborhood: 'Bessa',
        city: 'João Pessoa',
        price_min: 480000,
        price_max: 495000,
        bedrooms_min: 1,
        bedrooms_max: 1,
        area_min: 36,
        area_max: 38,
        delivery_status: 'pronto',
        features: ['varanda', 'vista do mar'],
        public_url: 'https://crmronaldomeira.com/imovel/flat-36',
      },
      {
        // Abaixo dos 22m² exigidos por Sirleida — NÃO deve entrar
        property_id: 'studio-18',
        account_id: 'acc-1',
        status: 'ativo',
        operation: 'venda',
        title: 'Studio Compacto 18m² no Bessa',
        property_type: 'flat',
        neighborhood: 'Bessa',
        city: 'João Pessoa',
        price_min: 220000,
        price_max: 230000,
        bedrooms_min: 1,
        bedrooms_max: 1,
        area_min: 18,
        area_max: 18,
        delivery_status: 'pronto',
        features: ['varanda'],
        public_url: 'https://crmronaldomeira.com/imovel/studio-18',
      },
    ];

    const supabase = buildMockSupabase({
      suggestions: [
        {
          id: 'sugg-sirleida',
          account_id: 'acc-1',
          category: 'followup',
          contact_id: 'lead-sirleida',
          conversation_id: 'conv-sirleida',
          contact: { id: 'lead-sirleida', name: 'Sirleida', ai_score: 72 },
        },
      ],
      conversations: [
        {
          id: 'conv-sirleida',
          account_id: 'acc-1',
          contact_id: 'lead-sirleida',
          last_message_text: 'Eu quero um flat q acima de 22 q tenha varanda com vista do mar',
        },
      ],
      messages: [
        {
          conversation_id: 'conv-sirleida',
          sender_type: 'customer',
          content_text: 'Quero comprar um flat q acima de 22 q tenha varanda com vista do mar para investimento',
        },
      ],
      intelligence: [
        {
          contact_id: 'lead-sirleida',
          summary: {
            purpose: ['Compra'],
            investment_purpose: ['investimento'],
            location: ['Bessa'],
            property_type: ['Flat'],
            notes: 'Deseja flat acima de 22m² com varanda e vista do mar',
          },
        },
      ],
      projections,
    });
    mockRequireRole.mockResolvedValue({ supabase, accountId: 'acc-1' });

    const page1Res = await GET(
      new Request(
        'https://crmronaldomeira.com/api/followup/sugg-sirleida/properties?exclude_ids=flat-23,flat-25,flat-28&offset=0&limit=2'
      ),
      makeParams('sugg-sirleida')
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      properties: Array<{ propertyId: string; areaMin: number | null }>;
      totalCount: number;
      totalRemainingCount: number;
      hasMore: boolean;
      nextOffset: number;
    };

    expect(page1.totalCount).toBe(6);
    expect(page1.totalRemainingCount).toBe(3);
    expect(page1.properties).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextOffset).toBe(2);

    const excluded = new Set(['flat-23', 'flat-25', 'flat-28']);
    for (const p of page1.properties) {
      expect(excluded.has(p.propertyId)).toBe(false);
      expect(p.propertyId).not.toBe('studio-18');
      expect((p.areaMin ?? 0) >= 22).toBe(true);
    }

    const page2Res = await GET(
      new Request(
        'https://crmronaldomeira.com/api/followup/sugg-sirleida/properties?exclude_ids=flat-23,flat-25,flat-28&offset=2&limit=2'
      ),
      makeParams('sugg-sirleida')
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as {
      properties: Array<{ propertyId: string; areaMin: number | null }>;
      totalRemainingCount: number;
      hasMore: boolean;
      nextOffset: number;
    };

    expect(page2.properties).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextOffset).toBe(3);
    expect(page2.properties[0]?.propertyId).not.toBe('studio-18');
    const seenAcrossPages = new Set([
      ...page1.properties.map((p) => p.propertyId),
      ...page2.properties.map((p) => p.propertyId),
    ]);
    expect(seenAcrossPages.size).toBe(3);
  });

  it('mantém aderência comercial para Alex Diniz (2-3 quartos, R$ 400k-600k) na lista expandida', async () => {
    const supabase = buildMockSupabase({
      suggestions: [
        {
          id: 'sugg-alex-expand',
          account_id: 'acc-1',
          category: 'followup',
          contact_id: 'lead-alex-2',
          conversation_id: 'conv-alex-2',
          contact: { id: 'lead-alex-2', name: 'Alex Diniz', ai_score: 78 },
        },
      ],
      conversations: [
        {
          id: 'conv-alex-2',
          account_id: 'acc-1',
          contact_id: 'lead-alex-2',
          last_message_text: 'Quero comprar um apto de 2 ou 3 quartos entre 400 e 600 mil',
        },
      ],
      messages: [
        {
          conversation_id: 'conv-alex-2',
          sender_type: 'customer',
          content_text:
            'Estou procurando para comprar apartamento de 2 ou 3 quartos com área gourmet de 400 mil a 600 mil no Bessa',
        },
      ],
      intelligence: [
        {
          contact_id: 'lead-alex-2',
          summary: {
            purpose: ['Compra'],
            location: ['Bessa'],
            property_type: ['Apartamento'],
            bedrooms: [2, 3],
            price_min: 400000,
            price_max: 600000,
          },
        },
      ],
      projections: [
        {
          property_id: 'apto-2q-520k',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Apartamento 2Q Bessa',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 520000,
          price_max: 520000,
          bedrooms_min: 2,
          bedrooms_max: 2,
          area_min: 58,
          area_max: 58,
          delivery_status: 'pronto',
          features: ['área gourmet'],
          public_url: 'https://crmronaldomeira.com/imovel/apto-2q-520k',
        },
        {
          property_id: 'studio-18-250k',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Studio Compacto 18m² no Bessa',
          property_type: 'studio',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 250000,
          price_max: 250000,
          bedrooms_min: 1,
          bedrooms_max: 1,
          area_min: 18,
          area_max: 18,
          delivery_status: 'pronto',
          public_url: 'https://crmronaldomeira.com/imovel/studio-18-250k',
        },
        {
          property_id: 'luxo-4q-1500k',
          account_id: 'acc-1',
          status: 'ativo',
          operation: 'venda',
          title: 'Cobertura Luxo 4Q no Bessa',
          property_type: 'apartamento',
          neighborhood: 'Bessa',
          city: 'João Pessoa',
          price_min: 1500000,
          price_max: 1500000,
          bedrooms_min: 4,
          bedrooms_max: 4,
          area_min: 160,
          area_max: 160,
          delivery_status: 'pronto',
          public_url: 'https://crmronaldomeira.com/imovel/luxo-4q-1500k',
        },
      ],
    });
    mockRequireRole.mockResolvedValue({ supabase, accountId: 'acc-1' });

    const res = await GET(
      new Request('https://crmronaldomeira.com/api/followup/sugg-alex-expand/properties'),
      makeParams('sugg-alex-expand')
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      properties: Array<{ propertyId: string }>;
      totalCount: number;
    };
    const ids = body.properties.map((p) => p.propertyId);
    expect(ids).toContain('apto-2q-520k');
    expect(ids).not.toContain('studio-18-250k');
    expect(ids).not.toContain('luxo-4q-1500k');
  });
});
