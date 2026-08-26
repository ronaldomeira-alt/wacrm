import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

// Função auxiliar para adicionar dias a uma data
function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await requireRole('agent')

    const body = await request.json().catch(() => null)
    const mode = body?.mode
    if (mode !== 'template') {
      return bad('Invalid mode')
    }

    const { data: existing, error: fetchError } = await supabase
      .from('ai_suggestions')
      .select('id, category, status, payload, contact_id, conversation_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()

    if (fetchError) return bad('Failed to load suggestion', 500)
    if (!existing) return bad('Not found', 404)
    if (existing.category !== 'followup') return bad('Suggestion is not a follow-up')
    if (existing.status === 'done') {
      return NextResponse.json({ success: true, already_done: true })
    }

    if (body?.planData) {
      const { planData } = body;
      const { data: plan, error: planError } = await supabase.from('followup_plans').insert({
        account_id: accountId,
        contact_id: existing.contact_id,
        conversation_id: existing.conversation_id,
        plan_data: planData,
        status: 'active',
      }).select().single();

      if (planError || !plan) {
        console.error('[followup complete] plan insert error:', planError)
        return bad('Failed to save followup plan', 500)
      }

      const sendsToCreate = [];
      const now = new Date();
      let contact1SendAt = now;

      if (planData.contact1 && planData.contact1.scheduleDays > 0) {
        contact1SendAt = addDays(now, planData.contact1.scheduleDays);
        sendsToCreate.push({
          account_id: accountId,
          contact_id: existing.contact_id,
          followup_plan_id: plan.id,
          send_at: contact1SendAt.toISOString(),
          template_name: planData.contact1.template_name,
          template_language: 'pt_BR', // Assumindo pt_BR, idealmente viria do template
          template_params: { values: planData.contact1.values },
        });
      }

      if (planData.contact2 && planData.contact2.scheduleDays > 0) {
        const contact2SendAt = addDays(contact1SendAt, planData.contact2.scheduleDays);
        sendsToCreate.push({
          account_id: accountId,
          contact_id: existing.contact_id,
          followup_plan_id: plan.id,
          send_at: contact2SendAt.toISOString(),
          template_name: planData.contact2.template_name,
          template_language: 'pt_BR',
          template_params: { values: planData.contact2.values },
        });
      }

      if (sendsToCreate.length > 0) {
        const { error: sendsError } = await supabase.from('scheduled_sends').insert(sendsToCreate);
        if (sendsError) {
           console.error('[followup complete] scheduled sends insert error:', sendsError)
           return bad('Failed to schedule followup sends', 500)
        }
      }
    }

    const { error: suggestionUpdateError } = await supabase
      .from('ai_suggestions')
      .update({ status: 'done', resolved_by: userId, resolved_at: new Date().toISOString() })
      .eq('id', id)

    if (suggestionUpdateError) {
      console.error('[followup complete] suggestion update error:', suggestionUpdateError)
      return bad('Failed to record the follow-up', 500)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
