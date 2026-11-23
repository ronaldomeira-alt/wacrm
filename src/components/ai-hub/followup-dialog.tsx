'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertCircle,
  Ban,
  Building2,
  Check,
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  ShieldAlert,
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
import { resolveValidatedPublicPropertyUrl } from '@/lib/match/smart-send';
import { renderTemplatePreview } from '@/lib/whatsapp/template-validators';
import {
  evaluateFollowupSessionWindow,
  type CompatiblePropertySummary,
  type FollowupSessionWindowInfo,
} from '@/lib/followup/engine';
import type { FollowupPlan, FollowupPlanContact } from '@/lib/ai/followup-types';
import type { AiSuggestion } from '@/types';

/** Default "Adiar" window — a single click, no duration picker, kept
 *  here so it's a one-line change later if it needs to become
 *  user-configurable. */
const SNOOZE_DAYS = 3;

interface FollowupPayload {
  stage_name?: string | null;
  has_purchased?: boolean;
  hours_since_contact?: number;
  last_customer_message_at?: string | null;
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
        supports_public_url?: boolean;
      }
    | { mode: 'plan'; plan: FollowupPlan };
}

type Step = 'review' | 'choose_mode' | 'free_draft' | 'template_draft' | 'plan_review' | 'no_template';

function resolveClientPublicPropertyUrl(prop: {
  publicUrl?: string | null;
  coverUrl?: string | null;
  code?: string | null;
  propertyId?: string | null;
}): string | null {
  const explicit =
    typeof prop.publicUrl === 'string' && prop.publicUrl.trim() ? prop.publicUrl.trim() : null;
  const cover =
    typeof prop.coverUrl === 'string' && prop.coverUrl.trim() ? prop.coverUrl.trim() : null;
  const coverInvId = cover?.match(/\/properties\/([^/]+)/)?.[1]?.trim() || null;
  const fallbackId = explicit
    ? null
    : coverInvId || (prop.code ? String(prop.propertyId || '').trim() || null : null);
  return resolveValidatedPublicPropertyUrl(explicit, fallbackId).url;
}

function formatPropertyTypePtBr(raw?: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const norm = raw.trim().toLowerCase();
  const labels: Record<string, string> = {
    apartamento: 'Apartamento',
    studio: 'Studio',
    flat: 'Flat',
    cobertura: 'Cobertura',
    casa: 'Casa',
    terreno: 'Terreno',
    comercial: 'Comercial',
    garden: 'Garden',
  };
  return labels[norm] || raw.trim().charAt(0).toUpperCase() + raw.trim().slice(1);
}

function formatCommercialPricePtBr(priceMin?: number | null, priceMax?: number | null): string | null {
  const min = Number(priceMin || 0);
  const max = Number(priceMax || 0);
  const val = min > 0 ? min : max;
  if (val <= 0) return null;
  const formatted = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  }).format(val);
  return min > 0 && max > min ? `A partir de ${formatted}` : formatted;
}

