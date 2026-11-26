'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  ShieldAlert,
  Clock,
  UserCheck,
  Bot,
  Loader2,
  Save,
  ChevronDown,
  FileText,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import { ResponseStyleInstructionsEditor } from './response-style-instructions-editor';
import { GlobalNeverRulesEditor, formatLinesToLegacyRules } from './global-never-rules-editor';
import type { AccountMember } from '@/types';

const HANDOFF_QUEUE = '__queue__';

export function AiBehaviorSettings() {
  const { accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<AccountMember[]>([]);

  // Config state
  const [identityName, setIdentityName] = useState('');
  const [toneStyle, setToneStyle] = useState('consultative_warm');
  const [teamPresentation, setTeamPresentation] = useState('');
  const [responseStyleInstructions, setResponseStyleInstructions] = useState<string[]>([]);
  const [globalNeverRules, setGlobalNeverRules] = useState('');
  const [businessHoursStart, setBusinessHoursStart] = useState('08:00');
  const [businessHoursEnd, setBusinessHoursEnd] = useState('18:00');
  const [offHoursInstructions, setOffHoursInstructions] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [safetyLimit, setSafetyLimit] = useState(8);
  const [maxAutoReplies, setMaxAutoReplies] = useState(3);
  const [handoffAgentId, setHandoffAgentId] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [showLegacyPrompt, setShowLegacyPrompt] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const [cfgRes, mbrs] = await Promise.all([
        fetch('/api/ai/config'),
        fetchAccountMembers().catch(() => []),
      ]);
      setMembers(mbrs);

      const data = await cfgRes.json().catch(() => ({}));
      if (cfgRes.ok && data.configured) {
        setIdentityName(data.identity_name || '');
        setToneStyle(data.tone_style || 'consultative_warm');
        setTeamPresentation(data.team_presentation || '');
        setResponseStyleInstructions(Array.isArray(data.response_style_instructions) ? data.response_style_instructions : []);
        setGlobalNeverRules(data.global_never_rules || '');
        setBusinessHoursStart(data.business_hours_start || '08:00');
        setBusinessHoursEnd(data.business_hours_end || '18:00');
        setOffHoursInstructions(data.off_hours_instructions || '');
        setIsActive(data.is_active || false);
        setAutoReplyEnabled(data.auto_reply_enabled || false);
        setSafetyLimit(data.safety_message_limit || 8);
        setMaxAutoReplies(data.auto_reply_max_per_conversation ?? 3);
        setHandoffAgentId(data.handoff_agent_id || '');
        setSystemPrompt(data.system_prompt || '');
      }
    } catch {
      toast.error('Erro ao carregar configurações de comportamento.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSave = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identity_name: identityName.trim() || null,
          tone_style: toneStyle,
          team_presentation: teamPresentation.trim() || null,
          response_style_instructions: responseStyleInstructions,
          global_never_rules: globalNeverRules.trim() || null,
          business_hours_start: businessHoursStart,
          business_hours_end: businessHoursEnd,
          off_hours_instructions: offHoursInstructions.trim() || null,
          is_active: isActive,
          auto_reply_enabled: autoReplyEnabled,
          safety_message_limit: safetyLimit,
          auto_reply_max_per_conversation: maxAutoReplies,
          handoff_agent_id: handoffAgentId || null,
          system_prompt: systemPrompt.trim() || null,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao salvar configurações');
      }

      toast.success('Comportamento e regras da IA salvos com sucesso!');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao salvar';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-border bg-card">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const effectiveLimit = Math.min(
    Math.max(1, safetyLimit || 1),
    Math.max(1, maxAutoReplies || 1),
  );
  const readOnly = !canEdit || saving;

  return (
    <div className="space-y-6">
      {!canEdit && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Somente admins e proprietários podem alterar as configurações de comportamento da IA.
        </p>
      )}

      {/* 1. Identidade e Apresentação */}
      <fieldset disabled={readOnly} className="space-y-6 disabled:opacity-90">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            Identidade e Tom de Voz
          </CardTitle>
          <CardDescription className="text-xs">
            Como a IA se apresenta ao lead e qual o estilo de comunicação adotado no atendimento.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ai-name" className="text-xs">Nome da IA no Atendimento</Label>
              <Input
                id="ai-name"
                value={identityName}
                onChange={(e) => setIdentityName(e.target.value)}
                placeholder="Ex: Assistente Virtual / Atendimento WACRM"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Tom de Voz</Label>
              <Select value={toneStyle} onValueChange={(val) => val && setToneStyle(val)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="consultative_warm">Consultivo & Acolhedor (Recomendado)</SelectItem>
                  <SelectItem value="direct_objective">Direto & Objetivo</SelectItem>
                  <SelectItem value="formal_technical">Formal & Técnico</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="team-presentation" className="text-xs">
              Apresentação da Equipe & Imobiliária
            </Label>
            <Textarea
              id="team-presentation"
              value={teamPresentation}
              onChange={(e) => setTeamPresentation(e.target.value)}
              placeholder="Ex: Somos a equipe de atendimento do Ronaldo e da Thatianna na Imobiliária. Estou aqui para te ajudar a conhecer o empreendimento e tirar suas primeiras dúvidas antes de te conectar diretamente com nossos especialistas..."
              rows={3}
              className="text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-semibold text-foreground">
              Instruções de Estilo de Resposta
            </Label>
            <ResponseStyleInstructionsEditor
              instructions={responseStyleInstructions}
              onAdd={async (text) => setResponseStyleInstructions((prev) => [...prev, text])}
              onRemove={async (index) => setResponseStyleInstructions((prev) => prev.filter((_, i) => i !== index))}
              onEdit={async (index, text) =>
                setResponseStyleInstructions((prev) => prev.map((v, i) => (i === index ? text : v)))
              }
            />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Diretrizes de condução, qualificação, ritmo e encaminhamento organizadas por categorias. Adicionar, editar ou remover aqui é gravado ao clicar em &quot;Salvar Configurações da IA&quot; no final da página.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 2. Regras Globais e Fronteiras */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-rose-600 dark:text-rose-400">
            <ShieldAlert className="h-4 w-4 text-rose-600 dark:text-rose-400" />
            Fronteiras e Regras Globais (O que a IA NUNCA pode fazer)
          </CardTitle>
          <CardDescription className="text-xs">
            Diretrizes inegociáveis de segurança jurídica, comercial e de posicionamento.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <GlobalNeverRulesEditor
              value={globalNeverRules}
              onChange={(updatedRules) => {
                setGlobalNeverRules(formatLinesToLegacyRules(updatedRules));
              }}
            />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Diretrizes inegociáveis de segurança, restrições comerciais, limites de competência e regras de encaminhamento para a equipe. As alterações são salvas ao clicar em &quot;Salvar Configurações da IA&quot; abaixo.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 3. Horários & Plantão */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            Horários de Atendimento & Plantão
          </CardTitle>
          <CardDescription className="text-xs">
            Comportamento da IA durante e fora do expediente da equipe.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="hours-start" className="text-xs">Início do Expediente</Label>
              <Input
                id="hours-start"
                type="time"
                value={businessHoursStart}
                onChange={(e) => setBusinessHoursStart(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hours-end" className="text-xs">Fim do Expediente</Label>
              <Input
                id="hours-end"
                type="time"
                value={businessHoursEnd}
                onChange={(e) => setBusinessHoursEnd(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="off-hours" className="text-xs">
              Instruções para Atendimento Fora do Horário
            </Label>
            <Textarea
              id="off-hours"
              value={offHoursInstructions}
              onChange={(e) => setOffHoursInstructions(e.target.value)}
              placeholder="Ex: Acolher o cliente, responder dúvidas básicas sobre o empreendimento e avisar gentilmente que Ronaldo ou Thatianna entrarão em contato pessoalmente no início da manhã seguinte."
              rows={3}
              className="text-sm"
            />
          </div>
        </CardContent>
      </Card>
      </fieldset>

      {/* 4. Controles Mestre de Produção */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <UserCheck className="h-4 w-4 text-primary" />
            Controles Mestre & Transferência (Handoff)
          </CardTitle>
          <CardDescription className="text-xs">
            Gerenciamento de ativação do agente e roteamento das conversas.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">IA Ativa no CRM</p>
              <p className="text-xs text-muted-foreground">
                Habilita o motor de IA para gerar sugestões, análises e testes no Playground.
              </p>
            </div>
            <Switch
              checked={isActive}
              onCheckedChange={setIsActive}
              disabled={readOnly}
              className="shrink-0"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 bg-muted/20">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <p className="text-sm font-medium text-foreground">
                  Respostas Automáticas no WhatsApp (Auto-Reply)
                </p>
                <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">
                  Produção
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Quando ativado, a IA responde clientes reais no WhatsApp automaticamente. Recomendado manter desligado durante a fase de testes.
              </p>
            </div>
            <Switch
              checked={autoReplyEnabled}
              onCheckedChange={setAutoReplyEnabled}
              disabled={readOnly || !isActive}
              className="shrink-0"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="safety-limit" className="text-xs">
                Limite de Segurança de Mensagens por Conversa (1–30)
              </Label>
              <Input
                id="safety-limit"
                type="number"
                min={1}
                max={30}
                value={safetyLimit}
                disabled={readOnly}
                onChange={(e) =>
                  setSafetyLimit(Math.min(30, Math.max(1, Number(e.target.value) || 1)))
                }
                className="w-full"
              />
              <p className="text-[11px] text-muted-foreground">
                Teto de segurança conversacional antes de transferir para um atendente humano.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="max-auto-replies" className="text-xs">
                Máximo de Respostas Automáticas por Conversa (1–20)
              </Label>
              <Input
                id="max-auto-replies"
                type="number"
                min={1}
                max={20}
                value={maxAutoReplies}
                disabled={readOnly}
                onChange={(e) =>
                  setMaxAutoReplies(Math.min(20, Math.max(1, Number(e.target.value) || 1)))
                }
                className="w-full"
              />
              <p className="text-[11px] text-muted-foreground">
                Limite do bot de auto-reply por conversa antes de escalar para atendimento humano.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-border/80 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <strong className="text-foreground">Limite efetivo aplicado pelo motor:</strong>{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {effectiveLimit} {effectiveLimit === 1 ? 'mensagem' : 'mensagens'}
            </span>{' '}
            por conversa (o motor sempre aplica o menor valor entre os dois limites acima).
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="handoff-target" className="text-xs">
              Atendente Padrão para Transferência
            </Label>
            <Select
              value={handoffAgentId || HANDOFF_QUEUE}
              disabled={readOnly}
              onValueChange={(val) => setHandoffAgentId(!val || val === HANDOFF_QUEUE ? '' : val)}
            >
              <SelectTrigger id="handoff-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={HANDOFF_QUEUE}>
                  Fila Geral (Não atribuído)
                </SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {memberLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* 5. Contexto Legado (Rascunhos / Fluxos Auxiliares) */}
      <Card>
        <CardHeader className="pb-3">
          <button
            type="button"
            onClick={() => setShowLegacyPrompt((v) => !v)}
            className="flex w-full items-center justify-between gap-2 text-left"
          >
            <div className="space-y-1">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                Instruções de Contexto Legado (Rascunhos e Fluxos Auxiliares)
              </CardTitle>
              <CardDescription className="text-xs">
                Campo de compatibilidade (<code className="text-[11px]">system_prompt</code>) preservado para fluxos legados. O atendimento principal da Clara utiliza os campos estruturados acima.
              </CardDescription>
            </div>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                showLegacyPrompt ? 'rotate-180' : ''
              }`}
            />
          </button>
        </CardHeader>
        {showLegacyPrompt && (
          <CardContent className="pt-0 space-y-2">
            <Label htmlFor="legacy-system-prompt" className="text-xs">
              Contexto de negócio legado
            </Label>
            <Textarea
              id="legacy-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              disabled={readOnly}
              placeholder="Opcional — usado apenas por fluxos legados que consomem system_prompt diretamente."
              rows={4}
              className="text-sm"
            />
          </CardContent>
        )}
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={readOnly} className="px-6">
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Salvar Configurações da IA
        </Button>
      </div>
    </div>
  );
}
