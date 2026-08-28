import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/calendar/admin-client';
import { buildAuthorizedOAuth2Client, type StoredConnection } from '@/lib/calendar/google-calendar-provider';
import { registerWatchChannel } from '@/lib/calendar/google-watch';
import { getBaseUrl } from '@/lib/http/base-url';

// Renew any channel expiring within this window — comfortably inside
// the 7-day TTL google-watch.ts requests, so a daily/hourly pinger
// (see .env.local.example) never lets one lapse even with occasional
// missed ticks.
const RENEW_WITHIN_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * GET /api/calendar/google/watch-cron
 *
 * Renews Google Calendar Events.watch push-notification channels
 * before they expire (registerWatchChannel/google-watch.ts) and
 * registers one for any connection that doesn't have one yet (e.g. the
 * initial registration failed at connect time — see the callback
 * route's comment). Same shared-secret pattern as the other external
 * pingers in this codebase (GET /api/envios/cron, GET
 * /api/automations/cron) — deliberately outside `/api/whatsapp/*`,
 * which requires a user session.
 */
export async function GET(request: Request) {
  const expected = process.env.GOOGLE_CALENDAR_WATCH_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = supabaseAdmin();
  const cutoff = new Date(Date.now() + RENEW_WITHIN_MS).toISOString();
  const { data: connections, error } = await db
    .from('calendar_connections')
    .select('user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at')
    .or(`channel_expires_at.is.null,channel_expires_at.lt.${cutoff}`);
  if (error) {
    console.error('[calendar/watch-cron] failed to list connections:', error);
    return NextResponse.json({ error: 'lookup failed' }, { status: 500 });
  }

  const baseUrl = getBaseUrl(request);
  let renewed = 0;
  let failed = 0;
  for (const connection of (connections ?? []) as (StoredConnection & { user_id: string })[]) {
    try {
      const oauth2Client = buildAuthorizedOAuth2Client(db, connection.user_id, connection);
      await registerWatchChannel(db, connection.user_id, oauth2Client, baseUrl);
      renewed++;
    } catch (err) {
      failed++;
      console.error('[calendar/watch-cron] failed to renew channel for user', connection.user_id, err);
    }
  }

  return NextResponse.json({ renewed, failed, checked: connections?.length ?? 0 });
}
