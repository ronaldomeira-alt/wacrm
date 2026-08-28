import { NextResponse, after } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/calendar/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { processConnectionChanges, type CalendarConnectionForSync } from '@/lib/calendar/inbound-sync-service';

/**
 * POST /api/calendar/google/webhook
 *
 * Google's Events.watch push-notification target (registered by
 * src/lib/calendar/google-watch.ts). Google calls this directly, with
 * no wacrm session — src/middleware.ts doesn't gate `/api/calendar/*`
 * at all, so authenticity here rests entirely on the
 * `X-Goog-Channel-Token` header matching the per-connection secret
 * minted at registration time (channel_token_encrypted).
 *
 * The notification body carries no event data (Calendar's watch API
 * only ever says "something changed, go look"), so every call that
 * isn't the one-time `sync` handshake triggers a syncToken-based
 * incremental fetch (see inbound-sync-service.ts). Google expects a
 * fast ack; the actual sync runs in `after()` so it isn't cut short if
 * the function is frozen right after the response is sent — same
 * reasoning as the WhatsApp webhook (see that route's comment on
 * issue #301).
 */
export async function POST(request: Request) {
  const channelId = request.headers.get('x-goog-channel-id');
  const resourceState = request.headers.get('x-goog-resource-state');
  const suppliedToken = request.headers.get('x-goog-channel-token') ?? '';

  if (!channelId) {
    return NextResponse.json({ error: 'Missing X-Goog-Channel-Id' }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: connection, error } = await db
    .from('calendar_connections')
    .select(
      'account_id, user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, channel_token_encrypted, sync_token',
    )
    .eq('channel_id', channelId)
    .maybeSingle<CalendarConnectionForSync & { channel_token_encrypted: string | null }>();

  if (error) {
    console.error('[calendar/google/webhook] lookup failed:', error);
    return NextResponse.json({ error: 'lookup failed' }, { status: 500 });
  }
  if (!connection) {
    // Unknown/stale channel — a disconnected account, or a channel
    // Google hasn't stopped calling yet after we replaced it on
    // renewal. Ack 200 so Google doesn't retry forever.
    console.warn('[calendar/google/webhook] unknown channel id:', channelId);
    return NextResponse.json({ status: 'ignored' });
  }

  const expectedToken = connection.channel_token_encrypted
    ? decrypt(connection.channel_token_encrypted)
    : '';
  const suppliedBuf = Buffer.from(suppliedToken);
  const expectedBuf = Buffer.from(expectedToken);
  if (
    !expectedToken ||
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    console.warn('[calendar/google/webhook] channel token mismatch');
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }

  // `sync` is the one-time handshake Google sends right when a channel
  // is created — no changes to fetch yet.
  if (resourceState === 'sync') {
    return NextResponse.json({ status: 'sync_ack' });
  }

  after(async () => {
    try {
      await processConnectionChanges(db, connection);
    } catch (err) {
      console.error('[calendar/google/webhook] sync failed:', err);
    }
  });

  return NextResponse.json({ status: 'received' });
}
