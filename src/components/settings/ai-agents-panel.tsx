'use client';

import { useEffect, useState } from 'react';
import {
  Sparkles,
  Settings2,
  BarChart3,
  ShieldCheck,
  Bot,
  Activity,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiProvidersPanel } from '@/components/agents/ai-providers';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiConfig } from '@/components/settings/ai-config';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';

type Tab = 'setup' | 'playground' | 'providers' | 'usage';

interface HubSummary {
  autoReplyEnabled: boolean;
  isActive: boolean;
  primaryProvider: string;
  primaryModel: string;
  secondaryProvider: string | null;
  secondaryModel: string | null;
  fallbackEnabled: boolean;
  tokens30d: number | null;
  pendingCount: number;
}

const PROVIDER_SHORT: Record<string, string> = {
  deepseek: 'DeepSeek',
  opencode_go: 'OpenCode Go',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

function formatTokensCompact(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} M`;
  if (n >= 1_000) return `${(n / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return n.toLocaleString('pt-BR');
}

export function AiAgentsPanel() {
  const { accountRole } = useAuth();
  const canViewAdminTabs = accountRole ? canEditSettings(accountRole) : false;
  const [tab, setTab] = useState<Tab>('setup');
  const [decided, setDecided] = useState(false);
  const [summary, setSummary] = useState<HubSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfgRes, provRes, usageRes] = await Promise.allSettled([
          fetch('/api/ai/config', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/ai/providers', { cache: 'no-store' }).then((r) =>
            r.ok ? r.json() : null,
          ),
          fetch('/api/ai/usage?preset=30d', { cache: 'no-store' }).then((r) =>
            r.ok ? r.json() : null,
          ),
        ]);

        if (cancelled) return;
        const cfg = cfgRes.status === 'fulfilled' ? cfgRes.value : {};
        const prov = provRes.status === 'fulfilled' ? provRes.value : null;
        const usage = usageRes.status === 'fulfilled' ? usageRes.value : null;

        setTab(cfg?.configured ? 'playground' : 'setup');
        setSummary({
          isActive: Boolean(cfg?.is_active),
          autoReplyEnabled: Boolean(cfg?.auto_reply_enabled),
          primaryProvider: prov?.settings?.provider ?? cfg?.provider ?? 'deepseek',
          primaryModel: prov?.settings?.model ?? cfg?.model ?? 'deepseek-flash',
          secondaryProvider: prov?.settings?.secondaryProvider ?? null,
          secondaryModel: prov?.settings?.secondaryModel ?? null,
          fallbackEnabled: Boolean(prov?.settings?.fallbackEnabled),
          tokens30d:
            typeof usage?.totals?.total_tokens === 'number'
              ? usage.totals.total_tokens
              : null,
          pendingCount: Number(prov?.queue?.pendingCount ?? 0),
        });
      } catch {
        if (!cancelled) setTab('setup');
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const navCards: Array<{
    id: Tab;
    title: string;
    description: string;
    icon: typeof Settings2;
    adminOnly?: boolean;
  }> = [
    {
      id: 'setup',
      title: 'Configuração',
      description: 'Identidade, comportamento, instruções, conhecimento e embeddings.',
      icon: Settings2,
    },
    {
      id: 'playground',
      title: 'Playground',
      description: 'Laboratório de testes, simulações e validação de modelos.',
      icon: Sparkles,
    },
    {
      id: 'providers',
      title: 'Provedores',
      description: 'Modelos, credenciais, prioridade, timeout, circuit breaker, cotas e fallback.',
      icon: ShieldCheck,
      adminOnly: true,
    },
    {
      id: 'usage',
      title: 'Consumo',
      description: 'Gráficos, tokens, requisições, custos e histórico.',
      icon: BarChart3,
      adminOnly: true,
    },
  ];

  const visibleCards = navCards.filter((c) => !c.adminOnly || canViewAdminTabs);

  return (
    <div className="space-y-6">
      <SettingsPanelHead
        title="Agentes de IA"
        description="Central de gerenciamento da Clara — comportamento, laboratório de testes, provedores e consumo."
      />

      {/* Resumo operacional da Clara */}
      {summary && (
        <div className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">Atendimento Automático</p>
            <div className="flex items-center gap-1.5">
              <Bot className="h-4 w-4 text-primary" />
              <Badge variant={summary.isActive && summary.autoReplyEnabled ? 'default' : 'secondary'}>
                {summary.isActive && summary.autoReplyEnabled ? 'Ativo' : 'Pausado'}
              </Badge>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">Modelo Principal</p>
            <p className="truncate text-sm font-semibold text-foreground">
              {PROVIDER_SHORT[summary.primaryProvider] ?? summary.primaryProvider} · {summary.primaryModel}
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">Secundário & Fallback</p>
            <p className="truncate text-sm font-medium text-foreground">
              {summary.secondaryProvider
                ? `${PROVIDER_SHORT[summary.secondaryProvider] ?? summary.secondaryProvider} (${summary.fallbackEnabled ? 'Ativo' : 'Desativado'})`
                : 'Não configurado'}
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">Tokens (30 dias)</p>
            <p className="text-sm font-semibold tabular-nums text-foreground">
              {formatTokensCompact(summary.tokens30d)}
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-medium text-muted-foreground">Atendimentos Pendentes</p>
            <div className="flex items-center gap-1.5 text-sm font-semibold tabular-nums text-foreground">
              <Activity className="h-3.5 w-3.5 text-primary" />
              {summary.pendingCount}
            </div>
          </div>
        </div>
      )}

      {/* 4 cards de navegação */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {visibleCards.map((card) => {
          const Icon = card.icon;
          const active = tab === card.id;
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => setTab(card.id)}
              className={cn(
                'flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors',
                active
                  ? 'border-primary bg-primary-soft/40 shadow-xs'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-card-2',
              )}
            >
              <span
                className={cn(
                  'flex size-8 items-center justify-center rounded-lg',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-primary-soft text-primary-on-soft',
                )}
              >
                <Icon className="size-4" />
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">{card.title}</p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                  {card.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {decided && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="hidden">
            <TabsTrigger value="setup">Configuração</TabsTrigger>
            <TabsTrigger value="playground">Playground</TabsTrigger>
            {canViewAdminTabs && <TabsTrigger value="providers">Provedores</TabsTrigger>}
            {canViewAdminTabs && <TabsTrigger value="usage">Consumo</TabsTrigger>}
          </TabsList>

          <TabsContent value="setup" className="mt-0">
            <AiConfig onGoToProviders={canViewAdminTabs ? () => setTab('providers') : undefined} />
          </TabsContent>

          <TabsContent value="playground" className="mt-0">
            <AiPlayground onGoToSetup={() => setTab('setup')} />
          </TabsContent>

          {canViewAdminTabs && (
            <TabsContent value="providers" className="mt-0">
              <AiProvidersPanel />
            </TabsContent>
          )}

          {canViewAdminTabs && (
            <TabsContent value="usage" className="mt-0">
              <AiUsageCard />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
