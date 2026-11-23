'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Sparkles,
  Flame,
  Gauge,
  Building2,
  ChevronRight,
  ExternalLink,
  Phone,
  Clock,
  Eye,
  EyeOff,
  Archive,
  RotateCcw,
  RefreshCw,
  Loader2,
  Send,
} from 'lucide-react';
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { LeadMatchGroup, MatchStatus } from '@/lib/match/types';
import type { MatchCardItem } from '@/components/match/match-card';
import type { MatchLifecycleAction } from '@/lib/match/service';

interface LeadMatchCardProps {
  group: LeadMatchGroup;
  activeTab?: MatchStatus;
  loadingAction?: string | null;
  preparingSendLeadId?: string | null;
  onOpenModal: (group: LeadMatchGroup) => void;
  onQuickAction?: (
    group: LeadMatchGroup,
    action: MatchLifecycleAction,
    scope?: 'lead' | 'best_match'
  ) => void;
  onSmartSend?: (group: LeadMatchGroup) => void;
}

function formatMatchTimestamp(isoDate?: string | null): {
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

export function LeadMatchCard({
  group,
  activeTab = 'novo',
  loadingAction,
  preparingSendLeadId,
  onOpenModal,
  onQuickAction,
  onSmartSend,
}: LeadMatchCardProps) {
  const leadName = group.lead.name || 'Lead sem nome';
  const initials =
    leadName
      .split(' ')
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'L';

  const bestMatch = group.bestMatch as unknown as MatchCardItem;
  const bestScore = Math.round(bestMatch?.match_score ?? 0);
  const bestProp = bestMatch?.property;

  const formattedPrice = bestProp?.priceMin
    ? new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: 0,
      }).format(bestProp.priceMin)
    : 'Sob consulta';

  const getScoreBadgeClass = (score: number) => {
    if (score >= 85) {
      return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    }
    if (score >= 70) {
      return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    }
    return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  };

  const totalMatchesCount = group.statusMatchesCount || group.totalMatches || group.matches.length || 0;
  const matchTime = formatMatchTimestamp(
    group.latestMatchAt || (bestMatch as unknown as { created_at?: string })?.created_at
  );
  const isUnread = Boolean(group.isUnread);
  const isInAnalysis =
    activeTab === 'em_analise' ||
    (bestMatch as unknown as { match_status?: string })?.match_status === 'em_analise';
  const isBusy = Boolean(loadingAction && loadingAction.startsWith(group.leadId));
  const isPreparingSend = preparingSendLeadId === group.leadId;
  const isActionDisabled = isBusy || isPreparingSend;

  return (
    <Card
      className={`flex flex-col justify-between border bg-card/70 hover:border-primary/40 transition-all duration-200 rounded-xl p-4 gap-3 shadow-xs hover:shadow-md ${
        isUnread && activeTab === 'novo'
          ? 'border-primary/35 ring-1 ring-primary/15'
          : 'border-border/70'
      }`}
    >
      {/* 1. Header do Lead */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative shrink-0">
            <div className="size-8 rounded-full bg-primary/10 border border-primary/20 text-primary font-bold text-xs flex items-center justify-center">
              {initials}
            </div>
            {isUnread && activeTab === 'novo' && (
              <span
                className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-background"
                title="Oportunidade ainda não visualizada"
              />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <h3 className="text-sm font-semibold text-foreground truncate" title={leadName}>
                {leadName}
              </h3>
              {isUnread && activeTab === 'novo' && (
                <span className="rounded-full bg-primary/15 border border-primary/30 px-1.5 py-0.2 text-[9px] font-bold uppercase tracking-wide text-primary shrink-0">
                  Novo
                </span>
              )}
              {isInAnalysis && (
                <span
                  data-testid="match-in-analysis-badge"
                  className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/25 px-1.5 py-0.2 text-[9px] font-semibold uppercase tracking-wide text-blue-400 shrink-0"
                  title="Oportunidade em análise"
                >
                  <Eye className="size-2.5" />
                  Em análise
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground font-mono flex items-center gap-1">
              <Phone className="size-2.5 text-muted-foreground/70" />
              {group.lead.phone}
            </p>
          </div>
        </div>

        {/* Badges de Qualificação */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Maturidade */}
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border ${
              group.profileMaturity >= 70
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                : 'bg-amber-500/10 text-amber-400 border-amber-500/25'
            }`}
            title={`Maturidade do perfil: ${group.profileMaturity}%`}
          >
            <Gauge className="size-2.5" />
            {group.profileMaturity}%
          </span>

          {/* Temperatura IA */}
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border ${
              group.aiScore >= 7
                ? 'bg-rose-500/10 text-rose-400 border-rose-500/25'
                : group.aiScore >= 4
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/25'
                : 'bg-muted text-muted-foreground border-border/50'
            }`}
            title={`Score comercial IA: ${group.aiScore}/10`}
          >
            <Flame className="size-2.5" />
            {group.aiScore}/10
          </span>
        </div>
      </div>

      {/* Data e Hora de Identificação + Motivo de Reabertura */}
      <div className="flex flex-col gap-1">
        <div
          className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"
          title={`Identificado em ${matchTime.fullLabel}`}
        >
          <span className="inline-flex items-center gap-1 truncate">
            <Clock className="size-3 text-muted-foreground/70 shrink-0" />
            <span>{matchTime.shortLabel}</span>
          </span>
          {matchTime.relativeLabel && (
            <span className="text-[10px] text-muted-foreground/80 shrink-0">
              {matchTime.relativeLabel}
            </span>
          )}
        </div>

        {group.reopenReason && (
          <div className="flex items-center gap-1.5 rounded-md bg-amber-500/10 border border-amber-500/25 px-2 py-1 text-[10px] text-amber-300">
            <RefreshCw className="size-3 shrink-0 text-amber-400" />
            <span className="truncate" title={group.reopenReason}>
              Reaberto: {group.reopenReason}
            </span>
          </div>
        )}
      </div>

      {/* 2. Seção Central: MELHOR MATCH */}
      <div className="rounded-lg bg-muted/40 border border-border/50 p-2.5">
        <div className="flex items-center justify-between gap-1 mb-1.5">
          <span className="text-[10px] font-semibold tracking-wider uppercase text-muted-foreground/80 flex items-center gap-1">
            <Sparkles className="size-2.5 text-primary" />
            Melhor Match
          </span>
          {bestMatch && (
            <span
              className={`rounded-full px-1.5 py-0.2 text-[10px] font-bold border ${getScoreBadgeClass(
                bestScore
              )}`}
            >
              {bestScore}% match
            </span>
          )}
        </div>

        {bestProp ? (
          <div className="flex items-center gap-2.5">
            {/* Foto de Capa / Fallback */}
            <div className="size-11 rounded-md overflow-hidden bg-muted border border-border/60 shrink-0 relative">
              {bestProp.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={bestProp.coverUrl}
                  alt={bestProp.title}
                  className="size-full object-cover"
                />
              ) : (
                <div className="size-full flex items-center justify-center text-muted-foreground">
                  <Building2 className="size-4" />
                </div>
              )}
            </div>

            {/* Informações Resumidas do Imóvel */}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground truncate" title={bestProp.title}>
                {bestProp.title}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">
                {bestProp.neighborhood
                  ? `${bestProp.neighborhood}, ${bestProp.city}`
                  : bestProp.city}
              </p>
              <p className="text-xs font-semibold text-foreground/90 mt-0.5">{formattedPrice}</p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">Nenhum match calculado</p>
        )}
      </div>

      {/* 3. Rodapé de Ações: Contador Clicável + Ações Rápidas de Ciclo de Vida + Ver Perfil */}
      <div className="flex flex-col gap-2 pt-1.5 border-t border-border/40">
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenModal(group)}
            className="h-7 text-xs font-medium bg-primary/10 hover:bg-primary/20 text-primary border-primary/25 hover:border-primary/40 px-2.5 gap-1 transition-colors"
          >
            <span>
              {totalMatchesCount}{' '}
              {totalMatchesCount === 1 ? 'imóvel compatível' : 'imóveis compatíveis'}
            </span>
            <ChevronRight className="size-3" />
          </Button>

          <Link
            href={`/match/lead/${group.leadId}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/70 border border-border/60 rounded-md px-2.5 py-1 h-7 transition-colors"
          >
            <span>Ver Perfil</span>
            <ExternalLink className="size-3 text-muted-foreground/80" />
          </Link>
        </div>

        {/* Barra de Ações do Rodapé: IGNORAR | ARQUIVAR | ENVIAR */}
        {(onQuickAction || onSmartSend) && (
          <div className="pt-1.5 border-t border-border/30">
            {(activeTab === 'novo' || activeTab === 'em_analise' || activeTab === 'enviado') && (
              <div
                data-testid="match-card-footer-actions"
                className="grid grid-cols-3 gap-2"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isActionDisabled || !onQuickAction}
                  onClick={() => onQuickAction?.(group, 'ignore', 'lead')}
                  className="h-8 w-full rounded-lg border border-rose-500/25 bg-rose-500/10 px-2 text-xs font-medium text-rose-400 hover:bg-rose-500/20 hover:text-rose-300 gap-1.5"
                  title="Ignorar oportunidade (não volta à fila ativa sem mudança material)"
                >
                  <EyeOff className="size-3.5 shrink-0" />
                  <span>Ignorar</span>
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isActionDisabled || !onQuickAction}
                  onClick={() => onQuickAction?.(group, 'archive', 'lead')}
                  className="h-8 w-full rounded-lg border border-border/70 bg-muted/50 px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground gap-1.5"
                  title="Arquivar oportunidade mantendo no histórico"
                >
                  <Archive className="size-3.5 shrink-0" />
                  <span>Arquivar</span>
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isActionDisabled || !bestProp}
                  onClick={() =>
                    onSmartSend ? onSmartSend(group) : onOpenModal(group)
                  }
                  className="h-8 w-full rounded-lg border border-emerald-500/40 bg-emerald-600 px-2 text-xs font-semibold text-white hover:bg-emerald-500 hover:text-white gap-1.5"
                  title="Preparar mensagem personalizada por IA e abrir conversa no Inbox"
                >
                  {isPreparingSend ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Send className="size-3.5 shrink-0" />
                  )}
                  <span>{isPreparingSend ? 'Preparando' : 'Enviar'}</span>
                </Button>
              </div>
            )}

            {(activeTab === 'ignorado' ||
              activeTab === 'arquivado' ||
              activeTab === 'pausado') &&
              onQuickAction && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isActionDisabled}
                    onClick={() => onQuickAction(group, 'restore', 'lead')}
                    className="h-7 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2.5 text-xs gap-1.5 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/20"
                    title="Restaurar oportunidade para Novos"
                  >
                    {isBusy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="size-3.5" />
                    )}
                    <span>Restaurar</span>
                  </Button>
                </div>
              )}
          </div>
        )}
      </div>
    </Card>
  );
}
