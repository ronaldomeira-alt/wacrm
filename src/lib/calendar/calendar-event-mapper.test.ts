import { describe, expect, it } from 'vitest';
import { mapGoogleEventToAppointmentFields } from './calendar-event-mapper';
import type { calendar_v3 } from 'googleapis';

describe('mapGoogleEventToAppointmentFields', () => {
  it('maps a timed event to date/time parts in the business timezone (America/Sao_Paulo)', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Visita ao imóvel',
      description: 'Levar as chaves',
      start: { dateTime: '2026-03-10T14:30:00-03:00', timeZone: 'America/Sao_Paulo' },
      end: { dateTime: '2026-03-10T15:00:00-03:00', timeZone: 'America/Sao_Paulo' },
    };
    const result = mapGoogleEventToAppointmentFields(event);
    expect(result).toEqual({
      title: 'Visita ao imóvel',
      description: 'Levar as chaves',
      scheduled_date: '2026-03-10',
      scheduled_time: '14:30:00',
      scheduled_end_time: '15:00:00',
    });
  });

  // Regression test for the "iPhone events land 3h ahead" bug: reading
  // an event's time must depend only on the UTC offset embedded in its
  // `dateTime` (which unambiguously pins the absolute instant), never
  // on the timezone the machine running this code happens to be
  // configured with. `+14:00` is virtually guaranteed to differ from
  // the CI/dev machine's own ambient zone — if the conversion ever
  // regresses to ambient `Date#getHours`-style local getters, this is
  // the test that catches it regardless of where it runs.
  it('resolves the correct absolute instant from an extreme UTC offset, independent of the host machine\'s own timezone', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Reunião remota',
      // 2026-03-10T23:00:00+14:00 is the same instant as 2026-03-10T09:00:00Z,
      // which is 2026-03-10T06:00:00-03:00 in the business timezone.
      start: { dateTime: '2026-03-10T23:00:00+14:00', timeZone: 'Pacific/Kiritimati' },
    };
    const result = mapGoogleEventToAppointmentFields(event);
    expect(result?.scheduled_date).toBe('2026-03-10');
    expect(result?.scheduled_time).toBe('06:00:00');
  });

  // Regression test for a real corrupted specimen found in production:
  // an appointment created before this fix was pushed to Google while
  // a production instance's ambient clock resolved to UTC, so Google
  // stored `timeZone: "UTC"` even though the numeric offset in
  // `dateTime` (written from the correct wall-clock digits) is the
  // real, correct "-03:00". The two fields disagree; the mapper must
  // trust the unambiguous numeric offset and ignore the stale
  // `timeZone` label, or it re-introduces the same 3h error while
  // "fixing" it.
  it("trusts dateTime's own UTC offset over a stale/inconsistent timeZone label", () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Visita apto Kelly',
      start: { dateTime: '2026-08-31T10:00:00-03:00', timeZone: 'UTC' },
      end: { dateTime: '2026-08-31T10:30:00-03:00', timeZone: 'UTC' },
    };
    const result = mapGoogleEventToAppointmentFields(event);
    expect(result).toEqual({
      title: 'Visita apto Kelly',
      description: null,
      scheduled_date: '2026-08-31',
      scheduled_time: '10:00:00',
      scheduled_end_time: '10:30:00',
    });
  });

  it('maps an all-day event with no timezone conversion', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Fechamento de contrato',
      start: { date: '2026-03-10' },
      end: { date: '2026-03-11' },
    };
    const result = mapGoogleEventToAppointmentFields(event);
    expect(result).toEqual({
      title: 'Fechamento de contrato',
      description: null,
      scheduled_date: '2026-03-10',
      scheduled_time: null,
      scheduled_end_time: null,
    });
  });

  it('drops the end time when it spills onto a later local day', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Plantão noturno',
      start: { dateTime: '2026-03-10T23:00:00-03:00', timeZone: 'America/Sao_Paulo' },
      end: { dateTime: '2026-03-11T01:00:00-03:00', timeZone: 'America/Sao_Paulo' },
    };
    const result = mapGoogleEventToAppointmentFields(event);
    expect(result?.scheduled_date).toBe('2026-03-10');
    expect(result?.scheduled_time).toBe('23:00:00');
    expect(result?.scheduled_end_time).toBeNull();
  });

  it('falls back to a placeholder title when summary is missing', () => {
    const event: calendar_v3.Schema$Event = {
      start: { dateTime: '2026-03-10T09:00:00-03:00', timeZone: 'America/Sao_Paulo' },
    };
    const result = mapGoogleEventToAppointmentFields(event);
    expect(result?.title).toBe('(Sem título)');
  });

  it('returns null for an event with no usable start', () => {
    const event: calendar_v3.Schema$Event = { summary: 'Sem início' };
    expect(mapGoogleEventToAppointmentFields(event)).toBeNull();
  });
});
