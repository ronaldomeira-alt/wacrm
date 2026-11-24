'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertCircle,
  Ban,
  Building2,
  Check,
  CheckSquare,
  Circle,
  CircleDot,
  Clock,
  Copy,
  ExternalLink,
  GitBranch,
  Loader2,
  MessageSquare,
  Send,
  ShieldAlert,
  Sparkles,
  Square,
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
import { resolveValidatedPublicPropertyUrl } from '@/lib/match/smart-send';
import { renderTemplatePreview } from '@/lib/whatsapp/template-validators';
import {
  FOLLOWUP_MAX_RECOMMENDED_PROPERTIES,
  FOLLOWUP_REQUIRED_TEMPLATE_NAME,
  buildMatchImovelPersonalizadoParams,
  buildMultiPropertyFreeFollowupMessage,
  evaluateFollowupSessionWindow,
  extractPropertyUrlSlug,
  formatNaturalElapsedContactPtBr,
  type CompatiblePropertySummary,
  type FollowupSessionWindowInfo,
} from '@/lib/followup/engine';
import type { AiSuggestion } from '@/types';

const SNOOZE_DAYS = 3;

interface FollowupPayload {
  stage_name?: string | null;
  hours_since_contact?: number;
  last_customer_message_at?: string | null;
  reason?: string | null;
  [key: string]: unknown;
}

interface TemplateDraftState {
  template_id: string;
  template_name: string;
  template_language: string;
  body_text: string;
  body_values: string[];
  button_text: string;
  button_url: string;
  button_url_suffix: string;
}

type ModalStep = 'review' | 'prepare_free' | 'prepare_template' | 'template_blocked';

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

