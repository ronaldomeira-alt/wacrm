'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
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
import { LeadMatchCard } from '@/components/match/lead-match-card';
import { LeadMatchesModal } from '@/components/match/lead-matches-modal';
import { SendWhatsAppModal } from '@/components/match/send-whatsapp-modal';
import { AssignedNotificationsPopover } from '@/components/action-items/assigned-notifications-popover';
import type { MatchCardItem } from '@/components/match/match-card';
import type { MatchLifecycleAction } from '@/lib/match/service';
import { writeFollowupDraft } from '@/lib/inbox/followup-draft';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Sparkles,
  Search,
  RefreshCw,
  Loader2,
  Building2,
  Clock,
  CheckCircle2,
  Archive,
  History,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  X,
  AlertTriangle,
  Send,
} from 'lucide-react';
import type { MatchStatus, LeadMatchGroup } from '@/lib/match/types';
import { createClient } from '@/lib/supabase/client';
import { PULL_TO_REFRESH_EVENT } from '@/hooks/use-pull-to-refresh';

const SCORE_FILTER_LABELS: Record<string, string> = {
  all: 'Compatibilidade: Todas (≥90%)',
  elite: '95%+ (Match Perfeito)',
  strong: '90%+ (Match Forte)',
};

const MATURITY_FILTER_LABELS: Record<string, string> = {
  all: 'Maturidade: Todas',
  ready: '≥ 70% (Pronto para Match)',
  growing: '< 70% (Em Amadurecimento)',
};

const AI_SCORE_FILTER_LABELS: Record<string, string> = {
  '0': 'Score IA: Qualquer',
  '5': 'Score ≥ 5 (Morno/Quente)',
  '7': 'Score ≥ 7 (Qualificado)',
  '9': 'Score ≥ 9 (Altíssimo calor)',
};

const DATE_FILTER_LABELS: Record<string, string> = {
  all: 'Período: Todas as datas',
  today: 'Hoje',
  '24h': 'Últimas 24 horas',
  '7d': 'Últimos 7 dias (Recentes)',
  '30d': 'Últimos 30 dias',
  older: 'Anteriores (> 7 dias)',
};

const SORT_BY_LABELS: Record<string, string> = {
  recent_desc: 'Mais recentes primeiro',
  score_desc: 'Maior compatibilidade',
  priority_desc: 'Maior prioridade comercial',
  ai_score_desc: 'Maior Score IA',
};

