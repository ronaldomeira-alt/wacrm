import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  applyMatchLifecycleAction,
  updateMatchStatus,
  type MatchLifecycleAction,
} from '@/lib/match/service';
import type { MatchStatus } from '@/lib/match/types';

const ALLOWED_STATUSES: MatchStatus[] = [
  'novo',
  'em_analise',
  'enviado',
  'pausado',
  'arquivado',
  'ignorado',
];

const ALLOWED_ACTIONS: MatchLifecycleAction[] = [
  'view',
  'mark_viewed',
  'ignore',
  'archive',
  'pause',
  'send',
  'restore',
];

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: matchId } = await params;

    const body = (await request.json().catch(() => null)) as {
      status?: MatchStatus;
      action?: MatchLifecycleAction;
      leadId?: string;
      matchIds?: string[];
      currentStatusFilter?: MatchStatus;
    } | null;

    if (body?.action && ALLOWED_ACTIONS.includes(body.action)) {
      const success = await applyMatchLifecycleAction(ctx.supabase, ctx.accountId, {
        matchId: body.leadId || body.matchIds ? undefined : matchId,
        leadId: body.leadId,
        matchIds: body.matchIds,
        currentStatusFilter: body.currentStatusFilter,
        action: body.action,
      });

      if (!success) {
        return NextResponse.json(
          { error: 'Falha ao executar ação de ciclo de vida do Match' },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, action: body.action });
    }

    if (!body?.status || !ALLOWED_STATUSES.includes(body.status)) {
      return NextResponse.json(
        {
          error:
            'Status inválido. Deve ser novo, em_analise, enviado, pausado, arquivado ou ignorado.',
        },
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
 * DELETE = Descartar / Ignorar Match (FASE 11: Supressão com Snapshot).
 * Marca o Match como suppressed = true e salva snapshot para só reabrir em caso de mudança material.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: matchId } = await params;

    const success = await applyMatchLifecycleAction(ctx.supabase, ctx.accountId, {
      matchId,
      action: 'ignore',
    });

    if (!success) {
      return NextResponse.json({ error: 'Falha ao descartar match' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, suppressed: true, status: 'ignorado' });
  } catch (err) {
    return toErrorResponse(err);
  }
}
