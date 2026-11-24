'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Building2,
  CalendarCheck2,
  Check,
  Clock,
  EyeOff,
  Flame,
  Gauge,
  GitBranch,
  Loader2,
  MessageSquare,
  Phone,
  RotateCcw,
  Send,
  Sparkles,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { FollowupDialog } from '@/components/ai-hub/followup-dialog';
import { FOLLOWUP_UPDATED_EVENT } from '@/components/dashboard/followup-recommendations-card';
import { scoreConfidenceBand } from '@/lib/ai/lead-analysis-config';
import {
  evaluateFollowupSessionWindow,
  formatNaturalElapsedContactPtBr,
  type EnrichedFollowupItem,
} from '@/lib/followup/engine';
import type { AiSuggestionStatus } from '@/types';

export interface FollowupCardProps {
  item: EnrichedFollowupItem;
  onUpdateStatus: (id: string, status: AiSuggestionStatus) => Promise<void>;
  onRefresh?: () => void;
  /** Optional external control for testing or parent modal inspection */
  onOpenDialog?: (item: EnrichedFollowupItem) => void;
}

function formatTimestampPtBr(isoDate?: string | null): {
  shortLabel: string;
  fullLabel: string;
  relativeLabel: string;
} {
  if (!isoDate) {
    return {
      shortLabel: 'Data não registrada',
      fullLabel: 'Data não registrada',
      relativeLabel: '',
    };
  }
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) {
    return {
      shortLabel: 'Data não registrada',
      fullLabel: 'Data não registrada',
      relativeLabel: '',
    };
  }

  const timeStr = format(d, 'HH:mm', { locale: ptBR });
  const fullLabel = format(d, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
  const relativeLabel = formatDistanceToNow(d, { addSuffix: true, locale: ptBR });

  if (isToday(d)) {
    return {
      shortLabel: `Hoje às ${timeStr}`,
      fullLabel,
      relativeLabel,
    };
  }
  if (isYesterday(d)) {
    return {
      shortLabel: `Ontem às ${timeStr}`,
      fullLabel,
      relativeLabel,
    };
  }

  return {
    shortLabel: `${format(d, 'dd/MM/yyyy', { locale: ptBR })} às ${timeStr}`,
    fullLabel,
    relativeLabel,
  };
}

function formatElapsedWithoutContact(
  hours: number | null,
  neverContacted: boolean,
  lastContactAt?: string | null
): string {
  if (neverContacted || (hours === null && !lastContactAt)) {
    return 'Nunca contatado';
  }
  return formatNaturalElapsedContactPtBr({
    hours,
    lastContactAt,
    neverContacted,
  });
}

