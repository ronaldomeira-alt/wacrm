'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

interface BlockLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  contactName: string;
  /** Called after a successful block, before the dialog closes — the
   *  caller owns removing the lead from whatever local list it renders
   *  (currently just the Inbox conversation list). */
  onBlocked: (contactId: string) => void;
}

/**
 * "Bloquear lead" confirmation + action — same shared-dialog pattern as
 * DeleteLeadDialog, but reversible and non-destructive: sets
 * `contacts.blocked_at` (migration 083) instead of deleting the row.
 * Conversation, messages, tags, notes and Pipeline deal(s) are all left
 * untouched — only the Inbox conversation list (matching this dialog's
 * only caller today) and the WhatsApp webhook (processMessage in
 * src/app/api/whatsapp/webhook/route.ts) act on `blocked_at`.
 */
export function BlockLeadDialog({
  open,
  onOpenChange,
  contactId,
  contactName,
  onBlocked,
}: BlockLeadDialogProps) {
  const t = useTranslations('Leads.blockDialog');
  const [blocking, setBlocking] = useState(false);

  async function handleBlock() {
    if (!contactId) return;
    setBlocking(true);
    const supabase = createClient();

    const { error } = await supabase
      .from('contacts')
      .update({ blocked_at: new Date().toISOString() })
      .eq('id', contactId);

    if (error) {
      console.error('[block-lead] failed:', error);
      toast.error(t('toastFailedBlock'));
    } else {
      toast.success(t('toastBlocked'));
      onBlocked(contactId);
      onOpenChange(false);
    }
    setBlocking(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('description', { name: contactName })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={blocking}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button variant="destructive" onClick={handleBlock} disabled={blocking || !contactId}>
            {blocking && <Loader2 className="size-4 animate-spin" />}
            {t('blockBtn')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
