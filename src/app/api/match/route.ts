import { NextResponse, after } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/push/admin-client';
import { resolveMatchLifecycle, type RawMatchRowForLifecycle } from '@/lib/match/lifecycle';
import {
  applyMatchLifecycleAction,
  type MatchLifecycleAction,
} from '@/lib/match/service';
import { reconcileInventoryWithProjections } from '@/lib/match/inventory-reconciler';
import type { MatchStatus } from '@/lib/match/types';

const DEFAULT_PAGE_SIZE = 36;
const MAX_PAGE_SIZE = 200;
const MAX_PREVIEW_MATCHES_PER_LEAD = 20;

interface RpcLeadGroupRow {
  lead_id: string;
  lead: Record<string, unknown>;
  profile_maturity: number;
  ai_score: number;
  status_matches_count: number | string;
  unread_matches_count: number | string;
  is_unread: boolean;
  is_recent: boolean;
  latest_match_at: string | null;
  first_match_at: string | null;
  viewed_at: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  best_match: Record<string, unknown>;
  matches: Array<Record<string, unknown>>;
  total_groups: number | string;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const { searchParams } = new URL(request.url);

    const status = (searchParams.get('status') || 'novo') as MatchStatus;
    const minScore = parseInt(searchParams.get('min_score') || '0', 10);
    const maxScore = parseInt(searchParams.get('max_score') || '100', 10);
    const minMaturity = parseInt(searchParams.get('min_maturity') || '0', 10);
    const maxMaturity = parseInt(searchParams.get('max_maturity') || '100', 10);
    const minAiScore = parseInt(searchParams.get('min_ai_score') || '0', 10);
    const leadSearch = (searchParams.get('lead_search') || '').trim();
    const propertySearch = (searchParams.get('property_search') || '').trim();
    const dateFilter = (searchParams.get('date_filter') || 'all').trim(); // all | today | 24h | 7d | 30d | older
    const viewFilter = (searchParams.get('view_filter') || 'all').trim(); // all | unread | viewed
    const sortBy = (
      searchParams.get('sort_by') || (status === 'novo' ? 'recent_desc' : 'score_desc')
    ).trim();
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get('page_size') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
    );
    const offset = (page - 1) * pageSize;
    const forceSync = searchParams.get('sync') === '1';

    let adminDb = ctx.supabase;
    try {
      adminDb = supabaseAdmin();
    } catch {
      adminDb = ctx.supabase;
    }

    // 0. Reconciliação incremental (fallback complementar ao envio em tempo real e ao cron/watcher em background)
    const reconcileStats = await reconcileInventoryWithProjections(adminDb, ctx.accountId, {
      force: forceSync,
      maxPropertiesToRecalculate: forceSync ? 40 : 10,
    });

    // 1. Projeções com colunas específicas necessárias para listagem, contadores e status de catálogo
    const { data: allProjections } = await ctx.supabase
      .from('property_match_projections')
      .select(
        'property_id, status, title, code, property_type, neighborhood, city, price_min, price_max, bedrooms_min, bedrooms_max, delivery_status, cover_url, public_url, features, updated_at'
      )
      .eq('account_id', ctx.accountId);

    const validPropertyIds = new Set((allProjections || []).map((p) => p.property_id));
    const activePropertyIds = new Set(
      (allProjections || []).filter((p) => p.status === 'ativo').map((p) => p.property_id)
    );
    const propertiesMap = new Map<string, Record<string, unknown>>();
    let latestCatalogUpdate: string | null = null;
    for (const p of allProjections || []) {
      propertiesMap.set(p.property_id, p);
      if (p.updated_at && (!latestCatalogUpdate || p.updated_at > latestCatalogUpdate)) {
        latestCatalogUpdate = p.updated_at;
      }
    }

    // 2. Contadores precisos por aba via RPC `get_match_tab_counts`
    let countNovos = 0;
    let countEmAnalise = 0;
    let countEnviados = 0;
    let countPausados = 0;
    let countArquivados = 0;
    let countIgnorados = 0;

    const { data: tabCounts, error: tabCountsErr } = await ctx.supabase.rpc('get_match_tab_counts', {
      p_account_id: ctx.accountId,
    });

    const hasModernTabCounts = !tabCountsErr && Array.isArray(tabCounts);
    if (hasModernTabCounts) {
      for (const row of tabCounts as { match_status: string; distinct_leads: number | string }[]) {
        const val = Number(row.distinct_leads) || 0;
        if (row.match_status === 'novo') countNovos = val;
        else if (row.match_status === 'em_analise') countEmAnalise = val;
        else if (row.match_status === 'enviado') countEnviados = val;
        else if (row.match_status === 'pausado') countPausados = val;
        else if (row.match_status === 'arquivado') countArquivados = val;
        else if (row.match_status === 'ignorado') countIgnorados = val;
      }
    }

    // 3. Caminho primário: RPC SQL paginada `get_match_lead_groups` (pós-migration 088)
    //    Agrega 100% das linhas no PostgreSQL (~15ms) preservando TODO o histórico e paginando todos os leads.
    const { data: rpcGroups, error: rpcGroupsErr } = await ctx.supabase.rpc(
      'get_match_lead_groups',
      {
        p_account_id: ctx.accountId,
        p_status: status,
        p_min_score: minScore,
        p_max_score: maxScore,
        p_min_maturity: minMaturity,
        p_max_maturity: maxMaturity,
        p_min_ai_score: minAiScore,
        p_lead_search: leadSearch || null,
        p_property_search: propertySearch || null,
        p_date_filter: dateFilter,
        p_view_filter: viewFilter,
        p_sort_by: sortBy,
        p_limit: pageSize,
        p_offset: offset,
        p_max_matches_per_lead: MAX_PREVIEW_MATCHES_PER_LEAD,
      }
    );

    if (!rpcGroupsErr && Array.isArray(rpcGroups)) {
      const typedRows = rpcGroups as RpcLeadGroupRow[];
      const totalGroups =
        typedRows.length > 0 ? Number(typedRows[0].total_groups) || typedRows.length : 0;
      const totalPages = Math.max(1, Math.ceil(totalGroups / pageSize));

      const groups = typedRows.map((row) => ({
        leadId: row.lead_id,
        lead: row.lead,
        profileMaturity: Number(row.profile_maturity) || 0,
        aiScore: Number(row.ai_score) || 0,
        bestMatch: row.best_match,
        totalMatches: Number(row.status_matches_count) || 0,
        statusMatchesCount: Number(row.status_matches_count) || 0,
        unreadMatchesCount: Number(row.unread_matches_count) || 0,
        isUnread: Boolean(row.is_unread),
        isRecent: Boolean(row.is_recent),
        latestMatchAt: row.latest_match_at || undefined,
        firstMatchAt: row.first_match_at || undefined,
        viewedAt: row.viewed_at || null,
        reopenedAt: row.reopened_at || null,
        reopenReason: row.reopen_reason || null,
        matches: Array.isArray(row.matches) ? row.matches : [],
      }));

      const recentGroupsCount = groups.filter((g) => g.isRecent).length;
      const unreadGroupsCount = groups.filter((g) => g.isUnread).length;

      return NextResponse.json({
        counts: {
          novos: countNovos,
          em_analise: countEmAnalise,
          enviados: countEnviados,
          pausados: countPausados,
          arquivados: countArquivados,
          ignorados: countIgnorados,
          recentes: recentGroupsCount,
          nao_lidos: unreadGroupsCount,
        },
        pagination: {
          page,
          pageSize,
          totalGroups,
          totalPages,
          hasMore: page < totalPages,
          mode: 'rpc',
        },
        catalogStatus: {
          activePropertiesCount: activePropertyIds.size,
          totalProjectionsCount: validPropertyIds.size,
          latestCatalogUpdate,
          reconcileStats,
        },
        groups,
        matches: groups.flatMap((g) => g.matches),
      });
    }

    // 4. Caminho fallback completo (pré-migration 088 ou mocks sem RPC `get_match_lead_groups`)
    //    Carrega contatos da conta UMA única vez (sem repetir em cada linha de match)
    //    e pagina todas as linhas leves de `lead_property_matches` em fatias de 1.000,
    //    garantindo que 100% dos leads (ex.: todos os 282) sejam agrupados e paginados sem truncamento.
    const { data: accountContacts } = await ctx.supabase
      .from('contacts')
      .select(
        'id, name, phone, ai_score, ai_score_reason, paused_at, archived_at, has_purchased, is_personal_whatsapp'
      )
      .eq('account_id', ctx.accountId);

    const contactsMap = new Map<string, Record<string, unknown>>();
    for (const c of accountContacts || []) {
      contactsMap.set(c.id, c as Record<string, unknown>);
    }

    // Busca todas as linhas leves de lead_property_matches para a conta sem truncar em 1.000
    const allMatchRows: Array<Record<string, unknown>> = [];
    const CHUNK_SIZE = 1000;
    const MAX_SCAN_PAGES = 80; // até 80.000 linhas com segurança
    for (let scanPage = 0; scanPage < MAX_SCAN_PAGES; scanPage++) {
      const from = scanPage * CHUNK_SIZE;
      const to = from + CHUNK_SIZE - 1;
      const { data: batch, error: batchErr } = await ctx.supabase
        .from('lead_property_matches')
        .select(
          'id, account_id, lead_id, property_id, match_score, score_breakdown, profile_maturity, commercial_priority, match_status, suppressed, origin, sent_at, paused_at, archived_at, created_at, updated_at'
        )
        .eq('account_id', ctx.accountId)
        .order('id', { ascending: true })
        .range(from, to);

      if (batchErr) {
        console.error('[GET /api/match] Erro no fallback paginado:', batchErr);
        return NextResponse.json({ error: 'Falha ao buscar matches' }, { status: 500 });
      }
      if (!batch || batch.length === 0) break;
      allMatchRows.push(...(batch as Array<Record<string, unknown>>));
      if (batch.length < CHUNK_SIZE) break;
    }

    const nowMs = Date.now();

    // Recalcula contadores reais a partir de 100% das linhas lidas para coerência exata com as páginas
    const tabLeadSets: Record<MatchStatus, Set<string>> = {
      novo: new Set(),
      em_analise: new Set(),
      enviado: new Set(),
      pausado: new Set(),
      arquivado: new Set(),
      ignorado: new Set(),
    };

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const ms24h = 24 * 60 * 60 * 1000;
    const ms7d = 7 * ms24h;
    const ms30d = 30 * ms24h;
    const normLeadSearch = leadSearch.toLowerCase();
    const normPropSearch = propertySearch.toLowerCase();

    const groupsMap = new Map<
      string,
      {
        leadId: string;
        lead: Record<string, unknown>;
        profileMaturity: number;
        aiScore: number;
        matches: Array<Record<string, unknown>>;
      }
    >();

    const staleIds: string[] = [];

    for (const rawRow of allMatchRows) {
      const propId = String(rawRow.property_id || '');
      const leadId = String(rawRow.lead_id || '');
      const prop = propertiesMap.get(propId);
      const contact = contactsMap.get(leadId);

      if (!prop) {
        if (propertiesMap.size > 0 && rawRow.id) staleIds.push(String(rawRow.id));
        continue;
      }
      if (!contact) continue;

      const lc = resolveMatchLifecycle(rawRow as unknown as RawMatchRowForLifecycle, nowMs);
      const isContactArchived = Boolean(contact.archived_at);
      const isContactPaused = Boolean(contact.paused_at);

      // Contabiliza nas abas respeitando contatos ativos e imóveis ativos
      const isActiveTabStatus = lc.effectiveStatus === 'novo' || lc.effectiveStatus === 'em_analise';
      if (isActiveTabStatus) {
        if (prop.status === 'ativo' && !isContactArchived && !isContactPaused) {
          tabLeadSets[lc.effectiveStatus].add(leadId);
        } else if (isContactArchived) {
          tabLeadSets.arquivado.add(leadId);
        } else if (isContactPaused) {
          tabLeadSets.pausado.add(leadId);
        }
      } else {
        tabLeadSets[lc.effectiveStatus].add(leadId);
      }

      // Filtra pela aba selecionada
      let effectiveStatusForFilter = lc.effectiveStatus;
      if (isActiveTabStatus && isContactArchived) effectiveStatusForFilter = 'arquivado';
      else if (isActiveTabStatus && isContactPaused) effectiveStatusForFilter = 'pausado';

      if (effectiveStatusForFilter !== status) continue;
      if ((status === 'novo' || status === 'em_analise') && prop.status !== 'ativo') continue;

      const matchScore = Number(rawRow.match_score || 0);
      const profileMaturity = Number(rawRow.profile_maturity || 0);
      const aiScore = Number(contact.ai_score ?? 0);

      if (matchScore < minScore || matchScore > maxScore) continue;
      if (profileMaturity < minMaturity || profileMaturity > maxMaturity) continue;
      if (minAiScore > 0 && aiScore < minAiScore) continue;

      if (normLeadSearch) {
        const cName = String(contact.name || '').toLowerCase();
        const cPhone = String(contact.phone || '').toLowerCase();
        if (!cName.includes(normLeadSearch) && !cPhone.includes(normLeadSearch)) continue;
      }

      if (normPropSearch) {
        const pTitle = String(prop.title || '').toLowerCase();
        const pNeigh = String(prop.neighborhood || '').toLowerCase();
        const pCode = String(prop.code || '').toLowerCase();
        if (
          !pTitle.includes(normPropSearch) &&
          !pNeigh.includes(normPropSearch) &&
          !pCode.includes(normPropSearch)
        ) {
          continue;
        }
      }

      if (viewFilter === 'unread' && !lc.isUnread) continue;
      if (viewFilter === 'viewed' && lc.isUnread) continue;

      if (dateFilter !== 'all') {
        const refStr = lc.reopenedAt || String(rawRow.created_at || rawRow.updated_at || '');
        const refMs = refStr ? new Date(refStr).getTime() : 0;
        if (!refMs || Number.isNaN(refMs)) continue;
        const ageMs = nowMs - refMs;
        if (dateFilter === 'today' && refMs < todayMs) continue;
        if (dateFilter === '24h' && ageMs > ms24h) continue;
        if (dateFilter === '7d' && ageMs > ms7d) continue;
        if (dateFilter === '30d' && ageMs > ms30d) continue;
        if (dateFilter === 'older' && ageMs <= ms7d) continue;
      }

      const enrichedRow = {
        ...rawRow,
        match_score: matchScore,
        commercial_priority: Number(rawRow.commercial_priority || 0),
        profile_maturity: profileMaturity,
        match_status: effectiveStatusForFilter,
        viewed_at: lc.viewedAt,
        ignored_at: lc.ignoredAt,
        reopened_at: lc.reopenedAt,
        reopen_reason: lc.reopenReason,
        reopen_count: lc.reopenCount,
        is_unread: lc.isUnread,
        is_recent: lc.isRecent,
        contacts: contact,
        property: {
          propertyId: prop.property_id,
          title: prop.title,
          code: prop.code,
          propertyType: prop.property_type,
          neighborhood: prop.neighborhood,
          city: prop.city,
          priceMin: Number(prop.price_min),
          priceMax: Number(prop.price_max),
          bedroomsMin: prop.bedrooms_min,
          bedroomsMax: prop.bedrooms_max,
          deliveryStatus: prop.delivery_status,
          coverUrl: prop.cover_url,
          publicUrl: prop.public_url,
          features: prop.features || [],
        },
      };

      if (!groupsMap.has(leadId)) {
        groupsMap.set(leadId, {
          leadId,
          lead: contact,
          profileMaturity,
          aiScore,
          matches: [],
        });
      }
      groupsMap.get(leadId)!.matches.push(enrichedRow);
    }

    if (staleIds.length > 0) {
      after(() => {
        for (let i = 0; i < staleIds.length; i += 50) {
          void ctx.supabase
            .from('lead_property_matches')
            .delete()
            .eq('account_id', ctx.accountId)
            .in('id', staleIds.slice(i, i + 50));
        }
      });
    }

    const allGroups = Array.from(groupsMap.values()).map((g) => {
      const sortedMatches = [...g.matches].sort((a, b) => {
        const sDiff = Number(b.match_score || 0) - Number(a.match_score || 0);
        if (sDiff !== 0) return sDiff;
        const pDiff = Number(b.commercial_priority || 0) - Number(a.commercial_priority || 0);
        if (pDiff !== 0) return pDiff;
        return new Date(String(b.created_at || 0)).getTime() - new Date(String(a.created_at || 0)).getTime();
      });

      let latestMatchAt = String(sortedMatches[0]?.created_at || '');
      let firstMatchAt = String(sortedMatches[0]?.created_at || '');
      let unreadMatchesCount = 0;
      let isRecent = false;
      let latestViewedAt: string | null = null;
      let reopenedAt: string | null = null;
      let reopenReason: string | null = null;

      for (const m of sortedMatches) {
        const refAt = String(m.reopened_at || m.created_at || '');
        if (refAt && (!latestMatchAt || refAt > latestMatchAt)) latestMatchAt = refAt;
        const cAt = String(m.created_at || '');
        if (cAt && (!firstMatchAt || cAt < firstMatchAt)) firstMatchAt = cAt;
        if (m.is_unread) unreadMatchesCount++;
        if (m.is_recent) isRecent = true;
        if (m.viewed_at && (!latestViewedAt || String(m.viewed_at) > latestViewedAt)) {
          latestViewedAt = String(m.viewed_at);
        }
        if (m.reopened_at && (!reopenedAt || String(m.reopened_at) > reopenedAt)) {
          reopenedAt = String(m.reopened_at);
          reopenReason = m.reopen_reason ? String(m.reopen_reason) : null;
        }
      }

      return {
        leadId: g.leadId,
        lead: g.lead,
        profileMaturity: g.profileMaturity,
        aiScore: g.aiScore,
        bestMatch: sortedMatches[0],
        totalMatches: sortedMatches.length,
        statusMatchesCount: sortedMatches.length,
        unreadMatchesCount,
        isUnread: unreadMatchesCount > 0,
        isRecent,
        latestMatchAt,
        firstMatchAt,
        viewedAt: latestViewedAt,
        reopenedAt,
        reopenReason,
        // Limita apenas a prévia retornada por card (Top 20) mantendo 100% no banco
        matches: sortedMatches.slice(0, MAX_PREVIEW_MATCHES_PER_LEAD),
      };
    });

    allGroups.sort((a, b) => {
      if (sortBy === 'recent_desc') {
        const timeA = a.latestMatchAt ? new Date(a.latestMatchAt).getTime() : 0;
        const timeB = b.latestMatchAt ? new Date(b.latestMatchAt).getTime() : 0;
        if (timeB !== timeA) return timeB - timeA;
        const scoreDiff = Number(b.bestMatch?.match_score || 0) - Number(a.bestMatch?.match_score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return Number(b.bestMatch?.commercial_priority || 0) - Number(a.bestMatch?.commercial_priority || 0);
      }
      if (sortBy === 'priority_desc') {
        const prioDiff = Number(b.bestMatch?.commercial_priority || 0) - Number(a.bestMatch?.commercial_priority || 0);
        if (prioDiff !== 0) return prioDiff;
        return Number(b.bestMatch?.match_score || 0) - Number(a.bestMatch?.match_score || 0);
      }
      if (sortBy === 'ai_score_desc') {
        if (b.aiScore !== a.aiScore) return b.aiScore - a.aiScore;
        return Number(b.bestMatch?.match_score || 0) - Number(a.bestMatch?.match_score || 0);
      }
      const scoreDiff = Number(b.bestMatch?.match_score || 0) - Number(a.bestMatch?.match_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return Number(b.bestMatch?.commercial_priority || 0) - Number(a.bestMatch?.commercial_priority || 0);
    });

    const totalGroups = allGroups.length;
    const totalPages = Math.max(1, Math.ceil(totalGroups / pageSize));
    const pagedGroups = allGroups.slice(offset, offset + pageSize);

    countNovos = tabLeadSets.novo.size;
    countEmAnalise = tabLeadSets.em_analise.size;
    countEnviados = tabLeadSets.enviado.size;
    countPausados = tabLeadSets.pausado.size;
    countArquivados = tabLeadSets.arquivado.size;
    countIgnorados = tabLeadSets.ignorado.size;

    const recentGroupsCount = allGroups.filter((g) => g.isRecent).length;
    const unreadGroupsCount = allGroups.filter((g) => g.isUnread).length;

    return NextResponse.json({
      counts: {
        novos: countNovos,
        em_analise: countEmAnalise,
        enviados: countEnviados,
        pausados: countPausados,
        arquivados: countArquivados,
        ignorados: countIgnorados,
        recentes: recentGroupsCount,
        nao_lidos: unreadGroupsCount,
      },
      pagination: {
        page,
        pageSize,
        totalGroups,
        totalPages,
        hasMore: page < totalPages,
        mode: 'fallback_complete',
      },
      catalogStatus: {
        activePropertiesCount: activePropertyIds.size,
        totalProjectionsCount: validPropertyIds.size,
        latestCatalogUpdate,
        reconcileStats,
      },
      groups: pagedGroups,
      matches: pagedGroups.flatMap((g) => g.matches),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/match
 * Operações de ciclo de vida em lote (por lead, por lista de matches ou triagem de histórico)
 * e sincronização sob demanda com o estoque do Meus Imóveis.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      operation?: 'lifecycle' | 'triage_historical' | 'sync_inventory';
      action?: MatchLifecycleAction;
      leadId?: string;
      matchId?: string;
      matchIds?: string[];
      currentStatusFilter?: MatchStatus;
      olderThanDays?: number;
      targetStatus?: 'arquivado' | 'em_analise';
    } | null;

    if (!body?.operation) {
      return NextResponse.json({ error: 'operation é obrigatória' }, { status: 400 });
    }

    let adminDb = ctx.supabase;
    try {
      adminDb = supabaseAdmin();
    } catch {
      adminDb = ctx.supabase;
    }

    if (body.operation === 'sync_inventory') {
      const stats = await reconcileInventoryWithProjections(adminDb, ctx.accountId, {
        force: true,
        maxPropertiesToRecalculate: 50,
      });
      return NextResponse.json({ ok: true, stats });
    }

    if (body.operation === 'lifecycle') {
      if (!body.action) {
        return NextResponse.json({ error: 'action é obrigatória' }, { status: 400 });
      }
      const success = await applyMatchLifecycleAction(ctx.supabase, ctx.accountId, {
        matchId: body.matchId,
        matchIds: body.matchIds,
        leadId: body.leadId,
        currentStatusFilter: body.currentStatusFilter,
        action: body.action,
      });
      if (!success) {
        return NextResponse.json(
          { error: 'Não foi possível atualizar o estado da oportunidade' },
          { status: 500 }
        );
      }
      return NextResponse.json({ ok: true, action: body.action });
    }

    if (body.operation === 'triage_historical') {
      const olderThanDays = Math.max(1, Number(body.olderThanDays || 14));
      const cutoffIso = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
      const nowIso = new Date().toISOString();

      const { data: archivedRows, error } = await ctx.supabase
        .from('lead_property_matches')
        .update({
          match_status: 'arquivado',
          archived_at: nowIso,
          updated_at: nowIso,
        })
        .eq('account_id', ctx.accountId)
        .eq('match_status', 'novo')
        .eq('suppressed', false)
        .lt('created_at', cutoffIso)
        .select('id, lead_id');

      if (error) {
        return NextResponse.json(
          { error: 'Falha ao arquivar oportunidades antigas: ' + error.message },
          { status: 500 }
        );
      }

      const distinctLeadsCount = new Set((archivedRows || []).map((r) => r.lead_id)).size;

      return NextResponse.json({
        ok: true,
        matchesArchived: archivedRows?.length || 0,
        leadsArchived: distinctLeadsCount,
        cutoffIso,
      });
    }

    return NextResponse.json({ error: 'Operação desconhecida' }, { status: 400 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