function PropertyThumbnail({
  coverUrl,
  title,
  sizeClass = 'size-12',
}: {
  coverUrl?: string | null;
  title: string;
  sizeClass?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!coverUrl || failed) {
    return (
      <div
        data-testid="followup-property-thumbnail-fallback"
        className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/50 text-muted-foreground`}
      >
        <Building2 className="size-5" />
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-testid="followup-property-thumbnail-img"
      src={coverUrl}
      alt={title}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`${sizeClass} shrink-0 rounded-lg border border-border/70 object-cover bg-muted/30`}
    />
  );
}

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
  lastCustomerMessageAt,
  sessionWindow: initialSessionWindow,
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
  lastCustomerMessageAt?: string | null;
  sessionWindow?: FollowupSessionWindowInfo;
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
  const [noTemplateReason, setNoTemplateReason] = useState<string | null>(null);
  const [fetchedProperties, setFetchedProperties] = useState<CompatiblePropertySummary[] | null>(
    null,
  );
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [matchesExpanded, setMatchesExpanded] = useState(true);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  // Atualiza o estado da janela de atendimento de 24h em tempo real enquanto o modal está aberto (Seção 5)
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const liveSessionWindow = useMemo<FollowupSessionWindowInfo>(() => {
    const effectiveCustAt =
      lastCustomerMessageAt !== undefined
        ? lastCustomerMessageAt
        : (payload.last_customer_message_at ?? initialSessionWindow?.ctwaFreeBenefitExpiresAt ?? null);
    if (lastCustomerMessageAt !== undefined || payload.last_customer_message_at) {
      return evaluateFollowupSessionWindow({
        lastCustomerMessageAt: effectiveCustAt,
        isCtwaLead: initialSessionWindow?.isCtwaLead ?? false,
        ctwaFepExpiresAt: initialSessionWindow?.ctwaFreeBenefitExpiresAt ?? null,
        nowMs: nowTick,
      });
    }
    if (initialSessionWindow) return initialSessionWindow;
    return evaluateFollowupSessionWindow({ lastCustomerMessageAt: null, nowMs: nowTick });
  }, [lastCustomerMessageAt, payload.last_customer_message_at, initialSessionWindow, nowTick]);

  const compatibleProperties = useMemo<CompatiblePropertySummary[]>(() => {
    const base =
      initialCompatibleProperties && initialCompatibleProperties.length > 0
        ? initialCompatibleProperties
        : (fetchedProperties ?? []);
    return base.map((p) => ({
      ...p,
      publicUrl: resolveClientPublicPropertyUrl(p),
    }));
  }, [initialCompatibleProperties, fetchedProperties]);

  useEffect(() => {
    if (initialCompatibleProperties && initialCompatibleProperties.length > 0) {
      return;
    }
    if (!open || !suggestion.contact_id) return;
    let active = true;
    const controller = new AbortController();
    fetch(`/api/match/lead/${encodeURIComponent(suggestion.contact_id)}`, {
      signal: controller.signal,
    })
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
            const coverUrl = prop.coverUrl ? String(prop.coverUrl) : null;
            const rawPublicUrl = prop.publicUrl ? String(prop.publicUrl) : null;
            const propertyId = String(prop.propertyId || m.property_id || '');
            const code = prop.code ? String(prop.code) : null;
            return {
              matchId: String(m.id || ''),
              propertyId,
              title: String(prop.title || 'Imóvel compatível'),
              code,
              neighborhood: String(prop.neighborhood || ''),
              city: String(prop.city || 'João Pessoa'),
              operation: String(data.searchProfile?.operation || 'venda'),
              propertyType: prop.propertyType ? String(prop.propertyType) : null,
              priceMin: Number(prop.priceMin || 0),
              priceMax: Number(prop.priceMax || 0),
              bedroomsMin: prop.bedroomsMin != null ? Number(prop.bedroomsMin) : null,
              bedroomsMax: prop.bedroomsMax != null ? Number(prop.bedroomsMax) : null,
              areaMin: prop.areaMin != null ? Number(prop.areaMin) : null,
              deliveryStatus: prop.deliveryStatus ? String(prop.deliveryStatus) : null,
              coverUrl,
              publicUrl: resolveClientPublicPropertyUrl({
                publicUrl: rawPublicUrl,
                coverUrl,
                code,
                propertyId,
              }),
              matchScore: Math.round(Number(m.match_score || 0)),
              commercialPriority: Number(m.commercial_priority || 0),
              matchStatus: String(m.match_status || 'novo'),
              reasons: Array.isArray(breakdown.reasons)
                ? (breakdown.reasons as unknown[]).map((r) => String(r))
                : [],
            };
          });
        setFetchedProperties(mapped);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingMatches(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, suggestion.contact_id, initialCompatibleProperties]);

  const selectedProperty = useMemo(
    () => compatibleProperties.find((p) => p.propertyId === selectedPropertyId) ?? null,
    [compatibleProperties, selectedPropertyId],
  );

  const insertPropertyIntoFreeDraft = useCallback((prop: CompatiblePropertySummary) => {
    const location = [prop.neighborhood, prop.city].filter(Boolean).join(', ');
    const resolvedUrl = resolveClientPublicPropertyUrl(prop);
    const refLine = resolvedUrl
      ? `\n\nSeparei também esta opção que combina com o que você busca: ${prop.title}${location ? ` (${location})` : ''}\n${resolvedUrl}`
      : `\n\nSeparei também esta opção compatível com sua busca: ${prop.title}${location ? ` (${location})` : ''}.`;
    setFreeText((prev) => {
      const trimmed = prev.trim();
      if (trimmed.includes(prop.title)) {
        if (resolvedUrl && !trimmed.includes(resolvedUrl)) {
          return `${trimmed}\n${resolvedUrl}`.trim();
        }
        return prev;
      }
      return `${trimmed}${refLine}`.trim();
    });
    toast.success(`Imóvel "${prop.title}" incluído na preparação da mensagem.`);
  }, []);

  const applyPropertyToTemplateDraft = useCallback(
    (prop: CompatiblePropertySummary) => {
      if (!templateDraft) return;
      const typeLabel = formatPropertyTypePtBr(prop.propertyType)?.toLowerCase() || 'imóvel';
      const loc = prop.neighborhood || prop.city || 'João Pessoa';
      const contextPhrase = `${typeLabel} em ${loc} (${prop.title})`;

      setTemplateValues((prev) => {
        if (prev.length < 2) return prev;
        const next = [...prev];
        next[1] = contextPhrase;
        if (next.length >= 3 && prop.publicUrl) {
          next[2] = prop.publicUrl;
        }
        return next;
      });
      toast.success(`Contexto de "${prop.title}" aplicado às variáveis do template.`);
    },
    [templateDraft],
  );

  const handleSelectProperty = useCallback(
    (prop: CompatiblePropertySummary) => {
      const isDeselect = selectedPropertyId === prop.propertyId;
      const nextId = isDeselect ? null : prop.propertyId;
      setSelectedPropertyId(nextId);

      // Selecionar um imóvel NUNCA envia a mensagem automaticamente (Seção 9).
      // Apenas prepara/associa ao rascunho em edição quando aplicável.
      if (!isDeselect) {
        if (step === 'free_draft') {
          insertPropertyIntoFreeDraft(prop);
        } else if (step === 'template_draft' && templateDraft && templateValues.length >= 2) {
          applyPropertyToTemplateDraft(prop);
        }
      }
    },
    [
      selectedPropertyId,
      step,
      templateDraft,
      templateValues.length,
      insertPropertyIntoFreeDraft,
      applyPropertyToTemplateDraft,
    ],
  );

  const generate = useCallback(
    async (mode: 'free' | 'template' | 'plan') => {
      setBusy(true);
      setNoTemplateReason(null);
      try {
        const res = await fetch(`/api/ai/suggestions/${suggestion.id}/followup/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode,
            interestProperty,
            primaryNeed,
            selectedProperty: selectedProperty
              ? {
                  propertyId: selectedProperty.propertyId,
                  title: selectedProperty.title,
                  neighborhood: selectedProperty.neighborhood,
                  city: selectedProperty.city,
                  propertyType: selectedProperty.propertyType,
                  operation: selectedProperty.operation,
                  deliveryStatus: selectedProperty.deliveryStatus,
                  priceMin: selectedProperty.priceMin,
                  bedroomsMin: selectedProperty.bedroomsMin,
                  areaMin: selectedProperty.areaMin,
                  publicUrl: selectedProperty.publicUrl,
                }
              : null,
          }),
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
            setNoTemplateReason(
              typeof data.failureReason === 'string' && data.failureReason.trim()
                ? data.failureReason.trim()
                : null,
            );
            setStep('no_template');
          }
        } else if (data.draft?.plan) {
          setPlan(data.draft.plan);
          setStep('plan_review');
        } else {
          setNoTemplateReason(
            typeof data.failureReason === 'string' && data.failureReason.trim()
              ? data.failureReason.trim()
              : null,
          );
          setStep('no_template');
        }
      } catch {
        toast.error(t('generateError'));
      } finally {
        setBusy(false);
      }
    },
    [suggestion.id, interestProperty, primaryNeed, selectedProperty, t],
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

  const templateSupportsUrl = Boolean(
    templateDraft?.supports_public_url || (templateValues && templateValues.length >= 3),
  );

  const renderCompatiblePropertiesSelector = () => {
    if (compatibleProperties.length === 0 && !loadingMatches) return null;

    return (
      <div
        data-testid="followup-dialog-compatible-properties"
        className="rounded-xl border border-border/70 bg-card/60 p-3 space-y-2.5"
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
          <div className="space-y-2 pt-2 border-t border-border/50 max-h-60 overflow-y-auto pr-0.5">
            <p className="text-[11px] text-muted-foreground">
              Visualize as opções compatíveis e selecione um imóvel para preparar a abordagem (não envia a mensagem automaticamente):
            </p>
            {compatibleProperties.map((prop) => {
              const isSelected = selectedPropertyId === prop.propertyId;
              const typeLabel = formatPropertyTypePtBr(prop.propertyType);
              const priceLabel = formatCommercialPricePtBr(prop.priceMin, prop.priceMax);
              const bedroomsLabel =
                prop.bedroomsMin && prop.bedroomsMax && prop.bedroomsMax > prop.bedroomsMin
                  ? `${prop.bedroomsMin} a ${prop.bedroomsMax} quartos`
                  : prop.bedroomsMin
                    ? `${prop.bedroomsMin} ${prop.bedroomsMin === 1 ? 'quarto' : 'quartos'}`
                    : null;
              const areaLabel =
                prop.areaMin && prop.areaMin > 0 ? `${Math.round(prop.areaMin)} m²` : null;

              return (
                <div
                  key={prop.propertyId}
                  data-testid="followup-compatible-property-option"
                  className={`flex items-center justify-between gap-2.5 rounded-lg border p-2 text-xs transition-colors ${
                    isSelected
                      ? 'border-primary bg-primary/10 ring-1 ring-primary/25'
                      : 'border-border/60 bg-background/50 hover:border-border'
                  }`}
                >
                  <PropertyThumbnail coverUrl={prop.coverUrl} title={prop.title} sizeClass="size-12" />

                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.2 text-[10px] font-bold text-emerald-400 shrink-0">
                        {prop.matchScore}% compatível
                      </span>
                      <span className="font-semibold text-foreground truncate" title={prop.title}>
                        {prop.title}
                      </span>
                      {prop.code && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          ({prop.code})
                        </span>
                      )}
                    </div>

                    <p className="text-[11px] text-muted-foreground truncate">
                      {[
                        prop.neighborhood,
                        typeLabel,
                        areaLabel,
                        bedroomsLabel,
                        prop.operation === 'locacao' ? 'Locação' : 'Venda',
                      ]
                        .filter(Boolean)
                        .join(' • ')}
                    </p>

                    {priceLabel && (
                      <p className="text-[11px] font-semibold text-foreground/90">{priceLabel}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {prop.publicUrl && (
                      <a
                        href={prop.publicUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted"
                        title={`Abrir link público: ${prop.publicUrl}`}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant={isSelected ? 'default' : 'outline'}
                      onClick={() => handleSelectProperty(prop)}
                      className="h-7 px-2.5 text-[11px]"
                    >
                      {isSelected ? 'Selecionado' : 'Selecionar'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Resumo verificável do imóvel selecionado (Seção 9) */}
        {selectedProperty && (
          <div
            data-testid="followup-selected-property-summary"
            className="rounded-lg border border-primary/35 bg-primary/5 p-2.5 space-y-1.5 text-[11px]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground flex items-center gap-1.5 truncate">
                <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                <span>Imóvel selecionado: {selectedProperty.title}</span>
              </span>
              <span className="text-[10px] font-bold text-emerald-400 shrink-0">
                {selectedProperty.matchScore}% Match
              </span>
            </div>

            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Link2 className="h-3 w-3 text-primary shrink-0" />
              <span className="shrink-0">Link público:</span>
              {selectedProperty.publicUrl ? (
                <a
                  href={selectedProperty.publicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline truncate font-mono"
                  title={selectedProperty.publicUrl}
                >
                  {selectedProperty.publicUrl}
                </a>
              ) : (
                <span className="text-amber-400">Link público não disponível para este imóvel</span>
              )}
            </div>

            {step === 'template_draft' && templateDraft && (
              <p className="text-[10px] text-muted-foreground leading-snug pt-0.5 border-t border-border/40">
                {templateSupportsUrl ? (
                  <span className="text-emerald-400">
                    ✓ Este template aprovado permite incluir o link público nas variáveis.
                  </span>
                ) : (
                  <span className="text-amber-400">
                    Nota: O template aprovado &ldquo;{templateDraft.template_name}&rdquo; possui
                    estrutura fixa da Meta sem campo de URL; o contexto do imóvel foi preparado nas
                    variáveis permitidas e o link público poderá ser enviado assim que o cliente
                    responder e reabrir a janela de 24h.
                  </span>
                )}
              </p>
            )}

            {step === 'free_draft' && (
              <div className="flex items-center justify-between gap-2 pt-0.5 border-t border-border/40">
                <span className="text-[10px] text-emerald-400">
                  ✓ Formato de texto livre permite inserir o link público diretamente.
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => insertPropertyIntoFreeDraft(selectedProperty)}
                  className="h-6 px-2 text-[10px] gap-1"
                >
                  <Plus className="h-2.5 w-2.5" />
                  Inserir no texto
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{suggestion.contact?.name ?? t('title')}</DialogTitle>
          <DialogDescription>{t('title')}</DialogDescription>
        </DialogHeader>

        {/* Indicador em tempo real da Janela de Atendimento de 24h vs. Benefício CTWA (Seção 5) */}
        <div
          data-testid="followup-dialog-window-banner"
          className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
            liveSessionWindow.status === 'closing_soon'
              ? 'border-amber-500/35 bg-amber-500/10 text-amber-300'
              : liveSessionWindow.status === 'open'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-border/70 bg-muted/40 text-muted-foreground'
          }`}
        >
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            {liveSessionWindow.status === 'closing_soon' ? (
              <span>
                <strong>Janela prestes a encerrar</strong> ({liveSessionWindow.remainingLabel}) —
                texto livre permitido agora
              </span>
            ) : liveSessionWindow.status === 'open' ? (
              <span>
                <strong>Janela de 24h aberta</strong> ({liveSessionWindow.remainingLabel}) — texto
                livre permitido
              </span>
            ) : liveSessionWindow.status === 'expired' ? (
              <span>
                <strong>Janela de 24h encerrada</strong> — envio via Cloud API exige template
                aprovado
              </span>
            ) : (
              <span>
                <strong>Situação da janela desconhecida</strong> — envio via Cloud API exige
                template aprovado
              </span>
            )}
          </div>
          {liveSessionWindow.ctwaFreeBenefitActive &&
            liveSessionWindow.ctwaFreeBenefitRemainingLabel && (
              <span
                className="rounded-full bg-primary/15 border border-primary/25 px-2 py-0.5 text-[10px] font-semibold text-primary"
                title="A janela gratuita CTWA isenta a tarifa da Meta, mas não substitui a exigência de template quando a janela de 24h está encerrada."
              >
                {liveSessionWindow.ctwaFreeBenefitRemainingLabel}
              </span>
            )}
        </div>

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

            {/* Lista visual de imóveis compatíveis do Match com miniaturas reais (Seção 9) */}
            {renderCompatiblePropertiesSelector()}
          </div>
        )}

        {step === 'choose_mode' && (
          <div className="space-y-3">
            {renderCompatiblePropertiesSelector()}

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
          </div>
        )}

        {step === 'free_draft' && (
          <div className="space-y-3">
            {renderCompatiblePropertiesSelector()}

            <div className="space-y-1.5">
              <Label className="text-xs">{t('messagePreview')}</Label>
              <Textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                rows={6}
                className="text-sm"
              />
            </div>

            {!liveSessionWindow.windowOpen && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] text-amber-300">
                <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  A janela de 24 horas da WhatsApp Cloud API está encerrada. Este texto livre pode
                  ser copiado para uso manual, mas o envio direto pela Cloud API exige um template
                  aprovado.
                </span>
              </div>
            )}
          </div>
        )}

        {step === 'template_draft' && templateDraft && (
          <div className="space-y-3">
            {/* Permite consultar e selecionar os imóveis compatíveis também na opção de envio pelo CRM (Seção 9.4) */}
            {renderCompatiblePropertiesSelector()}

            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p className="mb-1 text-xs text-muted-foreground">
                {t('templateUsed')}: <strong className="text-foreground">{templateDraft.template_name}</strong>
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
                    prev?.contact1
                      ? {
                          ...prev,
                          contact1: {
                            ...prev.contact1,
                            values: { ...prev.contact1.values, body: values },
                          },
                        }
                      : prev,
                  )
                }
                onScheduleChange={(days) =>
                  setPlan((prev) =>
                    prev?.contact1
                      ? { ...prev, contact1: { ...prev.contact1, scheduleDays: days } }
                      : prev,
                  )
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
                    prev?.contact2
                      ? {
                          ...prev,
                          contact2: {
                            ...prev.contact2,
                            values: { ...prev.contact2.values, body: values },
                          },
                        }
                      : prev,
                  )
                }
                onScheduleChange={(days) =>
                  setPlan((prev) =>
                    prev?.contact2
                      ? { ...prev, contact2: { ...prev.contact2, scheduleDays: days } }
                      : prev,
                  )
                }
              />
            )}
          </div>
        )}

        {step === 'no_template' && (
          <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs">
            <div className="flex items-start gap-2 text-amber-300">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold">Não foi possível associar um template aprovado</p>
                <p className="text-muted-foreground leading-relaxed">
                  {noTemplateReason || t('noTemplate')}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Você pode preparar a mensagem livre para copiar, agendar ou abrir a conversa na Caixa
              de Entrada.
            </p>
          </div>
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
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" onClick={() => setStep('choose_mode')}>
                  {t('back')}
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => generate('free')}>
                  <RotateCcw className="h-3.5 w-3.5" /> {t('regenerate')}
                </Button>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={copyToClipboard}>
                  <Copy className="h-3.5 w-3.5" /> {t('copyButton')}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => complete('whatsapp')}>
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  {t('markDone')}
                </Button>
              </div>
            </>
          )}

          {step === 'template_draft' && (
            <>
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" onClick={() => setStep('choose_mode')}>
                  {t('back')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => generate('template')}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> {t('regenerate')}
                </Button>
              </div>
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
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" onClick={() => setStep('choose_mode')}>
                  {t('back')}
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => generate('plan')}>
                  <RotateCcw className="h-3.5 w-3.5" /> {t('regenerate')}
                </Button>
              </div>
              <Button size="sm" disabled={busy} onClick={approvePlan}>
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {t('approvePlan')}
              </Button>
            </>
          )}

          {step === 'no_template' && (
            <div className="flex w-full items-center justify-between gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep('choose_mode')}>
                {t('back')}
              </Button>
              <div className="flex gap-2">
                {suggestion.conversation_id && (
                  <Button
                    variant="outline"
                    size="sm"
                    render={<a href={`/inbox?c=${suggestion.conversation_id}`} />}
                  >
                    <MessageSquare className="h-3.5 w-3.5" /> {t('viewConversation')}
                  </Button>
                )}
                <Button size="sm" onClick={() => generate('free')}>
                  <Copy className="h-3.5 w-3.5" /> {t('modeWhatsApp')}
                </Button>
              </div>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
