'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FollowupCard } from '@/components/followup/followup-card';
import { FOLLOWUP_UPDATED_EVENT } from '@/components/dashboard/followup-recommendations-card';
import { IGNORED_SUGGESTION_RETENTION_DAYS } from '@/lib/ai-suggestion-status';
import { createClient } from '@/lib/supabase/client';
import { PULL_TO_REFRESH_EVENT } from '@/hooks/use-pull-to-refresh';
import { toast } from 'sonner';
import {
  ArrowUpDown,
  Calendar,
  CalendarCheck2,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  EyeOff,
  GitBranch,
  History,
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type {
  EnrichedFollowupItem,
  FollowupDateFilter,
  FollowupMaturityBand,
  FollowupOpportunityType,
  FollowupSortBy,
  FollowupWindowFilter,
} from '@/lib/followup/engine';
import type { AiSuggestionStatus } from '@/types';

const DEFAULT_DATE_FILTER: FollowupDateFilter = 'all';

function getNaturalEmptyMessage(
  activeTab: AiSuggestionStatus,
  dateFilter: FollowupDateFilter
): string {
  if (activeTab !== 'pending') {
    const tabLabels: Record<AiSuggestionStatus, string> = {
      pending: 'pendentes',
      approved: 'aceitas',
      done: 'realizadas',
      ignored: 'ignoradas',
      rejected: 'rejeitadas',
    };
    return `Nenhuma oportunidade encontrada em ${tabLabels[activeTab] || 'nesta aba'}.`;
  }
  if (dateFilter === 'yesterday') return 'Ontem não tivemos nenhuma sugestão de follow-up.';
  if (dateFilter === 'today') return 'Hoje ainda não temos sugestões de follow-up.';
  if (dateFilter === 'all') return 'Nenhuma oportunidade de follow-up pendente no momento.';
  return 'Nenhuma oportunidade encontrada neste período.';
}

function getNaturalCountSubtitle(
  total: number,
  activeTab: AiSuggestionStatus,
  dateFilter: FollowupDateFilter
): string | null {
  if (activeTab !== 'pending' || total <= 0) return null;
  if (dateFilter === 'today') {
    return total === 1
      ? 'Hoje temos uma sugestão de follow-up.'
      : `Hoje temos ${total} sugestões de follow-up.`;
  }
  if (dateFilter === 'yesterday') {
    return total === 1
      ? 'Ontem tivemos uma sugestão de follow-up.'
      : `Ontem tivemos ${total} sugestões de follow-up.`;
  }
  if (dateFilter === '7d') {
    return total === 1
      ? 'Encontramos 1 oportunidade nos últimos 7 dias.'
      : `Encontramos ${total} oportunidades nos últimos 7 dias.`;
  }
  if (dateFilter === '30d') {
    return total === 1
      ? 'Encontramos 1 oportunidade nos últimos 30 dias.'
      : `Encontramos ${total} oportunidades nos últimos 30 dias.`;
  }
  if (dateFilter === 'all') {
    return total === 1
      ? 'Temos 1 oportunidade comercial pronta para retomada.'
      : `Temos ${total} oportunidades comerciais prontas para retomada.`;
  }
  return total === 1
    ? 'Encontramos 1 oportunidade neste período.'
    : `Encontramos ${total} oportunidades neste período.`;
}

const DATE_FILTER_LABELS: Record<FollowupDateFilter, string> = {
  today: 'Hoje',
  yesterday: 'Ontem',
  day_before_yesterday: 'Anteontem',
  '3d': 'Últimos 3 dias',
  this_week: 'Esta semana',
  '7d': 'Últimos 7 dias',
  this_month: 'Este mês',
  '30d': 'Últimos 30 dias',
  all: 'Todas as datas',
  custom: 'Período personalizado',
};

const WINDOW_FILTER_LABELS: Record<FollowupWindowFilter, string> = {
  all: 'Janela: Todas',
  open: 'Janela de atendimento aberta',
  closing_soon: 'Janela prestes a encerrar',
  expired: 'Template necessário (24h encerrada)',
};

const MATURITY_FILTER_LABELS: Record<FollowupMaturityBand, string> = {
  all: 'Maturidade: Todas',
  ready: '≥ 70% (Alta maturidade)',
  growing: '40–69% (Em amadurecimento)',
  initial: '< 40% (Inicial)',
};

const AI_SCORE_FILTER_LABELS: Record<string, string> = {
  '0': 'Score IA: Qualquer',
  '5': 'Score ≥ 5 (Morno/Quente)',
  '7': 'Score ≥ 7 (Qualificado)',
  '9': 'Score ≥ 9 (Altíssimo calor)',
};

const OPPORTUNITY_TYPE_LABELS: Record<'all' | FollowupOpportunityType, string> = {
  all: 'Tipo: Todos',
  first_contact: 'Primeiro contato',
  resumption: 'Retomada de contato',
};

const SORT_BY_LABELS: Record<FollowupSortBy, string> = {
  recent_priority: 'Mais recentes e prioritários',
  window_closing_soon: 'Janela prestes a encerrar',
  priority_desc: 'Maior prioridade geral',
  maturity_desc: 'Maior maturidade',
  ai_score_desc: 'Maior score da IA',
  longest_without_contact: 'Mais tempo sem contato',
};

export default function FollowupPage() {
  return (
    <Suspense fallback={null}>
      <FollowupPageInner />
    </Suspense>
  );
}

function FollowupPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialStatus = (searchParams.get('status') as AiSuggestionStatus) || 'pending';
  const initialDate =
    (searchParams.get('date') as FollowupDateFilter) || DEFAULT_DATE_FILTER;
  const initialWindow =
    (searchParams.get('window') as FollowupWindowFilter) || 'all';
  const initialSort = (searchParams.get('sort') as FollowupSortBy) || 'recent_priority';
  const initialSearch = searchParams.get('q') || '';
  const initialStage = searchParams.get('stage') || 'all';
  const initialMaturity = (searchParams.get('maturity') as FollowupMaturityBand) || 'all';
  const initialAiScore = searchParams.get('ai_score') || '0';
  const initialType =
    (searchParams.get('type') as 'all' | FollowupOpportunityType) || 'all';
  const initialContact = searchParams.get('contact') || null;
  const initialFrom = searchParams.get('from') || '';
  const initialTo = searchParams.get('to') || '';

  const [activeTab, setActiveTab] = useState<AiSuggestionStatus>(initialStatus);
  const [dateFilter, setDateFilter] = useState<FollowupDateFilter>(initialDate);
  const [windowFilter, setWindowFilter] = useState<FollowupWindowFilter>(initialWindow);
  const [customFrom, setCustomFrom] = useState<string>(initialFrom);
  const [customTo, setCustomTo] = useState<string>(initialTo);
  const [search, setSearch] = useState<string>(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState<string>(initialSearch);
  const [stageFilter, setStageFilter] = useState<string>(initialStage);
  const [maturityFilter, setMaturityFilter] = useState<FollowupMaturityBand>(initialMaturity);
  const [minAiScore, setMinAiScore] = useState<string>(initialAiScore);
  const [opportunityType, setOpportunityType] = useState<'all' | FollowupOpportunityType>(
    initialType
  );
  const [contactFilter, setContactFilter] = useState<string | null>(initialContact);
  const [sortBy, setSortBy] = useState<FollowupSortBy>(initialSort);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const [items, setItems] = useState<EnrichedFollowupItem[]>([]);
  const [availableStages, setAvailableStages] = useState<
    Array<{ id: string; name: string; color: string; position: number }>
  >([]);
  const [counts, setCounts] = useState({
    pending: 0,
    approved: 0,
    done: 0,
    ignored: 0,
    rejected: 0,
    totalInActiveStatusAllDates: 0,
    filteredInPeriod: 0,
  });
  const [countsLoaded, setCountsLoaded] = useState(false);
  const [page, setPage] = useState<number>(1);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 36,
    totalItems: 0,
    totalPages: 1,
    hasMore: false,
  });

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Ações coletivas com proteção contra disparo acidental (Seção 11)
  const [bulkActionTarget, setBulkActionTarget] = useState<'approved' | 'ignored' | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const bulkInFlightRef = useRef(false);

  // Debounce da busca para evitar múltiplas chamadas durante digitação rápida
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 220);
    return () => clearTimeout(timer);
  }, [search]);

  const activeSecondaryFiltersCount = useMemo(() => {
    let count = 0;
    if (dateFilter !== DEFAULT_DATE_FILTER) count++;
    if (windowFilter !== 'all') count++;
    if (stageFilter !== 'all') count++;
    if (maturityFilter !== 'all') count++;
    if (minAiScore !== '0') count++;
    if (opportunityType !== 'all') count++;
    if (contactFilter) count++;
    return count;
  }, [
    dateFilter,
    windowFilter,
    stageFilter,
    maturityFilter,
    minAiScore,
    opportunityType,
    contactFilter,
  ]);

  // Sincroniza estado dos filtros na URL para permitir acesso direto e refresh sem perda de estado
  useEffect(() => {
    const params = new URLSearchParams();
    if (activeTab !== 'pending') params.set('status', activeTab);
    if (dateFilter !== DEFAULT_DATE_FILTER) params.set('date', dateFilter);
    if (windowFilter !== 'all') params.set('window', windowFilter);
    if (dateFilter === 'custom' && customFrom) params.set('from', customFrom);
    if (dateFilter === 'custom' && customTo) params.set('to', customTo);
    if (sortBy !== 'recent_priority') params.set('sort', sortBy);
    if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
    if (stageFilter !== 'all') params.set('stage', stageFilter);
    if (maturityFilter !== 'all') params.set('maturity', maturityFilter);
    if (minAiScore !== '0') params.set('ai_score', minAiScore);
    if (opportunityType !== 'all') params.set('type', opportunityType);
    if (contactFilter) params.set('contact', contactFilter);

    const qs = params.toString();
    const targetUrl = `/followup${qs ? `?${qs}` : ''}`;
    router.replace(targetUrl, { scroll: false });
  }, [
    activeTab,
    dateFilter,
    windowFilter,
    customFrom,
    customTo,
    sortBy,
    debouncedSearch,
    stageFilter,
    maturityFilter,
    minAiScore,
    opportunityType,
    contactFilter,
    router,
  ]);

  const fetchFollowups = useCallback(
    async (silent = false) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      if (!silent) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      try {
        const params = new URLSearchParams();
        params.set('status', activeTab);
        params.set('date_filter', dateFilter);
        params.set('sort_by', sortBy);
        params.set('page', String(page));
        params.set('page_size', '36');

        if (windowFilter !== 'all') params.set('window_filter', windowFilter);
        if (dateFilter === 'custom') {
          if (customFrom) params.set('custom_from', customFrom);
          if (customTo) params.set('custom_to', customTo);
        }
        if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
        if (stageFilter !== 'all') params.set('stage', stageFilter);
        if (maturityFilter !== 'all') params.set('maturity', maturityFilter);
        if (parseInt(minAiScore, 10) > 0) params.set('min_ai_score', minAiScore);
        if (opportunityType !== 'all') params.set('opportunity_type', opportunityType);
        if (contactFilter) params.set('contact_id', contactFilter);

        const res = await fetch(`/api/followup?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Falha ao carregar sugestões de follow-up');
        const data = await res.json();

        if (controller.signal.aborted) return;

        setItems((data.items || []) as EnrichedFollowupItem[]);
        if (data.counts) {
          setCounts((prev) => ({ ...prev, ...data.counts }));
          setCountsLoaded(true);
        }
        if (data.pagination) {
          setPagination(data.pagination);
        }
        if (Array.isArray(data.availableStages)) {
          setAvailableStages(data.availableStages);
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        console.error('[FollowupPage] fetch error:', err);
        if (!silent) {
          toast.error('Erro ao carregar sugestões de follow-up');
        }
      } finally {
        if (abortControllerRef.current === controller) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [
      activeTab,
      dateFilter,
      windowFilter,
      customFrom,
      customTo,
      sortBy,
      page,
      debouncedSearch,
      stageFilter,
      maturityFilter,
      minAiScore,
      opportunityType,
      contactFilter,
    ]
  );

  useEffect(() => {
    void fetchFollowups();
  }, [fetchFollowups]);

  // Atualização em tempo real via Supabase Realtime em ai_suggestions
  useEffect(() => {
    const supabase = createClient();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void fetchFollowups(true);
      }, 900);
    };

    const channel = supabase
      .channel('followup-page-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ai_suggestions' },
        () => scheduleRefresh()
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [fetchFollowups]);

  // Sincronização em retomada de tela (PWA no iPhone) e Pull-to-Refresh
  useEffect(() => {
    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        void fetchFollowups(true);
      }
    };
    const handlePull = () => {
      void fetchFollowups(true);
    };

    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('online', handleResume);
    window.addEventListener(PULL_TO_REFRESH_EVENT, handlePull);

    return () => {
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('online', handleResume);
      window.removeEventListener(PULL_TO_REFRESH_EVENT, handlePull);
    };
  }, [fetchFollowups]);

  const patchSuggestion = useCallback(async (id: string, status: AiSuggestionStatus) => {
    const res = await fetch(`/api/ai/suggestions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Falha ao atualizar sugestão');
  }, []);

  const handleUpdateStatus = useCallback(
    async (id: string, nextStatus: AiSuggestionStatus) => {
      const previousItems = items;
      setItems((prev) => prev.filter((item) => item.suggestion.id !== id));
      try {
        await patchSuggestion(id, nextStatus);
        const statusMessages: Partial<Record<AiSuggestionStatus, string>> = {
          approved: 'Sugestão de follow-up aceita!',
          ignored: 'Sugestão de follow-up ignorada.',
          pending: 'Sugestão restaurada para Pendentes.',
          done: 'Follow-up marcado como realizado!',
        };
        toast.success(statusMessages[nextStatus] || 'Sugestão atualizada!');
        window.dispatchEvent(new CustomEvent(FOLLOWUP_UPDATED_EVENT));
        await fetchFollowups(true);
      } catch (err) {
        setItems(previousItems);
        toast.error((err as Error).message || 'Não foi possível atualizar a sugestão');
      }
    },
    [items, patchSuggestion, fetchFollowups]
  );

  const handleConfirmBulkAction = useCallback(async () => {
    if (!bulkActionTarget || bulkInFlightRef.current || items.length === 0) return;
    bulkInFlightRef.current = true;
    setBulkRunning(true);

    const targets = items.filter((i) => i.suggestion.status === 'pending');
    let failed = 0;

    for (const item of targets) {
      try {
        await patchSuggestion(item.suggestion.id, bulkActionTarget);
        setItems((prev) => prev.filter((x) => x.suggestion.id !== item.suggestion.id));
      } catch {
        failed += 1;
      }
    }

    setBulkRunning(false);
    bulkInFlightRef.current = false;
    const actionDone = bulkActionTarget;
    setBulkActionTarget(null);

    if (failed === 0) {
      toast.success(
        actionDone === 'approved'
          ? `${targets.length} sugestões de follow-up aceitas com sucesso.`
          : `${targets.length} sugestões de follow-up ignoradas.`
      );
    } else {
      toast.error(`${failed} de ${targets.length} sugestões não puderam ser processadas.`);
    }

    window.dispatchEvent(new CustomEvent(FOLLOWUP_UPDATED_EVENT));
    await fetchFollowups(true);
  }, [bulkActionTarget, items, patchSuggestion, fetchFollowups]);

  const resetAllFilters = useCallback(() => {
    setSearch('');
    setDebouncedSearch('');
    setDateFilter(DEFAULT_DATE_FILTER);
    setWindowFilter('all');
    setCustomFrom('');
    setCustomTo('');
    setStageFilter('all');
    setMaturityFilter('all');
    setMinAiScore('0');
    setOpportunityType('all');
    setContactFilter(null);
    setSortBy('recent_priority');
    setPage(1);
  }, []);

  const naturalSubtitle = useMemo(() => {
    if (!countsLoaded) return null;
    return getNaturalCountSubtitle(pagination.totalItems, activeTab, dateFilter);
  }, [countsLoaded, pagination.totalItems, activeTab, dateFilter]);

  return (
    <div className="-m-4 sm:-m-6 flex min-h-[calc(100%+2rem)] sm:min-h-[calc(100%+3rem)] flex-col">
      {/* Top Header */}
      <div className="border-b border-border bg-card/60 backdrop-blur-md px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-foreground flex items-center gap-1.5 shrink-0">
              <CalendarCheck2 className="size-4.5 sm:size-5 text-primary" />
              Follow-up
            </h1>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {activeTab === 'pending' && items.length > 0 && (
              <div className="hidden md:flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loading || refreshing || bulkRunning}
                  onClick={() => setBulkActionTarget('ignored')}
                  className="h-8 px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-rose-400"
                >
                  <EyeOff className="size-3.5" />
                  <span>Ignorar página ({items.length})</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loading || refreshing || bulkRunning}
                  onClick={() => setBulkActionTarget('approved')}
                  className="h-8 px-2.5 text-xs gap-1.5"
                >
                  <CheckCheck className="size-3.5 text-primary" />
                  <span>Aceitar página ({items.length})</span>
                </Button>
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRefreshing(true);
                void fetchFollowups(false);
              }}
              disabled={loading || refreshing}
              className="h-8 px-2.5 sm:px-3 text-xs gap-1.5"
              title="Atualizar sugestões de follow-up"
            >
              <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Atualizar</span>
            </Button>
          </div>
        </div>

        {naturalSubtitle && (
          <p className="text-xs text-muted-foreground mt-1">{naturalSubtitle}</p>
        )}

        {/* Tabs de Status do Follow-up */}
        <div className="mt-3 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto no-scrollbar pb-1">
          <Tabs
            value={activeTab}
            onValueChange={(val) => {
              setActiveTab(val as AiSuggestionStatus);
              setPage(1);
            }}
            className="w-full"
          >
            <TabsList className="inline-flex w-max space-x-1 bg-muted/60 p-1 rounded-xl">
              <TabsTrigger value="pending" className="gap-1.5 text-xs px-3 py-1.5 shrink-0">
                Pendentes
                <span className="rounded-full bg-primary/15 px-1.5 py-0.2 text-[10px] font-bold text-primary">
                  {!countsLoaded && loading ? '…' : counts.pending}
                </span>
              </TabsTrigger>
              <TabsTrigger value="approved" className="gap-1.5 text-xs px-3 py-1.5 shrink-0">
                Aceitos
                <span className="rounded-full bg-blue-500/15 px-1.5 py-0.2 text-[10px] font-bold text-blue-400">
                  {!countsLoaded && loading ? '…' : counts.approved}
                </span>
              </TabsTrigger>
              <TabsTrigger value="done" className="gap-1.5 text-xs px-3 py-1.5 shrink-0">
                Realizados
                <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-bold text-emerald-400">
                  {!countsLoaded && loading ? '…' : counts.done}
                </span>
              </TabsTrigger>
              <TabsTrigger value="ignored" className="gap-1.5 text-xs px-3 py-1.5 shrink-0">
                Ignorados
                <span className="rounded-full bg-rose-500/15 px-1.5 py-0.2 text-[10px] font-bold text-rose-400">
                  {!countsLoaded && loading ? '…' : counts.ignored}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* Barra de Filtros Horizontais (Mobile compacta + Desktop 8 colunas) */}
      <div className="border-b border-border bg-card/30 px-4 py-2.5 sm:px-6 sm:py-3">
        {/* Mobile: Busca + Toggle Filtros */}
        <div className="sm:hidden flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Buscar lead (nome/tel)..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 pr-7 text-xs h-9 bg-background/60"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>

            <Button
              type="button"
              variant={
                mobileFiltersOpen || activeSecondaryFiltersCount > 0 ? 'secondary' : 'outline'
              }
              size="sm"
              onClick={() => setMobileFiltersOpen((prev) => !prev)}
              className="h-9 px-2.5 text-xs gap-1.5 shrink-0"
            >
              <SlidersHorizontal className="size-3.5" />
              <span>Filtros</span>
              {activeSecondaryFiltersCount > 0 && (
                <span className="rounded-full bg-primary text-primary-foreground text-[10px] px-1.5 py-0.2 font-bold leading-none">
                  {activeSecondaryFiltersCount}
                </span>
              )}
            </Button>
          </div>

          {mobileFiltersOpen && (
            <div className="rounded-xl border border-border/80 bg-card p-3 shadow-md space-y-2.5 animate-in fade-in-50 slide-in-from-top-2">
              <div className="flex items-center justify-between pb-1 border-b border-border/50 text-xs">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <SlidersHorizontal className="size-3 text-primary" />
                  Filtros e Ordenação
                </span>
                {activeSecondaryFiltersCount > 0 && (
                  <button
                    type="button"
                    onClick={resetAllFilters}
                    className="text-[11px] text-primary hover:underline font-medium"
                  >
                    Restaurar padrão
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2 pt-1">
                {/* Período da última mensagem do cliente */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">
                    Última mensagem do cliente
                  </label>
                  <Select
                    value={dateFilter}
                    onValueChange={(val) => {
                      setDateFilter((val as FollowupDateFilter) || DEFAULT_DATE_FILTER);
                      setPage(1);
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs bg-background">
                      <Calendar className="size-3 mr-1 text-muted-foreground shrink-0" />
                      <SelectValue placeholder="Período">
                        {DATE_FILTER_LABELS[dateFilter] || 'Ontem'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="text-xs">
                      <SelectItem value="today">Hoje</SelectItem>
                      <SelectItem value="yesterday">Ontem</SelectItem>
                      <SelectItem value="day_before_yesterday">Anteontem</SelectItem>
                      <SelectItem value="3d">Últimos 3 dias</SelectItem>
                      <SelectItem value="7d">Últimos 7 dias</SelectItem>
                      <SelectItem value="this_week">Esta semana</SelectItem>
                      <SelectItem value="this_month">Este mês</SelectItem>
                      <SelectItem value="30d">Últimos 30 dias</SelectItem>
                      <SelectItem value="all">Todas as datas</SelectItem>
                      <SelectItem value="custom">Período personalizado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {dateFilter === 'custom' && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] text-muted-foreground uppercase font-semibold">
                        De
                      </label>
                      <Input
                        type="date"
                        value={customFrom}
                        onChange={(e) => {
                          setCustomFrom(e.target.value);
                          setPage(1);
                        }}
                        className="h-8 text-xs bg-background"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] text-muted-foreground uppercase font-semibold">
                        Até
                      </label>
                      <Input
                        type="date"
                        value={customTo}
                        onChange={(e) => {
                          setCustomTo(e.target.value);
                          setPage(1);
                        }}
                        className="h-8 text-xs bg-background"
                      />
                    </div>
                  </div>
                )}

                {/* Filtro complementar de Janela de Atendimento (Seção 2) */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">
                    Janela WhatsApp (24h)
                  </label>
                  <Select
                    value={windowFilter}
                    onValueChange={(val) => {
                      setWindowFilter((val as FollowupWindowFilter) || 'all');
                      setPage(1);
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs bg-background">
                      <Clock className="size-3 mr-1 text-muted-foreground shrink-0" />
                      <SelectValue placeholder="Janela">
                        {WINDOW_FILTER_LABELS[windowFilter]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="text-xs">
                      <SelectItem value="all">Janela: Todas</SelectItem>
                      <SelectItem value="open">Janela de atendimento aberta</SelectItem>
                      <SelectItem value="closing_soon">Janela prestes a encerrar</SelectItem>
                      <SelectItem value="expired">Template necessário (24h encerrada)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Ordenação */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">
                    Ordenação
                  </label>
                  <Select
                    value={sortBy}
                    onValueChange={(val) => {
                      setSortBy((val as FollowupSortBy) || 'recent_priority');
                      setPage(1);
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs bg-background">
                      <ArrowUpDown className="size-3 mr-1 text-muted-foreground shrink-0" />
                      <SelectValue placeholder="Ordenar por">
                        {SORT_BY_LABELS[sortBy]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="text-xs">
                      <SelectItem value="recent_priority">
                        Mais recentes e prioritários
                      </SelectItem>
                      <SelectItem value="window_closing_soon">
                        Janela prestes a encerrar
                      </SelectItem>
                      <SelectItem value="priority_desc">Maior prioridade geral</SelectItem>
                      <SelectItem value="maturity_desc">Maior maturidade</SelectItem>
                      <SelectItem value="ai_score_desc">Maior score da IA</SelectItem>
                      <SelectItem value="longest_without_contact">
                        Mais tempo sem contato
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Etapa do Pipeline e Tipo */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">
                      Etapa
                    </label>
                    <Select
                      value={stageFilter}
                      onValueChange={(val) => {
                        setStageFilter(val || 'all');
                        setPage(1);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs bg-background">
                        <SelectValue placeholder="Etapa">
                          {stageFilter === 'all'
                            ? 'Todas'
                            : stageFilter === '__none__'
                              ? 'Sem etapa'
                              : stageFilter}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="text-xs">
                        <SelectItem value="all">Todas as etapas</SelectItem>
                        {availableStages.map((st) => (
                          <SelectItem key={st.id} value={st.name}>
                            {st.name}
                          </SelectItem>
                        ))}
                        <SelectItem value="__none__">Sem etapa</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">
                      Tipo
                    </label>
                    <Select
                      value={opportunityType}
                      onValueChange={(val) => {
                        setOpportunityType(
                          (val as 'all' | FollowupOpportunityType) || 'all'
                        );
                        setPage(1);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs bg-background">
                        <SelectValue placeholder="Tipo">
                          {OPPORTUNITY_TYPE_LABELS[opportunityType]}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="text-xs">
                        <SelectItem value="all">Todos</SelectItem>
                        <SelectItem value="first_contact">Primeiro contato</SelectItem>
                        <SelectItem value="resumption">Retomada de contato</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Maturidade e Score IA */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">
                      Maturidade
                    </label>
                    <Select
                      value={maturityFilter}
                      onValueChange={(val) => {
                        setMaturityFilter((val as FollowupMaturityBand) || 'all');
                        setPage(1);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs bg-background">
                        <SelectValue placeholder="Maturidade">
                          {MATURITY_FILTER_LABELS[maturityFilter]}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="text-xs">
                        <SelectItem value="all">Todas</SelectItem>
                        <SelectItem value="ready">≥ 70%</SelectItem>
                        <SelectItem value="growing">40–69%</SelectItem>
                        <SelectItem value="initial">&lt; 40%</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">
                      Score IA
                    </label>
                    <Select
                      value={minAiScore}
                      onValueChange={(val) => {
                        setMinAiScore(val || '0');
                        setPage(1);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs bg-background">
                        <SelectValue placeholder="Score IA">
                          {AI_SCORE_FILTER_LABELS[minAiScore]}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="text-xs">
                        <SelectItem value="0">Qualquer</SelectItem>
                        <SelectItem value="5">≥ 5</SelectItem>
                        <SelectItem value="7">≥ 7</SelectItem>
                        <SelectItem value="9">≥ 9</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              <Button
                type="button"
                size="sm"
                onClick={() => setMobileFiltersOpen(false)}
                className="w-full text-xs h-8 mt-1"
              >
                Ver Resultados
              </Button>
            </div>
          )}
        </div>

        {/* Desktop: Grid Responsivo de 8 Colunas */}
        <div className="hidden sm:grid sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
          {/* 1. Busca por Lead */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Buscar lead (nome/tel)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-7 text-xs h-8"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {/* 2. Filtro de Data da Última Mensagem do Cliente (Padrão: Ontem) */}
          <Select
            value={dateFilter}
            onValueChange={(val) => {
              setDateFilter((val as FollowupDateFilter) || DEFAULT_DATE_FILTER);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 text-xs" data-testid="followup-date-filter-trigger">
              <Calendar className="size-3 mr-1 text-muted-foreground shrink-0" />
              <SelectValue placeholder="Período">
                {DATE_FILTER_LABELS[dateFilter] || 'Ontem'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="today">Hoje</SelectItem>
              <SelectItem value="yesterday">Ontem</SelectItem>
              <SelectItem value="day_before_yesterday">Anteontem</SelectItem>
              <SelectItem value="3d">Últimos 3 dias</SelectItem>
              <SelectItem value="7d">Últimos 7 dias</SelectItem>
              <SelectItem value="this_week">Esta semana</SelectItem>
              <SelectItem value="this_month">Este mês</SelectItem>
              <SelectItem value="30d">Últimos 30 dias</SelectItem>
              <SelectItem value="all">Todas as datas</SelectItem>
              <SelectItem value="custom">Período personalizado</SelectItem>
            </SelectContent>
          </Select>

          {/* 3. Filtro complementar de Janela de Atendimento (Seção 2 e 5) */}
          <Select
            value={windowFilter}
            onValueChange={(val) => {
              setWindowFilter((val as FollowupWindowFilter) || 'all');
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 text-xs" data-testid="followup-window-filter-trigger">
              <Clock className="size-3 mr-1 text-muted-foreground shrink-0" />
              <SelectValue placeholder="Janela">
                {WINDOW_FILTER_LABELS[windowFilter]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="all">Janela: Todas</SelectItem>
              <SelectItem value="open">Janela de atendimento aberta</SelectItem>
              <SelectItem value="closing_soon">Janela prestes a encerrar</SelectItem>
              <SelectItem value="expired">Template necessário (24h encerrada)</SelectItem>
            </SelectContent>
          </Select>

          {/* 4. Etapa do Pipeline */}
          <Select
            value={stageFilter}
            onValueChange={(val) => {
              setStageFilter(val || 'all');
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 text-xs">
              <GitBranch className="size-3 mr-1 text-muted-foreground shrink-0" />
              <SelectValue placeholder="Etapa">
                {stageFilter === 'all'
                  ? 'Etapa: Todas'
                  : stageFilter === '__none__'
                    ? 'Etapa: Sem etapa'
                    : `Etapa: ${stageFilter}`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="all">Etapa: Todas</SelectItem>
              {availableStages.map((st) => (
                <SelectItem key={st.id} value={st.name}>
                  {st.name}
                </SelectItem>
              ))}
              <SelectItem value="__none__">Sem etapa</SelectItem>
            </SelectContent>
          </Select>

          {/* 5. Tipo da Oportunidade (Primeiro contato vs Retomada) */}
          <Select
            value={opportunityType}
            onValueChange={(val) => {
              setOpportunityType((val as 'all' | FollowupOpportunityType) || 'all');
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Tipo">
                {OPPORTUNITY_TYPE_LABELS[opportunityType]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="all">Tipo: Todos</SelectItem>
              <SelectItem value="first_contact">Primeiro contato</SelectItem>
              <SelectItem value="resumption">Retomada de contato</SelectItem>
            </SelectContent>
          </Select>

          {/* 6. Maturidade */}
          <Select
            value={maturityFilter}
            onValueChange={(val) => {
              setMaturityFilter((val as FollowupMaturityBand) || 'all');
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Maturidade">
                {MATURITY_FILTER_LABELS[maturityFilter]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="all">Maturidade: Todas</SelectItem>
              <SelectItem value="ready">≥ 70% (Alta maturidade)</SelectItem>
              <SelectItem value="growing">40–69% (Em amadurecimento)</SelectItem>
              <SelectItem value="initial">&lt; 40% (Inicial)</SelectItem>
            </SelectContent>
          </Select>

          {/* 7. Score da IA */}
          <Select
            value={minAiScore}
            onValueChange={(val) => {
              setMinAiScore(val || '0');
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Score IA">
                {AI_SCORE_FILTER_LABELS[minAiScore]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="0">Score IA: Qualquer</SelectItem>
              <SelectItem value="5">Score ≥ 5 (Morno/Quente)</SelectItem>
              <SelectItem value="7">Score ≥ 7 (Qualificado)</SelectItem>
              <SelectItem value="9">Score ≥ 9 (Altíssimo calor)</SelectItem>
            </SelectContent>
          </Select>

          {/* 8. Ordenação */}
          <Select
            value={sortBy}
            onValueChange={(val) => {
              setSortBy((val as FollowupSortBy) || 'recent_priority');
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 text-xs" data-testid="followup-sort-trigger">
              <ArrowUpDown className="size-3 mr-1 text-muted-foreground shrink-0" />
              <SelectValue placeholder="Ordenar por">{SORT_BY_LABELS[sortBy]}</SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="recent_priority">Mais recentes e prioritários</SelectItem>
              <SelectItem value="window_closing_soon">Janela prestes a encerrar</SelectItem>
              <SelectItem value="priority_desc">Maior prioridade geral</SelectItem>
              <SelectItem value="maturity_desc">Maior maturidade</SelectItem>
              <SelectItem value="ai_score_desc">Maior score da IA</SelectItem>
              <SelectItem value="longest_without_contact">Mais tempo sem contato</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Intervalo personalizado no Desktop quando "Período personalizado" está selecionado */}
        {dateFilter === 'custom' && (
          <div className="hidden sm:flex items-center gap-3 pt-2.5 mt-2.5 border-t border-border/50 text-xs">
            <span className="text-muted-foreground font-medium">Intervalo personalizado:</span>
            <div className="flex items-center gap-1.5">
              <label className="text-muted-foreground">De</label>
              <Input
                type="date"
                value={customFrom}
                onChange={(e) => {
                  setCustomFrom(e.target.value);
                  setPage(1);
                }}
                className="h-7 w-36 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-muted-foreground">Até</label>
              <Input
                type="date"
                value={customTo}
                onChange={(e) => {
                  setCustomTo(e.target.value);
                  setPage(1);
                }}
                className="h-7 w-36 text-xs"
              />
            </div>
          </div>
        )}
      </div>

      {/* Conteúdo Principal: Grid de Cards (3 colunas no desktop, 2 intermediárias, 1 no mobile) */}
      <div className="flex-1 p-3 sm:p-6 space-y-4 sm:space-y-5">
        {/* Banner informativo de retenção na aba Ignorados */}
        {activeTab === 'ignored' && (
          <div className="rounded-xl border border-border bg-muted/30 px-3.5 py-2.5 text-xs text-muted-foreground">
            Sugestões ignoradas são apagadas definitivamente após{' '}
            <strong>{IGNORED_SUGGESTION_RETENTION_DAYS} dias</strong>. Use &ldquo;Restaurar&rdquo;
            no card para retorná-las à fila de pendentes antes disso.
          </div>
        )}

        {/* Chip de filtro por contato ativo */}
        {contactFilter && (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-primary/30 bg-primary/10 px-3.5 py-2 text-xs">
            <span className="text-foreground">
              Filtrado por lead:{' '}
              <strong>{items[0]?.contact.name || 'Contato selecionado'}</strong>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setContactFilter(null);
                setPage(1);
              }}
              className="h-7 px-2 text-xs gap-1"
            >
              <X className="size-3.5" />
              Limpar contato
            </Button>
          </div>
        )}

        {loading ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
              <Loader2 className="size-3.5 animate-spin text-primary" />
              <span>Carregando oportunidades de Follow-up...</span>
            </div>
            <div
              data-testid="followup-loading-skeleton"
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
            >
              {Array.from({ length: 6 }).map((_, idx) => (
                <div
                  key={idx}
                  className="flex flex-col justify-between rounded-xl border border-border/60 bg-card/50 p-4 gap-3 h-64 animate-pulse"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div className="size-8 rounded-full bg-muted" />
                      <div className="space-y-1.5">
                        <div className="h-3.5 w-28 rounded bg-muted" />
                        <div className="h-2.5 w-20 rounded bg-muted/70" />
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <div className="h-5 w-12 rounded-full bg-muted" />
                      <div className="h-5 w-12 rounded-full bg-muted" />
                    </div>
                  </div>
                  <div className="h-10 rounded-lg bg-muted/40" />
                  <div className="flex-1 rounded-lg bg-muted/30 p-3 space-y-2">
                    <div className="h-3 w-3/4 rounded bg-muted" />
                    <div className="h-3 w-full rounded bg-muted/80" />
                    <div className="h-3 w-2/3 rounded bg-muted/60" />
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    <div className="h-8 rounded-lg bg-muted/50" />
                    <div className="h-8 rounded-lg bg-muted/50" />
                    <div className="h-8 rounded-lg bg-muted/70" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : items.length === 0 ? (
          <div
            data-testid="followup-empty-state"
            className="flex h-60 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 p-6 sm:p-8 text-center w-full"
          >
            <CalendarCheck2 className="size-10 text-muted-foreground/40 mb-3" />
            <h3 className="text-sm font-semibold text-foreground">
              {getNaturalEmptyMessage(activeTab, dateFilter)}
            </h3>
            <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
              {activeTab === 'pending' && dateFilter !== 'all' && counts.pending > 0 && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setDateFilter('all');
                    setPage(1);
                  }}
                  className="h-8 text-xs gap-1.5"
                >
                  <History className="size-3.5" />
                  <span>Ver todas as oportunidades ({counts.pending})</span>
                </Button>
              )}
              {(activeSecondaryFiltersCount > 0 || search.trim()) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={resetAllFilters}
                  className="h-8 text-xs"
                >
                  Limpar filtros
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div
            data-testid="followup-cards-grid"
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          >
            {items.map((item) => (
              <FollowupCard
                key={item.suggestion.id}
                item={item}
                onUpdateStatus={handleUpdateStatus}
                onRefresh={() => void fetchFollowups(true)}
              />
            ))}
          </div>
        )}

        {/* Controles de Paginação (mesmo padrão do Match) */}
        {!loading && pagination.totalItems > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-border/60 text-xs text-muted-foreground">
            <span>
              Mostrando{' '}
              <strong className="text-foreground">
                {(pagination.page - 1) * pagination.pageSize + 1}–
                {Math.min(pagination.page * pagination.pageSize, pagination.totalItems)}
              </strong>{' '}
              de <strong className="text-foreground">{pagination.totalItems}</strong> sugestões
              filtradas
              {activeTab === 'pending' && counts.pending !== pagination.totalItems && (
                <>
                  {' '}
                  (total geral pendente: <strong className="text-foreground">{counts.pending}</strong>)
                </>
              )}
            </span>

            {pagination.totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pagination.page <= 1 || refreshing}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="h-7 text-xs gap-1"
                >
                  <ChevronLeft className="size-3.5" />
                  Anterior
                </Button>
                <span className="px-2 font-medium text-foreground">
                  Página {pagination.page} de {pagination.totalPages}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!pagination.hasMore || refreshing}
                  onClick={() => setPage((p) => p + 1)}
                  className="h-7 text-xs gap-1"
                >
                  Próxima
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal de Confirmação para Ações Coletivas (evita disparo acidental — Seção 11) */}
      <Dialog
        open={bulkActionTarget !== null}
        onOpenChange={(open) => {
          if (!open && !bulkRunning) {
            setBulkActionTarget(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {bulkActionTarget === 'approved'
                ? 'Confirmar aceitação em lote'
                : 'Confirmar descarte em lote'}
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Você está prestes a{' '}
              <strong>
                {bulkActionTarget === 'approved' ? 'aceitar' : 'ignorar'} {items.length}{' '}
                {items.length === 1 ? 'sugestão de follow-up' : 'sugestões de follow-up'}
              </strong>{' '}
              exibidas nesta página. Esta ação atualizará os estados imediatamente sem enviar
              mensagens automáticas.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bulkRunning}
              onClick={() => setBulkActionTarget(null)}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={bulkRunning}
              onClick={() => void handleConfirmBulkAction()}
            >
              {bulkRunning && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
              Confirmar ({items.length})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
