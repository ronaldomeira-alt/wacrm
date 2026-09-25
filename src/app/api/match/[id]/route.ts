import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { updateMatchStatus } from '@/lib/match/service';
import type { MatchStatus } from '@/lib/match/types';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: matchId } = await params;

    const body = (await request.json().catch(() => null)) as {
      status?: MatchStatus;
    } | null;

    if (!body?.status || !['novo', 'enviado', 'pausado', 'arquivado'].includes(body.status)) {
      return NextResponse.json(
        { error: 'Status inválido. Deve ser novo, enviado, pausado ou arquivado.' },
        { status: 400 }
      );
    }

    const success = await updateMatchStatus(ctx.supabase, ctx.accountId, matchId, body.status);
    if (!success) {
      return NextResponse.json({ error: 'Falha ao atualizar status do Match' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, status: body.status });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE = Descartar Match (FASE 11: Supressão).
 * Marca o Match como suppressed = true no banco de dados. Nunca remove fisicamente.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: matchId } = await params;

    const { error } = await ctx.supabase
      .from('lead_property_matches')
      .update({
        suppressed: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', matchId)
      .eq('account_id', ctx.accountId);

    if (error) {
      console.error('[DELETE /api/match/:id] Erro ao suprimir match:', error);
      return NextResponse.json({ error: 'Falha ao descartar match' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, suppressed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
