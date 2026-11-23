'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Ban,
  Building2,
  Check,
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  ShoppingBag,
  Sparkles,
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
import { writeFollowupDraft } from '@/lib/inbox/followup-draft';
import { renderTemplatePreview } from '@/lib/whatsapp/template-validators';
import type { FollowupPlan, FollowupPlanContact } from '@/lib/ai/followup-types';
import type { CompatiblePropertySummary } from '@/lib/followup/engine';
import type { AiSuggestion } from '@/types';

/** Default "Adiar" window — a single click, no duration picker, kept
 *  here so it's a one-line change later if it needs to become
 *  user-configurable. */
const SNOOZE_DAYS = 3;

interface FollowupPayload {
  stage_name?: string | null;
  has_purchased?: boolean;
  hours_since_contact?: number;
  reason?: string | null;
  approach_summary?: string | null;
  score?: number | null;
  draft?:
    | { mode: 'free'; text: string }
    | {
        mode: 'template';
        template_id: string;
        template_name: string;
        body_text: string;
        values: { body: string[]; headerText?: string };
      }
    | { mode: 'plan'; plan: FollowupPlan };
}

type Step = 'review' | 'choose_mode' | 'free_draft' | 'template_draft' | 'plan_review' | 'no_template';

function PlanContactReview({
  contact,
  title,
  scheduleLabel,
  onValuesChange,
  onScheduleChange,
}: {
  contact: FollowupPlanContact;
  title: string;
  scheduleLabel: string;
  onValuesChange: (values: string[]) => void;
  onScheduleChange: (days: number) => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <h4 className="font-medium text-foreground">{title}</h4>
      <p className="text-xs text-muted-foreground">{contact.template_name}</p>
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
        <Label className="text-xs">{scheduleLabel}</Label>
        <Input
          type="number"
          min={1}
          value={contact.scheduleDays}
          onChange={(e) => onScheduleChange(parseInt(e.target.value, 10) || 0)}
        />
      </div>
    </div>
  );
}

