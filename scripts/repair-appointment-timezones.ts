/**
 * One-off repair for appointments imported before the timezone fix in
 * calendar-event-mapper.ts (splitInBusinessTimeZone): events synced
 * while a production instance's ambient clock resolved to a timezone
 * other than Brazil landed with the wrong scheduled_date/time
 * (observed: iPhone/CalDAV-originated events off by exactly the host's
 * UTC offset, e.g. +3h for America/Sao_Paulo).
 *
 * Re-fetches each affected appointment's Google event directly and
 * recomputes its fields with the fixed mapper, bypassing the normal
 * echo-guard (which would otherwise skip these — the Google-side etag
 * hasn't changed since the bad import, so a plain resync doesn't touch
 * them). Only writes rows whose recomputed value actually differs.
 *
 * Deliberately scoped to appointments *created by* inbound sync, never
 * ones authored in the CRM and pushed outward: a CRM-authored
 * appointment's `scheduled_time` is the agent's original input, never
 * overwritten by any inbound read — if its Google mirror is itself off
 * (a pre-existing, separate bug on the *outbound* push, out of scope
 * here), recomputing from that mirror would destroy correct CRM data
 * with a corrupted value instead of fixing anything. Inbound-created
 * rows are identified by the exact defaults `applyIncomingEvent` (see
 * inbound-sync-service.ts) always inserts: no contact/client/property
 * link, type 'other', no notes — fields a human filling out the
 * appointment form essentially never leaves *all* unset together.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/repair-appointment-timezones.ts          (dry run — reports only)
 *   APPLY=1 npx tsx --env-file=.env.local scripts/repair-appointment-timezones.ts  (writes the fixes)
 */
const APPLY = process.env.APPLY === '1';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import { buildAuthorizedOAuth2Client, type StoredConnection } from '../src/lib/calendar/google-calendar-provider';
import { mapGoogleEventToAppointmentFields } from '../src/lib/calendar/calendar-event-mapper';

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: connections, error: connError } = await db
    .from('calendar_connections')
    .select('user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at');
  if (connError) throw connError;

  for (const connection of connections ?? []) {
    const oauth2Client = buildAuthorizedOAuth2Client(db, connection.user_id, connection as StoredConnection);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const { data: appointments, error } = await db
      .from('appointments')
      .select('id, title, scheduled_date, scheduled_time, scheduled_end_time, external_calendar_id')
      .eq('user_id', connection.user_id)
      .not('external_calendar_id', 'is', null)
      // See the file-level comment: only rows inbound sync itself
      // created are safe to recompute from Google's data.
      .is('contact_id', null)
      .is('client_name', null)
      .is('property_id', null)
      .is('notes', null)
      .eq('type', 'other');
    if (error) throw error;

    let checked = 0;
    let fixed = 0;
    let missing = 0;

    for (const appt of appointments ?? []) {
      checked++;
      let event;
      try {
        const res = await calendar.events.get({ calendarId: 'primary', eventId: appt.external_calendar_id! });
        event = res.data;
      } catch (err) {
        missing++;
        console.warn(`[skip] ${appt.title} (${appt.id}) — event fetch failed:`, (err as Error).message);
        continue;
      }

      const fields = mapGoogleEventToAppointmentFields(event);
      if (!fields) continue;

      const changed =
        fields.scheduled_date !== appt.scheduled_date ||
        fields.scheduled_time !== appt.scheduled_time ||
        fields.scheduled_end_time !== appt.scheduled_end_time;

      if (!changed) continue;

      console.log(
        `[${APPLY ? 'fix' : 'would fix'}] ${appt.title} (${appt.id}): ` +
          `${appt.scheduled_date} ${appt.scheduled_time ?? 'all-day'}–${appt.scheduled_end_time ?? ''} ` +
          `-> ${fields.scheduled_date} ${fields.scheduled_time ?? 'all-day'}–${fields.scheduled_end_time ?? ''}`,
      );

      if (APPLY) {
        const { error: updateError } = await db
          .from('appointments')
          .update({
            scheduled_date: fields.scheduled_date,
            scheduled_time: fields.scheduled_time,
            scheduled_end_time: fields.scheduled_end_time,
            external_calendar_etag: event.etag ?? null,
          })
          .eq('id', appt.id);
        if (updateError) {
          console.error(`[error] failed to update ${appt.id}:`, updateError);
          continue;
        }
      }
      fixed++;
    }

    console.log(`\nUser ${connection.user_id}: checked ${checked}, fixed ${fixed}, missing ${missing}`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
