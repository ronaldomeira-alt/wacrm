import type { SupabaseClient } from '@supabase/supabase-js';
import type { Appointment } from '@/types';
import type { CalendarProvider } from './calendar-provider';
import { mapAppointmentToCalendarEvent } from './calendar-event-mapper';

/**
 * Orchestrates syncing one appointment to a CalendarProvider and
 * persisting the result (sync_status/external_calendar_id/
 * last_synced_at — migration 045).
 *
 * Called from `POST /api/calendar/sync` after an appointment is
 * created/updated (see appointment-form-dialog.tsx), using a
 * provider built by `createGoogleCalendarProviderForUser`. A failed
 * sync records sync_status = 'error' rather than throwing silently —
 * the appointment save itself already succeeded by the time this
 * runs, so a Google-side failure shouldn't look like the whole save
 * failed.
 */
export class CalendarSyncService {
  constructor(
    private readonly db: SupabaseClient,
    private readonly provider: CalendarProvider,
  ) {}

  async sync(appointment: Appointment): Promise<void> {
    const event = mapAppointmentToCalendarEvent(appointment);
    try {
      let externalId = appointment.external_calendar_id;
      let etag: string | null;
      if (externalId) {
        ({ etag } = await this.provider.updateEvent(externalId, event));
      } else {
        const created = await this.provider.createEvent(event);
        externalId = created.externalId;
        etag = created.etag;
      }

      const { error } = await this.db
        .from('appointments')
        .update({
          external_calendar_id: externalId,
          // Recorded so the inbound (Google → CRM) sync path can tell
          // its own echo of this exact push apart from a genuine
          // external edit — see inbound-sync-service.ts's echo guard.
          external_calendar_etag: etag,
          sync_status: 'synced',
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', appointment.id);
      if (error) throw error;
    } catch (err) {
      await this.db.from('appointments').update({ sync_status: 'error' }).eq('id', appointment.id);
      throw err;
    }
  }
}
