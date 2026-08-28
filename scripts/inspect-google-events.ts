/**
 * Diagnostic: fetch raw Google Calendar event JSON for specific event
 * ids to inspect exactly what `start`/`end`/`dateTime`/`timeZone` Google
 * returns, comparing an iPhone-created event against a Google-Calendar-
 * created one. Read-only — makes no writes.
 *
 * Usage: npx tsx --env-file=.env.local scripts/inspect-google-events.ts
 */
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import { buildAuthorizedOAuth2Client, type StoredConnection } from '../src/lib/calendar/google-calendar-provider';

const EVENT_IDS = [
  // "Novo novo teste iphone" — CRM shows 19:00-21:00, iPhone set 16:00-18:00
  '_8h0kad1i6ssk8ba3712k6b9k68q48ba26oskcb9p611jae9m70qjid1i8k',
  // "Testando iphone" — CRM shows 29/08 02:00-03:00, iPhone set 28/08 23:00-00:00
  '_8oqkaca274sjcb9k8h148b9k8opk6ba28csk8b9g6crkae9j88p34di684',
  // "Teste pelo iphone" — for comparison
  '_611jgc9p6gsk8ba36sq3gb9k88s42ba16ookaba26spj4ghk6gsjcca18g',
  // "teste novo pc" (Google Calendar Web-created) — known-good baseline
  '4jdjo04v3rmg8l7s1m4o7fjnc2',
];

async function main() {
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

  for (const eventId of EVENT_IDS) {
    console.log(`\n=== ${eventId} ===`);
    try {
      const { data } = await calendar.events.get({ calendarId: 'primary', eventId });
      console.log(JSON.stringify({
        summary: data.summary,
        start: data.start,
        end: data.end,
        created: data.created,
        updated: data.updated,
        source: data.source,
        organizer: data.organizer,
        iCalUID: data.iCalUID,
      }, null, 2));
    } catch (err) {
      console.error('FAILED:', err);
    }
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
