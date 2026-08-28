import { google, type calendar_v3 } from 'googleapis';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildAuthorizedOAuth2Client, type StoredConnection } from './google-calendar-provider';
import { mapGoogleEventToAppointmentFields } from './calendar-event-mapper';

// Bounds the very first (no-syncToken) listing so reconnecting — or a
// stale/expired sync token forcing a resync, see the 410 branch below
// — doesn't import years of unrelated calendar history into
// appointments. Google's incremental sync then tracks forward from
// this window on every later call.
const INITIAL_SYNC_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Upper bound on the same initial listing. Without this, `singleEvents:
// true` expands a yearly-recurring event with no end date (a birthday,
// for instance) into one row per future occurrence with no cap —
// observed pulling instances 30 years out on a single sync. A year
// comfortably covers any real near-term appointment; a recurring
// instance further out than this is simply never listed by the
// syncToken this establishes (Google's incremental sync only returns
// *changes* within the window a token was created with — the window
// doesn't roll forward on its own as time passes). That instance only
// starts syncing once something re-establishes the token with a
// window that includes it (a reconnect, or the sync token going stale
// and forcing a resync) — an acceptable gap for a booking calendar
// where appointments aren't made a year+ out.
const INITIAL_SYNC_LOOKAHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export interface CalendarConnectionForSync extends StoredConnection {
  account_id: string;
  user_id: string;
  sync_token: string | null;
}

/**
 * Pulls whatever changed on the connection's Google Calendar since the
 * last call (via Calendar's syncToken incremental-sync protocol) and
 * applies it to `appointments`. Entry point for both the push webhook
 * (src/app/api/calendar/google/webhook/route.ts) and the one-time
 * initial sync run right after a connection is created (see the
 * OAuth callback route).
 */
export async function processConnectionChanges(
  db: SupabaseClient,
  connection: CalendarConnectionForSync,
): Promise<void> {
  const oauth2Client = buildAuthorizedOAuth2Client(db, connection.user_id, connection);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  await syncPages(db, calendar, connection, connection.sync_token);
}

async function syncPages(
  db: SupabaseClient,
  calendar: calendar_v3.Calendar,
  connection: CalendarConnectionForSync,
  syncToken: string | null,
  pageToken?: string,
): Promise<void> {
  const params: calendar_v3.Params$Resource$Events$List = {
    calendarId: 'primary',
    singleEvents: true, // expand recurring events into per-instance rows
    pageToken,
  };
  if (syncToken) {
    params.syncToken = syncToken;
  } else {
    params.timeMin = new Date(Date.now() - INITIAL_SYNC_LOOKBACK_MS).toISOString();
    params.timeMax = new Date(Date.now() + INITIAL_SYNC_LOOKAHEAD_MS).toISOString();
  }

  let response;
  try {
    response = await calendar.events.list(params);
  } catch (err) {
    if (syncToken && isGoneError(err)) {
      // Google requires a full resync when the sync token has expired
      // or become invalid — clear it and start over.
      console.warn('[calendar] sync token invalid/expired, doing a full resync');
      await db.from('calendar_connections').update({ sync_token: null }).eq('user_id', connection.user_id);
      return syncPages(db, calendar, connection, null);
    }
    throw err;
  }

  for (const event of response.data.items ?? []) {
    await applyIncomingEvent(db, connection, event);
  }

  if (response.data.nextPageToken) {
    return syncPages(db, calendar, connection, syncToken, response.data.nextPageToken);
  }

  if (response.data.nextSyncToken) {
    const { error } = await db
      .from('calendar_connections')
      .update({ sync_token: response.data.nextSyncToken })
      .eq('user_id', connection.user_id);
    if (error) console.error('[calendar] failed to persist sync token:', error);
  }
}

function isGoneError(err: unknown): boolean {
  const status =
    (err as { code?: number })?.code ?? (err as { response?: { status?: number } })?.response?.status;
  return status === 410;
}

interface ExistingAppointment {
  id: string;
  status: string;
  external_calendar_etag: string | null;
}

async function applyIncomingEvent(
  db: SupabaseClient,
  connection: CalendarConnectionForSync,
  event: calendar_v3.Schema$Event,
): Promise<void> {
  if (!event.id) return;

  const { data: existing, error: findError } = await db
    .from('appointments')
    .select('id, status, external_calendar_etag')
    .eq('account_id', connection.account_id)
    .eq('external_calendar_id', event.id)
    .maybeSingle<ExistingAppointment>();
  if (findError) {
    console.error('[calendar] failed to look up appointment for event', event.id, findError);
    return;
  }

  if (event.status === 'cancelled') {
    // Nothing to cancel (never synced to CRM, or already cancelled —
    // also covers the CRM-initiated delete's own echo, since that
    // flow already hard-deletes the appointment before this can run).
    if (!existing || existing.status === 'cancelled') return;
    const { error } = await db
      .from('appointments')
      .update({ status: 'cancelled', sync_status: 'synced', last_synced_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) console.error('[calendar] failed to cancel appointment for event', event.id, error);
    return;
  }

  // Echo guard — this exact Google-side state is what CRM already
  // pushed or pulled last, so there's nothing new to apply. Prevents a
  // CRM → Google push (CalendarSyncService.sync) from bouncing back
  // through this webhook and clobbering CRM-only fields (notes,
  // contact_id, client_name, type, property_id) that a Google event
  // has no concept of.
  if (existing?.external_calendar_etag && event.etag && existing.external_calendar_etag === event.etag) {
    return;
  }

  const fields = mapGoogleEventToAppointmentFields(event);
  if (!fields) return; // no usable start — nothing to sync

  const common = {
    ...fields,
    external_calendar_etag: event.etag ?? null,
    sync_status: 'synced' as const,
    last_synced_at: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await db.from('appointments').update(common).eq('id', existing.id);
    if (error) console.error('[calendar] failed to update appointment for event', event.id, error);
    return;
  }

  // No matching appointment — this event was created directly on
  // Google Calendar (iPhone, Web, Android — all funnel through the
  // same primary calendar CRM watches). Create one with sensible
  // CRM-only defaults; nothing in a Google event maps to
  // contact/client/property/type, so those stay unset until an agent
  // fills them in.
  const { error } = await db.from('appointments').insert({
    account_id: connection.account_id,
    user_id: connection.user_id,
    contact_id: null,
    client_name: null,
    property_id: null,
    type: 'other',
    status: 'scheduled',
    notes: null,
    external_calendar_id: event.id,
    ...common,
  });
  if (error) console.error('[calendar] failed to create appointment for event', event.id, error);
}