export default function MatchPage() {
  const [activeTab, setActiveTab] = useState<MatchStatus>('novo');
  const [groups, setGroups] = useState<LeadMatchGroup[]>([]);
  const [counts, setCounts] = useState({
    novos: 0,
    em_analise: 0,
    enviados: 0,
    pausados: 0,
    arquivados: 0,
    ignorados: 0,
    recentes: 0,
    nao_lidos: 0,
  });
  const [catalogStatus, setCatalogStatus] = useState<{
    activePropertiesCount: number;
    totalProjectionsCount: number;
    latestCatalogUpdate: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingActionKey, setLoadingActionKey] = useState<string | null>(null);
  const [triagingHistory, setTriagingHistory] = useState(false);

  // Filtros
  const [leadSearch, setLeadSearch] = useState('');
  const [propertySearch, setPropertySearch] = useState('');
  const [propertyIdFilter, setPropertyIdFilter] = useState<string | null>(null);
  const [urlInitialized, setUrlInitialized] = useState(false);
  const [selectedPropertyContext, setSelectedPropertyContext] = useState<{
    propertyId: string;
    title: string;
    neighborhood: string;
    coverUrl?: string | null;
  } | null>(null);
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | '24h' | '7d' | '30d' | 'older'>('all');
  const [scoreFilter, setScoreFilter] = useState<'all' | 'elite' | 'strong'>('all');
  const [maturityFilter, setMaturityFilter] = useState<'all' | 'ready' | 'growing'>('all');
  const [minAiScore, setMinAiScore] = useState<string>('0');
  const [sortBy, setSortBy] = useState<'recent_desc' | 'score_desc' | 'priority_desc' | 'ai_score_desc'>('recent_desc');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const activeSecondaryFiltersCount = useMemo(() => {
    let count = 0;
    if (propertyIdFilter) count++;
    if (propertySearch.trim()) count++;
    if (dateFilter !== 'all') count++;
    if (scoreFilter !== 'all') count++;
    if (maturityFilter !== 'all') count++;
    if (minAiScore !== '0') count++;
    return count;
  }, [propertyIdFilter, propertySearch, dateFilter, scoreFilter, maturityFilter, minAiScore]);

  // Modais e Deep-link de Notificações
  const router = useRouter();
  const [selectedGroupForModal, setSelectedGroupForModal] = useState<LeadMatchGroup | null>(null);
  const [highlightPropertyId, setHighlightPropertyId] = useState<string | null>(null);
  const [selectedMatchForSend, setSelectedMatchForSend] = useState<MatchCardItem | null>(null);
  const [preparingSendLeadId, setPreparingSendLeadId] = useState<string | null>(null);
  const preparingSendRef = useRef(false);
  const [duplicateConfirmState, setDuplicateConfirmState] = useState<{
    group: LeadMatchGroup;
    propertyTitle: string;
    lastSentAt: string | null;
    sendCount: number;
  } | null>(null);
  const deepLinkHandledRef = useRef<string | null>(null);

  const clearPropertyIdFilter = useCallback(() => {
    setPropertyIdFilter(null);
    setSelectedPropertyContext(null);
    setHighlightPropertyId(null);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('property_id');
      window.history.replaceState(null, '', url.pathname + url.search);
    }
  }, []);

  const resetAllFilters = useCallback(() => {
    setLeadSearch('');
    setPropertySearch('');
    setDateFilter('all');
    setScoreFilter('all');
    setMaturityFilter('all');
    setMinAiScore('0');
    clearPropertyIdFilter();
  }, [clearPropertyIdFilter]);
  const [page, setPage] = useState<number>(1);
  const [pagination, setPagination] = useState<{
    page: number;
    pageSize: number;
    totalGroups: number;
    totalPages: number;
    hasMore: boolean;
  }>({
    page: 1,
    pageSize: 36,
    totalGroups: 0,
    totalPages: 1,
    hasMore: false,
  });

  const fetchMatches = useCallback(
    async (silent = false, forceInventorySync = false) => {
      if (!silent) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      try {
        const params = new URLSearchParams();
        params.set('status', activeTab);
        params.set('sort_by', sortBy);
        params.set('page', String(page));
        params.set('page_size', '36');

        if (forceInventorySync) params.set('sync', '1');
        if (leadSearch.trim()) params.set('lead_search', leadSearch.trim());
        if (propertySearch.trim()) params.set('property_search', propertySearch.trim());
        if (propertyIdFilter) params.set('property_id', propertyIdFilter);
        if (dateFilter !== 'all') params.set('date_filter', dateFilter);

        if (scoreFilter === 'elite') {
          params.set('min_score', '95');
        } else {
          // 'all' e 'strong' aplicam a nota de corte comercial de 90%+
          params.set('min_score', '90');
        }

        if (maturityFilter === 'ready') {
          params.set('min_maturity', '70');
        } else if (maturityFilter === 'growing') {
          params.set('max_maturity', '69');
        }

        if (parseInt(minAiScore, 10) > 0) {
          params.set('min_ai_score', minAiScore);
        }

        const res = await fetch(`/api/match?${params.toString()}`);
        if (!res.ok) throw new Error('Falha ao carregar matches');
        const data = await res.json();

        const newGroups: LeadMatchGroup[] = data.groups || [];
        setGroups(newGroups);
        if (data.counts) {
          setCounts((prev) => ({ ...prev, ...data.counts }));
        }
        if (data.pagination) {
          setPagination(data.pagination);
        }
        if (data.catalogStatus) {
          setCatalogStatus(data.catalogStatus);
        }
        if (propertyIdFilter) {
          setSelectedPropertyContext(data.selectedProperty || null);
        } else {
          setSelectedPropertyContext(null);
        }

        // Atualiza modal caso esteja aberto
        setSelectedGroupForModal((prev) => {
          if (!prev) return null;
          return newGroups.find((g) => g.leadId === prev.leadId) || null;
        });

        // Verifica parâmetros de deep-link vindos de notificação (?lead=...&property=...)
        if (typeof window !== 'undefined') {
          const urlParams = new URLSearchParams(window.location.search);
          const targetLeadId = urlParams.get('lead');
          const targetPropId = urlParams.get('property');
          const deepLinkKey = `${targetLeadId || ''}:${targetPropId || ''}`;

          if ((targetLeadId || targetPropId) && deepLinkHandledRef.current !== deepLinkKey) {
            deepLinkHandledRef.current = deepLinkKey;
            if (targetPropId) {
              setHighlightPropertyId(targetPropId);
            }
            if (targetLeadId) {
              const foundGroup = newGroups.find((g) => g.leadId === targetLeadId);
              if (foundGroup) {
                setSelectedGroupForModal(foundGroup);
              } else {
                // Busca diretamente o grupo do lead caso esteja em outra aba/filtro
                fetch(`/api/match/lead/${targetLeadId}`)
                  .then((r) => (r.ok ? r.json() : null))
                  .then((leadData) => {
                    if (leadData?.matchGroup) {
                      setSelectedGroupForModal(leadData.matchGroup);
                    }
                  })
                  .catch(() => {});
              }
            }
          }
        }
      } catch (err) {
        console.error(err);
        if (!silent) {
          toast.error('Erro ao carregar lista de matches');
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeTab, leadSearch, propertySearch, propertyIdFilter, dateFilter, scoreFilter, maturityFilter, minAiScore, sortBy, page]
  );

  // Lê filtro inicial ?property_id=... da URL (navegação contextual vinda do Painel)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const initialPropId = new URLSearchParams(window.location.search).get('property_id');
      if (initialPropId) {
        setPropertyIdFilter(initialPropId);
        setHighlightPropertyId(initialPropId);
      }
    }
    setUrlInitialized(true);
  }, []);

  // Volta para a página 1 quando mudar aba, filtros ou ordenação
  useEffect(() => {
    setPage(1);
  }, [activeTab, leadSearch, propertySearch, propertyIdFilter, dateFilter, scoreFilter, maturityFilter, minAiScore, sortBy]);

  useEffect(() => {
    if (!urlInitialized) return;
    fetchMatches();
  }, [urlInitialized, fetchMatches]);

  // Sincronização em tempo real via Supabase Realtime
  // Escuta alterações em lead_property_matches, property_match_projections E inventory_properties (Meus Imóveis)
  useEffect(() => {
    const supabase = createClient();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = (forceSync = false) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        fetchMatches(true, forceSync);
      }, 1000);
    };

    const channel = supabase
      .channel('match-page-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lead_property_matches' },
        () => scheduleRefresh(false)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'property_match_projections' },
        () => scheduleRefresh(false)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inventory_properties' },
        () => scheduleRefresh(true)
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [fetchMatches]);

  // Sincronização em retomada de tela (PWA no iPhone/Windows) e Pull-to-Refresh
  useEffect(() => {
    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        fetchMatches(true);
      }
    };

    const handlePull = () => {
      fetchMatches(true, true);
    };

    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('online', handleResume);
    window.addEventListener(PULL_TO_REFRESH_EVENT, handlePull);

    return () => {
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('online', handleResume);
      window.removeEventListener(PULL_TO_REFRESH_EVENT, handlePull);
    };
  }, [fetchMatches]);

  // Ao abrir o modal de um lead na aba 'novo', registra visualização (mark_viewed) silenciosamente
  const handleOpenLeadModal = useCallback(
    (group: LeadMatchGroup) => {
      if (propertyIdFilter) {
        setHighlightPropertyId(propertyIdFilter);
      }
      setSelectedGroupForModal(group);
      if (propertyIdFilter) {
        // Quando filtrado por imóvel, hidrata os demais imóveis compatíveis do cliente para a modal
        fetch(`/api/match/lead/${group.leadId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((leadData) => {
            if (leadData?.matchGroup) {
              setSelectedGroupForModal((curr) =>
                curr?.leadId === group.leadId ? leadData.matchGroup : curr
              );
            }
          })
          .catch(() => {});
      }
      if (group.isUnread) {
        fetch('/api/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation: 'lifecycle',
            action: 'mark_viewed',
            leadId: group.leadId,
            currentStatusFilter: activeTab,
          }),
        })
          .then(() => {
            setGroups((prev) =>
              prev.map((g) =>
                g.leadId === group.leadId ? { ...g, isUnread: false, unreadMatchesCount: 0 } : g
              )
            );
          })
          .catch(() => {});
      }
    },
    [activeTab, propertyIdFilter]
  );

  // Ações rápidas de ciclo de vida diretamente no card do Lead (Em análise, Ignorar, Arquivar, Restaurar)
  const handleQuickAction = useCallback(
    async (
      group: LeadMatchGroup,
      action: MatchLifecycleAction,
      scope: 'lead' | 'best_match' = 'lead'
    ) => {
      const key = `${group.leadId}:${action}`;
      setLoadingActionKey(key);
      try {
        const res = await fetch('/api/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation: 'lifecycle',
            action,
            leadId: scope === 'lead' ? group.leadId : undefined,
            matchId: scope === 'best_match' ? group.bestMatch?.id : undefined,
            currentStatusFilter: activeTab,
          }),
        });

        if (!res.ok) {
          throw new Error('Falha ao atualizar oportunidade');
        }

        const actionLabels: Record<string, string> = {
          view: 'Oportunidade movida para Em Análise.',
          ignore: 'Oportunidade ignorada (não voltará aos novos sem mudança material).',
          archive: 'Oportunidade arquivada no histórico.',
          restore: 'Oportunidade restaurada para Novos.',
        };

        toast.success(actionLabels[action] || 'Estado atualizado!');
        await fetchMatches(true);
      } catch (err) {
        toast.error((err as Error).message || 'Erro ao executar ação');
      } finally {
        setLoadingActionKey(null);
      }
    },
    [activeTab, fetchMatches]
  );

  // Preparação inteligente de envio no Inbox: gera mensagem contextual + link público e abre conversa com rascunho (sem disparar)
  const handleSmartSend = useCallback(
    async (group: LeadMatchGroup, forceResend = false) => {
      if (preparingSendRef.current) return;

      const bestMatch = group.bestMatch as unknown as {
        id?: string;
        property_id?: string;
        property?: { title?: string };
      } | undefined;
      const propertyId = bestMatch?.property_id;

      if (!propertyId) {
        toast.error('Imóvel desta oportunidade não foi identificado.');
        return;
      }

      preparingSendRef.current = true;
      setPreparingSendLeadId(group.leadId);
      try {
        const res = await fetch('/api/match/prepare-send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_id: group.leadId,
            property_id: propertyId,
            match_id: bestMatch?.id || null,
            force_resend: forceResend,
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error || 'Não foi possível preparar a mensagem para envio.');
        }

        if (data.requiresConfirmation) {
          setDuplicateConfirmState({
            group,
            propertyTitle: data.propertyTitle || bestMatch?.property?.title || 'Imóvel selecionado',
            lastSentAt: data.duplicateInfo?.lastSentAt || null,
            sendCount: Number(data.duplicateInfo?.sendCount || 1),
          });
          return;
        }

        setDuplicateConfirmState(null);
        writeFollowupDraft(data.conversationId, {
          mode: 'free',
          text: data.draftText,
          matchShare: {
            matchId: data.matchId || bestMatch?.id || null,
            leadId: group.leadId,
            propertyId: data.propertyId || propertyId,
            propertyTitle: data.propertyTitle || bestMatch?.property?.title || 'Imóvel selecionado',
            publicUrl: data.publicUrl,
            alreadySentBefore: Boolean(data.duplicateInfo?.alreadySent),
            templateAngle: data.templateAngle,
          },
        });

        if (data.generatedBy === 'fallback') {
          toast.info(
            'Mensagem segura preparada com os dados do imóvel (IA indisponível no momento).'
          );
        }

        router.push(`/inbox?c=${encodeURIComponent(data.conversationId)}`);
      } catch (err) {
        toast.error((err as Error).message || 'Erro ao preparar mensagem contextual.');
      } finally {
        preparingSendRef.current = false;
        setPreparingSendLeadId(null);
      }
    },
    [router]
  );

  // Triagem em lote de oportunidades antigas acumuladas (> 14 dias)
  const handleTriageHistorical = useCallback(async () => {
    setTriagingHistory(true);
    try {
      const res = await fetch('/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'triage_historical',
          olderThanDays: 14,
        }),
      });
      if (!res.ok) throw new Error('Falha ao arquivar oportunidades antigas');
      const data = await res.json();
      toast.success(
        `${data.leadsArchived || 0} leads antigos (${data.matchesArchived || 0} matches) movidos para Arquivados!`
      );
      await fetchMatches(true);
    } catch (err) {
      toast.error((err as Error).message || 'Erro ao arquivar histórico');
    } finally {
      setTriagingHistory(false);
    }
  }, [fetchMatches]);

  // Separação entre oportunidades recentes (últimos 7 dias) e anteriores na aba 'novo'
  const { recentGroups, historicalGroups, showSplitView } = useMemo(() => {
    if (activeTab !== 'novo' || dateFilter !== 'all') {
      return {
        recentGroups: groups,
        historicalGroups: [] as LeadMatchGroup[],
        showSplitView: false,
      };
    }

    const recent: LeadMatchGroup[] = [];
    const historical: LeadMatchGroup[] = [];
    for (const g of groups) {
      if (g.isRecent) {
        recent.push(g);
      } else {
        historical.push(g);
      }
    }

    return {
      recentGroups: recent,
      historicalGroups: historical,
      showSplitView: true,
    };
  }, [groups, activeTab, dateFilter]);

  return (
    <div className="-m-4 sm:-m-6 flex min-h-[calc(100%+2rem)] sm:min-h-[calc(100%+3rem)] flex-col">
      {/* Top Header */}
      <div className="border-b border-border bg-card/60 backdrop-blur-md px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-foreground flex items-center gap-1.5 shrink-0">
              <Sparkles className="size-4.5 sm:size-5 text-primary" />
              Match
            </h1>
            <span className="rounded-full bg-primary/10 border border-primary/20 px-2 py-0.5 text-[10px] sm:text-xs font-semibold text-primary shrink-0">
              Túnel Ativo
            </span>
            {catalogStatus && (
              <span className="hidden md:inline-flex rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                {catalogStatus.activePropertiesCount} imóveis sincronizados
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Sino de Notificações Internas de Match */}
            <AssignedNotificationsPopover onlyMatch />

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRefreshing(true);
                fetchMatches(false, true);
              }}
              disabled={loading || refreshing}
              className="h-8 px-2.5 sm:px-3 text-xs gap-1.5"
              title="Sincronizar com Meus Imóveis e atualizar oportunidades"
            >
              <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Atualizar</span>
            </Button>
          </div>
        </div>

        <p className="hidden sm:block text-xs text-muted-foreground mt-1">
          Recomendações determinísticas de imóveis para leads qualificados.
        </p>

        {/* Tabs de Status do Ciclo de Vida (Swipe horizontal fluido no iPhone) */}
        <div className="mt-3 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto no-scrollbar pb-1">
          <Tabs
            value={activeTab}
            onValueChange={(val) => {
              const nextTab = val as MatchStatus;
              setActiveTab(nextTab);
              if (nextTab === 'novo') {
                setSortBy('recent_desc');
              }
            }}
            className="w-full"
          >
            <TabsList className="inline-flex w-max space-x-1 bg-muted/60 p-1 rounded-xl">
              <TabsTrigger value="novo" className="gap-1.5 text-xs px-3 py-1.5 shrink-0">
                Novos
                <span className="rounded-full bg-primary/15 px-1.5 py-0.2 text-[10px] font-bold text-primary">
                  {counts.novos}
                </span>
              </TabsTrigger>
              <TabsTrigger value="em_analise" className="gap-1.5 text-xs px-3 py-1.5 shrink-0">
                Em Análise
                <span className="rounded-full bg-blue-500/15 px-1.5 py-0.2 text-[10px] font-bold text-blue-400">
                  {counts.em_analise}
                </span>
              </TabsTrigger>
              <TabsTrigger value="enviado" className="gap-1.5 text-xs px-3 py-1.5 shrink-0">
                Enviados
                <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-bold text-emerald-400">
                  {counts.enviados}
                </span>
              </TabsTrigger>
              <TabsTrigger value="pausado" className="gap-1.5 text-xs px-3 py-1.5 shrink-0">
                Pausados
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.2 text-[10px] font-bold text-amber-500">
                  {counts.pausados}
                </span>
              </TabsTrigger>
              <TabsTrigger value="arquivado" className="gap-1.5 text-xs px-3 py-1.5 shrink-0">
                Arquivados
                <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-bold text-muted-foreground">
                  {counts.arquivados}
                </span>
              </TabsTrigger>
              <TabsTrigger value="ignorado" className="gap-1.5 text-xs px-3 py-1.5 shrink-0">
                Ignorados
                <span className="rounded-full bg-rose-500/15 px-1.5 py-0.2 text-[10px] font-bold text-rose-400">
                  {counts.ignorados}
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* Barra de Filtros Inteligentes */}
      <div className="border-b border-border bg-card/30 px-4 py-2.5 sm:px-6 sm:py-3">
        {/* Mobile: Barra compacta (Busca de Lead + Toggle Filtros + Ordenação) */}
        <div className="sm:hidden flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Buscar lead (nome/tel)..."
                value={leadSearch}
                onChange={(e) => setLeadSearch(e.target.value)}
                className="pl-8 pr-7 text-xs h-9 bg-background/60"
              />
              {leadSearch && (
                <button
                  type="button"
                  onClick={() => setLeadSearch('')}
                  className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>

            <Button
              type="button"
              variant={mobileFiltersOpen || activeSecondaryFiltersCount > 0 ? 'secondary' : 'outline'}
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

          {/* Painel Expansível de Filtros Secundários no Mobile */}
          {mobileFiltersOpen && (
            <div className="rounded-xl border border-border/80 bg-card p-3 shadow-md space-y-2.5 animate-in fade-in-50 slide-in-from-top-2">
              <div className="flex items-center justify-between pb-1 border-b border-border/50 text-xs">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <SlidersHorizontal className="size-3 text-primary" />
                  Filtros Avançados
                </span>
                {activeSecondaryFiltersCount > 0 && (
                  <button
                    type="button"
                    onClick={resetAllFilters}
                    className="text-[11px] text-primary hover:underline font-medium"
                  >
                    Limpar filtros
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2 pt-1">
                {/* Busca por Imóvel */}
                <div className="relative">
                  <Building2 className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Buscar imóvel/bairro..."
                    value={propertySearch}
                    onChange={(e) => setPropertySearch(e.target.value)}
                    className="pl-8 text-xs h-8 bg-background"
                  />
                </div>

                {/* Ordenação no Mobile */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Ordenação</label>
                  <Select
                    value={sortBy}
                    onValueChange={(val) => setSortBy((val as typeof sortBy) || 'recent_desc')}
                  >
                    <SelectTrigger className="h-8 text-xs bg-background">
                      <ArrowUpDown className="size-3 mr-1 text-muted-foreground shrink-0" />
                      <SelectValue placeholder="Ordenar por">
                        {SORT_BY_LABELS[sortBy] || 'Mais recentes primeiro'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="text-xs">
                      <SelectItem value="recent_desc">Mais recentes primeiro</SelectItem>
                      <SelectItem value="score_desc">Maior compatibilidade</SelectItem>
                      <SelectItem value="priority_desc">Maior prioridade comercial</SelectItem>
                      <SelectItem value="ai_score_desc">Maior Score IA</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Filtro de Data / Período */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Período</label>
                  <Select
                    value={dateFilter}
                    onValueChange={(val) => setDateFilter((val as typeof dateFilter) || 'all')}
                  >
                    <SelectTrigger className="h-8 text-xs bg-background">
                      <SelectValue placeholder="Período">
                        {DATE_FILTER_LABELS[dateFilter] || 'Período: Todas as datas'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="text-xs">
                      <SelectItem value="all">Período: Todas as datas</SelectItem>
                      <SelectItem value="today">Hoje</SelectItem>
                      <SelectItem value="24h">Últimas 24 horas</SelectItem>
                      <SelectItem value="7d">Últimos 7 dias (Recentes)</SelectItem>
                      <SelectItem value="30d">Últimos 30 dias</SelectItem>
                      <SelectItem value="older">Anteriores (&gt; 7 dias)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Faixa de Compatibilidade */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Compatibilidade</label>
                  <Select
                    value={scoreFilter}
                    onValueChange={(val) => setScoreFilter((val as typeof scoreFilter) || 'all')}
                  >
                    <SelectTrigger className="h-8 text-xs bg-background">
                      <SelectValue placeholder="Compatibilidade">
                        {SCORE_FILTER_LABELS[scoreFilter] || 'Compatibilidade: Todas'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="text-xs">
                      <SelectItem value="all">Compatibilidade: Todas (≥90%)</SelectItem>
                      <SelectItem value="elite">95%+ (Match Perfeito)</SelectItem>
                      <SelectItem value="strong">90%+ (Match Forte)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Maturidade e Score IA em linha */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">Maturidade</label>
                    <Select
                      value={maturityFilter}
                      onValueChange={(val) => setMaturityFilter((val as typeof maturityFilter) || 'all')}
                    >
                      <SelectTrigger className="h-8 text-xs bg-background">
                        <SelectValue placeholder="Maturidade">
                          {MATURITY_FILTER_LABELS[maturityFilter] || 'Maturidade: Todas'}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="text-xs">
                        <SelectItem value="all">Todas</SelectItem>
                        <SelectItem value="ready">≥ 70%</SelectItem>
                        <SelectItem value="growing">&lt; 70%</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground uppercase font-semibold">Score IA</label>
                    <Select value={minAiScore} onValueChange={(val) => setMinAiScore(val || '0')}>
                      <SelectTrigger className="h-8 text-xs bg-background">
                        <SelectValue placeholder="Temperatura">
                          {AI_SCORE_FILTER_LABELS[minAiScore] || 'Score IA: Qualquer'}
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

        {/* Desktop: Grid Responsivo de 7 Colunas (mantido idêntico) */}
        <div className="hidden sm:grid sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2.5">
          {/* Busca por Lead */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Buscar lead (nome/tel)..."
              value={leadSearch}
              onChange={(e) => setLeadSearch(e.target.value)}
              className="pl-8 text-xs h-8"
            />
          </div>

          {/* Busca por Imóvel */}
          <div className="relative">
            <Building2 className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Buscar imóvel/bairro..."
              value={propertySearch}
              onChange={(e) => setPropertySearch(e.target.value)}
              className="pl-8 text-xs h-8"
            />
          </div>

          {/* Filtro de Data / Período */}
          <Select
            value={dateFilter}
            onValueChange={(val) => setDateFilter((val as typeof dateFilter) || 'all')}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Período">
                {DATE_FILTER_LABELS[dateFilter] || 'Período: Todas as datas'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="all">Período: Todas as datas</SelectItem>
              <SelectItem value="today">Hoje</SelectItem>
              <SelectItem value="24h">Últimas 24 horas</SelectItem>
              <SelectItem value="7d">Últimos 7 dias (Recentes)</SelectItem>
              <SelectItem value="30d">Últimos 30 dias</SelectItem>
              <SelectItem value="older">Anteriores (&gt; 7 dias)</SelectItem>
            </SelectContent>
          </Select>

          {/* Faixa de Compatibilidade */}
          <Select
            value={scoreFilter}
            onValueChange={(val) => setScoreFilter((val as typeof scoreFilter) || 'all')}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Compatibilidade">
                {SCORE_FILTER_LABELS[scoreFilter] || 'Compatibilidade: Todas'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="all">Compatibilidade: Todas (≥90%)</SelectItem>
              <SelectItem value="elite">95%+ (Match Perfeito)</SelectItem>
              <SelectItem value="strong">90%+ (Match Forte)</SelectItem>
            </SelectContent>
          </Select>

          {/* Maturidade */}
          <Select
            value={maturityFilter}
            onValueChange={(val) => setMaturityFilter((val as typeof maturityFilter) || 'all')}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Maturidade">
                {MATURITY_FILTER_LABELS[maturityFilter] || 'Maturidade: Todas'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="all">Maturidade: Todas</SelectItem>
              <SelectItem value="ready">≥ 70% (Pronto para Match)</SelectItem>
              <SelectItem value="growing">&lt; 70% (Em Amadurecimento)</SelectItem>
            </SelectContent>
          </Select>

          {/* Temperatura / Score IA */}
          <Select value={minAiScore} onValueChange={(val) => setMinAiScore(val || '0')}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Temperatura">
                {AI_SCORE_FILTER_LABELS[minAiScore] || 'Score IA: Qualquer'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="0">Score IA: Qualquer</SelectItem>
              <SelectItem value="5">Score ≥ 5 (Morno/Quente)</SelectItem>
              <SelectItem value="7">Score ≥ 7 (Qualificado)</SelectItem>
              <SelectItem value="9">Score ≥ 9 (Altíssimo calor)</SelectItem>
            </SelectContent>
          </Select>

          {/* Ordenação */}
          <Select
            value={sortBy}
            onValueChange={(val) => setSortBy((val as typeof sortBy) || 'recent_desc')}
          >
            <SelectTrigger className="h-8 text-xs">
              <ArrowUpDown className="size-3 mr-1 text-muted-foreground shrink-0" />
              <SelectValue placeholder="Ordenar por">
                {SORT_BY_LABELS[sortBy] || 'Mais recentes primeiro'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-xs">
              <SelectItem value="recent_desc">Mais recentes primeiro</SelectItem>
              <SelectItem value="score_desc">Maior compatibilidade</SelectItem>
              <SelectItem value="priority_desc">Maior prioridade comercial</SelectItem>
              <SelectItem value="ai_score_desc">Maior Score IA</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Conteúdo Principal: Grid de Leads (1 Card Visual = 1 Lead) */}
      <div className="flex-1 p-3 sm:p-6 space-y-4 sm:space-y-6">
        {propertyIdFilter && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/30 bg-primary/10 px-3.5 py-2.5 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <Building2 className="size-4 shrink-0 text-primary" />
              <span className="truncate text-foreground">
                Filtrado por imóvel:{' '}
                <strong>
                  {selectedPropertyContext
                    ? selectedPropertyContext.neighborhood &&
                      !selectedPropertyContext.title
                        .toLowerCase()
                        .includes(selectedPropertyContext.neighborhood.toLowerCase())
                      ? `${selectedPropertyContext.title} – ${selectedPropertyContext.neighborhood}`
                      : selectedPropertyContext.title
                    : 'Imóvel selecionado'}
                </strong>
              </span>
              {!loading && (
                <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  {pagination.totalGroups}{' '}
                  {pagination.totalGroups === 1 ? 'cliente' : 'clientes'}
                </span>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearPropertyIdFilter}
              className="h-7 shrink-0 gap-1 px-2 text-xs text-foreground hover:bg-primary/15"
            >
              <X className="size-3.5" />
              <span>Limpar filtro</span>
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex h-56 flex-col items-center justify-center gap-3 text-center px-4">
            <div className="relative">
              <div className="size-9 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
              <Sparkles className="size-3.5 text-primary absolute inset-0 m-auto" />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold text-foreground">
                {refreshing ? 'Sincronizando com Meus Imóveis...' : 'Carregando oportunidades determinísticas...'}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Cruzando perfis dos leads com o estoque imobiliário ativo.
              </p>
            </div>
          </div>
        ) : groups.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 p-6 sm:p-8 text-center w-full">
            <Sparkles className="size-10 text-muted-foreground/40 mb-3" />
            <h3 className="text-sm font-semibold text-foreground">
              Nenhuma oportunidade encontrada nesta visualização
            </h3>
            <p className="text-xs text-muted-foreground max-w-sm mt-1">
              Não há recomendações correspondentes aos filtros selecionados na aba{' '}
              <strong>{activeTab.replace('_', ' ').toUpperCase()}</strong>.
            </p>
          </div>
        ) : showSplitView ? (
          <>
            {/* SEÇÃO 1: OPORTUNIDADES NOVAS / RECENTES (Últimos 7 dias) */}
            <section className="space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-border/60">
                <div className="flex items-center gap-2">
                  <Clock className="size-4 text-primary" />
                  <h2 className="text-sm font-bold text-foreground">
                    Novas Oportunidades Recentes (últimos 7 dias)
                  </h2>
                  <span className="rounded-full bg-primary/15 border border-primary/30 px-2 py-0.5 text-xs font-bold text-primary">
                    {recentGroups.length}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Ordenadas da mais recente para a mais antiga.
                </p>
              </div>

              {recentGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
                  <CheckCircle2 className="size-8 text-emerald-400 mb-2" />
                  <h3 className="text-sm font-semibold text-foreground">
                    Nenhuma oportunidade nova identificada nos últimos 7 dias
                  </h3>
                  <p className="text-xs text-muted-foreground max-w-md mt-1">
                    Você está em dia com as novidades recentes! Abaixo estão apenas as oportunidades anteriores acumuladas que aguardam triagem.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {recentGroups.map((group) => (
                    <LeadMatchCard
                      key={group.leadId}
                      group={group}
                      activeTab={activeTab}
                      loadingAction={loadingActionKey}
                      preparingSendLeadId={preparingSendLeadId}
                      onOpenModal={handleOpenLeadModal}
                      onQuickAction={handleQuickAction}
                      onSmartSend={(g) => void handleSmartSend(g)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* SEÇÃO 2: OPORTUNIDADES ANTERIORES / ACUMULADAS (+7 dias) */}
            {historicalGroups.length > 0 && (
              <section className="space-y-3 pt-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-border/60">
                  <div className="flex items-center gap-2">
                    <History className="size-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold text-muted-foreground">
                      Oportunidades Anteriores Aguardando Triagem (+7 dias)
                    </h2>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                      {historicalGroups.length}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={triagingHistory}
                      onClick={handleTriageHistorical}
                      className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                      title="Mover oportunidades com mais de 14 dias para a aba Arquivados (mantendo no histórico)"
                    >
                      {triagingHistory ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Archive className="size-3" />
                      )}
                      <span>Arquivar anteriores (&gt; 14 dias)</span>
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 opacity-95">
                  {historicalGroups.map((group) => (
                    <LeadMatchCard
                      key={group.leadId}
                      group={group}
                      activeTab={activeTab}
                      loadingAction={loadingActionKey}
                      preparingSendLeadId={preparingSendLeadId}
                      onOpenModal={handleOpenLeadModal}
                      onQuickAction={handleQuickAction}
                      onSmartSend={(g) => void handleSmartSend(g)}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {groups.map((group) => (
              <LeadMatchCard
                key={group.leadId}
                group={group}
                activeTab={activeTab}
                loadingAction={loadingActionKey}
                preparingSendLeadId={preparingSendLeadId}
                onOpenModal={handleOpenLeadModal}
                onQuickAction={handleQuickAction}
                onSmartSend={(g) => void handleSmartSend(g)}
              />
            ))}
          </div>
        )}

        {/* Controles de Paginação Completa (cobre 100% dos leads sem truncamento) */}
        {!loading && pagination.totalGroups > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-border/60 text-xs text-muted-foreground">
            <span>
              Mostrando{' '}
              <strong className="text-foreground">
                {(pagination.page - 1) * pagination.pageSize + 1}–
                {Math.min(pagination.page * pagination.pageSize, pagination.totalGroups)}
              </strong>{' '}
              de <strong className="text-foreground">{pagination.totalGroups}</strong> leads nesta aba
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

      {/* Modal Central Grande de Imóveis Compatíveis do Lead */}
      <LeadMatchesModal
        open={!!selectedGroupForModal}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedGroupForModal(null);
            setHighlightPropertyId(null);
          }
        }}
        group={selectedGroupForModal}
        highlightPropertyId={highlightPropertyId}
        onOpenSendModal={(match) => setSelectedMatchForSend(match)}
        onMatchUpdated={() => fetchMatches(true)}
      />

      {/* Confirmação de reenvio quando o imóvel já foi apresentado anteriormente ao lead */}
      <Dialog
        open={!!duplicateConfirmState}
        onOpenChange={(open) => {
          if (!open && !preparingSendLeadId) {
            setDuplicateConfirmState(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-5 text-amber-400" />
              Imóvel já apresentado anteriormente
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              O imóvel <strong className="text-foreground">{duplicateConfirmState?.propertyTitle}</strong> já possui{' '}
              {duplicateConfirmState && duplicateConfirmState.sendCount > 1
                ? `${duplicateConfirmState.sendCount} registros de envio`
                : 'um registro de envio'}{' '}
              para <strong className="text-foreground">{duplicateConfirmState?.group.lead.name || 'este cliente'}</strong>
              {duplicateConfirmState?.lastSentAt &&
              !Number.isNaN(new Date(duplicateConfirmState.lastSentAt).getTime())
                ? ` (último envio em ${format(new Date(duplicateConfirmState.lastSentAt), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })})`
                : ''}
              . Deseja preparar uma nova mensagem mesmo assim?
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!!preparingSendLeadId}
              onClick={() => setDuplicateConfirmState(null)}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!!preparingSendLeadId}
              className="bg-emerald-600 hover:bg-emerald-500 text-white gap-1.5"
              onClick={() => {
                if (!duplicateConfirmState) return;
                void handleSmartSend(duplicateConfirmState.group, true);
              }}
            >
              {preparingSendLeadId ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Preparando...
                </>
              ) : (
                <>
                  <Send className="size-3.5" />
                  Preparar nova mensagem
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal de Envio via WhatsApp Pessoal Individual */}
      {selectedMatchForSend && (
        <SendWhatsAppModal
          open={!!selectedMatchForSend}
          onOpenChange={(open) => !open && setSelectedMatchForSend(null)}
          matchId={selectedMatchForSend.id}
          leadId={selectedMatchForSend.lead_id}
          leadName={selectedMatchForSend.contacts.name || 'Lead'}
          leadPhone={selectedMatchForSend.contacts.phone}
          propertyId={selectedMatchForSend.property_id}
          propertyTitle={selectedMatchForSend.property.title}
          propertyNeighborhood={selectedMatchForSend.property.neighborhood}
          propertyPriceMin={selectedMatchForSend.property.priceMin}
          propertyCoverUrl={selectedMatchForSend.property.coverUrl}
          matchScore={Math.round(selectedMatchForSend.match_score)}
          onSent={() => {
            fetchMatches(true);
          }}
        />
      )}
    </div>
  );
}
