import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const pushMocks = vi.hoisted(() => ({
  sendPushToAccount: vi.fn(),
}));

vi.mock('../push/send', () => ({
  sendPushToAccount: pushMocks.sendPushToAccount,
}));

import {
  recalculateMatchesForLead,
  recalculateMatchesForProperty,
  applyMatchLifecycleAction,
} from './service';
import {
  evaluateMaterialReopen,
  resolveMatchLifecycle,
  buildDecisionSnapshot,
} from './lifecycle';
import {
  formatMatchNotificationText,
  isMatchNotificationRelevant,
  parseNotificationTarget,
} from './notifications';
import {
  reconcileInventoryWithProjections,
  resetInventoryReconcileWatermark,
} from './inventory-reconciler';
import { ensurePropertyUuid } from '../tunnel/auth';

/**
 * Banco em memória isolado que emula operações do Supabase (`select`, `insert`, `update`,
 * `upsert`, `delete`, `eq`, `in`, `is`, `order`, `limit`, `maybeSingle`, `single`)
 * permitindo provar todos os fluxos de ponta a ponta sem tocar produção.
 */
function createInMemorySupabase(seed: {
  profiles?: Array<Record<string, unknown>>;
  contacts?: Array<Record<string, unknown>>;
  lead_intelligence?: Array<Record<string, unknown>>;
  contact_tags?: Array<Record<string, unknown>>;
  conversations?: Array<Record<string, unknown>>;
  property_match_projections?: Array<Record<string, unknown>>;
  inventory_properties?: Array<Record<string, unknown>>;
  deleted_match_properties?: Array<Record<string, unknown>>;
  lead_property_matches?: Array<Record<string, unknown>>;
  notifications?: Array<Record<string, unknown>>;
}) {
  const cloneList = (arr?: Array<Record<string, unknown>>) =>
    (arr || []).map((item) => structuredClone(item));

  const tables: Record<string, Array<Record<string, unknown>>> = {
    profiles: cloneList(seed.profiles),
    contacts: cloneList(seed.contacts),
    lead_intelligence: cloneList(seed.lead_intelligence),
    contact_tags: cloneList(seed.contact_tags),
    conversations: cloneList(seed.conversations),
    property_match_projections: cloneList(seed.property_match_projections),
    inventory_properties: cloneList(seed.inventory_properties),
    deleted_match_properties: cloneList(seed.deleted_match_properties),
    lead_property_matches: cloneList(seed.lead_property_matches),
    notifications: cloneList(seed.notifications),
  };

  let idSeq = 1;

  function makeBuilder(tableName: string) {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    let payload: unknown = null;
    let onConflictCols: string[] = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitCount: number | null = null;

    const execute = async () => {
      const rows = tables[tableName] || [];
      const matchFn = (row: Record<string, unknown>) => filters.every((f) => f(row));

      if (mode === 'select') {
        let out = rows.filter(matchFn).map((r) => ({ ...r }));
        if (orderCol) {
          out.sort((a, b) => {
            const va = String(a[orderCol!] ?? '');
            const vb = String(b[orderCol!] ?? '');
            return orderAsc ? va.localeCompare(vb) : vb.localeCompare(va);
          });
        }
        if (limitCount !== null) out = out.slice(0, limitCount);
        return { data: out, error: null };
      }

      if (mode === 'insert') {
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted: Array<Record<string, unknown>> = [];
        for (const item of items as Array<Record<string, unknown>>) {
          const row = {
            id: item.id || `${tableName}-${idSeq++}`,
            created_at: item.created_at || new Date().toISOString(),
            ...item,
          };
          rows.push(row);
          inserted.push(row);
        }
        return { data: inserted, error: null };
      }

      if (mode === 'upsert') {
        const items = Array.isArray(payload) ? payload : [payload];
        const upserted: Array<Record<string, unknown>> = [];
        for (const item of items as Array<Record<string, unknown>>) {
          const idx =
            onConflictCols.length > 0
              ? rows.findIndex((r) => onConflictCols.every((c) => r[c] === item[c]))
              : -1;
          if (idx >= 0) {
            rows[idx] = { ...rows[idx], ...item };
            upserted.push(rows[idx]);
          } else {
            const row = {
              id: item.id || `${tableName}-${idSeq++}`,
              created_at: item.created_at || new Date().toISOString(),
              ...item,
            };
            rows.push(row);
            upserted.push(row);
          }
        }
        return { data: upserted, error: null };
      }

      if (mode === 'update') {
        const updated: Array<Record<string, unknown>> = [];
        for (let i = 0; i < rows.length; i++) {
          if (matchFn(rows[i])) {
            rows[i] = { ...rows[i], ...(payload as Record<string, unknown>) };
            updated.push(rows[i]);
          }
        }
        return { data: updated, error: null };
      }

      if (mode === 'delete') {
        const removed: Array<Record<string, unknown>> = [];
        for (let i = rows.length - 1; i >= 0; i--) {
          if (matchFn(rows[i])) {
            removed.push(rows[i]);
            rows.splice(i, 1);
          }
        }
        return { data: removed, error: null };
      }

      return { data: null, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => {
        if (mode === 'select') {
          // keep mode select
        }
        return builder;
      },
      insert: (data: unknown) => {
        mode = 'insert';
        payload = data;
        return builder;
      },
      update: (data: unknown) => {
        mode = 'update';
        payload = data;
        return builder;
      },
      upsert: (data: unknown, opts?: { onConflict?: string }) => {
        mode = 'upsert';
        payload = data;
        onConflictCols = (opts?.onConflict || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        return builder;
      },
      delete: () => {
        mode = 'delete';
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        const set = new Set(vals);
        filters.push((r) => set.has(r[col]));
        return builder;
      },
      is: (col: string, val: unknown) => {
        filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return builder;
      },
      limit: (n: number) => {
        limitCount = n;
        return builder;
      },
      returns: () => execute(),
      maybeSingle: async () => {
        const res = await execute();
        const first = Array.isArray(res.data) ? res.data[0] || null : res.data;
        return { data: first, error: res.error };
      },
      single: async () => {
        const res = await execute();
        const first = Array.isArray(res.data) ? res.data[0] || null : res.data;
        return { data: first, error: res.error };
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        execute().then(resolve, reject),
    };

    return builder;
  }

  return {
    tables,
    db: {
      from: (tableName: string) => makeBuilder(tableName),
    } as unknown as SupabaseClient,
  };
}

describe('Auditoria End-to-End do Módulo Match — WACRM + Meus Imóveis', () => {
  const accountId = 'f8d2ae51-e393-4a74-a432-ddab0610837e';
  const leadMariaId = 'lead-maria-001';
  const propBessaId = '11111111-1111-4111-a111-111111111111';

  const baseProfiles = [
    { id: 'p-owner', user_id: 'user-ronaldo', account_id: accountId, account_role: 'owner' },
    { id: 'p-admin', user_id: 'user-thati', account_id: accountId, account_role: 'admin' },
    { id: 'p-viewer', user_id: 'user-viewer', account_id: accountId, account_role: 'viewer' },
  ];

  const mariaContact = {
    id: leadMariaId,
    account_id: accountId,
    name: 'Maria',
    phone: '5583999991234',
    ai_score: 8,
    paused_at: null,
    archived_at: null,
  };

  const mariaIntelligence = {
    contact_id: leadMariaId,
    account_id: accountId,
    summary: {
      purpose: ['Moradia'],
      property_type: ['Apartamento'],
      location: ['Bessa'],
      price_max: 500000,
      bedrooms: [2, 3],
      features: ['elevador', 'piscina'],
      requirements: {
        location_strict: true,
        price_strict_max: false,
      },
    },
  };

  const bessaProjection = {
    id: 'proj-bessa-1',
    account_id: accountId,
    property_id: propBessaId,
    code: 'AP-BESSA-01',
    title: 'Residencial Brisa do Bessa',
    operation: 'venda',
    property_type: 'apartamento',
    neighborhood: 'Bessa',
    city: 'João Pessoa',
    price_min: 450000,
    price_max: 490000,
    area_min: 68,
    area_max: 75,
    bedrooms_min: 2,
    bedrooms_max: 3,
    delivery_status: 'pronto',
    delivery_deadline: null,
    features: ['elevador', 'piscina'],
    cover_url: 'https://cdn.test/bessa.jpg',
    public_url: '/imovel/bessa-1',
    status: 'ativo',
    updated_at: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetInventoryReconcileWatermark();
    pushMocks.sendPushToAccount.mockResolvedValue({ sent: 1, pruned: 0 });
  });

  it('1 & 4 & 5. Novo imóvel compatível gera match, cria notificação interna + push formatado com deep-link e respeita permissões (exclui viewer)', async () => {
    const { db, tables } = createInMemorySupabase({
      profiles: baseProfiles,
      contacts: [mariaContact],
      lead_intelligence: [mariaIntelligence],
      property_match_projections: [bessaProjection],
    });

    const result = await recalculateMatchesForProperty(db, accountId, propBessaId);

    // 1. Match criado
    expect(result.totalLeadsEvaluated).toBe(1);
    expect(result.strongMatchesCount).toBe(1);
    expect(tables.lead_property_matches.length).toBe(1);
    const createdMatch = tables.lead_property_matches[0];
    expect(createdMatch.lead_id).toBe(leadMariaId);
    expect(createdMatch.property_id).toBe(propBessaId);
    expect(Number(createdMatch.match_score)).toBeGreaterThanOrEqual(85);
    expect(createdMatch.match_status).toBe('novo');

    // 4. Notificação interna gravada APENAS para owner e admin (viewer excluído!)
    expect(tables.notifications.length).toBe(2);
    const notifiedUsers = tables.notifications.map((n) => n.user_id).sort();
    expect(notifiedUsers).toEqual(['user-ronaldo', 'user-thati']);
    expect(String(tables.notifications[0].body)).toContain(
      `Novo Match: apartamento no Bessa compatível com cliente Maria — ${Math.round(Number(createdMatch.match_score))}% de compatibilidade.`
    );

    // Web Push enviado com texto canônico e deep-link
    expect(pushMocks.sendPushToAccount).toHaveBeenCalledTimes(1);
    const pushPayload = pushMocks.sendPushToAccount.mock.calls[0][1];
    expect(pushPayload.body).toContain('Novo Match: apartamento no Bessa compatível com cliente Maria');
    expect(pushPayload.url).toBe(`/match?lead=${leadMariaId}&property=${propBessaId}`);

    // 5. Ao clicar na notificação, parseNotificationTarget resolve a oportunidade exata
    const parsed = parseNotificationTarget(tables.notifications[0] as Record<string, string>);
    expect(parsed.isMatchNotification).toBe(true);
    expect(parsed.targetUrl).toBe(`/match?lead=${leadMariaId}&property=${propBessaId}`);
    expect(parsed.cleanBody).not.toContain('[url:');
  });

  it('2. Novo lead qualificado encontra imóveis compatíveis e gera notificação relevante', async () => {
    const { db, tables } = createInMemorySupabase({
      profiles: baseProfiles,
      contacts: [mariaContact],
      lead_intelligence: [mariaIntelligence],
      property_match_projections: [bessaProjection],
    });

    const result = await recalculateMatchesForLead(db, accountId, leadMariaId);
    expect(result.matchesCreatedOrUpdated).toBe(1);
    expect(result.strongMatchesCount).toBe(1);
    expect(tables.lead_property_matches.length).toBe(1);
    expect(pushMocks.sendPushToAccount).toHaveBeenCalledTimes(1);
  });

  it('3. Alteração relevante no imóvel (preço acima do teto) remove match pendente incompatível', async () => {
    const { db, tables } = createInMemorySupabase({
      profiles: baseProfiles,
      contacts: [mariaContact],
      lead_intelligence: [mariaIntelligence],
      property_match_projections: [bessaProjection],
    });

    // Cria match inicial
    await recalculateMatchesForProperty(db, accountId, propBessaId);
    expect(tables.lead_property_matches.length).toBe(1);

    // Imóvel sobe de R$ 450k para R$ 900k (acima da tolerância +10% do orçamento de R$ 500k de Maria)
    tables.property_match_projections[0].price_min = 900000;
    tables.property_match_projections[0].price_max = 950000;

    const recalc = await recalculateMatchesForProperty(db, accountId, propBessaId);
    expect(recalc.staleRemovedCount).toBe(1);
    expect(tables.lead_property_matches.length).toBe(0);
  });

  it('6. Match ignorado permanece ignorado após recálculo rotineiro e só reabre mediante mudança material objetiva (queda de preço >= 8%)', async () => {
    const { db, tables } = createInMemorySupabase({
      profiles: baseProfiles,
      contacts: [mariaContact],
      lead_intelligence: [mariaIntelligence],
      property_match_projections: [bessaProjection],
    });

    await recalculateMatchesForProperty(db, accountId, propBessaId);
    const matchId = String(tables.lead_property_matches[0].id);

    // Corretor clica em "Ignorar"
    const ignored = await applyMatchLifecycleAction(db, accountId, {
      matchId,
      action: 'ignore',
    });
    expect(ignored).toBe(true);
    expect(tables.lead_property_matches[0].suppressed).toBe(true);
    expect(resolveMatchLifecycle(tables.lead_property_matches[0]).effectiveStatus).toBe('ignorado');

    pushMocks.sendPushToAccount.mockClear();
    tables.notifications.length = 0;

    // Recálculo rotineiro sem mudança material NÃO reabre nem notifica
    await recalculateMatchesForProperty(db, accountId, propBessaId);
    expect(tables.lead_property_matches[0].suppressed).toBe(true);
    expect(resolveMatchLifecycle(tables.lead_property_matches[0]).effectiveStatus).toBe('ignorado');
    expect(pushMocks.sendPushToAccount).not.toHaveBeenCalled();

    // Agora ocorre MUDANÇA MATERIAL: preço do imóvel cai de R$ 450.000 para R$ 390.000 (-13%)
    tables.property_match_projections[0].price_min = 390000;
    tables.property_match_projections[0].price_max = 410000;

    const recalcAfterDrop = await recalculateMatchesForProperty(db, accountId, propBessaId);
    expect(recalcAfterDrop.reopenedCount).toBe(1);
    expect(tables.lead_property_matches[0].suppressed).toBe(false);
    const reopenedLifecycle = resolveMatchLifecycle(tables.lead_property_matches[0]);
    expect(reopenedLifecycle.effectiveStatus).toBe('novo');
    expect(reopenedLifecycle.reopenReason).toContain('Redução relevante de preço');
    expect(reopenedLifecycle.reopenCount).toBe(1);
    expect(pushMocks.sendPushToAccount).toHaveBeenCalledTimes(1);
  });

  it('7. Match arquivado permanece arquivado após recálculo rotineiro sem retornar para Novos', async () => {
    const { db, tables } = createInMemorySupabase({
      profiles: baseProfiles,
      contacts: [mariaContact],
      lead_intelligence: [mariaIntelligence],
      property_match_projections: [bessaProjection],
    });

    await recalculateMatchesForLead(db, accountId, leadMariaId);
    const matchId = String(tables.lead_property_matches[0].id);

    const archived = await applyMatchLifecycleAction(db, accountId, {
      matchId,
      action: 'archive',
    });
    expect(archived).toBe(true);
    expect(tables.lead_property_matches[0].match_status).toBe('arquivado');

    pushMocks.sendPushToAccount.mockClear();

    // Recálculo sem mudança material preserva arquivado
    await recalculateMatchesForLead(db, accountId, leadMariaId);
    expect(tables.lead_property_matches[0].match_status).toBe('arquivado');
    expect(pushMocks.sendPushToAccount).not.toHaveBeenCalled();
  });

  it('8. Recalcular match existente não gera duplicação, não renotifica e preserva updated_at', async () => {
    const { db, tables } = createInMemorySupabase({
      profiles: baseProfiles,
      contacts: [mariaContact],
      lead_intelligence: [mariaIntelligence],
      property_match_projections: [bessaProjection],
    });

    await recalculateMatchesForLead(db, accountId, leadMariaId);
    expect(tables.lead_property_matches.length).toBe(1);
    const initialUpdatedAt = tables.lead_property_matches[0].updated_at;
    expect(pushMocks.sendPushToAccount).toHaveBeenCalledTimes(1);
    expect(tables.notifications.length).toBe(2);

    // Recalcula novamente 3 vezes com os mesmos dados
    await recalculateMatchesForLead(db, accountId, leadMariaId);
    await recalculateMatchesForProperty(db, accountId, propBessaId);
    await recalculateMatchesForLead(db, accountId, leadMariaId);

    expect(tables.lead_property_matches.length).toBe(1);
    expect(tables.lead_property_matches[0].updated_at).toBe(initialUpdatedAt);
    expect(pushMocks.sendPushToAccount).toHaveBeenCalledTimes(1);
    expect(tables.notifications.length).toBe(2);
  });

  it('9. Transição para Visualizado/Em análise e contatos arquivados refletem estados reais', async () => {
    const archivedLeadId = 'lead-archived-002';
    const { db, tables } = createInMemorySupabase({
      profiles: baseProfiles,
      contacts: [
        mariaContact,
        {
          id: archivedLeadId,
          account_id: accountId,
          name: 'Lead Arquivado',
          phone: '5583999990000',
          ai_score: 6,
          paused_at: null,
          archived_at: '2026-10-10T10:00:00.000Z',
        },
      ],
      lead_intelligence: [mariaIntelligence],
      property_match_projections: [bessaProjection],
      lead_property_matches: [
        {
          id: 'match-archived-old',
          account_id: accountId,
          lead_id: archivedLeadId,
          property_id: propBessaId,
          match_score: 90,
          profile_maturity: 80,
          match_status: 'novo',
          suppressed: false,
          score_breakdown: {},
          created_at: '2026-10-17T10:00:00.000Z',
          updated_at: '2026-10-17T10:00:00.000Z',
        },
      ],
    });

    await recalculateMatchesForLead(db, accountId, leadMariaId);
    const mariaMatch = tables.lead_property_matches.find((m) => m.lead_id === leadMariaId)!;
    expect(resolveMatchLifecycle(mariaMatch).isUnread).toBe(true);

    // Move Maria para 'em_analise'
    await applyMatchLifecycleAction(db, accountId, {
      matchId: String(mariaMatch.id),
      action: 'view',
    });
    const mariaAfter = tables.lead_property_matches.find((m) => m.lead_id === leadMariaId)!;
    const lc = resolveMatchLifecycle(mariaAfter);
    expect(lc.effectiveStatus).toBe('em_analise');
    expect(lc.isUnread).toBe(false);

    // Reconciliador higieniza match 'novo' do lead arquivado para 'arquivado'
    const rec = await reconcileInventoryWithProjections(db, accountId, { force: true });
    expect(rec.archivedContactMatchesCleaned).toBe(1);
    const archivedMatch = tables.lead_property_matches.find((m) => m.lead_id === archivedLeadId)!;
    expect(archivedMatch.match_status).toBe('arquivado');
  });

  it('10 & 11. Reconciliador incremental recupera imóveis perdidos após interrupção e suprime avalanche de notificações em catch-up histórico', async () => {
    const newInvPropRawId = 'prop-recovered-after-outage';
    const newInvUuid = ensurePropertyUuid(newInvPropRawId);

    // Cenário A: 1 imóvel recém-cadastrado no Meus Imóveis que não passou pelo túnel (interrupção)
    const { db, tables } = createInMemorySupabase({
      profiles: baseProfiles,
      contacts: [mariaContact],
      lead_intelligence: [mariaIntelligence],
      inventory_properties: [
        {
          account_id: '52716edc-399e-4d4c-9788-0d6b04c0031f',
          property_id: newInvPropRawId,
          updated_at: new Date().toISOString(),
          property_data: {
            id: newInvPropRawId,
            title: 'Apartamento Novo Bessa Recuperado',
            type: 'Apartamento',
            purpose: 'Venda',
            neighborhood: 'Bessa',
            price: 460000,
            bedrooms: 2,
            area_m2: 65,
            status: 'Ativo',
            ativo: true,
          },
        },
      ],
      property_match_projections: [],
    });

    const stats = await reconcileInventoryWithProjections(db, accountId, { force: true });
    expect(stats.upsertedProjections).toBe(1);
    expect(stats.recalculatedProperties).toBe(1);
    expect(tables.property_match_projections[0].property_id).toBe(newInvUuid);
    expect(tables.lead_property_matches.length).toBe(1);
    // Evento recente recuperado dispara notificação!
    expect(pushMocks.sendPushToAccount).toHaveBeenCalledTimes(1);

    // Cenário B: Catch-up histórico em lote (6 imóveis antigos > 24h) NÃO gera avalanche de notificações
    pushMocks.sendPushToAccount.mockClear();
    resetInventoryReconcileWatermark();

    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const bulkInventory = Array.from({ length: 6 }, (_, i) => ({
      account_id: '52716edc-399e-4d4c-9788-0d6b04c0031f',
      property_id: `old-prop-${i}`,
      updated_at: oldDate,
      property_data: {
        id: `old-prop-${i}`,
        title: `Imóvel Histórico ${i}`,
        type: 'Apartamento',
        purpose: 'Venda',
        neighborhood: 'Bessa',
        price: 420000 + i * 5000,
        bedrooms: 2,
        status: 'Ativo',
        ativo: true,
      },
    }));

    const { db: dbBulk, tables: bulkTables } = createInMemorySupabase({
      profiles: baseProfiles,
      contacts: [mariaContact],
      lead_intelligence: [mariaIntelligence],
      inventory_properties: bulkInventory,
      property_match_projections: [],
    });

    const bulkStats = await reconcileInventoryWithProjections(dbBulk, accountId, { force: true });
    expect(bulkStats.upsertedProjections).toBe(6);
    expect(bulkStats.recalculatedProperties).toBe(6);
    expect(bulkTables.lead_property_matches.length).toBe(6);
    // Zero notificações retroativas disparadas para backlog antigo!
    expect(pushMocks.sendPushToAccount).not.toHaveBeenCalled();
    expect(bulkTables.notifications.length).toBe(0);
  });

  it('Critérios de relevância e anti-spam diferenciam matchScore, profileMaturity e aiScore e respeitam teto de reaberturas', () => {
    // Lead vazio / baixa maturidade não notifica mesmo com score 85%
    expect(
      isMatchNotificationRelevant({
        matchScore: 86,
        profileMaturity: 30,
        aiScore: 3,
      })
    ).toBe(false);

    // Lead qualificado (aiScore >= 7, maturity >= 55) com compatibilidade 82% notifica
    expect(
      isMatchNotificationRelevant({
        matchScore: 82,
        profileMaturity: 60,
        aiScore: 8,
      })
    ).toBe(true);

    // Origem CTWA nunca notifica
    expect(
      isMatchNotificationRelevant({
        matchScore: 98,
        profileMaturity: 90,
        aiScore: 9,
        isCtwaOrigin: true,
      })
    ).toBe(false);

    // Formatação canônica
    const formatted = formatMatchNotificationText({
      leadId: leadMariaId,
      leadName: 'Maria',
      propertyId: propBessaId,
      propertyTitle: 'Residencial Bessa',
      propertyType: 'apartamento',
      neighborhood: 'Bessa',
      matchScore: 96,
      profileMaturity: 88,
      aiScore: 8,
    });
    expect(formatted.body).toBe(
      'Novo Match: apartamento no Bessa compatível com cliente Maria — 96% de compatibilidade.'
    );

    // Anti-spam: após 2 reaberturas, não reabre pela 3ª vez
    const snap = buildDecisionSnapshot({
      decidedStatus: 'ignorado',
      matchScore: 80,
      property: { priceMin: 500000, priceMax: 500000, neighborhood: 'Bessa', deliveryStatus: 'pronto' },
      leadMaturity: 80,
    });
    const blockedReopen = evaluateMaterialReopen({
      existingRow: {
        suppressed: true,
        match_status: 'novo',
        score_breakdown: {
          _lifecycle: { state: 'ignorado', reopenCount: 2, snapshot: snap },
        },
      },
      newScore: 95,
      newMaturity: 85,
      property: {
        propertyId: propBessaId,
        accountId,
        title: 'Bessa',
        operation: 'venda',
        propertyType: 'apartamento',
        neighborhood: 'Bessa',
        city: 'João Pessoa',
        priceMin: 350000,
        priceMax: 350000,
        deliveryStatus: 'pronto',
        features: [],
        status: 'ativo',
      },
      profile: {
        accountId,
        leadId: leadMariaId,
        name: 'Maria',
        phone: '5583999991234',
        aiScore: 8,
        isPaused: false,
        isArchived: false,
        operation: 'venda',
        purpose: ['Moradia'],
        propertyTypes: ['Apartamento'],
        propertyTypeStrict: false,
        locations: ['Bessa'],
        locationStrict: false,
        locationSpecificity: 'neighborhood',
        priceMin: null,
        priceMax: 500000,
        priceStrictMax: false,
        priceFlexMax: null,
        bedrooms: [2],
        bedroomsStrict: false,
        deliveryStatus: ['pronto'],
        deliveryStrict: false,
        requiredFeatures: [],
        preferredFeatures: [],
        isShortStayOnly: false,
        provenance: {},
      },
    });
    expect(blockedReopen.shouldReopen).toBe(false);
  });
});
