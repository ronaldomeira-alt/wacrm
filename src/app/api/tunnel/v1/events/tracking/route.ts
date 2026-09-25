import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/push/admin-client';
import { recordTrackingEvent } from '@/lib/match/service';

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      tracking_token?: string;
      event_name?: 'public_link.opened' | 'public_related_property.opened' | 'public_interest.clicked';
      related_property_id?: string;
      timestamp?: string;
    } | null;

    if (!body?.tracking_token || !body?.event_name) {
      return NextResponse.json(
        { error: 'tracking_token e event_name são obrigatórios' },
        { status: 400 }
      );
    }

    const validEvents = [
      'public_link.opened',
      'public_related_property.opened',
      'public_interest.clicked',
    ];

    if (!validEvents.includes(body.event_name)) {
      return NextResponse.json({ error: 'event_name inválido' }, { status: 400 });
    }

    const db = supabaseAdmin();
    const result = await recordTrackingEvent(db, {
      trackingToken: body.tracking_token,
      eventName: body.event_name,
      relatedPropertyId: body.related_property_id || null,
      timestamp: body.timestamp,
    });

    if (!result.success) {
      return NextResponse.json({ error: 'Token não encontrado ou expirado' }, { status: 404 });
    }

    return NextResponse.json({ success: true, share_id: result.shareId });
  } catch (err) {
    console.error('[POST /api/tunnel/v1/events/tracking] Erro interno:', err);
    return NextResponse.json({ error: 'Erro ao processar evento de tracking' }, { status: 500 });
  }
}