export function FollowupDialog({
  suggestion,
  open,
  onOpenChange,
  onResolved,
  compatibleProperties: initialCompatibleProperties,
  stageName: overrideStageName,
  hoursSinceLastCommunication,
  neverContacted,
  lastMessagePreview,
  primaryNeed,
  interestProperty,
}: {
  suggestion: AiSuggestion;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved: () => void;
  compatibleProperties?: CompatiblePropertySummary[];
  stageName?: string | null;
  hoursSinceLastCommunication?: number | null;
  neverContacted?: boolean;
  lastMessagePreview?: string | null;
  primaryNeed?: string | null;
  interestProperty?: string | null;
}) {
  const t = useTranslations('AiHub.followup');
  const router = useRouter();
  const payload = (suggestion.payload ?? {}) as FollowupPayload;

  // Resume straight into the draft screen if one was already generated
  // (page reload, or reopening the dialog) instead of asking the user
  // to pick a mode again.
  const [step, setStep] = useState<Step>(
    payload.draft?.mode === 'free'
      ? 'free_draft'
      : payload.draft?.mode === 'template'
        ? 'template_draft'
        : payload.draft?.mode === 'plan'
          ? 'plan_review'
          : 'review',
  );
  const [busy, setBusy] = useState(false);
  const [freeText, setFreeText] = useState(
    payload.draft?.mode === 'free' ? payload.draft.text : '',
  );
  const [templateValues, setTemplateValues] = useState<string[]>(
    payload.draft?.mode === 'template' ? payload.draft.values.body : [],
  );
  const [templateDraft, setTemplateDraft] = useState(
    payload.draft?.mode === 'template' ? payload.draft : null,
  );
  const [plan, setPlan] = useState<FollowupPlan | null>(
    payload.draft?.mode === 'plan' ? payload.draft.plan : null,
  );
  const [compatibleProperties, setCompatibleProperties] = useState<CompatiblePropertySummary[]>(
    initialCompatibleProperties ?? [],
  );
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [matchesExpanded, setMatchesExpanded] = useState(false);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);

  useEffect(() => {
    if (initialCompatibleProperties) {
      setCompatibleProperties(initialCompatibleProperties);
      return;
    }
    if (!open || !suggestion.contact_id) return;
    let active = true;
    setLoadingMatches(true);
    fetch(`/api/match/lead/${encodeURIComponent(suggestion.contact_id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active || !data?.matches) return;
        const mapped: CompatiblePropertySummary[] = (
          data.matches as Array<Record<string, unknown>>
        )
          .filter((m) => Number(m.match_score ?? 0) >= 70 && m.match_status !== 'ignorado')
          .slice(0, 5)
          .map((m) => {
            const prop = (m.property ?? {}) as Record<string, unknown>;
            const breakdown = (m.score_breakdown ?? {}) as Record<string, unknown>;
            return {
              matchId: String(m.id || ''),
              propertyId: String(prop.propertyId || m.property_id || ''),
              title: String(prop.title || 'Imóvel compatível'),
              code: prop.code ? String(prop.code) : null,
              neighborhood: String(prop.neighborhood || ''),
              city: String(prop.city || 'João Pessoa'),
              operation: String(data.searchProfile?.operation || 'venda'),
              propertyType: null,
              priceMin: Number(prop.priceMin || 0),
              priceMax: Number(prop.priceMax || 0),
              bedroomsMin: prop.bedroomsMin != null ? Number(prop.bedroomsMin) : null,
              bedroomsMax: prop.bedroomsMax != null ? Number(prop.bedroomsMax) : null,
              areaMin: prop.areaMin != null ? Number(prop.areaMin) : null,
              deliveryStatus: prop.deliveryStatus ? String(prop.deliveryStatus) : null,
              coverUrl: prop.coverUrl ? String(prop.coverUrl) : null,
              publicUrl: prop.publicUrl ? String(prop.publicUrl) : null,
              matchScore: Math.round(Number(m.match_score || 0)),
              commercialPriority: Number(m.commercial_priority || 0),
              matchStatus: String(m.match_status || 'novo'),
              reasons: Array.isArray(breakdown.reasons)
                ? (breakdown.reasons as unknown[]).map((r) => String(r))
                : [],
            };
          });
        setCompatibleProperties(mapped);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingMatches(false);
      });
    return () => {
      active = false;
    };
  }, [open, suggestion.contact_id, initialCompatibleProperties]);

  const selectedProperty =
    compatibleProperties.find((p) => p.propertyId === selectedPropertyId) ?? null;

  const insertPropertyIntoDraft = useCallback(
    (prop: CompatiblePropertySummary) => {
      const location = [prop.neighborhood, prop.city].filter(Boolean).join(', ');
      const refLine = prop.publicUrl
        ? `\n\nSeparei também esta opção que combina com o que você busca: ${prop.title}${location ? ` (${location})` : ''}\n${prop.publicUrl}`
        : `\n\nSeparei também esta opção compatível com sua busca: ${prop.title}${location ? ` (${location})` : ''}.`;
      setFreeText((prev) => {
        const trimmed = prev.trim();
        if (trimmed.includes(prop.title)) return prev;
        return `${trimmed}${refLine}`.trim();
      });
      toast.success(`Referência de "${prop.title}" adicionada ao rascunho.`);
    },
    [],
  );

  const generate = useCallback(
    async (mode: 'free' | 'template' | 'plan') => {
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
        } else if (mode === 'template') {
          if (data.draft) {
            setTemplateDraft(data.draft);
            setTemplateValues(data.draft.values.body);
            setStep('template_draft');
          } else {
            setStep('no_template');
          }
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

  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(freeText);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyError'));
    }
  }, [freeText, t]);

  const goToConversationTemplate = useCallback(() => {
    if (!suggestion.conversation_id || !templateDraft) return;
    writeFollowupDraft(suggestion.conversation_id, {
      suggestionId: suggestion.id,
      mode: 'template',
      templateId: templateDraft.template_id,
      values: { body: templateValues, headerText: templateDraft.values.headerText },
    });
    onOpenChange(false);
    router.push(`/inbox?c=${suggestion.conversation_id}`);
  }, [suggestion.conversation_id, suggestion.id, templateDraft, templateValues, onOpenChange, router]);

  const complete = useCallback(
    async (mode: 'whatsapp' | 'crm') => {
      setBusy(true);
      try {
        const res = await fetch(`/api/ai/suggestions/${suggestion.id}/followup/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode,
            message: mode === 'whatsapp' ? freeText : undefined,
            template_id: mode === 'crm' ? templateDraft?.template_id : undefined,
          }),
        });
        if (!res.ok) throw new Error();
        toast.success(t('markedDone'));
        onResolved();
        onOpenChange(false);
      } catch {
        toast.error(t('markDoneError'));
      } finally {
        setBusy(false);
      }
    },
    [suggestion.id, freeText, templateDraft, t, onResolved, onOpenChange],
  );

  const approvePlan = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/suggestions/${suggestion.id}/followup/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'plan', planData: plan }),
      });
      if (!res.ok) throw new Error();
      toast.success(t('markedDone'));
      onResolved();
      onOpenChange(false);
    } catch {
      toast.error(t('markDoneError'));
    } finally {
      setBusy(false);
    }
  }, [suggestion.id, plan, t, onResolved, onOpenChange]);

  const act = useCallback(
    async (status: 'ignored') => {
      setBusy(true);
      try {
        const res = await fetch(`/api/ai/suggestions/${suggestion.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) throw new Error();
        onResolved();
        onOpenChange(false);
      } catch {
        toast.error(t('actionError'));
      } finally {
        setBusy(false);
      }
    },
    [suggestion.id, t, onResolved, onOpenChange],
  );

  const snooze = useCallback(async () => {
    setBusy(true);
    try {
      const until = new Date(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const res = await fetch(`/api/ai/suggestions/${suggestion.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending', snoozed_until: until }),
      });
      if (!res.ok) throw new Error();
      toast.success(t('snoozed', { days: SNOOZE_DAYS }));
      onResolved();
      onOpenChange(false);
    } catch {
      toast.error(t('actionError'));
    } finally {
      setBusy(false);
    }
  }, [suggestion.id, t, onResolved, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{suggestion.contact?.name ?? t('title')}</DialogTitle>
          <DialogDescription>{t('title')}</DialogDescription>
        </DialogHeader>

        {step === 'review' && (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              {(overrideStageName ?? payload.stage_name) && (
                <div>
                  <dt className="text-xs text-muted-foreground">{t('stage')}</dt>
                  <dd className="text-foreground font-medium">
                    {overrideStageName ?? payload.stage_name}
                  </dd>
                </div>
              )}
              {payload.has_purchased !== undefined && (
                <div>
                  <dt className="text-xs text-muted-foreground">{t('hasPurchased')}</dt>
                  <dd className="flex items-center gap-1 text-foreground">
                    <ShoppingBag className="h-3.5 w-3.5" />
                    {payload.has_purchased ? t('yes') : t('no')}
                  </dd>
                </div>
              )}
              {neverContacted ? (
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">{t('lastContact')}</dt>
                  <dd className="flex items-center gap-1 text-amber-400 font-medium">
                    <Clock className="h-3.5 w-3.5" />
                    <span>Nunca contatado</span>
                  </dd>
                </div>
              ) : typeof (hoursSinceLastCommunication ?? payload.hours_since_contact) === 'number' ? (
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">{t('lastContact')}</dt>
                  <dd className="flex items-center gap-1 text-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    {t('hoursAgo', {
                      hours: hoursSinceLastCommunication ?? payload.hours_since_contact ?? 0,
                    })}
                  </dd>
                </div>
              ) : null}
            </dl>

            {(interestProperty || primaryNeed) && (
              <div className="rounded-lg border border-border/70 bg-muted/30 p-2.5 space-y-1 text-xs">
                {interestProperty && (
                  <p className="text-foreground flex items-center gap-1.5">
                    <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="text-muted-foreground">Empreendimento:</span>
                    <strong className="font-semibold">{interestProperty}</strong>
                  </p>
                )}
                {primaryNeed && (
                  <p className="text-foreground">
                    <span className="text-muted-foreground">Necessidade principal:</span>{' '}
                    <span className="font-medium">{primaryNeed}</span>
                  </p>
                )}
              </div>
            )}

            {(payload.reason || suggestion.title) && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('reason')}</p>
                <p className="text-sm text-foreground">{payload.reason || suggestion.title}</p>
              </div>
            )}
            {(payload.approach_summary || suggestion.description) && (
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('approach')}</p>
                <p className="text-sm text-foreground">
                  {payload.approach_summary || suggestion.description}
                </p>
              </div>
            )}

            {lastMessagePreview && (
              <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <p className="text-[11px] font-medium text-muted-foreground mb-1">
                  Última mensagem registrada na conversa
                </p>
                <p className="text-xs text-foreground/90 italic line-clamp-3">
                  &ldquo;{lastMessagePreview}&rdquo;
                </p>
              </div>
            )}

            {/* Seção secundária e discreta de imóveis compatíveis do Match (Seção 9) */}
            {(compatibleProperties.length > 0 || loadingMatches) && (
              <div
                data-testid="followup-dialog-compatible-properties"
                className="rounded-xl border border-border/70 bg-card/60 p-3 space-y-2"
              >
                <button
                  type="button"
                  onClick={() => setMatchesExpanded((prev) => !prev)}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="text-xs font-semibold text-foreground truncate">
                      Imóveis compatíveis para este atendimento
                    </span>
                    <span className="rounded-full bg-primary/15 border border-primary/25 px-1.5 py-0.2 text-[10px] font-bold text-primary shrink-0">
                      {loadingMatches ? '...' : compatibleProperties.length}
                    </span>
                  </div>
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                      matchesExpanded ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {matchesExpanded && (
                  <div className="space-y-2 pt-2 border-t border-border/50 max-h-48 overflow-y-auto">
                    <p className="text-[11px] text-muted-foreground">
                      Selecione um imóvel compatível como apoio contextual para apresentar ao cliente, se oportuno:
                    </p>
                    {compatibleProperties.map((prop) => {
                      const isSelected = selectedPropertyId === prop.propertyId;
                      return (
                        <div
                          key={prop.propertyId}
                          className={`flex items-center justify-between gap-2 rounded-lg border p-2 text-xs transition-colors ${
                            isSelected
                              ? 'border-primary bg-primary/10'
                              : 'border-border/60 bg-background/50 hover:border-border'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.2 text-[10px] font-bold text-emerald-400">
                                {prop.matchScore}% match
                              </span>
                              <span className="font-semibold text-foreground truncate">
                                {prop.title}
                              </span>
                            </div>
                            <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                              {[
                                prop.neighborhood,
                                prop.city,
                                prop.bedroomsMin ? `${prop.bedroomsMin}q` : null,
                                prop.operation === 'locacao' ? 'Locação' : 'Venda',
                              ]
                                .filter(Boolean)
                                .join(' • ')}
                            </p>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {prop.publicUrl && (
                              <a
                                href={prop.publicUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted"
                                title="Ver link público do imóvel"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant={isSelected ? 'default' : 'outline'}
                              onClick={() =>
                                setSelectedPropertyId((curr) =>
                                  curr === prop.propertyId ? null : prop.propertyId,
                                )
                              }
                              className="h-7 px-2 text-[11px]"
                            >
                              {isSelected ? 'Selecionado' : 'Selecionar'}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 'choose_mode' && (
          <div className="grid gap-2 sm:grid-cols-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => generate('free')}
              className="flex flex-col items-center gap-2 rounded-xl border border-border p-4 text-center transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:opacity-50"
            >
              <Copy className="h-5 w-5 text-primary" />
              <span className="text-sm font-medium text-foreground">{t('modeWhatsApp')}</span>
              <span className="text-xs text-muted-foreground">{t('modeWhatsAppDesc')}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => generate('template')}
              className="flex flex-col items-center gap-2 rounded-xl border border-border p-4 text-center transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:opacity-50"
            >
              <MessageSquare className="h-5 w-5 text-primary" />
              <span className="text-sm font-medium text-foreground">{t('modeCrm')}</span>
              <span className="text-xs text-muted-foreground">{t('modeCrmDesc')}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => generate('plan')}
              className="flex flex-col items-center gap-2 rounded-xl border border-border p-4 text-center transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:opacity-50"
            >
              <Sparkles className="h-5 w-5 text-primary" />
              <span className="text-sm font-medium text-foreground">{t('modePlan')}</span>
              <span className="text-xs text-muted-foreground">{t('modePlanDesc')}</span>
            </button>
            {busy && (
              <div className="col-span-3 flex justify-center py-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              </div>
            )}
          </div>
        )}

        {step === 'free_draft' && (
          <div className="space-y-2.5">
            <Label className="text-xs">{t('messagePreview')}</Label>
            <Textarea
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              rows={6}
              className="text-sm"
            />
            {compatibleProperties.length > 0 && (
              <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5 space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-primary" />
                  Adicionar imóvel compatível ao texto (opcional):
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {(selectedProperty ? [selectedProperty] : compatibleProperties.slice(0, 3)).map(
                    (prop) => (
                      <Button
                        key={prop.propertyId}
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => insertPropertyIntoDraft(prop)}
                        className="h-7 px-2 text-[11px] gap-1"
                      >
                        <Plus className="h-3 w-3" />
                        <span className="truncate max-w-[180px]">{prop.title}</span>
                        <span className="text-emerald-400 font-semibold">({prop.matchScore}%)</span>
                      </Button>
                    ),
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'template_draft' && templateDraft && (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p className="mb-1 text-xs text-muted-foreground">
                {t('templateUsed')}: {templateDraft.template_name}
              </p>
              <p className="whitespace-pre-wrap text-foreground">
                {renderTemplatePreview(templateDraft.body_text, templateValues)}
              </p>
            </div>
            {templateValues.map((v, i) => (
              <div key={i} className="space-y-1">
                <Label className="text-xs">{`{{${i + 1}}}`}</Label>
                <Input
                  value={v}
                  onChange={(e) => {
                    const next = [...templateValues];
                    next[i] = e.target.value;
                    setTemplateValues(next);
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {step === 'plan_review' && plan && (plan.contact1 || plan.contact2) && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">{t('modePlanDesc')}</p>
            {plan.contact1 && (
              <PlanContactReview
                contact={plan.contact1}
                title={t('planContact1')}
                scheduleLabel={t('planScheduleDays')}
                onValuesChange={(values) =>
                  setPlan((prev) =>
                    prev?.contact1 ? { ...prev, contact1: { ...prev.contact1, values: { ...prev.contact1.values, body: values } } } : prev,
                  )
                }
                onScheduleChange={(days) =>
                  setPlan((prev) => (prev?.contact1 ? { ...prev, contact1: { ...prev.contact1, scheduleDays: days } } : prev))
                }
              />
            )}
            {plan.contact2 && (
              <PlanContactReview
                contact={plan.contact2}
                title={t('planContact2')}
                scheduleLabel={t('planScheduleDays')}
                onValuesChange={(values) =>
                  setPlan((prev) =>
                    prev?.contact2 ? { ...prev, contact2: { ...prev.contact2, values: { ...prev.contact2.values, body: values } } } : prev,
                  )
                }
                onScheduleChange={(days) =>
                  setPlan((prev) => (prev?.contact2 ? { ...prev, contact2: { ...prev.contact2, scheduleDays: days } } : prev))
                }
              />
            )}
          </div>
        )}

        {step === 'no_template' && (
          <p className="text-sm text-muted-foreground">{t('noTemplate')}</p>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          {step === 'review' && (
            <>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => act('ignored')}>
                  <Ban className="h-3.5 w-3.5" /> {t('ignore')}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={snooze}>
                  <Clock className="h-3.5 w-3.5" /> {t('snooze')}
                </Button>
                {suggestion.conversation_id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    render={<a href={`/inbox?c=${suggestion.conversation_id}`} />}
                  >
                    <MessageSquare className="h-3.5 w-3.5" /> {t('viewConversation')}
                  </Button>
                )}
              </div>
              <Button size="sm" disabled={busy} onClick={() => setStep('choose_mode')}>
                <Check className="h-3.5 w-3.5" /> {t('accept')}
              </Button>
            </>
          )}

          {step === 'choose_mode' && (
            <Button variant="outline" size="sm" onClick={() => setStep('review')}>
              {t('back')}
            </Button>
          )}

          {step === 'free_draft' && (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => generate('free')}>
                <RotateCcw className="h-3.5 w-3.5" /> {t('regenerate')}
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={copyToClipboard}>
                  <Copy className="h-3.5 w-3.5" /> {t('copyButton')}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => complete('whatsapp')}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  {t('markDone')}
                </Button>
              </div>
            </>
          )}

          {step === 'template_draft' && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => generate('template')}
              >
                <RotateCcw className="h-3.5 w-3.5" /> {t('regenerate')}
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => complete('crm')}>
                  {t('markDone')}
                </Button>
                <Button size="sm" disabled={busy} onClick={goToConversationTemplate}>
                  <MessageSquare className="h-3.5 w-3.5" /> {t('goToConversation')}
                </Button>
              </div>
            </>
          )}

          {step === 'plan_review' && (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => generate('plan')}>
                <RotateCcw className="h-3.5 w-3.5" /> {t('regenerate')}
              </Button>
              <Button size="sm" disabled={busy} onClick={approvePlan}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {t('approvePlan')}
              </Button>
            </>
          )}

          {step === 'no_template' && (
            <Button size="sm" onClick={() => generate('free')}>
              {t('modeWhatsApp')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
