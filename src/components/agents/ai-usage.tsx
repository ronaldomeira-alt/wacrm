'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BarChart3, RefreshCw } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/dashboard/skeleton';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface UsageResponse {
  preset: string;
  window_days: number;
  truncated: boolean;
  totals: {
    attempts: number;
    completed_calls: number;
    failed_calls: number;
    fallback_calls: number;
    confirmed_calls: number;
    estimated_calls: number;
    unknown_calls: number;
    cost_measured_calls?: number;
    cache_measured_calls?: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
    cost_usd: number;
    cost_brl: number;
    avg_latency_ms: number | null;
  };
  by_provider: {
    provider: string;
    attempts: number;
    completed_calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    total_tokens: number;
    cost_usd: number;
    cost_brl: number;
  }[];
  by_mode: {
    mode: string;
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    total_tokens: number;
    cost_usd: number;
    cost_brl: number;
  }[];
  by_model: {
    provider: string;
    model: string;
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    total_tokens: number;
    cost_usd: number;
    cost_brl: number;
  }[];
  daily: {
    date: string;
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    total_tokens: number;
    cost_usd: number;
    cost_brl: number;
  }[];
  opencode_subscription: {
    quota: {
      status: string;
      fiveHour: { usagePercent: number } | null;
      weekly: { usagePercent: number } | null;
      monthly: { usagePercent: number; usageDollars: number; limitDollars: number } | null;
    };
    weeklyPreventiveEnabled: boolean;
    weeklyPreventivePct: number;
  } | null;
}

const PRESET_LABELS: Record<string, string> = {
  today: 'Hoje',
  '3d': 'Últimos 3 dias',
  '7d': 'Últimos 7 dias',
  '15d': 'Últimos 15 dias',
  '30d': 'Últimos 30 dias',
  month: 'Mês atual',
  custom: 'Período personalizado',
};

