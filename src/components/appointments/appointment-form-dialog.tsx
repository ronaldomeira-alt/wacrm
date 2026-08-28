'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTranslations } from 'next-intl';
import type { Appointment } from '@/types';
import { createAppointment, updateAppointment } from '@/lib/appointments/queries';
import { localDayKey } from '@/lib/dashboard/date-utils';

/**
 * Best-effort push to Google Calendar after a create/update. Never
 * throws — a network error or a 'sync_failed'/'not_connected' body
 * both just mean "nothing changed on Google's side"; the appointment
 * itself already saved successfully by the time this runs. Only
 * surfaces a toast when the sync was attempted and Google-side
 * (not the "not connected" no-op case, which is expected for most
 * agents most of the time).
 */
async function syncAppointmentToCalendar(appointmentId: string, failureMessage: string) {
  try {
    const res = await fetch('/api/calendar/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointmentId }),
    });
    const data = (await res.json()) as { synced?: boolean; reason?: string };
    if (!res.ok || (data.synced === false && data.reason === 'sync_failed')) {
      toast.warning(failureMessage);
    }
  } catch (err) {
    console.error('[calendar sync] request failed:', err);
    toast.warning(failureMessage);
  }
}

interface AppointmentFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing an existing appointment; omit/null to create a new one. */
  appointment?: Appointment | null;
  /** Pre-fills the date field — the dashboard always creates for today. */
  defaultDate?: string;
  /**
   * Attaches a contact to the appointment being created (client_name,
   * and contact_id when it's a real contacts row) — the Inbox
   * conversation menu's "Criar agendamento" is the caller. There's no
   * visible client field in this dialog (see the interface-alignment
   * task that removed it), so this is the only way a new appointment
   * ends up linked to a contact; ignored when `appointment` is set
   * (editing keeps its own existing link, see the reset effect below).
   */
  defaultContactId?: string;
  defaultClientName?: string;
  onSaved: () => void;
}

export function AppointmentFormDialog({
  open,
  onOpenChange,
  appointment,
  defaultDate,
  defaultContactId,
  defaultClientName,
  onSaved,
}: AppointmentFormDialogProps) {
  const t = useTranslations('Appointments.form');
  const supabase = createClient();
  const { user, accountId } = useAuth();

  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [notes, setNotes] = useState('');

  // Preserved but not editable here — this dialog only surfaces
  // Título/Data/Horários/Observações (see the interface-alignment
  // task). Editing a pre-085 appointment must not silently clear its
  // existing contact/property/type/description on save, so an edit
  // carries these straight through unchanged; a new appointment gets
  // sensible empty defaults (contact linking still works via
  // defaultContactId/defaultClientName above).
  const [contactId, setContactId] = useState('');
  const [clientName, setClientName] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [description, setDescription] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);

  // Reset on open — a legitimate prop-driven sync, same rationale as
  // deal-form.tsx.
  useEffect(() => {
    if (!open) return;
    if (appointment) {
      setTitle(appointment.title);
      setDate(appointment.scheduled_date);
      setTime(appointment.scheduled_time?.slice(0, 5) ?? '');
      setEndTime(appointment.scheduled_end_time?.slice(0, 5) ?? '');
      setNotes(appointment.notes ?? '');
      setContactId(appointment.contact_id ?? '');
      setClientName(
        appointment.contact?.name || appointment.contact?.phone || appointment.client_name || '',
      );
      setPropertyId(appointment.property_id ?? '');
      setDescription(appointment.description ?? null);
    } else {
      setTitle('');
      setDate(defaultDate ?? localDayKey(new Date()));
      setTime('');
      setEndTime('');
      setNotes('');
      setContactId(defaultContactId ?? '');
      setClientName(defaultClientName ?? '');
      setPropertyId('');
      setDescription(null);
    }
  }, [open, appointment, defaultDate, defaultContactId, defaultClientName]);

  async function handleSave() {
    if (!title.trim()) {
      toast.error(t('titleRequired'));
      return;
    }
    if (!date) {
      toast.error(t('dateRequired'));
      return;
    }
    if (endTime && !time) {
      toast.error(t('endTimeNeedsStart'));
      return;
    }
    if (endTime && time && endTime <= time) {
      toast.error(t('endTimeBeforeStart'));
      return;
    }
    if (!user || !accountId) {
      toast.error(t('notAuthenticated'));
      return;
    }

    setSaving(true);
    try {
      const input = {
        accountId,
        userId: user.id,
        title: title.trim(),
        description,
        notes: notes.trim() || null,
        type: appointment?.type ?? ('other' as const),
        scheduledDate: date,
        scheduledTime: time || null,
        scheduledEndTime: endTime || null,
        contactId: contactId || null,
        clientName: clientName.trim() || null,
        propertyId: propertyId || null,
      };
      let savedId: string;
      if (appointment) {
        await updateAppointment(supabase, appointment.id, input);
        toast.success(t('toastUpdated'));
        savedId = appointment.id;
      } else {
        const created = await createAppointment(supabase, input);
        toast.success(t('toastCreated'));
        savedId = created.id;
      }
      onOpenChange(false);
      onSaved();
      // Best-effort — a Google-side failure shouldn't undo a save
      // that already succeeded, so this runs after the dialog closes
      // and never throws into this try/catch. syncAppointmentToCalendar
      // itself no-ops quietly when the agent hasn't connected a
      // calendar (see /api/calendar/sync's `not_connected` reason).
      void syncAppointmentToCalendar(savedId, t('toastCalendarSyncFailed'));
    } catch (err) {
      console.error('Failed to save appointment:', err);
      toast.error(t('toastSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{appointment ? t('editTitle') : t('newTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium text-foreground">{t('titleLabel')}</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('titlePlaceholder')}
              disabled={saving}
              maxLength={120}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium text-foreground">{t('dateLabel')}</label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={saving}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <label className="text-sm font-medium text-foreground">{t('timeLabel')}</label>
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-foreground">{t('endTimeLabel')}</label>
              <Input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                disabled={saving}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium text-foreground">{t('notesLabel')}</label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('notesPlaceholder')}
              disabled={saving}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
