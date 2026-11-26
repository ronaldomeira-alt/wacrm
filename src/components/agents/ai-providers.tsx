'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Activity,
  ArrowLeftRight,
  ArrowRight,
  CheckCircle2,
  Clock,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/dashboard/skeleton';
import { ModelSelector } from './model-selector';
import type { ProviderCatalogResult } from '@/lib/ai/model-catalog';
import type { AiProvider, CircuitBreakerState } from '@/lib/ai/types';

const PROVIDER_LABELS: Record<AiProvider, string> = {
  deepseek: 'DeepSeek (API Oficial)',
  opencode_go: 'OpenCode Go',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

const DEFAULT_MODELS: Record<AiProvider, string> = {
  deepseek: 'deepseek-flash',
  opencode_go: 'glm-5.3-flash',
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-haiku-4-5-20251001',
};

const CIRCUIT_BADGE: Record<
  CircuitBreakerState,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  operational: { label: 'Operacional', variant: 'default' },
  suspended: { label: 'Temporariamente suspenso', variant: 'destructive' },
  quota_exhausted: { label: 'Cota esgotada', variant: 'destructive' },
  auth_failed: { label: 'Falha de autenticação', variant: 'destructive' },
  half_open: { label: 'Verificando recuperação', variant: 'secondary' },
  disabled: { label: 'Desabilitado manualmente', variant: 'outline' },
};

interface QuotaWindow {
  usageDollars: number;
  limitDollars: number;
  usagePercent: number;
  resetInSec: number | null;
  resetAt: string | null;
}

interface ProvidersPayload {
  configured: boolean;
  settings: {
    provider: AiProvider;
    model: string;
    fallbackEnabled: boolean;
    secondaryProvider: AiProvider | null;
    secondaryModel: string | null;
    primaryTimeoutMs: number;
    secondaryTimeoutMs: number;
    opencode5hPreventiveEnabled: boolean;
    opencode5hPreventivePct: number;
    opencodeWeeklyPreventiveEnabled: boolean;
    opencodeWeeklyPreventivePct: number;
    opencodeMonthlyPreventiveEnabled: boolean;
    opencodeMonthlyPreventivePct: number;
    circuitFailureThreshold: number;
    circuitCooldownSeconds: number;
    hasApiKey: boolean;
    hasDeepseekKey: boolean;
    hasOpencodeGoKey: boolean;
  };
  circuits: {
    provider: AiProvider;
    state: CircuitBreakerState;
    consecutiveFailures: number;
    lastFailureAt: string | null;
    lastFailureReason: string | null;
    lastErrorCode: string | null;
    nextProbeAt: string | null;
    quotaResetAt: string | null;
    lastSuccessAt: string | null;
    lastLatencyMs: number | null;
  }[];
  opencodeQuota: {
    status: 'ok' | 'unavailable' | 'auth_failed';
    fiveHour: QuotaWindow | null;
    weekly: QuotaWindow | null;
    monthly: QuotaWindow | null;
    fetchedAt: string;
    error?: string;
  } | null;
  queue: {
    pendingCount: number;
    supervisionCount: number;
  };
  fallbackEvents: {
    id: string;
    mode: string;
    from_provider: string;
    from_model: string;
    to_provider: string;
    to_model: string;
    error_code: string;
    reason: string;
    latency_ms: number | null;
    recovered: boolean;
    created_at: string;
  }[];
}

