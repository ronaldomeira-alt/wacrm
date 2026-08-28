/**
 * Diagnostic: compare what calendar.events.list() (the exact call the
 * inbound sync makes) returns for these events vs calendar.events.get().
 * Read-only.
 *
 * Usage: npx tsx --env-file=.env.local scripts/inspect-google-events-list.ts
 */
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import { buildAuthorizedOAuth2Client, type StoredConnection } from '../src/lib/calendar/google-calendar-provider';
import { mapGoogleEventToAppointmentFields } from '../src/lib/calendar/calendar-event-mapper';

const TARGET_IDS = new Set([
  '_8h0kad1i6ssk8ba3712k6b9k68q48ba26oskcb9p611jae9m70qjid1i8k', // Novo novo teste iphone
  '_8oqkaca274sjcb9k8h148b9k8opk6ba28csk8b9g6crkae9j88p34di684', // Testando iphone
  '_611jgc9p6gsk8ba36sq3gb9k88s42ba16ookaba26spj4ghk6gsjcca18g', // Teste pelo iphone
  '4jdjo04v3rmg8l7s1m4o7fjnc2', // teste novo pc
]);

async function main() {
  console.log('Local machine resolved timezone:', Intl.DateTimeFormat().resolvedOptions().timeZone);
  console.log('process.env.TZ:', process.env.TZ);

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data: connection, error } = await db
    .from('calendar_connections')
    .select('user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at')
    .single();
  if (error) throw error;

  const oauth2Client = buildAuthorizedOAuth2Client(db, connection.user_id, connection as StoredConnection);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const { data } = await calendar.events.list({
    calendarId: 'primary',
    singleEvents: true,
    timeMin: new Date('2026-08-27T00:00:00Z').toISOString(),
    timeMax: new Date('2026-08-30T00:00:00Z').toISOString(),
  });

  for (const event of data.items ?? []) {
    if (!event.id || !TARGET_IDS.has(event.id)) continue;
    console.log(`\n=== ${event.id} (${event.summary}) ===`);
    console.log('raw start:', JSON.stringify(event.start));
    console.log('raw end:', JSON.stringify(event.end));
    console.log('etag:', event.etag);
    console.log('mapped fields:', JSON.stringify(mapGoogleEventToAppointmentFields(event)));
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
