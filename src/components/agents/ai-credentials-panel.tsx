'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wifi,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/dashboard/skeleton';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import type { AiProvider } from '@/lib/ai/types';

interface CredentialsState {
  configured: boolean;
  provider: AiProvider;
  model: string;
  hasApiKey: boolean;
  hasDeepseekKey: boolean;
  hasOpencodeGoKey: boolean;
  hasEmbeddingsKey: boolean;
}

const PROVIDER_LABELS: Record<AiProvider, string> = {
  opencode_go: 'OpenCode Go',
  deepseek: 'DeepSeek (API Oficial)',
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
};

/**
 * Centralized AI Credentials management (Decision 4).
 *
 * Reuses the existing server endpoints (`/api/ai/config`, `/api/ai/providers`,
 * `/api/ai/knowledge/reindex`) without introducing new secret storage or
 * exposing raw keys. Respects the real `ai_configs` column layout:
 * - `opencode_go_api_key` (independent)
 * - `deepseek_api_key` (independent)
 * - `api_key` (shared credential slot for OpenAI / Anthropic)
 * - `embeddings_api_key` (independent OpenAI key for semantic RAG)
 */
export function AiCredentialsPanel({
  onGoToProviders,
}: {
  onGoToProviders?: () => void;
} = {}) {
  const { accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<CredentialsState | null>(null);

  // Initial setup form (only when `!configured`)
  const [setupProvider, setSetupProvider] = useState<AiProvider>('deepseek');
  const [setupModel, setSetupModel] = useState(AI_PROVIDER_DEFAULT_MODEL.deepseek);
  const [setupKey, setSetupKey] = useState('');
  const [savingSetup, setSavingSetup] = useState(false);

  // Per-slot credential inputs (write-only; never populated with plaintext)
  const [opencodeInput, setOpencodeInput] = useState('');
  const [showOpencode, setShowOpencode] = useState(false);
  const [savingOpencode, setSavingOpencode] = useState(false);

  const [deepseekInput, setDeepseekInput] = useState('');
  const [showDeepseek, setShowDeepseek] = useState(false);
  const [savingDeepseek, setSavingDeepseek] = useState(false);

  const [primarySlotInput, setPrimarySlotInput] = useState('');
  const [showPrimarySlot, setShowPrimarySlot] = useState(false);
  const [savingPrimarySlot, setSavingPrimarySlot] = useState(false);
  const [testPrimaryTarget, setTestPrimaryTarget] = useState<'openai' | 'anthropic'>('openai');

  const [embeddingsInput, setEmbeddingsInput] = useState('');
  const [showEmbeddings, setShowEmbeddings] = useState(false);
  const [savingEmbeddings, setSavingEmbeddings] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  const [testingProvider, setTestingProvider] = useState<AiProvider | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cfgRes, provRes] = await Promise.allSettled([
        fetch('/api/ai/config', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : null,
        ),
        fetch('/api/ai/providers', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : null,
        ),
      ]);

      const cfg = cfgRes.status === 'fulfilled' ? cfgRes.value : null;
      const prov = provRes.status === 'fulfilled' ? provRes.value : null;

      if (!cfg?.configured) {
        setState({
          configured: false,
          provider: 'deepseek',
          model: AI_PROVIDER_DEFAULT_MODEL.deepseek,
          hasApiKey: false,
          hasDeepseekKey: false,
          hasOpencodeGoKey: false,
          hasEmbeddingsKey: false,
        });
      } else {
        setState({
          configured: true,
          provider: (prov?.settings?.provider ?? cfg.provider ?? 'deepseek') as AiProvider,
          model: String(prov?.settings?.model ?? cfg.model ?? ''),
          hasApiKey: Boolean(prov?.settings?.hasApiKey ?? cfg.has_key),
          hasDeepseekKey: Boolean(prov?.settings?.hasDeepseekKey ?? cfg.has_deepseek_key),
          hasOpencodeGoKey: Boolean(
            prov?.settings?.hasOpencodeGoKey ?? cfg.has_opencode_go_key,
          ),
          hasEmbeddingsKey: Boolean(cfg.has_embeddings_key),
        });
        if (cfg.provider === 'anthropic') {
          setTestPrimaryTarget('anthropic');
        } else if (cfg.provider === 'openai') {
          setTestPrimaryTarget('openai');
        }
      }
    } catch {
      toast.error('Erro ao carregar status das credenciais de IA.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canEdit) return;
    void load();
  }, [canEdit, load]);

  const handleInitialSetup = async () => {
    if (!setupKey.trim() || !setupModel.trim()) {
      toast.error('Informe o modelo e a chave de API para concluir a configuração inicial.');
      return;
    }
    setSavingSetup(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: setupProvider,
          model: setupModel.trim(),
          api_key: setupProvider === 'deepseek' ? undefined : setupKey.trim(),
          deepseek_api_key: setupProvider === 'deepseek' ? setupKey.trim() : undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? 'Falha ao salvar configuração inicial.');
      setSetupKey('');
      toast.success('Configuração inicial criada com sucesso.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao configurar agente.');
    } finally {
      setSavingSetup(false);
    }
  };

  const handleSaveOpencode = async () => {
    if (!opencodeInput.trim()) {
      toast.error('Digite a nova chave do OpenCode Go.');
      return;
    }
    setSavingOpencode(true);
    try {
      const res = await fetch('/api/ai/providers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opencodeGoApiKey: opencodeInput.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? 'Falha ao salvar chave OpenCode Go.');
      setOpencodeInput('');
      toast.success('Chave OpenCode Go atualizada e criptografada.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar chave OpenCode Go.');
    } finally {
      setSavingOpencode(false);
    }
  };

  const handleSaveDeepseek = async () => {
    if (!deepseekInput.trim()) {
      toast.error('Digite a nova chave da DeepSeek.');
      return;
    }
    setSavingDeepseek(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deepseek_api_key: deepseekInput.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? 'Falha ao validar/salvar chave DeepSeek.');
      setDeepseekInput('');
      toast.success('Chave DeepSeek validada e atualizada.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar chave DeepSeek.');
    } finally {
      setSavingDeepseek(false);
    }
  };

  const handleSavePrimarySlot = async () => {
    if (!primarySlotInput.trim()) {
      toast.error('Digite a nova chave de API.');
      return;
    }
    setSavingPrimarySlot(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: primarySlotInput.trim(),
          api_key_provider: testPrimaryTarget,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? 'Falha ao validar/salvar chave de API.');
      setPrimarySlotInput('');
      toast.success('Chave OpenAI / Anthropic validada e atualizada.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar chave de API.');
    } finally {
      setSavingPrimarySlot(false);
    }
  };

  const handleSaveEmbeddings = async (clear = false) => {
    if (!clear && !embeddingsInput.trim()) {
      toast.error('Digite a chave OpenAI para embeddings.');
      return;
    }
    setSavingEmbeddings(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeddings_api_key: clear ? null : embeddingsInput.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? 'Falha ao atualizar chave de embeddings.');
      setEmbeddingsInput('');
      toast.success(
        clear
          ? 'Chave de embeddings removida. Busca semântica volta ao modo por palavras-chave.'
          : 'Chave de embeddings validada e salva com sucesso.',
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao atualizar embeddings.');
    } finally {
      setSavingEmbeddings(false);
    }
  };

  const handleTestConnectivity = async (
    target: AiProvider,
    candidateKey?: string,
  ) => {
    setTestingProvider(target);
    try {
      const res = await fetch('/api/ai/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: target,
          model: AI_PROVIDER_DEFAULT_MODEL[target],
          ...(candidateKey?.trim() ? { apiKey: candidateKey.trim() } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        toast.error(`${PROVIDER_LABELS[target]}: ${json?.error ?? 'Falha de conexão'}`);
      } else {
        toast.success(`${PROVIDER_LABELS[target]} operacional (${json.latencyMs} ms)`);
      }
    } catch {
      toast.error('Erro de rede ao testar conectividade.');
    } finally {
      setTestingProvider(null);
    }
  };

  const handleReindex = async () => {
    setReindexing(true);
    try {
      const res = await fetch('/api/ai/knowledge/reindex', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) {
        throw new Error(json?.error ?? 'Falha ao reindexar base de conhecimento.');
      }
      toast.success(`Reindexação concluída: ${json.reindexed ?? 0} documento(s) atualizados.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao reindexar.');
    } finally {
      setReindexing(false);
    }
  };

  const handleRemoveConfig = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? 'Falha ao remover configuração de IA.');
      toast.success('Configuração e credenciais de IA removidas.');
      setRemoveDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover configuração.');
    } finally {
      setRemoving(false);
    }
  };

  if (profileLoading || (canEdit && loading)) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-44 w-full rounded-xl" />
        <Skeleton className="h-36 w-full rounded-xl" />
      </div>
    );
  }

  if (!canEdit) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Somente admins e proprietários podem gerenciar as credenciais de inteligência artificial.
        </CardContent>
      </Card>
    );
  }

  if (!state?.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-primary" /> Configuração Inicial de Credenciais de IA
          </CardTitle>
          <CardDescription>
            Informe o provedor inicial, modelo e chave de API. Todas as credenciais são armazenadas criptografadas (AES-256-GCM) no servidor.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Provedor inicial</Label>
              <Select
                value={setupProvider}
                onValueChange={(v) => {
                  const p = v as AiProvider;
                  setSetupProvider(p);
                  setSetupModel(AI_PROVIDER_DEFAULT_MODEL[p]);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deepseek">DeepSeek (API Oficial)</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Modelo</Label>
              <Input value={setupModel} onChange={(e) => setSetupModel(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Chave de API</Label>
            <Input
              type="password"
              value={setupKey}
              onChange={(e) => setSetupKey(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={() => void handleInitialSetup()} disabled={savingSetup}>
              {savingSetup && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Validar e Salvar
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* 1. Credenciais dos Provedores de Inferência */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="h-4 w-4 text-primary" /> Credenciais dos Provedores de IA
              </CardTitle>
              <CardDescription>
                Chaves armazenadas com criptografia AES-256-GCM no servidor e nunca exibidas em texto puro. As chaves da API REST pública do CRM continuam em Configurações.
              </CardDescription>
            </div>
            {onGoToProviders && (
              <Button variant="outline" size="sm" onClick={onGoToProviders} className="shrink-0">
                <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                Ir para Provedores
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* OpenCode Go */}
          <div className="rounded-lg border border-border p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-foreground">OpenCode Go</p>
                <p className="text-xs text-muted-foreground">
                  Credencial independente (<code className="text-[11px]">opencode_go_api_key</code>) usada para modelos OpenCode Go e monitoramento de cotas.
                </p>
              </div>
              <Badge variant={state.hasOpencodeGoKey ? 'default' : 'outline'}>
                {state.hasOpencodeGoKey ? 'Configurada' : 'Não configurada'}
              </Badge>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Input
                  type={showOpencode ? 'text' : 'password'}
                  value={opencodeInput}
                  onChange={(e) => setOpencodeInput(e.target.value)}
                  className="pr-9"
                  placeholder={
                    state.hasOpencodeGoKey
                      ? '•••••••••••••••• (digite para substituir)'
                      : 'Cole a chave Bearer do OpenCode Go'
                  }
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowOpencode((s) => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showOpencode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button
                variant="outline"
                disabled={testingProvider === 'opencode_go'}
                onClick={() => void handleTestConnectivity('opencode_go', opencodeInput)}
              >
                {testingProvider === 'opencode_go' ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Wifi className="mr-1.5 h-4 w-4" />
                )}
                Testar
              </Button>
              <Button
                disabled={savingOpencode || !opencodeInput.trim()}
                onClick={() => void handleSaveOpencode()}
              >
                {savingOpencode && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Salvar
              </Button>
            </div>
          </div>

          {/* DeepSeek */}
          <div className="rounded-lg border border-border p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-foreground">DeepSeek (API Oficial)</p>
                <p className="text-xs text-muted-foreground">
                  Credencial independente (<code className="text-[11px]">deepseek_api_key</code>) validada antes da gravação.
                </p>
              </div>
              <Badge variant={state.hasDeepseekKey ? 'default' : 'outline'}>
                {state.hasDeepseekKey ? 'Configurada' : 'Não configurada'}
              </Badge>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Input
                  type={showDeepseek ? 'text' : 'password'}
                  value={deepseekInput}
                  onChange={(e) => setDeepseekInput(e.target.value)}
                  className="pr-9"
                  placeholder={
                    state.hasDeepseekKey
                      ? '•••••••••••••••• (digite para substituir)'
                      : 'sk-... (DeepSeek)'
                  }
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowDeepseek((s) => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showDeepseek ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button
                variant="outline"
                disabled={testingProvider === 'deepseek'}
                onClick={() => void handleTestConnectivity('deepseek', deepseekInput)}
              >
                {testingProvider === 'deepseek' ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Wifi className="mr-1.5 h-4 w-4" />
                )}
                Testar
              </Button>
              <Button
                disabled={savingDeepseek || !deepseekInput.trim()}
                onClick={() => void handleSaveDeepseek()}
              >
                {savingDeepseek && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Salvar
              </Button>
            </div>
          </div>

          {/* OpenAI / Anthropic (slot compartilhado `api_key` na arquitetura atual) */}
          <div className="rounded-lg border border-border p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-foreground">OpenAI / Anthropic</p>
                <p className="text-xs text-muted-foreground">
                  Slot de credencial principal (<code className="text-[11px]">api_key</code>) utilizado quando OpenAI ou Anthropic está selecionado como provedor.
                </p>
              </div>
              <Badge variant={state.hasApiKey ? 'default' : 'outline'}>
                {state.hasApiKey ? 'Configurada' : 'Não configurada'}
              </Badge>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Input
                  type={showPrimarySlot ? 'text' : 'password'}
                  value={primarySlotInput}
                  onChange={(e) => setPrimarySlotInput(e.target.value)}
                  className="pr-9"
                  placeholder={
                    state.hasApiKey
                      ? '•••••••••••••••• (digite para substituir)'
                      : 'sk-... ou sk-ant-...'
                  }
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowPrimarySlot((s) => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showPrimarySlot ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Select
                value={testPrimaryTarget}
                onValueChange={(v) => setTestPrimaryTarget(v as 'openai' | 'anthropic')}
              >
                <SelectTrigger className="sm:w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                disabled={testingProvider === testPrimaryTarget}
                onClick={() => void handleTestConnectivity(testPrimaryTarget, primarySlotInput)}
              >
                {testingProvider === testPrimaryTarget ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Wifi className="mr-1.5 h-4 w-4" />
                )}
                Testar
              </Button>
              <Button
                disabled={savingPrimarySlot || !primarySlotInput.trim()}
                onClick={() => void handleSavePrimarySlot()}
              >
                {savingPrimarySlot && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Salvar
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 2. Embeddings & Busca Semântica */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Database className="h-4 w-4 text-primary" /> Embeddings e Busca Semântica (RAG)
              </CardTitle>
              <CardDescription>
                Chave OpenAI independente (<code className="text-[11px]">embeddings_api_key</code>) para vetorização da base de conhecimento e books técnicos.
              </CardDescription>
            </div>
            <Badge variant={state.hasEmbeddingsKey ? 'default' : 'secondary'}>
              {state.hasEmbeddingsKey ? (
                <span className="inline-flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Busca Semântica Ativa
                </span>
              ) : (
                'Busca por Palavras-chave'
              )}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Input
                type={showEmbeddings ? 'text' : 'password'}
                value={embeddingsInput}
                onChange={(e) => setEmbeddingsInput(e.target.value)}
                className="pr-9"
                placeholder={
                  state.hasEmbeddingsKey
                    ? '•••••••••••••••• (digite para substituir)'
                    : 'sk-... (OpenAI Embeddings)'
                }
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowEmbeddings((s) => !s)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showEmbeddings ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button
              disabled={savingEmbeddings || !embeddingsInput.trim()}
              onClick={() => void handleSaveEmbeddings(false)}
            >
              {savingEmbeddings && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Salvar Chave
            </Button>
            {state.hasEmbeddingsKey && (
              <Button
                variant="outline"
                disabled={savingEmbeddings}
                onClick={() => void handleSaveEmbeddings(true)}
              >
                Limpar
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              Reprocessa os embeddings de todos os documentos da conta para recuperar indexações pendentes ou após trocar a chave.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={reindexing}
              onClick={() => void handleReindex()}
              className="shrink-0"
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${reindexing ? 'animate-spin' : ''}`} />
              {reindexing ? 'Reindexando...' : 'Reindexar Base de Conhecimento'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 3. Zona de Manutenção */}
      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-destructive">
            <AlertTriangle className="h-4 w-4" /> Zona de Manutenção
          </CardTitle>
          <CardDescription>
            Remove integralmente a configuração de IA desta conta (chaves criptografadas, provedores e parâmetros em <code className="text-[11px]">ai_configs</code>). Use apenas para reconfiguração completa ou recuperação de chave corrompida.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setRemoveDialogOpen(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Remover configuração de IA
          </Button>
        </CardContent>
      </Card>

      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" /> Remover configuração de IA?
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2 text-xs">
              <span className="block">
                Esta ação apagará permanentemente o registro em <code>ai_configs</code>, incluindo todas as chaves de API armazenadas, identidade, regras globais, horários e configuração de provedores/fallback.
              </span>
              <span className="block font-medium text-foreground">
                A Clara deixará de responder imediatamente até que uma nova configuração seja cadastrada. Documentos de conhecimento e empreendimentos não são apagados.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={removing}
              onClick={() => setRemoveDialogOpen(false)}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={removing}
              onClick={() => void handleRemoveConfig()}
            >
              {removing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirmar remoção
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
