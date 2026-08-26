import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createClient } from '@/lib/supabase/server' // Usar o server client para operações de admin

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: planId } = await params;
    const { supabase, accountId } = await requireRole('agent');

    // 1. Verifica se o plano existe e pertence à conta
    const { data: plan, error: fetchError } = await supabase
      .from('followup_plans')
      .select('id, status')
      .eq('id', planId)
      .eq('account_id', accountId)
      .single();

    if (fetchError || !plan) {
      return NextResponse.json({ error: 'Plano não encontrado ou não autorizado.' }, { status: 404 });
    }

    if (plan.status !== 'active') {
      return NextResponse.json({ error: 'Apenas planos ativos podem ser cancelados.' }, { status: 400 });
    }

    // 2. Atualiza o status do plano para 'cancelled'
    const { error: planUpdateError } = await supabase
      .from('followup_plans')
      .update({ status: 'cancelled' })
      .eq('id', planId);

    if (planUpdateError) {
      console.error('[CancelPlan API] Error updating plan:', planUpdateError);
      return NextResponse.json({ error: 'Falha ao cancelar o plano.' }, { status: 500 });
    }

    // 3. Atualiza o status dos envios pendentes para 'cancelled'
    const { error: sendsUpdateError } = await supabase
      .from('scheduled_sends')
      .update({ status: 'cancelled' })
      .eq('followup_plan_id', planId)
      .eq('status', 'pending');

    if (sendsUpdateError) {
      console.error('[CancelPlan API] Error updating scheduled sends:', sendsUpdateError);
      // O plano já foi cancelado, mas os envios não. Isso pode exigir atenção manual.
      // Por enquanto, retornamos sucesso, mas logamos o erro.
    }

    return NextResponse.json({ success: true });

  } catch (err) {
    return toErrorResponse(err);
  }
}
