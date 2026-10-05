import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { sendQualifiedLeadEvent } from '@/lib/whatsapp/meta-capi';

interface QualifyRequestBody {
  conversationId?: string;
  contactId?: string;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get('conversationId');
    const contactId = searchParams.get('contactId');

    if (!conversationId && !contactId) {
      return NextResponse.json(
        { error: 'conversationId ou contactId é obrigatório' },
        { status: 400 }
      );
    }

    let query = ctx.supabase
      .from('conversations')
      .select('id, contact_id, ctwa_referral, meta_capi_qualified_at')
      .eq('account_id', ctx.accountId);

    if (conversationId) {
      query = query.eq('id', conversationId);
    } else if (contactId) {
      query = query.eq('contact_id', contactId);
    }

    const { data: convs, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!convs || convs.length === 0) {
      return NextResponse.json({
        qualified_at: null,
        has_ctwa_clid: false,
        conversation_id: null,
      });
    }

    // Prioriza a conversa que tiver ctwa_clid
    const targetConv =
      convs.find((c) => {
        const referral = c.ctwa_referral as { ctwa_clid?: string } | null;
        return Boolean(referral?.ctwa_clid);
      }) || convs[0];

    const referral = targetConv.ctwa_referral as { ctwa_clid?: string } | null;

    return NextResponse.json({
      conversation_id: targetConv.id,
      contact_id: targetConv.contact_id,
      qualified_at: targetConv.meta_capi_qualified_at,
      has_ctwa_clid: Boolean(referral?.ctwa_clid),
      headline: (referral as { headline?: string } | null)?.headline || null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => ({}))) as QualifyRequestBody;
    const { conversationId, contactId } = body;

    if (!conversationId && !contactId) {
      return NextResponse.json(
        { error: 'conversationId ou contactId é obrigatório' },
        { status: 400 }
      );
    }

    let targetConvId = conversationId;

    if (!targetConvId && contactId) {
      const { data: convs, error } = await ctx.supabase
        .from('conversations')
        .select('id, ctwa_referral')
        .eq('contact_id', contactId)
        .eq('account_id', ctx.accountId)
        .order('last_message_at', { ascending: false, nullsFirst: false });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      if (!convs || convs.length === 0) {
        return NextResponse.json(
          { error: 'Nenhuma conversa encontrada para este contato' },
          { status: 404 }
        );
      }

      // Prioriza conversa com ctwa_clid se houver
      const withClid = convs.find((c) => {
        const ref = c.ctwa_referral as { ctwa_clid?: string } | null;
        return Boolean(ref?.ctwa_clid);
      });

      targetConvId = (withClid || convs[0]).id;
    }

    if (!targetConvId) {
      return NextResponse.json(
        { error: 'Identificador de conversa não localizado' },
        { status: 404 }
      );
    }

    const result = await sendQualifiedLeadEvent(
      ctx.supabase,
      ctx.accountId,
      targetConvId
    );

    if (result.sent) {
      const now = new Date().toISOString();
      return NextResponse.json({
        ok: true,
        sent: true,
        qualified_at: now,
        conversation_id: targetConvId,
      });
    }

    if (result.reason === 'no_ctwa_clid') {
      return NextResponse.json(
        {
          ok: false,
          sent: false,
          reason: 'no_ctwa_clid',
          error:
            'Este lead não possui identificador de clique de anúncio da Meta (ctwa_clid). O evento CAPI requer que o lead tenha vindo de um anúncio Click-to-WhatsApp.',
        },
        { status: 422 }
      );
    }

    if (result.reason === 'capi_not_configured') {
      return NextResponse.json(
        {
          ok: false,
          sent: false,
          reason: 'capi_not_configured',
          error:
            'Dataset da Meta Conversions API ou Access Token não configurados no painel de configurações do WhatsApp.',
        },
        { status: 422 }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        sent: false,
        reason: 'graph_api_error',
        error: result.detail || 'Erro ao comunicar com a Graph API da Meta.',
      },
      { status: 502 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
