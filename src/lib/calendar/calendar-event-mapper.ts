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

/**
 * Formats a `Date` into naive local `YYYY-MM-DD` / `HH:mm:ss` parts
 * using its LOCAL getters — same convention as `toLocalIsoString` in
 * google-calendar-provider.ts (the process's own timezone, aka
 * SERVER_TIME_ZONE there). Duplicated rather than shared: it's three
 * lines, and the two directions (CRM → Google, Google → CRM) are
 * small enough that a shared module would be more ceremony than the
 * code it saves.
 */
function splitLocalDateTime(date: Date): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
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

  const { date: scheduled_date, time: scheduled_time } = splitLocalDateTime(
    new Date(start.dateTime),
  );

  let scheduled_end_time: string | null = null;
  if (event.end?.dateTime) {
    const endParts = splitLocalDateTime(new Date(event.end.dateTime));
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
