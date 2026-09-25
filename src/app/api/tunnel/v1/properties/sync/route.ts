import { NextResponse } from 'next/server';
import { authenticateTunnelRequest } from '@/lib/tunnel/auth';
import { recalculateMatchesForProperty } from '@/lib/match/service';

export async function POST(request: Request) {
  const ctx = await authenticateTunnelRequest(request);
  if (!ctx) {
    return NextResponse.json({ error: 'Não autorizado no túnel' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    property_id?: string;
    code?: string;
    title?: string;
    operation?: 'venda' | 'locacao';
    property_type?: string;
    neighborhood?: string;
    city?: string;
    price_min?: number;
    price_max?: number;
    area_min?: number;
    area_max?: number;
    bedrooms_min?: number;
    bedrooms_max?: number;
    delivery_status?: 'pronto' | 'planta' | 'em_construcao';
    delivery_deadline?: string;
    features?: string[];
    cover_url?: string;
    public_url?: string;
    status?: 'ativo' | 'inativo' | 'arquivado';
  } | null;

  if (!body?.property_id || !body?.title || !body?.neighborhood) {
    return NextResponse.json(
      { error: 'property_id, title e neighborhood são obrigatórios' },
      { status: 400 }
    );
  }

  const { db, accountId } = ctx;

  const upsertData = {
    account_id: accountId,
    property_id: body.property_id,
    code: body.code || null,
    title: body.title,
    operation: body.operation || 'venda',
    property_type: body.property_type || 'apartamento',
    neighborhood: body.neighborhood,
    city: body.city || 'João Pessoa',
    price_min: body.price_min ?? 0,
    price_max: body.price_max ?? (body.price_min ?? 0),
    area_min: body.area_min ?? null,
    area_max: body.area_max ?? null,
    bedrooms_min: body.bedrooms_min ?? null,
    bedrooms_max: body.bedrooms_max ?? null,
    delivery_status: body.delivery_status || 'pronto',
    delivery_deadline: body.delivery_deadline || null,
    features: body.features || [],
    cover_url: body.cover_url || null,
    public_url: body.public_url || null,
    status: body.status || 'ativo',
    updated_at: new Date().toISOString(),
  };

  const { error } = await db
    .from('property_match_projections')
    .upsert(upsertData, { onConflict: 'account_id,property_id' });

  if (error) {
    console.error('[POST /api/tunnel/v1/properties/sync] Erro ao sincronizar imóvel:', error);
    return NextResponse.json({ error: 'Erro ao persistir projeção' }, { status: 500 });
  }

  // Recalcula os Matches para os leads ativos e elegíveis
  const recalculation = await recalculateMatchesForProperty(db, accountId, body.property_id);

  return NextResponse.json({
    success: true,
    action: 'upserted',
    property_id: body.property_id,
    matches_recalculated: recalculation.totalLeadsEvaluated,
    strong_matches_count: recalculation.strongMatchesCount,
  });
}