const MODE_LABELS: Record<string, string> = {
  auto_reply: 'Clara (WhatsApp)',
  draft: 'Rascunho',
  lead_analysis: 'Análise de Lead',
  followup: 'Follow-up',
  learning: 'Aprendizado',
  ctwa_rescue: 'Resgate CTWA',
  template_fill: 'Templates',
  smart_send: 'Smart Send',
  playground: 'Playground',
  test: 'Conectividade',
  recovery: 'Recuperação',
};

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  opencode_go: 'OpenCode Go',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} M`;
  if (n >= 1_000) return `${(n / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return n.toLocaleString('pt-BR');
}

function formatBrl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatUsd(v: number): string {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      <p className="mb-1.5 font-semibold text-foreground">{label}</p>
      <div className="space-y-1">
        {payload.map((entry, idx) => (
          <div key={idx} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: entry.color || 'var(--primary)' }}
              />
              {entry.name}:
            </span>
            <span className="font-semibold text-foreground tabular-nums">
              {formatTokens(Number(entry.value ?? 0))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AiUsageCard() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canView = accountRole ? canEditSettings(accountRole) : false;

  const [preset, setPreset] = useState('30d');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [modelFilter, setModelFilter] = useState('all');
  const [modeFilter, setModeFilter] = useState('all');

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<UsageResponse | null>(null);

  const fetchUsage = useCallback(async () => {
    if (!canView || !accountId) return;
    if (preset === 'custom' && (!startDate || !endDate)) return;

    setLoading(true);
    try {
      const params = new URLSearchParams({ preset });
      if (preset === 'custom') {
        params.set('startDate', startDate);
        params.set('endDate', endDate);
      }
      if (providerFilter !== 'all') params.set('provider', providerFilter);
      if (modelFilter !== 'all') params.set('model', modelFilter);
      if (modeFilter !== 'all') params.set('mode', modeFilter);

      const res = await fetch(`/api/ai/usage?${params.toString()}`, {
        cache: 'no-store',
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error ?? 'Falha ao carregar consumo');
        setData(null);
        return;
      }
      setData(json as UsageResponse);
    } catch {
      toast.error('Falha ao carregar consumo');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [canView, accountId, preset, startDate, endDate, providerFilter, modelFilter, modeFilter]);

  useEffect(() => {
    void fetchUsage();
  }, [fetchUsage]);

  if (profileLoading || !canView) return null;

  const totals = data?.totals;
  const costMeasured = totals?.cost_measured_calls ?? 0;
  const cacheMeasured = totals?.cache_measured_calls ?? 0;

  const dailyData =
    data?.daily.map((d) => ({
      day: format(parseISO(d.date), 'dd/MM', { locale: ptBR }),
      Entrada: Math.max(0, d.prompt_tokens - d.cached_tokens),
      Cache: d.cached_tokens,
      Saída: d.completion_tokens,
      Total: d.total_tokens,
    })) ?? [];

  const providerChartData =
    data?.by_provider.map((p) => ({
      name: PROVIDER_LABELS[p.provider] ?? p.provider,
      Tokens: p.total_tokens,
    })) ?? [];

  const modelChartData =
    data?.by_model.map((m) => ({
      name: m.model,
      Tokens: m.total_tokens,
    })) ?? [];

  const modeChartData =
    data?.by_mode.map((m) => ({
      name: MODE_LABELS[m.mode] ?? m.mode,
      Tokens: m.total_tokens,
    })) ?? [];

  const distinctModels = Array.from(new Set(data?.by_model.map((m) => m.model) ?? []));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4 text-primary" /> Consumo de Tokens de IA
            </CardTitle>
            <CardDescription>
              Agregação direta no banco de dados (sem limite de 1.000 registros). Inclui todas as tentativas, fallbacks e cache.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void fetchUsage()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Atualizar
          </Button>
        </div>

        {/* Filtros com rótulos em português */}
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Select value={preset} onValueChange={(v) => v && setPreset(v)}>
            <SelectTrigger>
              <SelectValue>
                <span>{PRESET_LABELS[preset] ?? 'Período'}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PRESET_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={providerFilter} onValueChange={(v) => v && setProviderFilter(v)}>
            <SelectTrigger>
              <SelectValue>
                <span>
                  {providerFilter === 'all'
                    ? 'Todos os provedores'
                    : PROVIDER_LABELS[providerFilter] ?? providerFilter}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os provedores</SelectItem>
              <SelectItem value="deepseek">DeepSeek</SelectItem>
              <SelectItem value="opencode_go">OpenCode Go</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="anthropic">Anthropic</SelectItem>
            </SelectContent>
          </Select>

          <Select value={modelFilter} onValueChange={(v) => v && setModelFilter(v)}>
            <SelectTrigger>
              <SelectValue>
                <span>
                  {modelFilter === 'all' ? 'Todos os modelos' : modelFilter}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os modelos</SelectItem>
              {distinctModels.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={modeFilter} onValueChange={(v) => v && setModeFilter(v)}>
            <SelectTrigger>
              <SelectValue>
                <span>
                  {modeFilter === 'all'
                    ? 'Todas as funcionalidades'
                    : MODE_LABELS[modeFilter] ?? modeFilter}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as funcionalidades</SelectItem>
              {Object.entries(MODE_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {preset === 'custom' && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-40"
            />
            <span className="text-xs text-muted-foreground">até</span>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-40"
            />
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-6">
        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !totals ? (
          <p className="text-sm text-muted-foreground">Sem dados disponíveis para o período.</p>
        ) : (
          <>
            {/* KPIs principais com Tokens em destaque e custo discreto abaixo */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-border bg-card-2/40 p-3.5">
                <p className="text-xs text-muted-foreground">Tokens Totais (WACRM)</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
                  {formatTokens(totals.total_tokens)}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                  {totals.attempts === 0 ? (
                    'Sem chamadas no período'
                  ) : costMeasured === 0 ? (
                    'Custo histórico não registrado (disponível a partir de 24/11)'
                  ) : costMeasured < totals.attempts ? (
                    `Custo parcial (${costMeasured.toLocaleString('pt-BR')} de ${totals.attempts.toLocaleString('pt-BR')}): ${formatBrl(Number(totals.cost_brl ?? 0))} (${formatUsd(Number(totals.cost_usd ?? 0))})`
                  ) : (
                    `Custo estimado: ${formatBrl(Number(totals.cost_brl ?? 0))} (${formatUsd(Number(totals.cost_usd ?? 0))})`
                  )}
                </p>
              </div>

              <div className="rounded-lg border border-border bg-card-2/40 p-3.5">
                <p className="text-xs text-muted-foreground">Entrada / Saída / Cache</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                  {formatTokens(totals.prompt_tokens)} / {formatTokens(totals.completion_tokens)}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                  {totals.attempts > 0 && cacheMeasured === 0
                    ? 'Cache: não registrado no histórico anterior'
                    : `Cache reaproveitado: ${formatTokens(totals.cached_tokens)}`}
                </p>
              </div>

              <div className="rounded-lg border border-border bg-card-2/40 p-3.5">
                <p className="text-xs text-muted-foreground">Tentativas & Conclusões</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
                  {totals.completed_calls.toLocaleString('pt-BR')}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                  {totals.attempts.toLocaleString('pt-BR')} tentativas · {totals.fallback_calls} fallbacks · {totals.failed_calls} falhas
                </p>
              </div>

              <div className="rounded-lg border border-border bg-card-2/40 p-3.5">
                <p className="text-xs text-muted-foreground">Qualidade da Contabilização</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                  {totals.confirmed_calls.toLocaleString('pt-BR')} confirmadas
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                  {totals.estimated_calls} assinatura · {totals.unknown_calls} desconhecidas
                </p>
              </div>
            </div>

            {data?.opencode_subscription?.quota.monthly && (
              <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-foreground">
                <span className="font-medium">Assinatura Global OpenCode Go (compartilhada com OpenBots):</span>{' '}
                {data.opencode_subscription.quota.monthly.usagePercent.toFixed(1)}% da franquia mensal utilizada
                {data.opencode_subscription.weeklyPreventiveEnabled
                  ? ` (limite preventivo semanal ativo em ${data.opencode_subscription.weeklyPreventivePct}%).`
                  : '.'}
              </div>
            )}

            {/* Gráfico 1: Consumo diário (Entrada, Cache, Saída) */}
            <div className="space-y-2 rounded-lg border border-border p-4">
              <h4 className="text-sm font-medium text-foreground">
                Consumo Diário (Entrada, Cache e Saída)
              </h4>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyData} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                    <XAxis
                      dataKey="day"
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      axisLine={{ stroke: 'var(--border)' }}
                      tickLine={{ stroke: 'var(--border)' }}
                    />
                    <YAxis
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      axisLine={{ stroke: 'var(--border)' }}
                      tickLine={{ stroke: 'var(--border)' }}
                      tickFormatter={formatTokens}
                    />
                    <Tooltip
                      content={<CustomTooltip />}
                      cursor={{ fill: 'var(--muted)', opacity: 0.25 }}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: 12, color: 'var(--foreground)', paddingTop: 8 }}
                    />
                    <Bar dataKey="Entrada" stackId="a" fill="#3b82f6" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="Cache" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="Saída" stackId="a" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Gráficos 2, 3 e 4 em barra com contraste e rótulos legíveis */}
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="space-y-2 rounded-lg border border-border p-3.5">
                <h4 className="text-xs font-medium text-muted-foreground">Por Provedor</h4>
                <div className="h-52 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={providerChartData} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
                      <XAxis
                        dataKey="name"
                        tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={{ stroke: 'var(--border)' }}
                      />
                      <YAxis
                        tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={{ stroke: 'var(--border)' }}
                        tickFormatter={formatTokens}
                      />
                      <Tooltip
                        content={<CustomTooltip />}
                        cursor={{ fill: 'var(--muted)', opacity: 0.25 }}
                      />
                      <Bar dataKey="Tokens" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="space-y-2 rounded-lg border border-border p-3.5">
                <h4 className="text-xs font-medium text-muted-foreground">Por Modelo</h4>
                <div className="h-52 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={modelChartData}
                      layout="vertical"
                      margin={{ top: 4, right: 12, left: 4, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
                      <XAxis
                        type="number"
                        tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={{ stroke: 'var(--border)' }}
                        tickFormatter={formatTokens}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={110}
                        tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={{ stroke: 'var(--border)' }}
                      />
                      <Tooltip
                        content={<CustomTooltip />}
                        cursor={{ fill: 'var(--muted)', opacity: 0.25 }}
                      />
                      <Bar dataKey="Tokens" fill="#10b981" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="space-y-2 rounded-lg border border-border p-3.5">
                <h4 className="text-xs font-medium text-muted-foreground">Por Funcionalidade</h4>
                <div className="h-52 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={modeChartData}
                      layout="vertical"
                      margin={{ top: 4, right: 12, left: 4, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
                      <XAxis
                        type="number"
                        tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={{ stroke: 'var(--border)' }}
                        tickFormatter={formatTokens}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={115}
                        tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={{ stroke: 'var(--border)' }}
                      />
                      <Tooltip
                        content={<CustomTooltip />}
                        cursor={{ fill: 'var(--muted)', opacity: 0.25 }}
                      />
                      <Bar dataKey="Tokens" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
