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
    const sortBy = (searchParams.get('sort_by') || (status === 'novo' ? 'recent_desc' : 'score_desc')).trim();
    const forceSync = searchParams.get('sync') === '1';

    let adminDb = ctx.supabase;
    try {
      adminDb = supabaseAdmin();
    } catch {
      adminDb = ctx.supabase;
    }

    // 0. Reconciliação incremental com inventory_properties (Meus Imóveis) + higienização de leads arquivados
    const reconcileStats = await reconcileInventoryWithProjections(adminDb, ctx.accountId, {
      force: forceSync,
      maxPropertiesToRecalculate: forceSync ? 40 : 15,
    });

    // 1. Projeções com colunas específicas necessárias para listagem e enriquecimento dos cards
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

    // Helper para deletar matches órfãos em lotes seguros
    const safeDeleteInChunks = (column: string, ids: string[]) => {
      const unique = [...new Set(ids)];
      const chunkSize = 50;
      for (let i = 0; i < unique.length; i += chunkSize) {
        const slice = unique.slice(i, i + chunkSize);
        void ctx.supabase
          .from('lead_property_matches')
          .delete()
          .eq('account_id', ctx.accountId)
          .in(column, slice);
      }
    };

    // 2. Busca das linhas de matches combinando as mais recentes + maior prioridade
    // para eliminar o truncamento de 1.000 linhas do PostgREST que ocultava novos leads
    const buildBaseSelect = () => {
      let q = ctx.supabase
        .from('lead_property_matches')
        .select(
          `
          id,
          account_id,
          lead_id,
          property_id,
          match_score,
          score_breakdown,
          profile_maturity,
          commercial_priority,
          match_status,
          suppressed,
          origin,
          sent_at,
          paused_at,
          archived_at,
          created_at,
          updated_at,
          contacts!inner (
            id,
            name,
            phone,
            ai_score,
            ai_score_reason,
            paused_at,
            archived_at,
            has_purchased,
            is_personal_whatsapp
          )
        `
        )
        .eq('account_id', ctx.accountId)
        .gte('match_score', minScore)
        .lte('match_score', maxScore)
        .gte('profile_maturity', minMaturity)
        .lte('profile_maturity', maxMaturity);

      if (status === 'ignorado') {
        q = q.eq('suppressed', true);
      } else if (status === 'novo' || status === 'em_analise') {
        // 'em_analise' pode estar armazenado com match_status='em_analise' (pós-088) ou match_status='novo' + _lifecycle.state='em_analise'
        q = q.in('match_status', ['novo', 'em_analise']).eq('suppressed', false);
      } else {
        q = q.eq('match_status', status).eq('suppressed', false);
      }

      if (minAiScore > 0) {
        q = q.gte('contacts.ai_score', minAiScore);
      }

      if (leadSearch) {
        q = q.or(`name.ilike.%${leadSearch}%,phone.ilike.%${leadSearch}%`, {
          foreignTable: 'contacts',
        });
      }

      return q;
    };

    // Executa duas buscas complementares em paralelo (Mais Recentes + Maior Score/Prioridade)
    // garantindo que 100% dos matches novos apareçam mesmo em bases com > 1.000 linhas
    const [recentRes, topRes] = await Promise.all([
      buildBaseSelect()
        .order('created_at', { ascending: false })
        .order('match_score', { ascending: false })
        .limit(1000),
      buildBaseSelect()
        .order('match_score', { ascending: false })
        .order('commercial_priority', { ascending: false })
        .order('updated_at', { ascending: false })
        .limit(1000),
    ]);

    if (recentRes.error && topRes.error) {
      console.error('[GET /api/match] Erro na busca de matches:', recentRes.error);
      return NextResponse.json({ error: 'Falha ao buscar matches' }, { status: 500 });
    }

    const mergedMatchesMap = new Map<string, NonNullable<typeof recentRes.data>[number]>();
    for (const row of recentRes.data || []) {
      mergedMatchesMap.set(row.id, row);
    }
    for (const row of topRes.data || []) {
      if (!mergedMatchesMap.has(row.id)) {
        mergedMatchesMap.set(row.id, row);
      }
    }
    const matches = Array.from(mergedMatchesMap.values());

    // Limpa do banco de dados qualquer match órfão sem imóvel ou match 'novo' de imóvel inativo
    if (propertiesMap.size > 0) {
      const staleMatches = matches.filter((m) => {
        const prop = propertiesMap.get(m.property_id);
        if (!prop) return true;
        if (!m.suppressed && m.match_status === 'novo' && prop.status !== 'ativo') return true;
        return false;
      });
      if (staleMatches.length > 0) {
        const staleIds = staleMatches.map((m) => m.id);
        after(() => {
          safeDeleteInChunks('id', staleIds);
        });
      }
    }

    const nowMs = Date.now();

    // Enriquecimento com ciclo de vida resolvido (`resolveMatchLifecycle`) e filtro de validade
    let filteredMatches = matches
      .map((m) => {
        const lifecycle = resolveMatchLifecycle(m as unknown as RawMatchRowForLifecycle, nowMs);
        return {
          ...m,
          _resolvedLifecycle: lifecycle,
        };
      })
      .filter((m) => {
        const prop = propertiesMap.get(m.property_id);
        if (!prop) return false;

        const contactObj = (Array.isArray(m.contacts) ? m.contacts[0] : m.contacts) as Record<
          string,
          unknown
        > | null;

        const isContactArchived = Boolean(contactObj?.archived_at);
        const isContactPaused = Boolean(contactObj?.paused_at);

        // Leads arquivados ou pausados não devem aparecer em 'novo' nem 'em_analise'
        if ((status === 'novo' || status === 'em_analise') && (isContactArchived || isContactPaused)) {
          return false;
        }

        // Imóveis inativos/vendidos não devem aparecer como oportunidades ativas ('novo' ou 'em_analise')
        if ((status === 'novo' || status === 'em_analise') && prop.status !== 'ativo') {
          return false;
        }

        // Filtra pelo estado efetivo do ciclo de vida
        if (m._resolvedLifecycle.effectiveStatus !== status) {
          return false;
        }

        return true;
      });

    // Filtro por imóvel (caso fornecido)
    if (propertySearch) {
      const normSearch = propertySearch.toLowerCase();
      filteredMatches = filteredMatches.filter((m) => {
        const prop = propertiesMap.get(m.property_id);
        if (!prop) return false;
        const title = String(prop.title || '').toLowerCase();
        const neighborhood = String(prop.neighborhood || '').toLowerCase();
        const code = String(prop.code || '').toLowerCase();
        return (
          title.includes(normSearch) ||
          neighborhood.includes(normSearch) ||
          code.includes(normSearch)
        );
      });
    }

    // Filtro de visualização (lidos / não visualizados)
    if (viewFilter === 'unread') {
      filteredMatches = filteredMatches.filter((m) => m._resolvedLifecycle.isUnread);
    } else if (viewFilter === 'viewed') {
      filteredMatches = filteredMatches.filter((m) => !m._resolvedLifecycle.isUnread);
    }

    // Filtro de data/período (baseado na data de identificação ou reabertura do match)
    if (dateFilter !== 'all') {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const todayMs = startOfToday.getTime();
      const ms24h = 24 * 60 * 60 * 1000;
      const ms7d = 7 * ms24h;
      const ms30d = 30 * ms24h;

      filteredMatches = filteredMatches.filter((m) => {
        const refStr = m._resolvedLifecycle.reopenedAt || m.created_at || m.updated_at;
        const refMs = refStr ? new Date(refStr).getTime() : 0;
        if (!refMs || Number.isNaN(refMs)) return false;
        const ageMs = nowMs - refMs;

        if (dateFilter === 'today') return refMs >= todayMs;
        if (dateFilter === '24h') return ageMs <= ms24h;
        if (dateFilter === '7d') return ageMs <= ms7d;
        if (dateFilter === '30d') return ageMs <= ms30d;
        if (dateFilter === 'older') return ageMs > ms7d;
        return true;
      });
    }

    // Anexa os dados do imóvel e metadados de ciclo de vida em cada match
    const enrichedMatches = filteredMatches.map((m) => {
      const prop = propertiesMap.get(m.property_id)!;
      const lc = m._resolvedLifecycle;
      return {
        ...m,
        match_status: lc.effectiveStatus,
        viewed_at: lc.viewedAt,
        ignored_at: lc.ignoredAt,
        reopened_at: lc.reopenedAt,
        reopen_reason: lc.reopenReason,
        reopen_count: lc.reopenCount,
        is_unread: lc.isUnread,
        is_recent: lc.isRecent,
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
    });

    // 3. Agrupa os matches por LEAD (1 Card Visual = 1 Lead)
    const groupsMap = new Map<
      string,
      {
        leadId: string;
        lead: Record<string, unknown>;
        profileMaturity: number;
        aiScore: number;
        matches: typeof enrichedMatches;
      }
    >();

    for (const m of enrichedMatches) {
      const contactObj = (Array.isArray(m.contacts) ? m.contacts[0] : m.contacts) as Record<
        string,
        unknown
      >;
      if (!groupsMap.has(m.lead_id)) {
        groupsMap.set(m.lead_id, {
          leadId: m.lead_id,
          lead: contactObj,
          profileMaturity: m.profile_maturity,
          aiScore: (contactObj?.ai_score as number) ?? 0,
          matches: [],
        });
      }
      groupsMap.get(m.lead_id)!.matches.push(m);
    }

    const groups = Array.from(groupsMap.values()).map((g) => {
      // Ordena os matches internos do lead: match_score DESC, depois commercial_priority DESC, depois mais recente
      const sortedMatches = [...g.matches].sort((a, b) => {
        if (b.match_score !== a.match_score) return b.match_score - a.match_score;
        if (b.commercial_priority !== a.commercial_priority) {
          return b.commercial_priority - a.commercial_priority;
        }
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      let latestMatchAt = sortedMatches[0]?.created_at || '';
      let firstMatchAt = sortedMatches[0]?.created_at || '';
      let unreadMatchesCount = 0;
      let isRecent = false;
      let latestViewedAt: string | null = null;
      let reopenedAt: string | null = null;
      let reopenReason: string | null = null;

      for (const m of sortedMatches) {
        const refAt = m.reopened_at || m.created_at;
        if (refAt && (!latestMatchAt || refAt > latestMatchAt)) {
          latestMatchAt = refAt;
        }
        if (m.created_at && (!firstMatchAt || m.created_at < firstMatchAt)) {
          firstMatchAt = m.created_at;
        }
        if (m.is_unread) unreadMatchesCount++;
        if (m.is_recent) isRecent = true;
        if (m.viewed_at && (!latestViewedAt || m.viewed_at > latestViewedAt)) {
          latestViewedAt = m.viewed_at;
        }
        if (m.reopened_at && (!reopenedAt || m.reopened_at > reopenedAt)) {
          reopenedAt = m.reopened_at;
          reopenReason = m.reopen_reason || null;
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
        matches: sortedMatches,
      };
    });

    // Ordenação dos grupos conforme seleção do usuário (padrão em 'novo': mais recente primeiro)
    groups.sort((a, b) => {
      if (sortBy === 'recent_desc') {
        const timeA = a.latestMatchAt ? new Date(a.latestMatchAt).getTime() : 0;
        const timeB = b.latestMatchAt ? new Date(b.latestMatchAt).getTime() : 0;
        if (timeB !== timeA) return timeB - timeA;
        const scoreDiff = (b.bestMatch?.match_score || 0) - (a.bestMatch?.match_score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return (b.bestMatch?.commercial_priority || 0) - (a.bestMatch?.commercial_priority || 0);
      }

      if (sortBy === 'priority_desc') {
        const prioDiff =
          (b.bestMatch?.commercial_priority || 0) - (a.bestMatch?.commercial_priority || 0);
        if (prioDiff !== 0) return prioDiff;
        return (b.bestMatch?.match_score || 0) - (a.bestMatch?.match_score || 0);
      }

      if (sortBy === 'ai_score_desc') {
        if (b.aiScore !== a.aiScore) return b.aiScore - a.aiScore;
        return (b.bestMatch?.match_score || 0) - (a.bestMatch?.match_score || 0);
      }

      // score_desc
      const scoreDiff = (b.bestMatch?.match_score || 0) - (a.bestMatch?.match_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return (b.bestMatch?.commercial_priority || 0) - (a.bestMatch?.commercial_priority || 0);
    });

    // 4. Contadores precisos para cada aba de status
    let countNovos = 0;
    let countEmAnalise = 0;
    let countEnviados = 0;
    let countPausados = 0;
    let countArquivados = 0;
    let countIgnorados = 0;

    const { data: tabCounts, error: tabCountsErr } = await ctx.supabase.rpc('get_match_tab_counts', {
      p_account_id: ctx.accountId,
    });

    if (!tabCountsErr && tabCounts && Array.isArray(tabCounts)) {
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

    // Complementa contadores para abas gerenciadas via _lifecycle ou suppressed antes da migration 088
    const [ignoredLeadsRes, emAnaliseRowsRes] = await Promise.all([
      ctx.supabase
        .from('lead_property_matches')
        .select('lead_id, property_id')
        .eq('account_id', ctx.accountId)
        .eq('suppressed', true)
        .limit(1000),
      ctx.supabase
        .from('lead_property_matches')
        .select('lead_id, property_id, match_status, score_breakdown')
        .eq('account_id', ctx.accountId)
        .eq('suppressed', false)
        .not('score_breakdown->_lifecycle', 'is', null)
        .limit(1000),
    ]);

    if (countIgnorados === 0 && ignoredLeadsRes.data) {
      const igSet = new Set<string>();
      for (const r of ignoredLeadsRes.data) {
        if (validPropertyIds.has(r.property_id)) igSet.add(r.lead_id);
      }
      countIgnorados = igSet.size;
    }

    if (emAnaliseRowsRes.data && emAnaliseRowsRes.data.length > 0) {
      const eaSet = new Set<string>();
      for (const r of emAnaliseRowsRes.data) {
        if (!activePropertyIds.has(r.property_id)) continue;
        const lc = resolveMatchLifecycle(r as unknown as RawMatchRowForLifecycle, nowMs);
        if (lc.effectiveStatus === 'em_analise') {
          eaSet.add(r.lead_id);
        }
      }
      if (countEmAnalise === 0 && eaSet.size > 0) {
        countEmAnalise = eaSet.size;
        countNovos = Math.max(0, countNovos - eaSet.size);
      }
    }

    // Se a aba ativa não tem filtros restritivos de busca, garante coerência entre o contador da aba e os grupos visíveis
    const hasNoSearchOrScoreFilters =
      !leadSearch &&
      !propertySearch &&
      minScore === 0 &&
      maxScore === 100 &&
      minMaturity === 0 &&
      minAiScore === 0 &&
      dateFilter === 'all' &&
      viewFilter === 'all';

    if (hasNoSearchOrScoreFilters) {
      if (status === 'em_analise') countEmAnalise = groups.length;
      if (status === 'ignorado') countIgnorados = groups.length;
      if (status === 'enviado') countEnviados = groups.length;
      if (status === 'pausado') countPausados = groups.length;
      if (status === 'arquivado') countArquivados = groups.length;
    }

    const recentGroupsCount = groups.filter((g) => g.isRecent).length;
    const unreadGroupsCount = groups.filter((g) => g.isUnread).length;

    return NextResponse.json({
      counts: {
        novos: countNovos ?? 0,
        em_analise: countEmAnalise ?? 0,
        enviados: countEnviados ?? 0,
        pausados: countPausados ?? 0,
        arquivados: countArquivados ?? 0,
        ignorados: countIgnorados ?? 0,
        recentes: recentGroupsCount,
        nao_lidos: unreadGroupsCount,
      },
      catalogStatus: {
        activePropertiesCount: activePropertyIds.size,
        totalProjectionsCount: validPropertyIds.size,
        latestCatalogUpdate,
        reconcileStats,
      },
      groups,
      matches: enrichedMatches,
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
