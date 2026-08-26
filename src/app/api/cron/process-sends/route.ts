import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/client' // Usando client-side para simplicidade, ideal seria server-side
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';

// Rota para ser chamada pelo cron-job.org
export async function POST(request: Request) {
  const CRON_SECRET = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createClient();
  const now = new Date().toISOString();

  const { data: pendingSends, error: fetchError } = await supabase
    .from('scheduled_sends')
    .select('*, account:accounts(whatsapp_config(*)) ')
    .eq('status', 'pending')
    .lte('send_at', now);

  if (fetchError) {
    console.error('Cron: Failed to fetch pending sends', fetchError);
    return NextResponse.json({ error: 'Failed to fetch sends' }, { status: 500 });
  }

  for (const send of pendingSends) {
    const config = send.account?.whatsapp_config?.[0];
    if (!config) {
      await supabase.from('scheduled_sends').update({ status: 'failed', error_message: 'WhatsApp config not found' }).eq('id', send.id);
      continue;
    }

    try {
        // Acessar contato para obter o número de telefone
        const { data: contact } = await supabase.from('contacts').select('phone').eq('id', send.contact_id).single();
        if(!contact || !contact.phone){
             await supabase.from('scheduled_sends').update({ status: 'failed', error_message: 'Contact phone not found' }).eq('id', send.id);
             continue;
        }

      await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
        to: contact.phone,
        templateName: send.template_name,
        language: send.template_language,
        params: send.template_params.values.body,
      });

      await supabase.from('scheduled_sends').update({ status: 'sent', processed_at: new Date().toISOString() }).eq('id', send.id);

    } catch (e: unknown) {
      console.error('Cron: Failed to send message', e);
      await supabase.from('scheduled_sends').update({ status: 'failed', error_message: (e instanceof Error ? e.message : String(e)) }).eq('id', send.id);
    }
  }

  return NextResponse.json({ success: true, processed: pendingSends.length });
}
