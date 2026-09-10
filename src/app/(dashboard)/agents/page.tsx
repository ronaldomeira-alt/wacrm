'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  BrainCircuit,
  Check,
  CheckCheck,
  ChevronDown,
  EyeOff,
  Loader2,
  X,
  BookOpen,
  Sparkles,
  ListTodo,
  Sliders,
  Building2,
  GraduationCap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { SuggestionCard } from '@/components/ai-hub/suggestion-card';
import { PropertyKnowledgeList } from '@/components/agents/property-knowledge-list';
import { GlobalKnowledgeSection } from '@/components/agents/global-knowledge-section';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiBehaviorSettings } from '@/components/agents/ai-behavior-settings';
import { AiEvolutionDashboard } from '@/components/agents/ai-evolution-dashboard';
import {
  AI_SUGGESTION_CATEGORIES,
  aiSuggestionCategoryConfig,
  IGNORED_SUGGESTION_RETENTION_DAYS,
} from '@/lib/ai-suggestion-status';
import type { AiSuggestion, AiSuggestionCategory, AiSuggestionStatus } from '@/types';

type StatusFilter = AiSuggestionStatus;
type MainTab = 'knowledge' | 'playground' | 'evolution' | 'suggestions' | 'behavior';

const STATUS_FILTERS: StatusFilter[] = [
  'pending',
  'approved',
  'rejected',
  'ignored',
  'done',
];

export default function AgentsPage() {
  return (
    <Suspense fallback={null}>
      <AgentsPageInner />
    </Suspense>
  );
}

