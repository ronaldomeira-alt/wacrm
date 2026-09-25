import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const { searchParams } = new URL(request.url);

    const status = searchParams.get('status') || 'novo';
    const minScore = parseInt(searchParams.get('min_score') || '0', 10);
    const maxScore = parseInt(searchParams.get('max_score') || '100', 10);
    const minMaturity = parseInt(searchParams.get('min_maturity') || '0', 10);
    const minAiScore = parseInt(searchParams.get('min_ai_score') || '0', 10);
    const leadSearch = (searchParams.get('lead_search') || '').trim();
    const propertySearch = (searchParams.get('property_search') || '').trim();

    // 1. Contadores para cada aba de status (somente não suprimidos)
    const [
      { count: countNovos },
      { count: countEnviados },
      { count: countPausados },
      { count: countArquivados },
    ] = await Promise.all([
      ctx.supabase
        .from('lead_property_matches')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId)
        .eq('match_status', 'novo')
        .eq('suppressed', false),
      ctx.supabase
        .from('lead_property_matches')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId)
        .eq('match_status', 'enviado')
        .eq('suppressed', false),
      ctx.supabase
        .from('lead_property_matches')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId)
        .eq('match_status', 'pausado')
        .eq('suppressed', false),
      ctx.supabase
        .from('lead_property_matches')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId)
        .eq('match_status', 'arquivado')
        .eq('suppressed', false),
    ]);

    // 2. Query dos Matches no status selecionado
    let query = ctx.supabase
      .from('lead_property_matches')
      .select(`
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
      `)
      .eq('account_id', ctx.accountId)
      .eq('match_status', status)
      .eq('suppressed', false)
      .gte('match_score', minScore)
      .lte('match_score', maxScore)
      .gte('profile_maturity', minMaturity);

    if (minAiScore > 0) {
      query = query.gte('contacts.ai_score', minAiScore);
    }

    if (leadSearch) {
      query = query.or(`name.ilike.%${leadSearch}%,phone.ilike.%${leadSearch}%`, {
        foreignTable: 'contacts',
      });
    }

    // Ordenação interna por prioridade comercial, score de match e recência
    query = query
      .order('commercial_priority', { ascending: false })
      .order('match_score', { ascending: false })
      .order('updated_at', { ascending: false });

    const { data: matches, error } = await query;

    if (error) {
      console.error('[GET /api/match] Erro na busca de matches:', error);
      return NextResponse.json({ error: 'Falha ao buscar matches' }, { status: 500 });
    }

    // Busca os imóveis correspondentes em property_match_projections
    const propertyIds = [...new Set((matches || []).map((m) => m.property_id))];
    let propertiesMap = new Map<string, Record<string, unknown>>();

    if (propertyIds.length > 0) {
      const { data: props } = await ctx.supabase
        .from('property_match_projections')
        .select('*')
        .eq('account_id', ctx.accountId)
        .in('property_id', propertyIds);

      for (const p of props || []) {
        propertiesMap.set(p.property_id, p);
      }
    }

    // Filtro por imóvel (caso fornecido)
    let filteredMatches = matches || [];
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

    // Anexa os dados do imóvel em cada match
    const enrichedMatches = filteredMatches.map((m) => {
      const prop = propertiesMap.get(m.property_id) || null;
      return {
        ...m,
        property: prop
          ? {
              propertyId: prop.property_id,
              title: prop.title,
              code: prop.code,
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
            }
          : {
              propertyId: m.property_id,
              title: 'Imóvel em Catálogo',
              neighborhood: 'João Pessoa',
              city: 'João Pessoa',
              priceMin: 0,
              priceMax: 0,
              deliveryStatus: 'pronto',
              features: [],
            },
      };
    });

    return NextResponse.json({
      counts: {
        novos: countNovos ?? 0,
        enviados: countEnviados ?? 0,
        pausados: countPausados ?? 0,
        arquivados: countArquivados ?? 0,
      },
      matches: enrichedMatches,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