export function FollowupCard({
  item,
  onUpdateStatus,
  onRefresh,
  onOpenDialog,
}: FollowupCardProps) {
  const [pendingAction, setPendingAction] = useState<AiSuggestionStatus | null>(null);
  const [followupOpen, setFollowupOpen] = useState(false);

  const { suggestion, contact } = item;
  const leadName = contact.name || 'Lead sem nome';
  const initials =
    leadName
      .split(' ')
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'L';

  const isPending = suggestion.status === 'pending';
  const isBusy = pendingAction !== null;

  const primaryCustomerIso =
    item.lastCustomerMessageAt !== undefined
      ? item.lastCustomerMessageAt
      : item.lastCommunicationAt;
  const customerTime = primaryCustomerIso ? formatTimestampPtBr(primaryCustomerIso) : null;
  const businessTime = item.lastBusinessMessageAt
    ? formatTimestampPtBr(item.lastBusinessMessageAt)
    : null;
  const suggestionTime = formatTimestampPtBr(item.suggestionCreatedAt);

  const effectiveHours =
    item.hoursSinceLastCustomerMessage ?? item.hoursSinceLastCommunication;
  const elapsedLabel = formatElapsedWithoutContact(
    effectiveHours,
    item.neverContacted,
    primaryCustomerIso
  );

  const liveWindow =
    item.sessionWindow ??
    evaluateFollowupSessionWindow({
      lastCustomerMessageAt: primaryCustomerIso,
    });

  const confidenceBand =
    typeof item.confidenceScore === 'number' ? scoreConfidenceBand(item.confidenceScore) : null;

  const getConfidenceBadgeClass = (score: number) => {
    if (score >= 85) {
      return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    }
    if (score >= 70) {
      return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    }
    return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  };

  const handleStatusAction = async (nextStatus: AiSuggestionStatus) => {
    if (isBusy) return;
    setPendingAction(nextStatus);
    try {
      await onUpdateStatus(suggestion.id, nextStatus);
    } finally {
      setPendingAction(null);
    }
  };

  const handleOpenSendModal = () => {
    setFollowupOpen(true);
    onOpenDialog?.(item);
  };

  return (
    <Card
      data-testid="followup-card"
      className={`flex flex-col justify-between border bg-card/70 hover:border-primary/40 transition-all duration-200 rounded-xl p-4 gap-3 shadow-xs hover:shadow-md ${
        item.priorityTier === 'high' && isPending
          ? 'border-primary/35 ring-1 ring-primary/15'
          : 'border-border/70'
      }`}
    >
      {/* 1. Identificação do Lead + Indicadores de Qualificação */}
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative shrink-0">
              {contact.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={contact.avatar_url}
                  alt={leadName}
                  loading="lazy"
                  decoding="async"
                  className="size-8 rounded-full border border-border/60 object-cover"
                />
              ) : (
                <div className="size-8 rounded-full bg-primary/10 border border-primary/20 text-primary font-bold text-xs flex items-center justify-center">
                  {initials}
                </div>
              )}
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                {suggestion.conversation_id ? (
                  <Link
                    href={`/inbox?c=${encodeURIComponent(suggestion.conversation_id)}`}
                    className="text-sm font-semibold text-foreground hover:text-primary hover:underline truncate"
                    title={leadName}
                  >
                    {leadName}
                  </Link>
                ) : (
                  <h3 className="text-sm font-semibold text-foreground truncate" title={leadName}>
                    {leadName}
                  </h3>
                )}
              </div>

              {contact.phone && (
                <p className="text-[11px] text-muted-foreground font-mono flex items-center gap-1">
                  <Phone className="size-2.5 text-muted-foreground/70" />
                  {contact.phone}
                </p>
              )}
            </div>
          </div>

          {/* Maturidade comercial e Score da IA */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border ${
                item.profileMaturity >= 70
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/25'
              }`}
              title={`Maturidade comercial do perfil: ${item.profileMaturity}%`}
            >
              <Gauge className="size-2.5" />
              {item.profileMaturity}%
            </span>

            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border ${
                item.aiScore >= 7
                  ? 'bg-rose-500/10 text-rose-400 border-rose-500/25'
                  : item.aiScore >= 4
                    ? 'bg-amber-500/10 text-amber-400 border-amber-500/25'
                    : 'bg-muted text-muted-foreground border-border/50'
              }`}
              title={`Score comercial da IA: ${item.aiScore}/10`}
            >
              <Flame className="size-2.5" />
              {item.aiScore}/10
            </span>
          </div>
        </div>

        {/* Chips de Etapa do Pipeline, Tipo da Oportunidade, Prioridade e Janela de Atendimento (Seções 3, 5 e 8) */}
        <div className="flex flex-wrap items-center gap-1.5">
          {item.stageName ? (
            <span
              data-testid="followup-stage-badge"
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 border border-primary/25 px-2 py-0.5 text-[10px] font-semibold text-primary"
            >
              <GitBranch className="size-2.5" />
              {item.stageName}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted border border-border/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <GitBranch className="size-2.5" />
              Sem etapa
            </span>
          )}

          {item.opportunityType === 'first_contact' ? (
            <span
              data-testid="followup-opportunity-type-badge"
              className="inline-flex items-center gap-1 rounded-full bg-purple-500/10 border border-purple-500/25 px-2 py-0.5 text-[10px] font-semibold text-purple-400"
            >
              <UserPlus className="size-2.5" />
              Primeiro contato
            </span>
          ) : (
            <span
              data-testid="followup-opportunity-type-badge"
              className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/25 px-2 py-0.5 text-[10px] font-semibold text-blue-400"
            >
              <UserCheck className="size-2.5" />
              Retomada de contato
            </span>
          )}

          {item.priorityTier === 'high' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
              Prioridade alta
            </span>
          )}

          {/* Indicador discreto do estado real da Janela de Atendimento de 24h (Seção 5) */}
          {liveWindow.status === 'closing_soon' ? (
            <span
              data-testid="followup-window-badge"
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/35 px-2 py-0.5 text-[10px] font-semibold text-amber-300"
              title={`Janela de atendimento de 24h prestes a encerrar (${liveWindow.remainingLabel || ''})`}
            >
              <Clock className="size-2.5" />
              Janela prestes a encerrar
              {liveWindow.remainingLabel ? ` • ${liveWindow.remainingLabel}` : ''}
            </span>
          ) : liveWindow.status === 'open' ? (
            <span
              data-testid="followup-window-badge"
              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 text-[10px] font-semibold text-emerald-400"
              title={`Janela de atendimento de 24h aberta (${liveWindow.remainingLabel || ''})`}
            >
              <Clock className="size-2.5" />
              Janela aberta{liveWindow.remainingLabel ? ` • ${liveWindow.remainingLabel}` : ''}
            </span>
          ) : liveWindow.status === 'expired' ? (
            <span
              data-testid="followup-window-badge"
              className="inline-flex items-center gap-1 rounded-full bg-muted/80 border border-border/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
              title="Janela de 24h encerrada: envio pela Cloud API exige template aprovado"
            >
              Template necessário
            </span>
          ) : (
            <span
              data-testid="followup-window-badge"
              className="inline-flex items-center gap-1 rounded-full bg-muted/60 border border-border/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground/80"
              title="Situação da janela de atendimento desconhecida"
            >
              Situação desconhecida
            </span>
          )}
        </div>
      </div>

      {/* 2. Informações Temporais: Última mensagem do cliente (principal) vs. Geração da sugestão (auditoria) */}
      <div className="flex flex-col gap-1 text-[11px] text-muted-foreground rounded-lg bg-muted/25 border border-border/40 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1 truncate">
            <Clock className="size-3 text-primary/80 shrink-0" />
            {item.neverContacted ? (
              <span
                data-testid="followup-never-contacted"
                className="font-semibold text-amber-400"
              >
                Nunca contatado
              </span>
            ) : customerTime ? (
              <span
                title={`Última mensagem recebida do cliente em ${customerTime.fullLabel}${
                  businessTime ? ` | Última msg da empresa: ${businessTime.fullLabel}` : ''
                }`}
              >
                Último contato: {customerTime.shortLabel}
              </span>
            ) : (
              <span>{elapsedLabel}</span>
            )}
          </span>

          {!item.neverContacted && (
            <span
              className={`text-[10px] font-semibold shrink-0 ${
                (effectiveHours ?? 0) >= 72 ? 'text-amber-400' : 'text-emerald-400'
              }`}
            >
              {elapsedLabel}
            </span>
          )}
        </div>

        <div
          className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground/80"
          title={`Sugestão gerada pela IA em ${suggestionTime.fullLabel}`}
        >
          <span className="inline-flex items-center gap-1 truncate">
            <CalendarCheck2 className="size-2.5 text-muted-foreground/60 shrink-0" />
            <span>Sugestão: {suggestionTime.shortLabel}</span>
          </span>
          {liveWindow.ctwaFreeBenefitActive && liveWindow.ctwaFreeBenefitRemainingLabel ? (
            <span className="text-primary font-medium shrink-0">
              {liveWindow.ctwaFreeBenefitRemainingLabel}
            </span>
          ) : suggestionTime.relativeLabel ? (
            <span className="shrink-0">{suggestionTime.relativeLabel}</span>
          ) : null}
        </div>
      </div>

      {/* 3. Seção Central: Motivo Comercial, Empreendimento e Necessidade Principal */}
      <div className="rounded-lg bg-muted/40 border border-border/50 p-2.5 flex-1 flex flex-col justify-between gap-2">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-1">
            <span className="text-[10px] font-semibold tracking-wider uppercase text-muted-foreground/80 flex items-center gap-1">
              <Sparkles className="size-2.5 text-primary" />
              Motivo para contato
            </span>

            {typeof item.confidenceScore === 'number' && (
              <span
                data-testid="followup-confidence-badge"
                className={`rounded-full px-1.5 py-0.2 text-[10px] font-bold border ${getConfidenceBadgeClass(
                  item.confidenceScore
                )}`}
                title={`Confiança da recomendação (${confidenceBand || 'IA'}): ${item.confidenceScore}%`}
              >
                {item.confidenceScore}% confiança
              </span>
            )}
          </div>

          {/* Empreendimento de origem (somente quando identificado com segurança) */}
          {item.interestProperty && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="inline-flex items-center gap-1 rounded-md bg-card border border-border/70 px-2 py-0.5 text-[11px] font-semibold text-foreground truncate max-w-full">
                <Building2 className="size-3 text-primary shrink-0" />
                <span className="truncate">{item.interestProperty}</span>
              </span>
            </div>
          )}

          {/* Comentário comercial personalizado */}
          <p
            data-testid="followup-reason-text"
            className="text-xs text-foreground/95 leading-relaxed line-clamp-4"
            title={item.reason}
          >
            {item.reason}
          </p>
        </div>

        {/* Indicador complementar de imóveis compatíveis no Match (Seção 9) */}
        {item.compatiblePropertiesCount > 0 && (
          <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-border/40 text-[11px]">
            <span className="inline-flex items-center gap-1 text-primary font-medium">
              <Sparkles className="size-3 shrink-0" />
              <span>
                {item.compatiblePropertiesCount}{' '}
                {item.compatiblePropertiesCount === 1
                  ? 'imóvel compatível no Match'
                  : 'imóveis compatíveis no Match'}
              </span>
            </span>
            <button
              type="button"
              onClick={handleOpenSendModal}
              className="text-[10px] font-semibold text-primary hover:underline"
            >
              Consultar no atendimento
            </button>
          </div>
        )}
      </div>

      {/* 4. Rodapé de Ações: IGNORAR | ACEITAR | ENVIAR */}
      <div className="flex flex-col gap-2 pt-1.5 border-t border-border/40">
        {isPending ? (
          <div
            data-testid="followup-card-footer-actions"
            className="grid grid-cols-3 gap-2"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isBusy}
              onClick={() => void handleStatusAction('ignored')}
              className="h-8 w-full rounded-lg border border-rose-500/25 bg-rose-500/10 px-2 text-xs font-medium text-rose-400 hover:bg-rose-500/20 hover:text-rose-300 gap-1.5"
              title="Ignorar sugestão de follow-up"
            >
              {pendingAction === 'ignored' ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <EyeOff className="size-3.5 shrink-0" />
              )}
              <span>Ignorar</span>
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isBusy}
              onClick={() => void handleStatusAction('approved')}
              className="h-8 w-full rounded-lg border border-border/70 bg-muted/50 px-2 text-xs font-medium text-foreground hover:bg-muted gap-1.5"
              title="Aceitar sugestão de follow-up"
            >
              {pendingAction === 'approved' ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <Check className="size-3.5 shrink-0" />
              )}
              <span>Aceitar</span>
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isBusy}
              onClick={handleOpenSendModal}
              className="h-8 w-full rounded-lg border border-emerald-500/40 bg-emerald-600 px-2 text-xs font-semibold text-white hover:bg-emerald-500 hover:text-white gap-1.5"
              title="Abrir fluxo de análise e atendimento (não envia mensagem automaticamente)"
            >
              <Send className="size-3.5 shrink-0" />
              <span>Enviar</span>
            </Button>
          </div>
        ) : suggestion.status === 'ignored' ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Sugestão ignorada</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isBusy}
              onClick={() => void handleStatusAction('pending')}
              className="h-7 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2.5 text-xs gap-1.5 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/20"
            >
              {pendingAction === 'pending' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              <span>Restaurar</span>
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            {suggestion.conversation_id ? (
              <Link
                href={`/inbox?c=${encodeURIComponent(suggestion.conversation_id)}`}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <MessageSquare className="size-3.5" />
                <span>Ver conversa</span>
              </Link>
            ) : (
              <span />
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOpenSendModal}
              className="h-7 text-xs gap-1.5"
            >
              <Send className="size-3" />
              <span>Ver detalhes</span>
            </Button>
          </div>
        )}
      </div>

      {/* Modal de Follow-up carregado sob demanda (evita montar 36 árvores de modal ocultas no iPhone PWA/desktop) */}
      {followupOpen && (
        <FollowupDialog
          suggestion={suggestion}
          open={followupOpen}
          onOpenChange={setFollowupOpen}
          onResolved={() => {
            window.dispatchEvent(new CustomEvent(FOLLOWUP_UPDATED_EVENT));
            onRefresh?.();
          }}
          compatibleProperties={item.compatibleProperties}
          totalCompatiblePropertiesCount={
            item.totalCompatiblePropertiesCount ?? item.compatiblePropertiesCount
          }
          stageName={item.stageName}
          hoursSinceLastCommunication={effectiveHours}
          neverContacted={item.neverContacted}
          lastMessagePreview={item.lastMessagePreview}
          interestProperty={item.interestProperty}
          reason={item.reason}
          lastCustomerMessageAt={primaryCustomerIso}
          sessionWindow={liveWindow}
        />
      )}
    </Card>
  );
}
