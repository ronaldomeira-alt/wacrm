import { describe, expect, it } from 'vitest';
import { mapGoogleEventToAppointmentFields } from './calendar-event-mapper';
import type { calendar_v3 } from 'googleapis';

describe('mapGoogleEventToAppointmentFields', () => {
  it('maps a timed event to local date/time parts', () => {
    const event: calendar_v3.Schema$Event = {
      summary: 'Visita ao imóvel',
      description: 'Levar as chaves',
      start: { dateTime: '2026-03-10T14:30:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      end: { dateTime: '2026-03-10T15:00:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
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
      start: { dateTime: '2026-03-10T23:00:00' },
      end: { dateTime: '2026-03-11T01:00:00' },
    };
    const result = mapGoogleEventToAppointmentFields(event);
    expect(result?.scheduled_end_time).toBeNull();
  });

  it('falls back to a placeholder title when summary is missing', () => {
    const event: calendar_v3.Schema$Event = {
      start: { dateTime: '2026-03-10T09:00:00' },
    };
    const result = mapGoogleEventToAppointmentFields(event);
    expect(result?.title).toBe('(Sem título)');
  });

  it('returns null for an event with no usable start', () => {
    const event: calendar_v3.Schema$Event = { summary: 'Sem início' };
    expect(mapGoogleEventToAppointmentFields(event)).toBeNull();
  });
});
