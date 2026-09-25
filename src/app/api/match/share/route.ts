import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { createPropertyShare } from '@/lib/match/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      lead_id?: string;
      property_id?: string;
      match_id?: string;
      message_text?: string;
    } | null;

    if (!body?.lead_id || !body?.property_id) {
      return NextResponse.json(
        { error: 'lead_id e property_id são obrigatórios' },
        { status: 400 }
      );
    }

    const result = await createPropertyShare(ctx.supabase, {
      accountId: ctx.accountId,
      leadId: body.lead_id,
      propertyId: body.property_id,
      matchId: body.match_id || null,
      messageText: body.message_text || null,
    });

    if (!result) {
      return NextResponse.json(
        { error: 'Falha ao registrar envio e gerar token' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      share: result.share,
      publicUrl: result.publicUrl,
      waLink: result.waLink,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