function formatCommercialPricePtBr(
  priceMin?: number | null,
  priceMax?: number | null
): string | null {
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
}: {
  coverUrl?: string | null;
  title: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!coverUrl || failed) {
    return (
      <div
        data-testid="followup-property-thumbnail-fallback"
        className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/50 text-muted-foreground"
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
      className="size-12 shrink-0 rounded-lg border border-border/70 object-cover bg-muted/30"
    />
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
  interestProperty,
  reason: overrideReason,
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
  reason?: string | null;
  lastCustomerMessageAt?: string | null;
  sessionWindow?: FollowupSessionWindowInfo;
}) {
  const payload = (suggestion.payload ?? {}) as FollowupPayload;
  const contactName = suggestion.contact?.name?.trim() || 'Cliente';
  const stageName = overrideStageName ?? payload.stage_name ?? null;
  const displayReason =
    (overrideReason && overrideReason.trim()) ||
    (payload.reason && payload.reason.trim()) ||
    suggestion.title ||
    '';

  const [step, setStep] = useState<ModalStep>('review');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [windowClosedMidFlow, setWindowClosedMidFlow] = useState(false);

  const [freeText, setFreeText] = useState('');
  const [templateDraft, setTemplateDraft] = useState<TemplateDraftState | null>(null);
  const [templateBlockedReason, setTemplateBlockedReason] = useState<string | null>(null);

  const [fetchedProperties, setFetchedProperties] = useState<CompatiblePropertySummary[] | null>(
    null
  );
  const [loadingMatches, setLoadingMatches] = useState(false);

  // Chave de idempotência para evitar envios duplicados em cliques repetidos
  const sendAttemptRef = useRef<string | null>(null);
  const sendingGuardRef = useRef(false);

  // Atualiza contagem da janela de 24h em tempo real enquanto o modal está aberto
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const liveSessionWindow = useMemo<FollowupSessionWindowInfo>(() => {
    if (windowClosedMidFlow) {
      return {
        status: 'expired',
        windowOpen: false,
        closingSoon: false,
        templateRequired: true,
        remainingMs: 0,
        remainingLabel: null,
        isCtwaLead: initialSessionWindow?.isCtwaLead ?? false,
        ctwaFreeBenefitActive: initialSessionWindow?.ctwaFreeBenefitActive ?? false,
        ctwaFreeBenefitExpiresAt: initialSessionWindow?.ctwaFreeBenefitExpiresAt ?? null,
        ctwaFreeBenefitRemainingLabel: initialSessionWindow?.ctwaFreeBenefitRemainingLabel ?? null,
      };
    }

    const effectiveCustAt =
      lastCustomerMessageAt !== undefined
        ? lastCustomerMessageAt
        : (payload.last_customer_message_at ?? null);
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
  }, [
    windowClosedMidFlow,
    lastCustomerMessageAt,
    payload.last_customer_message_at,
    initialSessionWindow,
    nowTick,
  ]);

  const isWindowOpen = liveSessionWindow.windowOpen;

  // Imóveis compatíveis (exclusivamente venda, link válido, até 3 opções)
  const compatibleProperties = useMemo<CompatiblePropertySummary[]>(() => {
    const base =
      initialCompatibleProperties && initialCompatibleProperties.length > 0
        ? initialCompatibleProperties
        : (fetchedProperties ?? []);
    return base
      .filter((p) => String(p.operation || 'venda').toLowerCase() === 'venda')
      .map((p) => ({
        ...p,
        operation: 'venda',
        publicUrl: resolveClientPublicPropertyUrl(p),
      }))
      .filter((p) => Boolean(p.publicUrl))
      .slice(0, FOLLOWUP_MAX_RECOMMENDED_PROPERTIES);
  }, [initialCompatibleProperties, fetchedProperties]);

  const [selectedPropertyIds, setSelectedPropertyIds] = useState<string[]>(() => {
    const initial = (initialCompatibleProperties || [])
      .filter((p) => String(p.operation || 'venda').toLowerCase() === 'venda')
      .slice(0, FOLLOWUP_MAX_RECOMMENDED_PROPERTIES);
    if (initial.length === 0) return [];
    return initialSessionWindow?.windowOpen
      ? initial.map((p) => p.propertyId)
      : [initial[0].propertyId];
  });

  // Inicializa seleção quando os imóveis são carregados sob demanda
  useEffect(() => {
    if (compatibleProperties.length === 0) return;
    setSelectedPropertyIds((prev) => {
      const validPrev = prev.filter((id) =>
        compatibleProperties.some((p) => p.propertyId === id)
      );
      if (validPrev.length > 0) {
        return isWindowOpen ? validPrev : [validPrev[0]];
      }
      return isWindowOpen
        ? compatibleProperties.map((p) => p.propertyId)
        : [compatibleProperties[0].propertyId];
    });
  }, [compatibleProperties, isWindowOpen]);

  // Carrega matches sob demanda se o modal foi aberto sem a lista pré-hidratada
  useEffect(() => {
    if (initialCompatibleProperties && initialCompatibleProperties.length > 0) return;
    if (!open || !suggestion.contact_id) return;
    let active = true;
    const controller = new AbortController();
    setLoadingMatches(true);
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
          .map((m) => {
            const prop = (m.property ?? {}) as Record<string, unknown>;
            const breakdown = (m.score_breakdown ?? {}) as Record<string, unknown>;
            const coverUrl = prop.coverUrl ? String(prop.coverUrl) : null;
            const rawPublicUrl = prop.publicUrl ? String(prop.publicUrl) : null;
            const propertyId = String(prop.propertyId || m.property_id || '');
            const code = prop.code ? String(prop.code) : null;
            const operation = String(prop.operation || data.searchProfile?.operation || 'venda').toLowerCase();
            return {
              matchId: String(m.id || ''),
              propertyId,
              title: String(prop.title || 'Imóvel compatível'),
              code,
              neighborhood: String(prop.neighborhood || ''),
              city: String(prop.city || 'João Pessoa'),
              operation,
              propertyType: prop.propertyType ? String(prop.propertyType) : null,
              priceMin: Number(prop.priceMin || 0),
              priceMax: Number(prop.priceMax || 0),
              bedroomsMin: prop.bedroomsMin != null ? Number(prop.bedroomsMin) : null,
              bedroomsMax: prop.bedroomsMax != null ? Number(prop.bedroomsMax) : null,
              areaMin: prop.areaMin != null ? Number(prop.areaMin) : null,
              areaMax: prop.areaMax != null ? Number(prop.areaMax) : null,
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
          })
          .filter((p) => p.operation === 'venda' && Boolean(p.publicUrl))
          .slice(0, FOLLOWUP_MAX_RECOMMENDED_PROPERTIES);
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

  const selectedProperties = useMemo(
    () => compatibleProperties.filter((p) => selectedPropertyIds.includes(p.propertyId)),
    [compatibleProperties, selectedPropertyIds]
  );

  // Alterna seleção respeitando estritamente a regra da janela:
  // - Janela aberta: multi-seleção (1 ou vários imóveis)
  // - Janela encerrada: seleção única (exatamente 1 imóvel)
  const handleToggleProperty = useCallback(
    (prop: CompatiblePropertySummary) => {
      let nextIds: string[];
      if (isWindowOpen) {
        const exists = selectedPropertyIds.includes(prop.propertyId);
        nextIds = exists
          ? selectedPropertyIds.filter((id) => id !== prop.propertyId)
          : [...selectedPropertyIds, prop.propertyId];
      } else {
        nextIds = [prop.propertyId];
      }

      setSelectedPropertyIds(nextIds);
      sendAttemptRef.current = null;

      const nextSelected = compatibleProperties.filter((p) => nextIds.includes(p.propertyId));

      // Se já estiver preparando a mensagem livre, atualiza texto e links imediatamente
      if (step === 'prepare_free') {
        setFreeText(
          buildMultiPropertyFreeFollowupMessage({
            contactName,
            properties: nextSelected,
            interestProperty,
          })
        );
      }

      // Se já estiver preparando o template match_imovel_personalizado, atualiza variáveis e link do botão
      if (step === 'prepare_template' && templateDraft && nextSelected[0]) {
        const rebuilt = buildMatchImovelPersonalizadoParams({
          contactName,
          property: nextSelected[0],
        });
        setTemplateDraft({
          ...templateDraft,
          body_values: rebuilt.body,
          button_url: nextSelected[0].publicUrl || templateDraft.button_url,
          button_url_suffix:
            rebuilt.buttonUrlSuffix ||
            extractPropertyUrlSlug(nextSelected[0].publicUrl) ||
            templateDraft.button_url_suffix,
        });
      }
    },
    [
      isWindowOpen,
      selectedPropertyIds,
      compatibleProperties,
      step,
      contactName,
      interestProperty,
      templateDraft,
    ]
  );

  const prepareTemplateMessage = useCallback(
    async (targetProp: CompatiblePropertySummary) => {
      setBusy(true);
      setTemplateBlockedReason(null);
      try {
        const res = await fetch(`/api/ai/suggestions/${suggestion.id}/followup/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'template',
            interestProperty,
            selectedProperties: [targetProp],
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error || 'Falha ao preparar o template.');
        }
        if (!data.draft) {
          setTemplateDraft(null);
          setTemplateBlockedReason(
            data.failureReason ||
              `O template "${FOLLOWUP_REQUIRED_TEMPLATE_NAME}" não está aprovado para envio.`
          );
          setStep('template_blocked');
          return;
        }
        const suffix =
          data.draft.values?.buttonParams?.[0] ||
          extractPropertyUrlSlug(targetProp.publicUrl) ||
          '';
        setTemplateDraft({
          template_id: data.draft.template_id,
          template_name: data.draft.template_name,
          template_language: data.draft.template_language || 'pt_BR',
          body_text: data.draft.body_text,
          body_values: Array.isArray(data.draft.values?.body) ? data.draft.values.body : [],
          button_text: data.draft.button_text || 'Ver imóvel',
          button_url: data.draft.button_url || targetProp.publicUrl || '',
          button_url_suffix: suffix,
        });
        setStep('prepare_template');
      } catch (err) {
        toast.error((err as Error).message || 'Não foi possível preparar o template.');
      } finally {
        setBusy(false);
      }
    },
    [suggestion.id, interestProperty]
  );

  // Preparar mensagem (NÃO envia e NÃO conclui o follow-up)
  const handlePrepareMessage = useCallback(async () => {
    if (selectedProperties.length === 0) {
      toast.error('Selecione ao menos um imóvel compatível antes de preparar a mensagem.');
      return;
    }

    sendAttemptRef.current = null;

    if (!isWindowOpen) {
      const single = selectedProperties[0];
      setSelectedPropertyIds([single.propertyId]);
      await prepareTemplateMessage(single);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/ai/suggestions/${suggestion.id}/followup/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'free',
          interestProperty,
          selectedProperties,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 && data?.code === 'window_expired') {
        // Janela encerrou antes mesmo da preparação -> adapta com transparência
        setWindowClosedMidFlow(true);
        const single = selectedProperties[0];
        setSelectedPropertyIds([single.propertyId]);
        toast.warning(
          'A janela de 24 horas foi encerrada. Adaptando para envio com 1 imóvel pelo template match_imovel_personalizado.'
        );
        await prepareTemplateMessage(single);
        return;
      }

      if (!res.ok) {
        throw new Error(data?.error || 'Não foi possível preparar a mensagem.');
      }

      setFreeText(
        data.draft?.text ||
          buildMultiPropertyFreeFollowupMessage({
            contactName,
            properties: selectedProperties,
            interestProperty,
          })
      );
      setStep('prepare_free');
    } catch (err) {
      toast.error((err as Error).message || 'Não foi possível preparar a mensagem.');
    } finally {
      setBusy(false);
    }
  }, [
    selectedProperties,
    isWindowOpen,
    suggestion.id,
    interestProperty,
    contactName,
    prepareTemplateMessage,
  ]);

  // Envio explícito confirmado pelo corretor (com revalidação da janela no backend e idempotência)
  const handleSendFreeMessage = useCallback(async () => {
    if (sendingGuardRef.current || sending) return;
    if (selectedProperties.length === 0) {
      toast.error('Selecione ao menos um imóvel para enviar.');
      return;
    }
    if (!freeText.trim()) {
      toast.error('Escreva ou revise a mensagem antes de enviar.');
      return;
    }

    sendingGuardRef.current = true;
    setSending(true);
    if (!sendAttemptRef.current) {
      sendAttemptRef.current = `followup-free-${suggestion.id}-${Date.now()}`;
    }

    try {
      const res = await fetch(`/api/ai/suggestions/${suggestion.id}/followup/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'free',
          text: freeText.trim(),
          selectedProperties,
          client_ref: sendAttemptRef.current,
        }),
      });
      const data = await res.json().catch(() => ({}));

      // Seção 12: Janela encerrou entre a preparação e o envio!
      if (res.status === 409 && data?.code === 'window_expired') {
        setWindowClosedMidFlow(true);
        sendAttemptRef.current = null;
        const single = selectedProperties[0];
        setSelectedPropertyIds([single.propertyId]);
        toast.warning(
          'A janela de conversação foi encerrada antes do envio. Selecione apenas um imóvel para enviar com o template match_imovel_personalizado.'
        );
        await prepareTemplateMessage(single);
        return;
      }

      if (!res.ok) {
        throw new Error(data?.error || 'Falha ao enviar mensagem pelo WhatsApp.');
      }

      toast.success('Follow-up enviado e concluído com sucesso!');
      onResolved();
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || 'Falha ao enviar mensagem. O follow-up não foi concluído.');
    } finally {
      sendingGuardRef.current = false;
      setSending(false);
    }
  }, [
    sending,
    selectedProperties,
    freeText,
    suggestion.id,
    prepareTemplateMessage,
    onResolved,
    onOpenChange,
  ]);

  const handleSendTemplateMessage = useCallback(async () => {
    if (sendingGuardRef.current || sending || !templateDraft) return;
    if (selectedProperties.length !== 1) {
      toast.error('Selecione exatamente um imóvel para enviar pelo template.');
      return;
    }

    sendingGuardRef.current = true;
    setSending(true);
    if (!sendAttemptRef.current) {
      sendAttemptRef.current = `followup-tpl-${suggestion.id}-${Date.now()}`;
    }

    try {
      const res = await fetch(`/api/ai/suggestions/${suggestion.id}/followup/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'template',
          template_name: FOLLOWUP_REQUIRED_TEMPLATE_NAME,
          body_values: templateDraft.body_values,
          button_url_suffix: templateDraft.button_url_suffix,
          selectedProperties: [selectedProperties[0]],
          client_ref: sendAttemptRef.current,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data?.code === 'template_not_approved') {
          setTemplateBlockedReason(data.error);
          setStep('template_blocked');
          return;
        }
        throw new Error(data?.error || 'Falha ao enviar template pelo WhatsApp.');
      }

      toast.success('Template enviado e follow-up concluído!');
      onResolved();
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || 'Falha ao enviar template. O follow-up não foi concluído.');
    } finally {
      sendingGuardRef.current = false;
      setSending(false);
    }
  }, [sending, templateDraft, selectedProperties, suggestion.id, onResolved, onOpenChange]);

  // Aceitar: altera status para 'approved' (NÃO envia e NÃO conclui)
  const handleAccept = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/suggestions/${suggestion.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      });
      if (!res.ok) throw new Error();
      toast.success('Oportunidade aceita! Você pode preparar e enviar a mensagem quando desejar.');
      onResolved();
      onOpenChange(false);
    } catch {
      toast.error('Não foi possível aceitar a oportunidade.');
    } finally {
      setBusy(false);
    }
  }, [suggestion.id, onResolved, onOpenChange]);

  const handleIgnore = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/suggestions/${suggestion.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ignored' }),
      });
      if (!res.ok) throw new Error();
      toast.success('Oportunidade ignorada.');
      onResolved();
      onOpenChange(false);
    } catch {
      toast.error('Não foi possível ignorar a oportunidade.');
    } finally {
      setBusy(false);
    }
  }, [suggestion.id, onResolved, onOpenChange]);

  const handleSnooze = useCallback(async () => {
    setBusy(true);
    try {
      const until = new Date(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const res = await fetch(`/api/ai/suggestions/${suggestion.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending', snoozed_until: until }),
      });
      if (!res.ok) throw new Error();
      toast.success(`Oportunidade adiada por ${SNOOZE_DAYS} dias.`);
      onResolved();
      onOpenChange(false);
    } catch {
      toast.error('Não foi possível adiar a oportunidade.');
    } finally {
      setBusy(false);
    }
  }, [suggestion.id, onResolved, onOpenChange]);

  const handleManualComplete = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/suggestions/${suggestion.id}/followup/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'whatsapp',
          message: freeText || undefined,
          selectedProperties: selectedProperties.map((p) => ({
            propertyId: p.propertyId,
            title: p.title,
            publicUrl: p.publicUrl,
          })),
        }),
      });
      if (!res.ok) throw new Error();
      toast.success('Follow-up marcado manualmente como realizado.');
      onResolved();
      onOpenChange(false);
    } catch {
      toast.error('Não foi possível concluir manualmente.');
    } finally {
      setBusy(false);
    }
  }, [suggestion.id, freeText, selectedProperties, onResolved, onOpenChange]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(freeText);
      toast.success('Mensagem copiada.');
    } catch {
      toast.error('Não foi possível copiar a mensagem.');
    }
  }, [freeText]);

  const effectiveCustAtForElapsed =
    lastCustomerMessageAt !== undefined
      ? lastCustomerMessageAt
      : (payload.last_customer_message_at ?? null);
  const effectiveHoursForElapsed =
    typeof hoursSinceLastCommunication === 'number'
      ? hoursSinceLastCommunication
      : typeof payload.hours_since_contact === 'number'
        ? payload.hours_since_contact
        : null;
  const naturalLastContactLabel = neverContacted
    ? 'Nunca contatado'
    : effectiveCustAtForElapsed || effectiveHoursForElapsed !== null
      ? formatNaturalElapsedContactPtBr({
          hours: effectiveHoursForElapsed,
          lastContactAt: effectiveCustAtForElapsed,
          neverContacted,
          nowMs: nowTick,
        })
      : null;

  const gridColsClass =
    compatibleProperties.length <= 1
      ? 'grid-cols-1'
      : compatibleProperties.length === 2
        ? 'grid-cols-1 md:grid-cols-2'
        : 'grid-cols-1 md:grid-cols-3';

  const renderPropertyCards = () => (
    <div data-testid="followup-dialog-compatible-properties" className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-primary shrink-0" />
          Imóveis selecionados para recomendar
        </span>
        <span className="text-[11px] text-muted-foreground">
          {isWindowOpen
            ? 'Selecione um ou mais imóveis'
            : 'Selecione apenas 1 imóvel (janela encerrada)'}
        </span>
      </div>

      {loadingMatches ? (
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin text-primary" />
          <span>Buscando opções compatíveis no estoque...</span>
        </div>
      ) : compatibleProperties.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
          Nenhum imóvel de venda compatível com link público válido disponível no momento.
        </div>
      ) : (
        <div
          data-testid="followup-properties-grid"
          className={`grid ${gridColsClass} gap-3`}
        >
          {compatibleProperties.map((prop) => {
            const isSelected = selectedPropertyIds.includes(prop.propertyId);
            const typeLabel = formatPropertyTypePtBr(prop.propertyType);
            const priceLabel = formatCommercialPricePtBr(prop.priceMin, prop.priceMax);
            const bedroomsLabel =
              prop.bedroomsMin && prop.bedroomsMax && prop.bedroomsMax > prop.bedroomsMin
                ? `${prop.bedroomsMin} a ${prop.bedroomsMax} quartos`
                : prop.bedroomsMin
                  ? `${prop.bedroomsMin} ${prop.bedroomsMin === 1 ? 'quarto' : 'quartos'}`
                  : null;
            const areaMinVal =
              prop.areaMin != null && prop.areaMin > 0 ? Math.round(prop.areaMin) : null;
            const areaMaxVal =
              prop.areaMax != null && prop.areaMax > 0 ? Math.round(prop.areaMax) : null;
            const areaLabel =
              areaMinVal && areaMaxVal && areaMaxVal > areaMinVal
                ? `${areaMinVal} a ${areaMaxVal} m²`
                : areaMinVal
                  ? `${areaMinVal} m²`
                  : areaMaxVal
                    ? `${areaMaxVal} m²`
                    : null;

            return (
              <div
                key={prop.propertyId}
                data-testid="followup-compatible-property-option"
                onClick={() => handleToggleProperty(prop)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleToggleProperty(prop);
                  }
                }}
                className={`flex flex-col justify-between gap-2.5 rounded-xl border p-3 text-xs transition-all cursor-pointer min-h-[112px] ${
                  isSelected
                    ? 'border-primary bg-primary/10 ring-1 ring-primary/25 shadow-xs'
                    : 'border-border/60 bg-background/50 hover:border-border'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    <span className="shrink-0 text-primary mt-0.5" aria-hidden>
                      {isWindowOpen ? (
                        isSelected ? (
                          <CheckSquare className="size-4" />
                        ) : (
                          <Square className="size-4 text-muted-foreground" />
                        )
                      ) : isSelected ? (
                        <CircleDot className="size-4" />
                      ) : (
                        <Circle className="size-4 text-muted-foreground" />
                      )}
                    </span>

                    <PropertyThumbnail coverUrl={prop.coverUrl} title={prop.title} />

                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-start justify-between gap-1.5">
                        <span
                          className="font-semibold text-foreground leading-snug line-clamp-2"
                          title={prop.title}
                        >
                          {prop.title}
                        </span>
                      </div>

                      {prop.neighborhood && (
                        <p className="text-[11px] text-muted-foreground truncate">
                          {[prop.neighborhood, typeLabel].filter(Boolean).join(' • ')}
                        </p>
                      )}
                    </div>
                  </div>

                  {prop.publicUrl && (
                    <a
                      href={prop.publicUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex h-9 w-9 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted"
                      title="Visualizar imóvel"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  )}
                </div>

                {/* Metragem, Quartos, Valor e Compatibilidade */}
                <div className="flex flex-col gap-1.5 pt-2 border-t border-border/40">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {areaLabel && (
                      <span
                        data-testid="followup-property-area-badge"
                        className="rounded-md bg-muted/70 border border-border/60 px-1.5 py-0.5 text-[10px] font-semibold text-foreground"
                      >
                        {areaLabel}
                      </span>
                    )}
                    {bedroomsLabel && (
                      <span
                        data-testid="followup-property-bedrooms-badge"
                        className="rounded-md bg-muted/70 border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground/90"
                      >
                        {bedroomsLabel}
                      </span>
                    )}
                    {prop.matchScore > 0 && (
                      <span
                        data-testid="followup-property-score-badge"
                        className="ml-auto rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-400 shrink-0"
                      >
                        {prop.matchScore}% compatível
                      </span>
                    )}
                  </div>

                  {priceLabel && (
                    <p
                      data-testid="followup-property-price"
                      className="text-xs font-bold text-foreground"
                    >
                      {priceLabel}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="followup-dialog-content"
        className="w-[calc(100vw-1rem)] max-w-full sm:max-w-2xl md:max-w-3xl lg:max-w-4xl max-h-[90dvh] overflow-y-auto overflow-x-hidden p-4 sm:p-6 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        {/* 1. Identificação */}
        <DialogHeader className="space-y-1.5 text-left">
          <DialogTitle className="text-base sm:text-lg font-bold text-foreground">
            {contactName}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {stageName && (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3 text-primary" />
                Etapa: <strong className="text-foreground font-medium">{stageName}</strong>
              </span>
            )}
            {interestProperty && (
              <span className="inline-flex items-center gap-1">
                <Building2 className="size-3 text-primary" />
                Empreendimento:{' '}
                <strong className="text-foreground font-medium">{interestProperty}</strong>
              </span>
            )}
            {naturalLastContactLabel && (
              <span
                data-testid="followup-dialog-last-contact"
                className="inline-flex items-center gap-1"
              >
                <Clock className="size-3 text-primary" />
                Último contato:{' '}
                <strong className="text-foreground font-medium">{naturalLastContactLabel}</strong>
              </span>
            )}
            {!stageName && !interestProperty && !naturalLastContactLabel && (
              <span>Oportunidade de Follow-up</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Status da janela de conversação */}
        <div
          data-testid="followup-dialog-window-banner"
          className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs ${
            liveSessionWindow.status === 'closing_soon'
              ? 'border-amber-500/35 bg-amber-500/10 text-amber-300'
              : liveSessionWindow.status === 'open'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-border/70 bg-muted/40 text-muted-foreground'
          }`}
        >
          <div className="flex items-center gap-1.5">
            <Clock className="size-3.5 shrink-0" />
            {liveSessionWindow.windowOpen ? (
              <span>
                <strong>Janela de conversação aberta</strong>
                {liveSessionWindow.remainingLabel ? ` (${liveSessionWindow.remainingLabel})` : ''}
              </span>
            ) : (
              <span>
                <strong>Janela de conversação encerrada</strong> — envio via template{' '}
                <code className="text-[11px] font-mono">{FOLLOWUP_REQUIRED_TEMPLATE_NAME}</code>
              </span>
            )}
          </div>
        </div>

        {/* Aviso quando a janela fechou durante a preparação */}
        {windowClosedMidFlow && (
          <div
            data-testid="followup-window-closed-alert"
            className="flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 text-xs text-amber-300"
          >
            <ShieldAlert className="size-4 shrink-0 mt-0.5" />
            <span>
              A janela de 24 horas foi encerrada enquanto você preparava a mensagem. Seus imóveis
              recomendados foram preservados — selecione apenas um imóvel para enviar usando o
              template <strong>{FOLLOWUP_REQUIRED_TEMPLATE_NAME}</strong>.
            </span>
          </div>
        )}

        {/* 2. Por que retomar esse contato? */}
        <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Por que retomar esse contato?
          </p>
          <p className="text-xs sm:text-sm text-foreground leading-relaxed">{displayReason}</p>
        </div>

        {/* 3. Imóveis selecionados para recomendar */}
        {renderPropertyCards()}

        {/* Etapa: Preparar mensagem livre (Janela Aberta) */}
        {step === 'prepare_free' && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold">Mensagem pronta para envio</Label>
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Copy className="size-3" />
                Copiar texto
              </button>
            </div>
            <Textarea
              data-testid="followup-free-textarea"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              rows={7}
              className="text-xs sm:text-sm leading-relaxed"
            />
          </div>
        )}

        {/* Etapa: Preparar template match_imovel_personalizado (Janela Encerrada) */}
        {step === 'prepare_template' && templateDraft && (
          <div className="space-y-3 pt-1">
            <div className="rounded-xl border border-border bg-muted/40 p-3 space-y-2 text-xs sm:text-sm">
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  Template oficial:{' '}
                  <strong className="text-foreground font-mono">{templateDraft.template_name}</strong>
                </span>
                <span className="uppercase">{templateDraft.template_language}</span>
              </div>
              <p
                data-testid="followup-template-preview"
                className="whitespace-pre-wrap text-foreground leading-relaxed"
              >
                {renderTemplatePreview(templateDraft.body_text, templateDraft.body_values)}
              </p>
              <div className="pt-2 border-t border-border/50 flex items-center justify-between gap-2">
                <a
                  href={templateDraft.button_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20"
                >
                  <ExternalLink className="size-3" />
                  <span>{templateDraft.button_text}</span>
                </a>
                <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[200px]">
                  {templateDraft.button_url}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {templateDraft.body_values.map((val, idx) => (
                <div key={idx} className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">
                    {idx === 0 ? 'Variável {{1}} (Nome)' : `Variável {{${idx + 1}}} (Contexto)`}
                  </Label>
                  <Input
                    value={val}
                    onChange={(e) => {
                      const next = [...templateDraft.body_values];
                      next[idx] = e.target.value;
                      setTemplateDraft({ ...templateDraft, body_values: next });
                    }}
                    className="h-8 text-xs"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Etapa: Template obrigatório bloqueado/não aprovado */}
        {step === 'template_blocked' && (
          <div
            data-testid="followup-template-blocked"
            className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300 flex items-start gap-2"
          >
            <AlertCircle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">Envio fora da janela bloqueado</p>
              <p className="text-rose-200/90 leading-relaxed">
                {templateBlockedReason ||
                  `O template obrigatório "${FOLLOWUP_REQUIRED_TEMPLATE_NAME}" não está aprovado pela Meta para envio.`}
              </p>
            </div>
          </div>
        )}

        {/* 4. Ações comerciais */}
        <DialogFooter className="flex-col sm:flex-row gap-2 sm:justify-between pt-2 border-t border-border/50">
          {step === 'review' && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleIgnore()}
                  className="h-8 px-2.5 text-xs text-muted-foreground hover:text-rose-400 gap-1"
                >
                  <Ban className="size-3.5" />
                  Ignorar
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleSnooze()}
                  className="h-8 px-2.5 text-xs text-muted-foreground gap-1"
                >
                  <Clock className="size-3.5" />
                  Adiar
                </Button>
                {suggestion.conversation_id && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2.5 text-xs text-muted-foreground gap-1"
                    render={<a href={`/inbox?c=${encodeURIComponent(suggestion.conversation_id)}`} />}
                  >
                    <MessageSquare className="size-3.5" />
                    Ver conversa
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-2 justify-end">
                {suggestion.status === 'pending' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleAccept()}
                    className="h-8 px-3 text-xs gap-1"
                  >
                    <Check className="size-3.5" />
                    Aceitar
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || selectedProperties.length === 0}
                  onClick={() => void handlePrepareMessage()}
                  className="h-8 px-3 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white"
                >
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                  Preparar mensagem
                </Button>
              </div>
            </>
          )}

          {step === 'prepare_free' && (
            <>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={sending || busy}
                  onClick={() => setStep('review')}
                  className="h-8 text-xs"
                >
                  Voltar
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={sending || busy}
                  onClick={() => void handleManualComplete()}
                  className="h-8 text-[11px] text-muted-foreground"
                  title="Marcar manualmente como realizado sem disparar pela Cloud API"
                >
                  Concluir manual
                </Button>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={sending || busy || selectedProperties.length === 0 || !freeText.trim()}
                onClick={() => void handleSendFreeMessage()}
                className="h-8 px-4 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                {sending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Send className="size-3.5" />
                )}
                Enviar mensagem
              </Button>
            </>
          )}

          {step === 'prepare_template' && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={sending || busy}
                onClick={() => setStep('review')}
                className="h-8 text-xs"
              >
                Voltar
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={sending || busy || selectedProperties.length !== 1 || !templateDraft}
                onClick={() => void handleSendTemplateMessage()}
                className="h-8 px-4 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                {sending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Send className="size-3.5" />
                )}
                Enviar template
              </Button>
            </>
          )}

          {step === 'template_blocked' && (
            <div className="flex w-full items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setStep('review')}
                className="h-8 text-xs"
              >
                Voltar
              </Button>
              {suggestion.conversation_id && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs gap-1"
                  render={<a href={`/inbox?c=${encodeURIComponent(suggestion.conversation_id)}`} />}
                >
                  <MessageSquare className="size-3.5" />
                  Ver conversa
                </Button>
              )}
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
