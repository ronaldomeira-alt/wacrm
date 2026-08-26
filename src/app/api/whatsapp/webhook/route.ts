import { NextResponse, after } from 'next/server'
// ... outros imports

// NOVA FUNÇÃO para cancelar o plano de follow-up
async function cancelFollowupIfActive(accountId: string, contactId: string) {
  try {
    const admin = supabaseAdmin();
    const { data: activePlan, error: planError } = await admin
      .from('followup_plans')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'active')
      .maybeSingle();

    if (planError) {
      console.error('[cancelFollowup] Error fetching active plan:', planError);
      return;
    }

    if (activePlan) {
      // Cancela o plano
      await admin.from('followup_plans').update({ status: 'cancelled' }).eq('id', activePlan.id);

      // Cancela os envios agendados pendentes para este plano
      await admin
        .from('scheduled_sends')
        .update({ status: 'cancelled' })
        .eq('followup_plan_id', activePlan.id)
        .eq('status', 'pending');

      console.log(`Follow-up plan ${activePlan.id} cancelled for contact ${contactId}`);
    }
  } catch (err) {
    console.error('[cancelFollowup] Unexpected error:', err);
  }
}

async function processMessage(
  // ... parâmetros existentes
) {
  // ... (lógica existente de findOrCreateContact e findOrCreateConversation)
  const contactRecord = contactOutcome.contact;
  const conversation = convResult.conversation;

  // Adiciona a chamada para cancelar o follow-up
  await cancelFollowupIfActive(accountId, contactRecord.id);

  // ... (restante da lógica de processMessage)
}

// ... (restante do arquivo webhook/route.ts)
