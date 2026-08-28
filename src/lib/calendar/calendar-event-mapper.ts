import type { calendar_v3 } from 'googleapis';
import type { Appointment } from '@/types';
import type { CalendarEvent } from './calendar-event';

/**
 * Turns a wacrm Appointment into the provider-agnostic shape
 * CalendarProvider implementations consume. Combines scheduled_date +
 * scheduled_time into a local ISO instant; an appointment with no
 * time maps to an all-day event. scheduled_end_time (migration 046),
 * when present, maps straight to endAt — otherwise providers fall
 * back to their own default duration, per CalendarEvent's doc comment.
 */
export function mapAppointmentToCalendarEvent(appointment: Appointment): CalendarEvent {
  const allDay = !appointment.scheduled_time;
  const startAt = allDay
    ? `${appointment.scheduled_date}T00:00:00`
    : `${appointment.scheduled_date}T${appointment.scheduled_time}`;
  const endAt =
    !allDay && appointment.scheduled_end_time
      ? `${appointment.scheduled_date}T${appointment.scheduled_end_time}`
      : null;

  return {
    title: appointment.title,
    description:
      [appointment.description, appointment.notes].filter(Boolean).join('\n\n') || null,
    startAt,
    endAt,
    allDay,
  };
}

/** The subset of an Appointment's columns the inbound (Google → CRM)
 *  sync path is willing to overwrite from a Google event — see
 *  `mapGoogleEventToAppointmentFields`'s doc comment for why this is
 *  deliberately narrower than the full Appointment shape. */
export interface GoogleEventAppointmentFields {
  title: string;
  description: string | null;
  scheduled_date: string;
  scheduled_time: string | null;
  scheduled_end_time: string | null;
}

// This app has exactly one implicit business timezone — every
// scheduled_date/scheduled_time in `appointments` is already a Brazil
// wall-clock value with no timezone column of its own (see
// SERVER_TIME_ZONE's doc comment in google-calendar-provider.ts, the
// CRM → Google push's equivalent assumption). Deliberately a fixed
// constant, NOT `event.start.timeZone`/`event.end.timeZone` from the
// payload: a real specimen (an appointment created before this fix,
// pushed to Google while a production instance's ambient clock
// resolved to UTC) shows Google echoing back `dateTime` with the
// *correct* "-03:00" offset alongside a *stale* `timeZone: "UTC"`
// label — the two fields had drifted apart. The offset embedded in
// `dateTime` is what unambiguously pins the absolute instant (that
// part is never in question); trusting the sibling `timeZone` string
// on top of it would have re-introduced a 3h error on exactly the
// corrupted rows this fix needs to repair. Rendering into this fixed
// zone instead sidesteps that field entirely.
const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

/**
 * Converts an absolute instant into `YYYY-MM-DD` / `HH:mm:ss` wall-
 * clock parts in `BUSINESS_TIME_ZONE` — deliberately not the process's
 * own ambient/local getters (`Date#getHours` and friends), which
 * reflect whatever timezone the *host machine* happens to be
 * configured with. That's fine for a single long-lived dev box, but
 * production is not guaranteed to run every request on an instance
 * whose system clock is set to America/Sao_Paulo — one that resolves
 * to UTC reads the exact same Date 3h later, which is precisely the
 * "iPhone events land 3h ahead" bug this fixes: an event timed 23:00
 * Brazil is the instant 2026-08-29T02:00Z, and a host reading that
 * instant with its own UTC clock reports "02:00" — the wrong value
 * that was landing in `appointments`. Using an explicit timezone here
 * makes the result deterministic regardless of the server's own
 * ambient configuration.
 */
function splitInBusinessTimeZone(date: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23', // avoid the well-known Intl footgun where
    // `hour12: false` alone can render midnight as "24" instead of "00"
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

/**
 * Turns a Google Calendar event into the Appointment fields the
 * inbound sync path (src/lib/calendar/inbound-sync-service.ts) is
 * willing to write. Deliberately narrower than the full Appointment
 * shape — a Google event has no concept of `contact_id`, `client_name`,
 * `property_id`, `type`, or `notes`, so those CRM-only fields are never
 * touched by an inbound update, only set once (to their defaults) when
 * an event with no matching appointment is first created.
 *
 * Returns `null` for an event with no usable start (e.g. a
 * working-location/out-of-office entry with a non-standard shape) —
 * nothing to sync.
 */
export function mapGoogleEventToAppointmentFields(
  event: calendar_v3.Schema$Event,
): GoogleEventAppointmentFields | null {
  const start = event.start;
  if (!start) return null;

  const title = event.summary?.trim() || '(Sem título)';
  const description = event.description ?? null;

  if (start.date) {
    // All-day event — Google's date-only start needs no timezone
    // conversion, unlike a timed dateTime below.
    return {
      title,
      description,
      scheduled_date: start.date,
      scheduled_time: null,
      scheduled_end_time: null,
    };
  }
  if (!start.dateTime) return null;

  const { date: scheduled_date, time: scheduled_time } = splitInBusinessTimeZone(
    new Date(start.dateTime),
  );

  let scheduled_end_time: string | null = null;
  if (event.end?.dateTime) {
    const endParts = splitInBusinessTimeZone(new Date(event.end.dateTime));
    // Appointment has no separate end-date column (scheduled_end_time
    // is "same day as scheduled_time" — see the Appointment type's doc
    // comment), so an end that spills onto a later local day is
    // dropped rather than misrepresented as an earlier time that day.
    if (endParts.date === scheduled_date) {
      scheduled_end_time = endParts.time;
    }
  }

  return { title, description, scheduled_date, scheduled_time, scheduled_end_time };
}
