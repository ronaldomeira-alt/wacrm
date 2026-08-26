'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Ban,
  Check,
  Clock,
  Copy,
  Loader2,
  MessageSquare,
  RotateCcw,
  ShoppingBag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { renderTemplatePreview } from '@/lib/whatsapp/template-validators';
import type { AiSuggestion } from '@/types';

const SNOOZE_DAYS = 3;

interface FollowupPayload {
  stage_name?: string | null;
  has_purchased?: boolean;
  hours_since_contact?: number;
  reason?: string | null;
  approach_summary?: string | null;
  score?: number | null;
  draft?: { mode: 'free'; text: string } | { mode: 'template'; plan: any };
}

type Step = 'review' | 'choose_mode' | 'free_draft' | 'plan_review' | 'no_template';

function PlanContactReview({ contact, onValuesChange, onScheduleChange, t }) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <h4 className="font-medium text-foreground">{contact.title}</h4>
      <p className="text-xs text-muted-foreground">{t('templateUsed')}: {contact.template_name}</p>
      <div className="rounded-md border border-border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
        {renderTemplatePreview(contact.body_text, contact.values.body)}
      </div>
      {contact.values.body.map((v, i) => (
        <div key={i} className="space-y-1">
          <Label className="text-xs">{`{{${i + 1}}}`}</Label>
          <Input
            value={v}
            onChange={(e) => {
              const next = [...contact.values.body];
              next[i] = e.target.value;
              onValuesChange(next);
            }}
          />
        </div>
      ))}
      <div className="space-y-1">
        <Label className="text-xs">{contact.scheduleLabel}</Label>
        <Input type="number" defaultValue={contact.defaultDays} onChange={e => onScheduleChange(parseInt(e.target.value, 10))} />
      </div>
    </div>
  );
}

export function FollowupDialog({
  suggestion,
  open,
  onOpenChange,
  onResolved,
}: {
  suggestion: AiSuggestion;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved: () => void;
}) {
  const t = useTranslations('AiHub.followup');
  const router = useRouter();
  const payload = (suggestion.payload ?? {}) as FollowupPayload;

  const [step, setStep] = useState<Step>(
    payload.draft?.mode === 'free'
      ? 'free_draft'
      : payload.draft?.mode === 'template'
        ? 'plan_review'
        : 'review',
  );
  const [busy, setBusy] = useState(false);
  const [freeText, setFreeText] = useState(
    payload.draft?.mode === 'free' ? payload.draft.text : '',
  );
  const [plan, setPlan] = useState<any | null>(
    payload.draft?.mode === 'template' ? payload.draft.plan : null,
  );

  const approvePlan = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/suggestions/${suggestion.id}/followup/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'template', planData: plan }),
      });
      if (!res.ok) throw new Error();
      toast.success(t('planApproved'));
      onResolved();
      onOpenChange(false);
    } catch {
      toast.error(t('planApproveError'));
    } finally {
      setBusy(false);
    }
  }, [suggestion.id, plan, t, onResolved, onOpenChange]);

  const generate = useCallback(
    async (mode: 'free' | 'template') => {
      setBusy(true);
      try {
        const res = await fetch(`/api/ai/suggestions/${suggestion.id}/followup/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Failed to generate');

        if (mode === 'free') {
          setFreeText(data.draft?.text ?? '');
          setStep('free_draft');
        } else if (data.draft?.plan) {
          setPlan(data.draft.plan);
          setStep('plan_review');
        } else {
          setStep('no_template');
        }
      } catch {
        toast.error(t('generateError'));
      } finally {
        setBusy(false);
      }
    },
    [suggestion.id, t],
  );

  // Outras funções (copyToClipboard, complete, act, snooze) omitidas por brevidade

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{suggestion.contact?.name ?? t('title')}</DialogTitle>
          <DialogDescription>{t('title')}</DialogDescription>
        </DialogHeader>

        {/* Renderização condicional dos steps omitida por brevidade */}

        {step === 'plan_review' && plan && (
          <div className="space-y-4">
            {plan.contact1 &&
              <PlanContactReview
                contact={{...plan.contact1, title: t('contact1'), scheduleLabel: t('schedule1'), defaultDays: 15}}
                onValuesChange={(newValues) => setPlan({...plan, contact1: {...plan.contact1, values: {...plan.contact1.values, body: newValues}}})}
                onScheduleChange={(days) => setPlan({...plan, contact1: {...plan.contact1, scheduleDays: days}})}
                t={t}
              />}
            {plan.contact2 &&
              <PlanContactReview
                contact={{...plan.contact2, title: t('contact2'), scheduleLabel: t('schedule2'), defaultDays: 10}}
                onValuesChange={(newValues) => setPlan({...plan, contact2: {...plan.contact2, values: {...plan.contact2.values, body: newValues}}})}
                onScheduleChange={(days) => setPlan({...plan, contact2: {...plan.contact2, scheduleDays: days}})}
                t={t}
              />}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
           {/* Botões para outros steps... */}

          {step === 'plan_review' && (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => generate('template')}>
                <RotateCcw className="h-3.5 w-3.5" /> {t('regenerate')}
              </Button>
              <Button size="sm" disabled={busy} onClick={approvePlan}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {t('approvePlan')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