function AgentsPageInner() {
  const t = useTranslations('AiHub');
  const router = useRouter();
  const searchParams = useSearchParams();

  const contactFilter = searchParams.get('contact');
  const tabParam = searchParams.get('tab') as MainTab | null;

  const [activeTab, setActiveTab] = useState<MainTab>(
    tabParam || (contactFilter ? 'suggestions' : 'knowledge'),
  );

  const handleTabChange = (val: string) => {
    const nextTab = val as MainTab;
    setActiveTab(nextTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', nextTab);
    router.replace(`/agents?${params.toString()}`, { scroll: false });
  };

  const [suggestions, setSuggestions] = useState<AiSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [expandedCategories, setExpandedCategories] = useState<
    Set<AiSuggestionCategory>
  >(new Set());

  const toggleCategory = useCallback((cat: AiSuggestionCategory) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const loadSuggestions = useCallback(async () => {
    try {
      const params = new URLSearchParams({ status: statusFilter });
      if (contactFilter) params.set('contactId', contactFilter);
      const res = await fetch(`/api/ai/suggestions?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to load');
      setSuggestions((data.suggestions ?? []) as AiSuggestion[]);
      setError(null);
    } catch {
      setError(t('loadError'));
    }
  }, [statusFilter, contactFilter, t]);

  const clearContactFilter = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('contact');
    router.replace(`/agents${params.toString() ? `?${params.toString()}` : ''}`, {
      scroll: false,
    });
  }, [router, searchParams]);

  useEffect(() => {
    if (activeTab === 'suggestions') {
      loadSuggestions();
    }
  }, [activeTab, loadSuggestions]);

  const patchSuggestion = useCallback(async (id: string, status: AiSuggestionStatus) => {
    const res = await fetch(`/api/ai/suggestions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Failed to update');
  }, []);

  const updateStatus = useCallback(
    async (id: string, status: AiSuggestionStatus) => {
      setSuggestions((prev) => prev?.filter((s) => s.id !== id) ?? prev);
      try {
        await patchSuggestion(id, status);
        toast.success(t('toastUpdated'));
      } catch {
        toast.error(t('toastError'));
        loadSuggestions();
      }
    },
    [loadSuggestions, patchSuggestion, t],
  );

  const itemsByCategory = AI_SUGGESTION_CATEGORIES.reduce<
    Record<AiSuggestionCategory, AiSuggestion[]>
  >(
    (acc, cat) => {
      acc[cat] = suggestions?.filter((s) => s.category === cat) ?? [];
      return acc;
    },
    {} as Record<AiSuggestionCategory, AiSuggestion[]>,
  );

  const counts = AI_SUGGESTION_CATEGORIES.reduce<Record<string, number>>(
    (acc, cat) => {
      acc[cat] = itemsByCategory[cat].length;
      return acc;
    },
    {},
  );

  const [groupBulkRunning, setGroupBulkRunning] = useState<
    Partial<Record<AiSuggestionCategory, boolean>>
  >({});

  const runGroupBulk = useCallback(
    async (category: AiSuggestionCategory, targetStatus: 'approved' | 'ignored') => {
      const targets = suggestions?.filter((s) => s.category === category) ?? [];
      if (targets.length === 0) return;
      setGroupBulkRunning((prev) => ({ ...prev, [category]: true }));
      let failed = 0;
      for (const s of targets) {
        try {
          await patchSuggestion(s.id, targetStatus);
          setSuggestions((prev) => prev?.filter((x) => x.id !== s.id) ?? prev);
        } catch {
          failed += 1;
        }
      }
      setGroupBulkRunning((prev) => ({ ...prev, [category]: false }));
      if (failed === 0) {
        toast.success(
          targetStatus === 'approved'
            ? t('groupBulkAcceptSuccess', { count: targets.length })
            : t('groupBulkIgnoreSuccess', { count: targets.length }),
        );
      } else {
        toast.error(t('groupBulkPartial', { failed, total: targets.length }));
        loadSuggestions();
      }
    },
    [suggestions, patchSuggestion, loadSuggestions, t],
  );

  const pendingPipelineMoves = useMemo(
    () =>
      statusFilter === 'pending'
        ? (suggestions ?? []).filter((s) => s.category === 'pipeline_move')
        : [],
    [statusFilter, suggestions],
  );
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);

  const runBulkAccept = useCallback(async () => {
    setBulkRunning(true);
    const targets = pendingPipelineMoves;
    let failed = 0;
    for (const s of targets) {
      try {
        await patchSuggestion(s.id, 'approved');
        setSuggestions((prev) => prev?.filter((x) => x.id !== s.id) ?? prev);
      } catch {
        failed += 1;
      }
    }
    setBulkRunning(false);
    setBulkConfirmOpen(false);
    if (failed === 0) {
      toast.success(t('bulkAcceptSuccess', { count: targets.length }));
    } else {
      toast.error(t('bulkAcceptPartial', { failed, total: targets.length }));
      loadSuggestions();
    }
  }, [pendingPipelineMoves, patchSuggestion, loadSuggestions, t]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <BrainCircuit className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Central de IA
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Gestão de conhecimento dos empreendimentos, testes de conversação, atividades e comportamento da IA.
        </p>
      </div>

      {contactFilter && (
        <button
          type="button"
          onClick={clearContactFilter}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary"
        >
          {suggestions?.[0]?.contact?.name ?? t('filteredByContact')}
          <X className="h-3 w-3" />
        </button>
      )}

      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-5 max-w-3xl">
          <TabsTrigger value="knowledge" className="flex items-center gap-1.5">
            <BookOpen className="h-4 w-4" />
            <span>Conhecimento</span>
          </TabsTrigger>
          <TabsTrigger value="playground" className="flex items-center gap-1.5">
            <Sparkles className="h-4 w-4" />
            <span>Playground</span>
          </TabsTrigger>
          <TabsTrigger value="evolution" className="flex items-center gap-1.5">
            <GraduationCap className="h-4 w-4" />
            <span>Evolução</span>
          </TabsTrigger>
          <TabsTrigger value="suggestions" className="flex items-center gap-1.5">
            <ListTodo className="h-4 w-4" />
            <span>Sugestões</span>
          </TabsTrigger>
          <TabsTrigger value="behavior" className="flex items-center gap-1.5">
            <Sliders className="h-4 w-4" />
            <span>Comportamento</span>
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Conhecimento */}
        <TabsContent value="knowledge" className="space-y-8">
          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                <Building2 className="h-4 w-4 text-primary" />
                Empreendimentos & Books Técnicos
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Cadastre seus empreendimentos, faça upload dos Books em PDF e adicione anotações práticas do corretor. O conhecimento é 100% isolado por imóvel no RAG.
              </p>
            </div>
            <PropertyKnowledgeList />
          </div>

          <div className="space-y-3 pt-6 border-t border-border">
            <GlobalKnowledgeSection />
          </div>
        </TabsContent>

        {/* Tab 2: Playground */}
        <TabsContent value="playground">
          <AiPlayground />
        </TabsContent>

        {/* Tab 3: Evolução & Aprendizado */}
        <TabsContent value="evolution">
          <AiEvolutionDashboard />
        </TabsContent>

        {/* Tab 4: Sugestões */}
        <TabsContent value="suggestions" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={statusFilter === s ? 'default' : 'outline'}
                  onClick={() => setStatusFilter(s)}
                >
                  {t(`status.${s}`)}
                </Button>
              ))}
            </div>
            {pendingPipelineMoves.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => setBulkConfirmOpen(true)}>
                <CheckCheck className="h-3.5 w-3.5" />
                {t('bulkAcceptButton')}
              </Button>
            )}
          </div>

          {statusFilter === 'ignored' && (
            <p className="text-xs text-muted-foreground">
              {t('ignoredRetentionHint', { days: IGNORED_SUGGESTION_RETENTION_DAYS })}
            </p>
          )}

          <Dialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('bulkAcceptTitle')}</DialogTitle>
                <DialogDescription>
                  {t('bulkAcceptConfirm', { count: pendingPipelineMoves.length })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" disabled={bulkRunning} onClick={() => setBulkConfirmOpen(false)}>
                  {t('bulkAcceptCancel')}
                </Button>
                <Button disabled={bulkRunning} onClick={runBulkAccept}>
                  {bulkRunning && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t('bulkAcceptConfirmBtn')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <div>
            {error ? (
              <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40">
                <p className="text-sm text-destructive">{error}</p>
                <Button variant="outline" size="sm" onClick={loadSuggestions}>
                  {t('retry')}
                </Button>
              </div>
            ) : suggestions === null ? (
              <div className="flex h-48 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : suggestions.length > 0 ? (
              <div className="space-y-3">
                {AI_SUGGESTION_CATEGORIES.filter((cat) => counts[cat] > 0).map((cat) => {
                  const meta = aiSuggestionCategoryConfig[cat];
                  const Icon = meta.icon;
                  const items = itemsByCategory[cat];
                  const isOpen = expandedCategories.has(cat);
                  const running = groupBulkRunning[cat] ?? false;
                  return (
                    <div key={cat} className="rounded-xl border border-border bg-card">
                      <button
                        type="button"
                        onClick={() => toggleCategory(cat)}
                        className="flex w-full items-center justify-between gap-2 p-3 text-left"
                      >
                        <span className="flex items-center gap-2">
                          <Icon className="h-4 w-4 text-primary" />
                          <span className="text-sm font-medium text-foreground">
                            {t(`categories.${meta.labelKey}`)}
                          </span>
                          <span className="text-sm text-muted-foreground">({items.length})</span>
                        </span>
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 text-muted-foreground transition-transform',
                            isOpen && 'rotate-180',
                          )}
                        />
                      </button>

                      {isOpen && (
                        <div className="border-t border-border p-3">
                          {statusFilter === 'pending' && (
                            <div className="mb-3 flex flex-wrap gap-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={running}
                                onClick={() => runGroupBulk(cat, 'ignored')}
                              >
                                {running ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <EyeOff className="h-3.5 w-3.5" />
                                )}
                                {t('groupIgnoreAll')}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={running}
                                onClick={() => runGroupBulk(cat, 'approved')}
                              >
                                {running ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5" />
                                )}
                                {t('groupAcceptAll')}
                              </Button>
                            </div>
                          )}
                          <div className="grid gap-3 lg:grid-cols-2">
                            {items.map((s) => (
                              <SuggestionCard
                                key={s.id}
                                suggestion={s}
                                onUpdateStatus={updateStatus}
                                onRefresh={loadSuggestions}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/40">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                  <BrainCircuit className="h-6 w-6 text-primary" />
                </div>
                <p className="mt-3 text-sm font-medium text-foreground">
                  {t('emptyTitle')}
                </p>
                <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                  {t('emptyDesc')}
                </p>
              </div>
            )}
          </div>
        </TabsContent>

        {/* Tab 4: Comportamento */}
        <TabsContent value="behavior">
          <AiBehaviorSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}
