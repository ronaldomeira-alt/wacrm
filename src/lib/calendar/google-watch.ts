import crypto from 'crypto';
import { google, type Auth } from 'googleapis';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encrypt } from '@/lib/whatsapp/encryption';

// Google doesn't document a precise, reliable default TTL for
// Events.watch channels — rather than depend on whatever Google
// happens to pick, every channel we register requests an explicit
// expiration and GET /api/calendar/google/watch-cron renews any
// channel within RENEW_WITHIN_MS of it, well before it can lapse.
const WATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function webhookUrl(baseUrl: string): string {
  return `${baseUrl}/api/calendar/google/webhook`;
}

export interface WatchRegistration {
  channelId: string;
  resourceId: string;
  expiresAt: string;
}

/**
 * Registers a Calendar Events.watch push-notification channel for the
 * caller's `primary` calendar (the same calendar CRM → Google push
 * writes to — see google-calendar-provider.ts), and persists the
 * bookkeeping onto their `calendar_connections` row (migration 084).
 *
 * Google has no in-place "renew" operation, only "create a new
 * channel" — so this always mints a fresh channel id/token. If the
 * connection already had a channel registered, the old one is stopped
 * (best-effort, after the new one is confirmed) so Google isn't left
 * calling back on two channels for the same connection.
 */
export async function registerWatchChannel(
  db: SupabaseClient,
  userId: string,
  oauth2Client: Auth.OAuth2Client,
  baseUrl: string,
): Promise<WatchRegistration> {
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const channelId = crypto.randomUUID();
  const channelToken = crypto.randomBytes(24).toString('hex');
  const expiration = Date.now() + WATCH_TTL_MS;

  const { data: previous } = await db
    .from('calendar_connections')
    .select('channel_id, resource_id')
    .eq('user_id', userId)
    .maybeSingle<{ channel_id: string | null; resource_id: string | null }>();

  const { data } = await calendar.events.watch({
    calendarId: 'primary',
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: webhookUrl(baseUrl),
      token: channelToken,
      expiration: String(expiration),
    },
  });

  if (!data.resourceId) {
    throw new Error('Google accepted the watch request but returned no resourceId.');
  }

  const expiresAt = data.expiration
    ? new Date(Number(data.expiration)).toISOString()
    : new Date(expiration).toISOString();

  const { error } = await db
    .from('calendar_connections')
    .update({
      channel_id: channelId,
      resource_id: data.resourceId,
      channel_token_encrypted: encrypt(channelToken),
      channel_expires_at: expiresAt,
    })
    .eq('user_id', userId);
  if (error) throw error;

  if (previous?.channel_id && previous.resource_id && previous.channel_id !== channelId) {
    await stopWatchChannel(oauth2Client, previous.channel_id, previous.resource_id).catch((err) => {
      console.warn('[calendar] failed to stop previous watch channel (non-fatal):', err);
    });
  }

  return { channelId, resourceId: data.resourceId, expiresAt };
}

/** Tells Google to stop delivering notifications for one channel. Used
 *  when replacing a channel on renewal — see `registerWatchChannel`
 *  above. Not called on disconnect: the row is simply deleted there,
 *  and an orphaned channel self-heals (the webhook no-ops on an
 *  unknown channel_id, and it stops firing once its own TTL lapses). */
export async function stopWatchChannel(
  oauth2Client: Auth.OAuth2Client,
  channelId: string,
  resourceId: string,
): Promise<void> {
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  await calendar.channels.stop({ requestBody: { id: channelId, resourceId } });
}
