'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { Building2, CalendarCheck2, ChevronRight, Clock, RefreshCw } from 'lucide-react';
import { getDateFnsLocale } from '@/lib/date-fns-locale';
import { createClient } from '@/lib/supabase/client';
import type { EnrichedFollowupItem } from '@/lib/followup/engine';
import { FollowupDialog } from '@/components/ai-hub/followup-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from './skeleton';

export const FOLLOWUP_UPDATED_EVENT = 'wacrm:followup-updated';

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function getAgeToneClass(hoursSince: number | null): string {
  if (hoursSince === null) return 'text-muted-foreground';
  if (hoursSince >= 72) return 'text-amber-400';
  if (hoursSince >= 24) return 'text-emerald-400';
  return 'text-purple-400';
}

export function FollowupRecommendationsCard() {
  const t = useTranslations('Dashboard.followupRecommendations');
  const appLocale = useLocale();
  const dateFnsLocale = getDateFnsLocale(appLocale);

  const [items, setItems] = useState<EnrichedFollowupItem[]>([]);
  const [totalPending, setTotalPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedItem, setSelectedItem] = useState<EnrichedFollowupItem | null>(null);

  const fetchTopFollowups = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(false);
    }
    try {
      const res = await fetch(
        '/api/followup?status=pending&date_filter=all&sort_by=recent_priority&page=1&page_size=3',
        { cache: 'no-store' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        items?: EnrichedFollowupItem[];
        counts?: { pending?: number };
      };
      const nextItems = Array.isArray(json.items) ? json.items.slice(0, 3) : [];
      setItems(nextItems);
      setTotalPending(Number(json.counts?.pending ?? nextItems.length));
      setError(false);
    } catch (err) {
      console.error('[dashboard] followup recommendations failed:', err);
      if (!silent) setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTopFollowups(false);
  }, [fetchTopFollowups]);

  // Sincronização em tempo real com a aba Follow-up e alterações de estado no banco
  useEffect(() => {
    const supabase = createClient();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void fetchTopFollowups(true);
      }, 400);
    };

    const channel = supabase
      .channel('dashboard-followup-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ai_suggestions' },
        () => scheduleRefresh()
      )
      .subscribe();

    const handleLocalUpdate = () => void fetchTopFollowups(true);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetchTopFollowups(true);
      }
    };

    window.addEventListener(FOLLOWUP_UPDATED_EVENT, handleLocalUpdate);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
      window.removeEventListener(FOLLOWUP_UPDATED_EVENT, handleLocalUpdate);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchTopFollowups]);

  const handleResolved = useCallback(() => {
    setSelectedItem(null);
    window.dispatchEvent(new CustomEvent(FOLLOWUP_UPDATED_EVENT));
    void fetchTopFollowups(true);
  }, [fetchTopFollowups]);

  return (
    <section
      data-testid="dashboard-followup-card"
      className="rounded-xl border border-border bg-card p-4 sm:p-5"
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <CalendarCheck2 className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-foreground">{t('title')}</h2>
            <p className="truncate text-xs text-muted-foreground">{t('description')}</p>
          </div>
        </div>

        <Link
          href="/followup"
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <span>
            {totalPending > 0
              ? t('viewAllWithCount', { count: totalPending })
              : t('viewAll')}
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </Link>
      </div>

      {/* Content */}
      <div className="mt-4">
        {loading ? (
          <div className="space-y-2.5">
            {[0, 1, 2].map((idx) => (
              <div
                key={idx}
                className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-3 py-3"
              >
                <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                <Skeleton className="h-4 w-28 shrink-0" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-16 shrink-0" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-border/70 px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">{t('error')}</p>
            <Button size="sm" variant="outline" onClick={() => void fetchTopFollowups(false)}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t('retry')}
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/70 px-4 py-8 text-center">
            <p className="text-sm font-medium text-foreground">{t('emptyTitle')}</p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              {t('emptyDescription')}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const contactName = item.contact?.name?.trim() || t('unnamedLead');
              const avatarUrl = item.contact?.avatar_url;
              const hoursSince =
                item.hoursSinceLastCustomerMessage ?? item.hoursSinceLastCommunication ?? null;
              const refDate =
                item.lastCustomerMessageAt || item.lastCommunicationAt || item.suggestionCreatedAt;
              const timeLabel = refDate
                ? formatDistanceToNow(new Date(refDate), {
                    addSuffix: true,
                    locale: dateFnsLocale,
                  })
                : '';

              return (
                <button
                  key={item.suggestion.id}
                  type="button"
                  data-testid="dashboard-followup-row"
                  onClick={() => setSelectedItem(item)}
                  className="group flex w-full text-left min-h-[56px] flex-col gap-2 rounded-xl border border-border/70 bg-background/40 px-3.5 py-3 transition-colors hover:border-primary/40 hover:bg-muted/50 active:bg-muted/70 md:flex-row md:items-center md:gap-3"
                >
                  {/* Lead Avatar + Name + Mobile Meta */}
                  <div className="flex items-center justify-between gap-2 md:w-52 md:shrink-0 md:justify-start">
                    <div className="flex min-w-0 items-center gap-2.5">
                      {avatarUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={avatarUrl}
                          alt={contactName}
                          className="h-8 w-8 shrink-0 rounded-full border border-border/60 object-cover"
                        />
                      ) : (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted text-xs font-semibold text-foreground">
                          {getInitials(contactName)}
                        </div>
                      )}
                      <div className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-foreground">
                          {contactName}
                        </span>
                        {item.interestProperty && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground truncate max-w-full">
                            <Building2 className="h-3 w-3 text-primary shrink-0" />
                            <span className="truncate">{item.interestProperty}</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Mobile timing badge */}
                    {timeLabel && (
                      <span
                        className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium md:hidden ${getAgeToneClass(hoursSince)}`}
                      >
                        <Clock className="h-3.5 w-3.5" />
                        <span>{timeLabel}</span>
                      </span>
                    )}
                  </div>

                  <span
                    aria-hidden
                    className="hidden h-4 w-px shrink-0 bg-border md:block"
                  />

                  {/* Personalized Commercial Reason */}
                  <p className="line-clamp-2 min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground md:line-clamp-2 md:text-sm">
                    {item.reason}
                  </p>

                  {/* Desktop timing + chevron */}
                  <div className="hidden shrink-0 items-center gap-2 md:flex">
                    {timeLabel && (
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-medium ${getAgeToneClass(hoursSince)}`}
                      >
                        <Clock className="h-3.5 w-3.5" />
                        <span>{timeLabel}</span>
                      </span>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Mesmo modal de detalhes e execução da aba Follow-up */}
      {selectedItem && (
        <FollowupDialog
          suggestion={selectedItem.suggestion}
          open={Boolean(selectedItem)}
          onOpenChange={(open) => {
            if (!open) setSelectedItem(null);
          }}
          onResolved={handleResolved}
          compatibleProperties={selectedItem.compatibleProperties}
          stageName={selectedItem.stageName}
          hoursSinceLastCommunication={
            selectedItem.hoursSinceLastCustomerMessage ?? selectedItem.hoursSinceLastCommunication
          }
          neverContacted={selectedItem.neverContacted}
          lastMessagePreview={selectedItem.lastMessagePreview}
          interestProperty={selectedItem.interestProperty}
          reason={selectedItem.reason}
          lastCustomerMessageAt={
            selectedItem.lastCustomerMessageAt !== undefined
              ? selectedItem.lastCustomerMessageAt
              : selectedItem.lastCommunicationAt
          }
          sessionWindow={selectedItem.sessionWindow}
        />
      )}
    </section>
  );
}
