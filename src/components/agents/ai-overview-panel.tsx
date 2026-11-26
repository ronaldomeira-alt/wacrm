'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  Bot,
  ChevronRight,
  Coins,
  Cpu,
  GraduationCap,
  ListTodo,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/dashboard/skeleton';
import { cn } from '@/lib/utils';
import {
  AI_HUB_SECTION_META,
  getVisibleAiHubSections,
  UNIFIED_SUGGESTION_CATEGORIES,
  type AiHubSection,
} from './ai-hub-sections';

const PROVIDER_SHORT: Record<string, string> = {
  deepseek: 'DeepSeek',
  opencode_go: 'OpenCode Go',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

function formatTokensCompact(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  }
  return n.toLocaleString('pt-BR');
}

function formatUsdCompact(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

interface OverviewData {
  configured: boolean;
  identityName: string;
  isActive: boolean;
  autoReplyEnabled: boolean;
  primaryProvider: string | null;
  primaryModel: string | null;
  secondaryProvider: string | null;
  secondaryModel: string | null;
  fallbackEnabled: boolean;
  pendingLearnings: number | null;
  pendingSuggestions: number | null;
  queuePending: number | null;
  queueSupervision: number | null;
  tokens30d: number | null;
  costUsd30d: number | null;
}

export function AiOverviewPanel({
  canAccessInfrastructure,
  onSelect,
}: {
  canAccessInfrastructure: boolean;
  onSelect: (section: AiHubSection) => void;
}) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [cfgRes, suggRes, provRes, usageRes] = await Promise.allSettled([
          fetch('/api/ai/config', { cache: 'no-store' }).then((r) =>
            r.ok ? r.json() : null,
          ),
          fetch('/api/ai/suggestions?status=pending', { cache: 'no-store' }).then((r) =>
            r.ok ? r.json() : null,
          ),
          canAccessInfrastructure
            ? fetch('/api/ai/providers', { cache: 'no-store' }).then((r) =>
                r.ok ? r.json() : null,
              )
            : Promise.resolve(null),
          canAccessInfrastructure
            ? fetch('/api/ai/usage?preset=30d', { cache: 'no-store' }).then((r) =>
                r.ok ? r.json() : null,
              )
            : Promise.resolve(null),
        ]);

        if (cancelled) return;

        const cfg = cfgRes.status === 'fulfilled' ? cfgRes.value : null;
        const sugg = suggRes.status === 'fulfilled' ? suggRes.value : null;
        const prov = provRes.status === 'fulfilled' ? provRes.value : null;
        const usage = usageRes.status === 'fulfilled' ? usageRes.value : null;

        const suggestionList: Array<{ category?: string }> = Array.isArray(sugg?.suggestions)
          ? sugg.suggestions
          : [];
        const operationalSet = new Set<string>(UNIFIED_SUGGESTION_CATEGORIES);
        const pendingLearnings = sugg
          ? suggestionList.filter((s) => s.category === 'learning').length
          : null;
        const pendingSuggestions = sugg
          ? suggestionList.filter((s) => s.category && operationalSet.has(s.category)).length
          : null;

        setData({
          configured: Boolean(cfg?.configured),
          identityName:
            typeof cfg?.identity_name === 'string' && cfg.identity_name.trim()
              ? cfg.identity_name.trim()
              : 'Clara',
          isActive: Boolean(cfg?.is_active),
          autoReplyEnabled: Boolean(cfg?.auto_reply_enabled),
          primaryProvider: prov?.settings?.provider ?? cfg?.provider ?? null,
          primaryModel: prov?.settings?.model ?? cfg?.model ?? null,
          secondaryProvider: prov?.settings?.secondaryProvider ?? cfg?.secondary_provider ?? null,
          secondaryModel: prov?.settings?.secondaryModel ?? cfg?.secondary_model ?? null,
          fallbackEnabled: Boolean(
            prov?.settings?.fallbackEnabled ?? cfg?.fallback_enabled ?? false,
          ),
          pendingLearnings,
          pendingSuggestions,
          queuePending:
            typeof prov?.queue?.pendingCount === 'number' ? prov.queue.pendingCount : null,
          queueSupervision:
            typeof prov?.queue?.supervisionCount === 'number'
              ? prov.queue.supervisionCount
              : null,
          tokens30d:
            typeof usage?.totals?.total_tokens === 'number'
              ? usage.totals.total_tokens
              : null,
          costUsd30d:
            typeof usage?.totals?.cost_usd === 'number' ? usage.totals.cost_usd : null,
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canAccessInfrastructure]);

  const quickSections = getVisibleAiHubSections(canAccessInfrastructure).filter(
    (s) => s !== 'overview',
  );

  const quickSubtitle = (section: AiHubSection): ReactNode => {
    if (loading || !data) {
      return (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" /> Carregando...
        </span>
      );
    }
    switch (section) {
      case 'behavior':
        return data.isActive
          ? data.autoReplyEnabled
            ? 'IA ativa · Auto-Reply ligado'
            : 'IA ativa · Auto-Reply pausado'
          : 'IA desativada no CRM';
      case 'evolution':
        return data.pendingLearnings == null
          ? AI_HUB_SECTION_META.evolution.description
          : data.pendingLearnings === 0
            ? 'Nenhum aprendizado pendente'
            : `${data.pendingLearnings} aprendizado${data.pendingLearnings > 1 ? 's' : ''} pendente${data.pendingLearnings > 1 ? 's' : ''}`;
      case 'suggestions':
        return data.pendingSuggestions == null
          ? AI_HUB_SECTION_META.suggestions.description
          : data.pendingSuggestions === 0
            ? 'Nenhuma sugestão pendente'
            : `${data.pendingSuggestions} sugest${data.pendingSuggestions > 1 ? 'ões' : 'ão'} pendente${data.pendingSuggestions > 1 ? 's' : ''}`;
      case 'providers':
        return data.primaryProvider && data.primaryModel
          ? `${PROVIDER_SHORT[data.primaryProvider] ?? data.primaryProvider} · ${data.primaryModel}`
          : 'Não configurado';
      case 'usage': {
        const usd = formatUsdCompact(data.costUsd30d);
        if (data.tokens30d == null) return 'Gráficos, tokens e custos em USD';
        return usd
          ? `${formatTokensCompact(data.tokens30d)} tokens · ${usd} (30d)`
          : `${formatTokensCompact(data.tokens30d)} tokens (30d)`;
      }
      default:
        return AI_HUB_SECTION_META[section].description;
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-xl" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  const usdFormatted = formatUsdCompact(data?.costUsd30d ?? null);

  return (
    <section className="space-y-5 animate-in fade-in-50 duration-200">
      {/* Identidade e estado operacional da Clara */}
      <Card className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4 min-w-0">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Bot className="size-6" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-foreground">
                {data?.identityName ?? 'Clara'}
              </h2>
              <Badge variant={data?.isActive ? 'default' : 'secondary'}>
                {data?.isActive ? 'IA Ativa no CRM' : 'IA Desativada'}
              </Badge>
              <Badge
                variant={
                  data?.isActive && data?.autoReplyEnabled ? 'default' : 'outline'
                }
                className={cn(
                  data?.isActive && data?.autoReplyEnabled
                    ? 'bg-emerald-600 text-white hover:bg-emerald-600'
                    : 'text-muted-foreground',
                )}
              >
                {data?.isActive && data?.autoReplyEnabled
                  ? 'Auto-Reply WhatsApp: Ativo'
                  : 'Auto-Reply WhatsApp: Pausado'}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {data?.configured
                ? data.primaryProvider && data.primaryModel
                  ? `Modelo principal: ${PROVIDER_SHORT[data.primaryProvider] ?? data.primaryProvider} · ${data.primaryModel}`
                  : 'Agente configurado no WACRM.'
                : 'Agente ainda não configurado. Acesse Credenciais para informar uma chave de API.'}
            </p>
          </div>
        </div>
      </Card>

      {/* Indicadores operacionais reais */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <GraduationCap className="size-3.5 text-primary" />
            <span>Aprendizados pendentes</span>
          </div>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
            {data?.pendingLearnings ?? '—'}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Aguardando revisão em Evolução
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ListTodo className="size-3.5 text-primary" />
            <span>Sugestões pendentes</span>
          </div>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
            {data?.pendingSuggestions ?? '—'}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Pipeline, ações e inconsistências
          </p>
        </div>

        {canAccessInfrastructure && (
          <>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="size-3.5 text-primary" />
                <span>Secundário & Fallback</span>
              </div>
              <p className="mt-2 truncate text-sm font-semibold text-foreground">
                {data?.secondaryProvider
                  ? `${PROVIDER_SHORT[data.secondaryProvider] ?? data.secondaryProvider}${data.secondaryModel ? ` · ${data.secondaryModel}` : ''}`
                  : 'Não configurado'}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Fallback automático: {data?.fallbackEnabled ? 'Ativo' : 'Desativado'}
              </p>
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Coins className="size-3.5 text-primary" />
                <span>Consumo (30 dias)</span>
              </div>
              <p className="mt-2 text-xl font-semibold tabular-nums text-foreground">
                {formatTokensCompact(data?.tokens30d ?? null)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">tokens</span>
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                {usdFormatted ? `Equivalente: ${usdFormatted}` : 'Consulte Consumo para detalhes'}
              </p>
            </div>

            <div className="rounded-xl border border-border bg-card p-4 sm:col-span-2 xl:col-span-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Cpu className="size-3.5 text-primary" />
                <span>Modelo principal em produção</span>
              </div>
              <p className="mt-2 truncate text-sm font-semibold text-foreground">
                {data?.primaryProvider && data?.primaryModel
                  ? `${PROVIDER_SHORT[data.primaryProvider] ?? data.primaryProvider} · ${data.primaryModel}`
                  : 'Não configurado'}
              </p>
            </div>

            <div className="rounded-xl border border-border bg-card p-4 sm:col-span-2 xl:col-span-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Activity className="size-3.5 text-primary" />
                <span>Fila de atendimento & supervisão</span>
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-4 text-sm">
                <span className="font-semibold tabular-nums text-foreground">
                  {data?.queuePending ?? 0} pendente{(data?.queuePending ?? 0) === 1 ? '' : 's'}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {data?.queueSupervision ?? 0} aguardando supervisão humana
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Acessos rápidos */}
      <div>
        <h3 className="mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Acessos rápidos
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {quickSections.map((section) => {
            const meta = AI_HUB_SECTION_META[section];
            const Icon = meta.icon;
            return (
              <button
                key={section}
                type="button"
                onClick={() => onSelect(section)}
                className={cn(
                  'group flex items-start gap-3.5 rounded-xl border border-border bg-card p-4 text-left transition-colors',
                  'hover:border-primary-soft-2 hover:bg-card-2',
                )}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-on-soft">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-foreground">
                    {meta.label}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {quickSubtitle(section)}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