function formatResetCountdown(resetAt: string | null): string {
  if (!resetAt) return '—';
  const diffMs = new Date(resetAt).getTime() - Date.now();
  if (diffMs <= 0) return 'Renovação iminente';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export interface AiProvidersPanelProps {
  /** When true (unified AI Central), credential inputs live exclusively in Credenciais. */
  hideCredentialInputs?: boolean;
  onGoToCredentials?: () => void;
}

export function AiProvidersPanel({
  hideCredentialInputs = false,
  onGoToCredentials,
}: AiProvidersPanelProps = {}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingProvider, setTestingProvider] = useState<AiProvider | null>(null);
  const [data, setData] = useState<ProvidersPayload | null>(null);

  // Editable form state
  const [provider, setProvider] = useState<AiProvider>('deepseek');
  const [model, setModel] = useState('deepseek-flash');
  const [fallbackEnabled, setFallbackEnabled] = useState(false);
  const [secondaryProvider, setSecondaryProvider] = useState<string>('none');
  const [secondaryModel, setSecondaryModel] = useState('');
  const [primaryTimeoutSec, setPrimaryTimeoutSec] = useState('45');
  const [secondaryTimeoutSec, setSecondaryTimeoutSec] = useState('45');
  const [limit5hEnabled, setLimit5hEnabled] = useState(false);
  const [limit5hPct, setLimit5hPct] = useState('90');
  const [limitWeeklyEnabled, setLimitWeeklyEnabled] = useState(true);
  const [limitWeeklyPct, setLimitWeeklyPct] = useState('90');
  const [limitMonthlyEnabled, setLimitMonthlyEnabled] = useState(false);
  const [limitMonthlyPct, setLimitMonthlyPct] = useState('90');
  const [failureThreshold, setFailureThreshold] = useState('3');
  const [opencodeGoKeyInput, setOpencodeGoKeyInput] = useState('');
  const [catalogs, setCatalogs] = useState<Partial<Record<AiProvider, ProviderCatalogResult>>>({});
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);

  const loadCatalog = useCallback(async (forceRefresh = false) => {
    if (forceRefresh) setCatalogRefreshing(true);
    else setCatalogLoading(true);
    try {
      const res = await fetch(`/api/ai/models${forceRefresh ? '?refresh=1' : ''}`, {
        cache: 'no-store',
      });
      const json = (await res.json().catch(() => null)) as {
        providers?: Partial<Record<AiProvider, ProviderCatalogResult>>;
      } | null;
      if (res.ok && json?.providers) {
        setCatalogs(json.providers);
        if (forceRefresh) {
          const ocCount = json.providers.opencode_go?.models?.length ?? 0;
          toast.success(`Catálogo atualizado (${ocCount} modelos conversacionais no OpenCode Go).`);
        }
      }
    } catch {
      if (forceRefresh) toast.error('Não foi possível atualizar o catálogo de modelos.');
    } finally {
      setCatalogLoading(false);
      setCatalogRefreshing(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/providers', { cache: 'no-store' });
      const json = (await res.json()) as ProvidersPayload;
      if (!res.ok) throw new Error('Falha ao carregar provedores');
      setData(json);
      setProvider(json.settings.provider);
      setModel(json.settings.model);
      setFallbackEnabled(json.settings.fallbackEnabled);
      setSecondaryProvider(json.settings.secondaryProvider ?? 'none');
      setSecondaryModel(json.settings.secondaryModel ?? '');
      setPrimaryTimeoutSec(String(Math.round(json.settings.primaryTimeoutMs / 1000)));
      setSecondaryTimeoutSec(String(Math.round(json.settings.secondaryTimeoutMs / 1000)));
      setLimit5hEnabled(Boolean(json.settings.opencode5hPreventiveEnabled));
      setLimit5hPct(String(json.settings.opencode5hPreventivePct ?? 90));
      setLimitWeeklyEnabled(Boolean(json.settings.opencodeWeeklyPreventiveEnabled));
      setLimitWeeklyPct(String(json.settings.opencodeWeeklyPreventivePct ?? 90));
      setLimitMonthlyEnabled(Boolean(json.settings.opencodeMonthlyPreventiveEnabled));
      setLimitMonthlyPct(String(json.settings.opencodeMonthlyPreventivePct ?? 90));
      setFailureThreshold(String(json.settings.circuitFailureThreshold));
    } catch {
      toast.error('Erro ao carregar configurações dos provedores');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadCatalog(false);
  }, [load, loadCatalog]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/providers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim() || DEFAULT_MODELS[provider],
          fallbackEnabled,
          secondaryProvider: secondaryProvider === 'none' ? null : secondaryProvider,
          secondaryModel:
            secondaryProvider === 'none'
              ? null
              : secondaryModel.trim() || DEFAULT_MODELS[secondaryProvider as AiProvider],
          primaryTimeoutMs: Number(primaryTimeoutSec) * 1000,
          secondaryTimeoutMs: Number(secondaryTimeoutSec) * 1000,
          opencode5hPreventiveEnabled: limit5hEnabled,
          opencode5hPreventivePct: Number(limit5hPct),
          opencodeWeeklyPreventiveEnabled: limitWeeklyEnabled,
          opencodeWeeklyPreventivePct: Number(limitWeeklyPct),
          opencodeMonthlyPreventiveEnabled: limitMonthlyEnabled,
          opencodeMonthlyPreventivePct: Number(limitMonthlyPct),
          circuitFailureThreshold: Number(failureThreshold),
          ...(opencodeGoKeyInput.trim() ? { opencodeGoApiKey: opencodeGoKeyInput.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Falha ao salvar');
      setOpencodeGoKeyInput('');
      toast.success('Configuração de provedores salva com sucesso');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleSwap = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/providers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'swap_priorities' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Não foi possível inverter');
      toast.success('Prioridades invertidas');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao inverter');
    } finally {
      setSaving(false);
    }
  };

  const handleCircuitAction = async (
    target: AiProvider,
    action: 'reset_circuit' | 'disable_provider' | 'enable_provider',
  ) => {
    try {
      const res = await fetch('/api/ai/providers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, provider: target }),
      });
      if (!res.ok) throw new Error('Falha ao atualizar circuito');
      toast.success('Estado do circuito atualizado');
      await load();
    } catch {
      toast.error('Erro ao atualizar estado do provedor');
    }
  };

  const handleTestConnectivity = async (target: AiProvider, targetModel?: string) => {
    setTestingProvider(target);
    try {
      const res = await fetch('/api/ai/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: target,
          model: targetModel || DEFAULT_MODELS[target],
          ...(target === 'opencode_go' && opencodeGoKeyInput.trim()
            ? { apiKey: opencodeGoKeyInput.trim() }
            : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        toast.error(`${PROVIDER_LABELS[target]}: ${json?.error ?? 'Falha de conexão'}`);
      } else {
        toast.success(`${PROVIDER_LABELS[target]} operacional (${json.latencyMs} ms)`);
      }
      await load();
    } catch {
      toast.error('Erro ao testar conectividade');
    } finally {
      setTestingProvider(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Roteamento Principal & Fallback */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-primary" /> Gerenciamento de Provedores e Fallback
              </CardTitle>
              <CardDescription>
                Configure o provedor principal, secundário, timeouts independentes e regras preventivas sem necessidade de novo deploy.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Atualizar
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSwap}
                disabled={saving || secondaryProvider === 'none'}
              >
                <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" /> Inverter Prioridades
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Provedor Principal</span>
                <Badge variant="default">Prioridade 1</Badge>
              </div>
              <div className="space-y-2">
                <Label>Provedor</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => {
                    const p = v as AiProvider;
                    setProvider(p);
                    const list = catalogs[p]?.models ?? [];
                    setModel(list[0]?.id ?? DEFAULT_MODELS[p]);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deepseek">DeepSeek (API Oficial)</SelectItem>
                    <SelectItem value="opencode_go">OpenCode Go</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Modelo Principal</Label>
                <ModelSelector
                  provider={provider}
                  value={model}
                  onChange={setModel}
                  models={catalogs[provider]?.models ?? []}
                  source={catalogs[provider]?.source}
                  loading={catalogLoading}
                  refreshing={catalogRefreshing}
                  onRefresh={() => void loadCatalog(true)}
                />
              </div>
              <div className="space-y-2">
                <Label>Timeout Máximo (segundos)</Label>
                <Input
                  type="number"
                  min={5}
                  max={120}
                  value={primaryTimeoutSec}
                  onChange={(e) => setPrimaryTimeoutSec(e.target.value)}
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                disabled={testingProvider === provider}
                onClick={() => void handleTestConnectivity(provider, model)}
              >
                <Wifi className="mr-1.5 h-3.5 w-3.5" />
                {testingProvider === provider ? 'Testando...' : 'Testar Conectividade'}
              </Button>
            </div>

            <div className="space-y-3 rounded-lg border border-border p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Provedor Secundário (Fallback)</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {fallbackEnabled ? 'Ativo' : 'Desativado'}
                  </span>
                  <Switch checked={fallbackEnabled} onCheckedChange={setFallbackEnabled} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Provedor de Contingência</Label>
                <Select
                  value={secondaryProvider}
                  onValueChange={(v) => {
                    if (!v) return;
                    setSecondaryProvider(v);
                    if (v !== 'none') {
                      const p = v as AiProvider;
                      const list = catalogs[p]?.models ?? [];
                      setSecondaryModel(list[0]?.id ?? DEFAULT_MODELS[p]);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nenhum</SelectItem>
                    <SelectItem value="deepseek">DeepSeek (API Oficial)</SelectItem>
                    <SelectItem value="opencode_go">OpenCode Go</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Modelo Secundário</Label>
                <ModelSelector
                  provider={secondaryProvider === 'none' ? 'none' : (secondaryProvider as AiProvider)}
                  value={secondaryModel}
                  onChange={setSecondaryModel}
                  models={
                    secondaryProvider === 'none'
                      ? []
                      : catalogs[secondaryProvider as AiProvider]?.models ?? []
                  }
                  source={
                    secondaryProvider === 'none'
                      ? undefined
                      : catalogs[secondaryProvider as AiProvider]?.source
                  }
                  loading={catalogLoading}
                  refreshing={catalogRefreshing}
                  disabled={secondaryProvider === 'none'}
                  onRefresh={() => void loadCatalog(true)}
                />
              </div>
              <div className="space-y-2">
                <Label>Timeout do Fallback (segundos)</Label>
                <Input
                  type="number"
                  min={5}
                  max={120}
                  value={secondaryTimeoutSec}
                  onChange={(e) => setSecondaryTimeoutSec(e.target.value)}
                />
              </div>
              {secondaryProvider !== 'none' && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  disabled={testingProvider === secondaryProvider}
                  onClick={() =>
                    void handleTestConnectivity(
                      secondaryProvider as AiProvider,
                      secondaryModel,
                    )
                  }
                >
                  <Wifi className="mr-1.5 h-3.5 w-3.5" />
                  {testingProvider === secondaryProvider
                    ? 'Testando...'
                    : 'Testar Secundário'}
                </Button>
              )}
            </div>
          </div>

          {/* Credencial & Limites Preventivos por Janela OpenCode Go */}
          <div className="grid gap-4 rounded-lg border border-border bg-muted/20 p-4 sm:grid-cols-2">
            <div className="space-y-3">
              {hideCredentialInputs ? (
                <div className="space-y-2.5 rounded-lg border border-border bg-background/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <KeyRound className="h-3.5 w-3.5 text-primary" />
                      Credenciais dos Provedores
                    </span>
                    {onGoToCredentials && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onGoToCredentials}
                        className="h-7 text-xs"
                      >
                        Gerenciar Credenciais
                        <ArrowRight className="ml-1 h-3 w-3" />
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge
                      variant={data?.settings.hasOpencodeGoKey ? 'default' : 'outline'}
                      className="text-[11px] font-normal"
                    >
                      OpenCode Go: {data?.settings.hasOpencodeGoKey ? 'Configurada' : 'Pendente'}
                    </Badge>
                    <Badge
                      variant={data?.settings.hasDeepseekKey ? 'default' : 'outline'}
                      className="text-[11px] font-normal"
                    >
                      DeepSeek: {data?.settings.hasDeepseekKey ? 'Configurada' : 'Pendente'}
                    </Badge>
                    <Badge
                      variant={data?.settings.hasApiKey ? 'default' : 'outline'}
                      className="text-[11px] font-normal"
                    >
                      OpenAI / Anthropic: {data?.settings.hasApiKey ? 'Configurada' : 'Pendente'}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    As chaves de API são gerenciadas de forma centralizada e criptografada na seção Credenciais.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>
                    Chave OpenCode Go{' '}
                    {data?.settings.hasOpencodeGoKey ? (
                      <span className="text-xs text-emerald-500">(configurada no servidor)</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">(não configurada)</span>
                    )}
                  </Label>
                  <Input
                    type="password"
                    placeholder={
                      data?.settings.hasOpencodeGoKey
                        ? '•••••••••••••••• (digite para substituir)'
                        : 'Cole a chave Bearer do OpenCode Go'
                    }
                    value={opencodeGoKeyInput}
                    onChange={(e) => setOpencodeGoKeyInput(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Armazenada criptografada (AES-256-GCM) no servidor. Nunca é exibida no navegador.
                  </p>
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">Falhas consecutivas p/ abrir circuito</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={failureThreshold}
                  onChange={(e) => setFailureThreshold(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2.5">
              <Label className="text-xs font-medium">
                Limites preventivos independentes (OpenCode Go)
              </Label>

              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/60 px-3 py-2">
                <div className="flex items-center gap-2.5">
                  <Switch checked={limit5hEnabled} onCheckedChange={setLimit5hEnabled} />
                  <span className="text-xs font-medium">Janela de 5 horas</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    disabled={!limit5hEnabled}
                    value={limit5hPct}
                    onChange={(e) => setLimit5hPct(e.target.value)}
                    className="h-8 w-20 text-right text-xs"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/60 px-3 py-2">
                <div className="flex items-center gap-2.5">
                  <Switch checked={limitWeeklyEnabled} onCheckedChange={setLimitWeeklyEnabled} />
                  <span className="text-xs font-medium">Janela semanal</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    disabled={!limitWeeklyEnabled}
                    value={limitWeeklyPct}
                    onChange={(e) => setLimitWeeklyPct(e.target.value)}
                    className="h-8 w-20 text-right text-xs"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/60 px-3 py-2">
                <div className="flex items-center gap-2.5">
                  <Switch checked={limitMonthlyEnabled} onCheckedChange={setLimitMonthlyEnabled} />
                  <span className="text-xs font-medium">Janela mensal</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    disabled={!limitMonthlyEnabled}
                    value={limitMonthlyPct}
                    onChange={(e) => setLimitMonthlyPct(e.target.value)}
                    className="h-8 w-20 text-right text-xs"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground">
                Janelas desativadas usam toda a capacidade disponível. O esgotamento real (100%) de qualquer janela aciona o fallback imediatamente.
              </p>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? 'Salvando...' : 'Salvar Configurações'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Saúde dos Provedores & Fila de Recuperação */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-primary" /> Saúde & Circuit Breaker
            </CardTitle>
            <CardDescription>
              Estado persistente de cada rota de inferência e latência observada.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(['deepseek', 'opencode_go', 'openai', 'anthropic'] as AiProvider[]).map((p) => {
              const circuit = data?.circuits.find((c) => c.provider === p);
              const state: CircuitBreakerState = circuit?.state ?? 'operational';
              const badge = CIRCUIT_BADGE[state];
              return (
                <div
                  key={p}
                  className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{PROVIDER_LABELS[p]}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span>
                        Latência:{' '}
                        {circuit?.lastLatencyMs != null ? `${circuit.lastLatencyMs} ms` : '—'}
                      </span>
                      <span>Falhas seguidas: {circuit?.consecutiveFailures ?? 0}</span>
                      {circuit?.lastFailureReason && (
                        <span className="text-destructive">
                          Último erro: {circuit.lastFailureReason}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    {state !== 'operational' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleCircuitAction(p, 'reset_circuit')}
                      >
                        Reativar
                      </Button>
                    )}
                    {state !== 'disabled' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleCircuitAction(p, 'disable_provider')}
                      >
                        Desabilitar
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4 text-primary" /> Cotas OpenCode Go & Fila de Recuperação
            </CardTitle>
            <CardDescription>
              Consumo global compartilhado (OpenCode Go + OpenBots) e atendimentos aguardando recuperação.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">Atendimentos pendentes (fila)</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {data?.queue.pendingCount ?? 0}
                </p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">Supervisão humana</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-amber-500">
                  {data?.queue.supervisionCount ?? 0}
                </p>
              </div>
            </div>

            {data?.opencodeQuota ? (
              <div className="space-y-2.5 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Assinatura Global OpenCode Go</span>
                  <Badge
                    variant={
                      data.opencodeQuota.status === 'ok' ? 'default' : 'secondary'
                    }
                  >
                    {data.opencodeQuota.status === 'ok'
                      ? 'Monitoramento ativo'
                      : data.opencodeQuota.status === 'auth_failed'
                        ? 'Chave rejeitada'
                        : 'Endpoint indisponível'}
                  </Badge>
                </div>
                {(
                  [
                    ['Janela de 5 horas', data.opencodeQuota.fiveHour],
                    ['Limite semanal', data.opencodeQuota.weekly],
                    ['Limite mensal', data.opencodeQuota.monthly],
                  ] as const
                ).map(([label, win]) => (
                  <div key={label} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span>{label}</span>
                      <span className="text-muted-foreground">
                        {win
                          ? `${win.usagePercent.toFixed(1)}% · renova em ${formatResetCountdown(win.resetAt)}`
                          : '—'}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${Math.min(100, win?.usagePercent ?? 0)}%` }}
                      />
                    </div>
                  </div>
                ))}
                <p className="text-[11px] text-muted-foreground">
                  Limites preventivos desativados usam 100% da janela; após renovação da cota, o circuito retorna automaticamente ao provedor principal.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Informe a chave do OpenCode Go acima para monitorar as janelas de 5h, semanal e mensal.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Histórico de Acionamento do Fallback */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-primary" /> Histórico Recente de Fallback
          </CardTitle>
          <CardDescription>
            Últimos 20 acionamentos automáticos de contingência entre provedores.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!data?.fallbackEvents || data.fallbackEvents.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              Nenhum acionamento de fallback registrado até o momento.
            </div>
          ) : (
            <div className="space-y-2">
              {data.fallbackEvents.map((ev) => (
                <div
                  key={ev.id}
                  className="flex flex-col justify-between gap-1 rounded-md border border-border p-2.5 text-xs sm:flex-row sm:items-center"
                >
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                    <span>
                      <strong>{ev.from_provider}</strong> → <strong>{ev.to_provider}</strong> (
                      {ev.mode})
                    </span>
                    <Badge variant="outline">{ev.error_code}</Badge>
                  </div>
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <span className="truncate max-w-[240px]">{ev.reason}</span>
                    {ev.latency_ms != null && <span>{ev.latency_ms} ms</span>}
                    <span>{new Date(ev.created_at).toLocaleString('pt-BR')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
