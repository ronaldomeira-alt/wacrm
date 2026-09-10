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
} from 'lucide-react';
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
import type { AccountMember } from '@/types';

const HANDOFF_QUEUE = '__queue__';

export function AiBehaviorSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<AccountMember[]>([]);

  // Config state
  const [identityName, setIdentityName] = useState('');
  const [toneStyle, setToneStyle] = useState('consultative_warm');
  const [teamPresentation, setTeamPresentation] = useState('');
  const [globalNeverRules, setGlobalNeverRules] = useState('');
  const [businessHoursStart, setBusinessHoursStart] = useState('08:00');
  const [businessHoursEnd, setBusinessHoursEnd] = useState('18:00');
  const [offHoursInstructions, setOffHoursInstructions] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [safetyLimit, setSafetyLimit] = useState(8);
  const [handoffAgentId, setHandoffAgentId] = useState('');

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
        setGlobalNeverRules(data.global_never_rules || '');
        setBusinessHoursStart(data.business_hours_start || '08:00');
        setBusinessHoursEnd(data.business_hours_end || '18:00');
        setOffHoursInstructions(data.off_hours_instructions || '');
        setIsActive(data.is_active || false);
        setAutoReplyEnabled(data.auto_reply_enabled || false);
        setSafetyLimit(data.safety_message_limit || 8);
        setHandoffAgentId(data.handoff_agent_id || '');
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
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identity_name: identityName.trim() || null,
          tone_style: toneStyle,
          team_presentation: teamPresentation.trim() || null,
          global_never_rules: globalNeverRules.trim() || null,
          business_hours_start: businessHoursStart,
          business_hours_end: businessHoursEnd,
          off_hours_instructions: offHoursInstructions.trim() || null,
          is_active: isActive,
          auto_reply_enabled: autoReplyEnabled,
          safety_message_limit: safetyLimit,
          handoff_agent_id: handoffAgentId || null,
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

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-border bg-card">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 1. Identidade e Apresentação */}
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
        </CardContent>
      </Card>

      {/* 2. Regras Globais e Fronteiras */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-destructive/90">
            <ShieldAlert className="h-4 w-4 text-destructive" />
            Fronteiras e Regras Globais (O que a IA NUNCA pode fazer)
          </CardTitle>
          <CardDescription className="text-xs">
            Diretrizes inegociáveis de segurança jurídica, comercial e de posicionamento.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="never-rules" className="text-xs">
              Regras Proibitivas Estritas
            </Label>
            <Textarea
              id="never-rules"
              value={globalNeverRules}
              onChange={(e) => setGlobalNeverRules(e.target.value)}
              placeholder="Ex:
- NUNCA inventar valores, metragens ou prazos de entrega que não constem no material oficial.
- NUNCA confirmar agendamento de visita sem transferir para a equipe humana.
- NUNCA conceder ou prometer descontos em nome da construtora.
- NUNCA insistir caso o cliente informe que não tem interesse."
              rows={5}
              className="text-sm font-mono text-xs leading-relaxed"
            />
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
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">IA Ativa no CRM</p>
              <p className="text-xs text-muted-foreground">
                Habilita o motor de IA para gerar sugestões, análises e testes no Playground.
              </p>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-3 bg-muted/20">
            <div>
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-medium text-foreground">
                  Respostas Automáticas no WhatsApp (Auto-Reply)
                </p>
                <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">
                  Produção
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Quando ativado, a IA responde clientes reais no WhatsApp automaticamente. Recomendado manter desligado durante a fase de testes.
              </p>
            </div>
            <Switch
              checked={autoReplyEnabled}
              onCheckedChange={setAutoReplyEnabled}
              disabled={!isActive}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="safety-limit" className="text-xs">
                Limite de Segurança de Mensagens por Conversa
              </Label>
              <Input
                id="safety-limit"
                type="number"
                min={1}
                max={30}
                value={safetyLimit}
                onChange={(e) => setSafetyLimit(Number(e.target.value) || 8)}
                className="w-full"
              />
              <p className="text-[11px] text-muted-foreground">
                Após esse número de mensagens, a IA transfere automaticamente para um atendente humano.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="handoff-target" className="text-xs">
                Atendente Padrão para Transferência
              </Label>
              <Select
                value={handoffAgentId || HANDOFF_QUEUE}
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
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving} className="px-6">
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
