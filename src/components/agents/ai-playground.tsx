'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Bot,
  RotateCcw,
  Send,
  Loader2,
  UserCircle2,
  Sparkles,
  Building2,
  Clock,
  ShieldCheck,
  ShieldAlert,
  SlidersHorizontal,
  Code2,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ResponseStyleInstructionsEditor } from './response-style-instructions-editor';
import type { AiDecision, AiUsage } from '@/lib/ai/types';

// Base UI's Select reserves the empty string for "no selection" internally,
// so "no property" needs its own sentinel value instead of ''.
const NO_PROPERTY_VALUE = '__none__';

const SIMULATED_HOURS_OPTIONS: Array<{
  value: 'business_hours' | 'off_hours' | 'real_time';
  label: string;
  dotClassName: string;
}> = [
  { value: 'business_hours', label: 'Horário Comercial', dotClassName: 'bg-emerald-500' },
  { value: 'off_hours', label: 'Fora do Horário Comercial', dotClassName: 'bg-amber-400' },
  { value: 'real_time', label: 'Horário Real Atual', dotClassName: 'bg-primary' },
];

interface TurnDiagnostic {
  decision?: AiDecision;
  retrievedKnowledgeCount?: number;
  retrievedKnowledge?: string[];
  propertyInfo?: { id: string; name: string; stage?: string | null } | null;
  businessHoursContext?: { isBusinessHours: boolean; startHour: string; endHour: string; instructionForModel: string };
  systemPrompt?: string;
  usage?: AiUsage | null;
  latencyMs?: number;
  model?: string;
  provider?: string;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  handoff?: boolean;
  diagnostic?: TurnDiagnostic;
}

const BOUNDARY_LABELS: Record<string, string> = {
  price: 'Preço / Valores',
  payment_terms: 'Condições de Pagamento',
  discount_negotiation: 'Desconto / Negociação',
  availability_check: 'Disponibilidade de Unidade',
  visit_request: 'Pedido de Visita',
  financing_inquiry: 'Financiamento Específico',
  reservation: 'Reserva de Imóvel',
  commercial_decision: 'Decisão Comercial',
  knowledge_limit: 'Conhecimento Insuficiente',
  incompatible_demand: 'Demanda Incompatível',
  human_requested: 'Atendente Humano Solicitado',
  safety_limit_reached: 'Limite de Segurança Atingido',
  custom_never_rule: 'Regra Proibitiva (Nunca Fazer)',
};

interface AiPlaygroundProps {
  onGoToSetup?: () => void;
}

export function AiPlayground({ onGoToSetup }: AiPlaygroundProps = {}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [properties, setProperties] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string>('');
  const [simulatedHours, setSimulatedHours] = useState<'real_time' | 'business_hours' | 'off_hours'>('business_hours');
  const [selectedTurnForInspect, setSelectedTurnForInspect] = useState<Turn | null>(null);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);

  // Response-style instructions — two independent scopes. Each entry is
  // its own array item, so removing/editing one "I changed my mind"
  // instruction is a single action instead of hand-editing a text blob.
  // Global saves to ai_configs (same field the "Comportamento" tab
  // reads/writes); per-property saves to property_ai_contexts for the
  // currently selected empreendimento. Both save immediately and take
  // effect on the very next message — in this Playground session and on
  // real production auto-replies too, since all read the same live rows.
  const [globalInstructions, setGlobalInstructions] = useState<string[]>([]);
  const [loadingGlobalStyle, setLoadingGlobalStyle] = useState(true);
  const [propertyInstructions, setPropertyInstructions] = useState<string[]>([]);
  const [loadingPropertyStyle, setLoadingPropertyStyle] = useState(false);
  const [styleDialogScope, setStyleDialogScope] = useState<'global' | 'property' | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Load properties + global style instructions on mount
  useEffect(() => {
    fetch('/api/ai/properties')
      .then((res) => res.json())
      .then((data) => {
        if (data.properties) {
          setProperties(
            data.properties.map((p: { id: string; name?: string; title?: string }) => ({
              id: p.id,
              name: p.name || p.title || 'Empreendimento',
            })),
          );
        }
      })
      .catch((err) => {
        console.error('[ai-playground] failed to load properties:', err);
        toast.error('Falha ao carregar empreendimentos — tente recarregar a página.');
      });

    fetch('/api/ai/config')
      .then((res) => res.json())
      .then((data) => {
        setGlobalInstructions(Array.isArray(data.response_style_instructions) ? data.response_style_instructions : []);
      })
      .catch((err) => {
        console.error('[ai-playground] failed to load style instructions:', err);
        toast.error('Falha ao carregar instruções de estilo — tente recarregar a página.');
      })
      .finally(() => setLoadingGlobalStyle(false));
  }, []);

  // Load the selected property's own style instructions whenever it changes
  useEffect(() => {
    if (!selectedPropertyId) {
      setPropertyInstructions([]);
      return;
    }
    setLoadingPropertyStyle(true);
    fetch(`/api/ai/properties/${selectedPropertyId}`)
      .then((res) => res.json())
      .then((data) => {
        setPropertyInstructions(
          Array.isArray(data.property?.ai_context?.response_style_instructions)
            ? data.property.ai_context.response_style_instructions
            : [],
        );
      })
      .catch((err) => {
        console.error('[ai-playground] failed to load property style instructions:', err);
        toast.error('Falha ao carregar instruções do empreendimento.');
      })
      .finally(() => setLoadingPropertyStyle(false));
  }, [selectedPropertyId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  const saveGlobalInstructions = async (next: string[]) => {
    const res = await fetch('/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_style_instructions: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Falha ao salvar instrução de estilo');
    }
    setGlobalInstructions(next);
  };

  const savePropertyInstructions = async (next: string[]) => {
    if (!selectedPropertyId) return;
    const res = await fetch(`/api/ai/properties/${selectedPropertyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_style_instructions: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Falha ao salvar instrução de estilo do empreendimento');
    }
    setPropertyInstructions(next);
  };

  const handleAddGlobalInstruction = async (text: string) => {
    try {
      await saveGlobalInstructions([...globalInstructions, text]);
      toast.success('Instrução global adicionada — valendo a partir da próxima mensagem.');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar instrução de estilo');
    }
  };

  const handleRemoveGlobalInstruction = async (index: number) => {
    try {
      await saveGlobalInstructions(globalInstructions.filter((_, i) => i !== index));
      toast.success('Instrução global removida.');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover instrução de estilo');
    }
  };

  const handleEditGlobalInstruction = async (index: number, text: string) => {
    try {
      await saveGlobalInstructions(globalInstructions.map((v, i) => (i === index ? text : v)));
      toast.success('Instrução global atualizada.');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao editar instrução de estilo');
    }
  };

  const handleAddPropertyInstruction = async (text: string) => {
    try {
      await savePropertyInstructions([...propertyInstructions, text]);
      toast.success('Instrução do empreendimento adicionada — valendo a partir da próxima mensagem.');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar instrução de estilo');
    }
  };

  const handleRemovePropertyInstruction = async (index: number) => {
    try {
      await savePropertyInstructions(propertyInstructions.filter((_, i) => i !== index));
      toast.success('Instrução do empreendimento removida.');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover instrução de estilo');
    }
  };

  const handleEditPropertyInstruction = async (index: number, text: string) => {
    try {
      await savePropertyInstructions(propertyInstructions.map((v, i) => (i === index ? text : v)));
      toast.success('Instrução do empreendimento atualizada.');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao editar instrução de estilo');
    }
  };

  const selectedPropertyName = properties.find((p) => p.id === selectedPropertyId)?.name;

  const send = async (customPrompt?: string) => {
    const text = (customPrompt || input).trim();
    if (!text || sending) return;

    if (!customPrompt) setInput('');
    const userTurn: Turn = { role: 'user', content: text };
    const currentTurns = [...turns, userTurn];
    setTurns(currentTurns);
    setSending(true);

    try {
      const res = await fetch('/api/ai/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: selectedPropertyId || null,
          simulated_hours: simulatedHours,
          simulated_lead: null,
          messages: currentTurns.map((t) => ({ role: t.role, content: t.content })),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errorMsg =
          data.code === 'ai_not_configured'
            ? 'Nenhum provedor de IA configurado. Configure a chave da API em Configurações.'
            : (data.error ?? 'Não foi possível obter resposta da IA.');

        toast.error(errorMsg);
        const errorTurn: Turn = {
          role: 'assistant',
          content: `⚠️ Não foi possível processar a resposta: ${errorMsg}`,
          handoff: false,
        };
        setTurns((prev) => [...prev, errorTurn]);
        return;
      }

      const replyContent =
        typeof data.reply === 'string' && data.reply.trim()
          ? data.reply.trim()
          : typeof data.decision?.response_text === 'string' && data.decision.response_text.trim()
            ? data.decision.response_text.trim()
            : 'Compreendi a sua mensagem. Em que mais posso te ajudar?';

      const assistantTurn: Turn = {
        role: 'assistant',
        content: replyContent,
        handoff: Boolean(data.handoff),
        diagnostic: {
          decision: data.decision,
          retrievedKnowledgeCount: data.retrievedKnowledgeCount,
          retrievedKnowledge: data.retrievedKnowledge,
          propertyInfo: data.propertyInfo,
          businessHoursContext: data.businessHoursContext,
          systemPrompt: data.systemPrompt,
          usage: data.usage,
          latencyMs: data.latencyMs,
          model: data.model,
          provider: data.provider,
        },
      };

      setTurns((prev) => [...prev, assistantTurn]);
    } catch (err) {
      console.error('[playground] send error:', err);
      toast.error('Não foi possível conectar à IA.');
      const errorTurn: Turn = {
        role: 'assistant',
        content: '⚠️ Falha de conexão ao comunicar com o servidor de IA. Por favor, tente novamente.',
        handoff: false,
      };
      setTurns((prev) => [...prev, errorTurn]);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const handleReset = () => {
    setTurns([]);
    toast.success('Sessão do Playground reiniciada com sucesso.');
  };

  return (
    <div className="space-y-4">
      {/* Simulation Controls Bar */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-stretch">
          {/* Contexto da IA */}
          <div className="flex shrink-0 items-start gap-2.5 border-b border-border/60 px-4 py-3 sm:max-w-[200px] sm:border-r sm:border-b-0 sm:py-3.5">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight text-foreground">Contexto da IA</p>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                Empreendimento e cenário da simulação.
              </p>
            </div>
          </div>

          {/* Selectors */}
          <div className="flex flex-1 flex-wrap items-center gap-2.5 px-4 py-3">
            {/* 1. Property Selector */}
            <Select
              value={selectedPropertyId || NO_PROPERTY_VALUE}
              onValueChange={(val) => {
                setSelectedPropertyId(val === NO_PROPERTY_VALUE ? '' : val ?? '');
                setTurns([]); // reset context to avoid mixing properties
              }}
            >
              <SelectTrigger className="h-auto min-w-[200px] sm:min-w-[220px] max-w-full items-center justify-start gap-2.5 rounded-xl border border-border/70 bg-background/60 py-1.5 pr-3 pl-2 text-left shadow-none hover:bg-background/80 focus-visible:ring-1 focus-visible:ring-ring data-[size=default]:h-auto [&_svg]:ml-auto">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Building2 className="size-4 shrink-0 block" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] leading-none font-medium tracking-wide text-muted-foreground uppercase">
                    Empreendimento
                  </p>
                  <SelectValue className="mt-0.5 truncate text-sm font-semibold text-foreground">
                    {selectedPropertyName ?? 'Geral'}
                  </SelectValue>
                </div>
              </SelectTrigger>
              <SelectContent className="w-(--anchor-width) min-w-[200px]">
                <SelectItem value={NO_PROPERTY_VALUE}>Geral</SelectItem>
                {properties.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* 2. Simulated Hours */}
            <Select
              value={simulatedHours}
              onValueChange={(val) => val && setSimulatedHours(val as typeof simulatedHours)}
            >
              <SelectTrigger className="h-auto min-w-[230px] sm:min-w-[250px] max-w-full items-center justify-start gap-2.5 rounded-xl border border-border/70 bg-background/60 py-1.5 pr-3 pl-2 text-left shadow-none hover:bg-background/80 focus-visible:ring-1 focus-visible:ring-ring data-[size=default]:h-auto [&_svg]:ml-auto">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Clock className="size-4 shrink-0 block" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] leading-none font-medium tracking-wide text-muted-foreground uppercase">
                    Horário Simulado
                  </p>
                  <SelectValue className="mt-0.5 min-w-0 text-sm font-semibold text-foreground">
                    {(() => {
                      const opt = SIMULATED_HOURS_OPTIONS.find((o) => o.value === simulatedHours);
                      return (
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <span className={cn('size-2 shrink-0 rounded-full inline-block', opt?.dotClassName)} />
                          <span className="truncate leading-none">{opt?.label}</span>
                        </span>
                      );
                    })()}
                  </SelectValue>
                </div>
              </SelectTrigger>
              <SelectContent className="w-(--anchor-width) min-w-[230px]">
                {SIMULATED_HOURS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    <span className="inline-flex items-center gap-2 leading-none">
                      <span className={cn('size-2 shrink-0 rounded-full inline-block', opt.dotClassName)} />
                      <span>{opt.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Nova Conversa */}
          <div className="flex items-center justify-end border-t border-border/60 px-4 py-3 sm:border-t-0 sm:border-l">
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={turns.length === 0 || sending}
              className="h-8 text-xs text-muted-foreground shrink-0"
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Nova Conversa
            </Button>
          </div>
        </div>
      </div>

      {/* Response Style Cards */}
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setStyleDialogScope('global')}
          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left shadow-xs transition-colors hover:border-primary/40 hover:bg-muted/30 cursor-pointer"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <SlidersHorizontal className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground truncate">Instruções Globais</p>
              <p className="text-[11px] text-muted-foreground">Valem para qualquer atendimento</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Badge variant="outline" className="text-[11px] px-1.5 py-0">
              {loadingGlobalStyle ? <Loader2 className="h-3 w-3 animate-spin" /> : globalInstructions.length}
            </Badge>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </div>
        </button>

        <button
          type="button"
          onClick={() => selectedPropertyId && setStyleDialogScope('property')}
          disabled={!selectedPropertyId}
          className={cn(
            'flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left shadow-xs transition-colors',
            selectedPropertyId
              ? 'hover:border-primary/40 hover:bg-muted/30 cursor-pointer'
              : 'opacity-60 cursor-not-allowed',
          )}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Building2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground truncate">Instruções deste Empreendimento</p>
              <p className="text-[11px] text-muted-foreground truncate">
                {selectedPropertyId
                  ? (selectedPropertyName ?? 'Empreendimento selecionado')
                  : 'Selecione um empreendimento para ver instruções específicas'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {selectedPropertyId && (
              <Badge variant="outline" className="text-[11px] px-1.5 py-0">
                {loadingPropertyStyle ? <Loader2 className="h-3 w-3 animate-spin" /> : propertyInstructions.length}
              </Badge>
            )}
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </div>
        </button>
      </div>

      {/* Chat Stream */}
      <div className="flex h-[460px] sm:h-[540px] lg:h-[620px] flex-col rounded-xl border border-border bg-card shadow-xs">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5 bg-muted/20">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold text-foreground">Sessão de Conversa (Simulação)</span>
            </div>
            <span className="text-[11px] text-muted-foreground">
              {turns.filter((t) => t.role === 'assistant').length} turnos respondidos
            </span>
          </div>

          {/* Transcript */}
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
            {turns.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-3">
                  <Sparkles className="h-6 w-6" />
                </div>
                <p className="font-semibold text-foreground">Laboratório de Testes da IA Conversacional</p>
                <p className="mt-1 text-xs max-w-md text-muted-foreground">
                  Simule perguntas de clientes e ajuste, ao lado, como a IA deve responder.
                </p>
              </div>
            )}

            {turns.map((t, i) => (
              <div
                key={i}
                className={cn(
                  'flex gap-2',
                  t.role === 'user' ? 'justify-end' : 'justify-start',
                )}
              >
                {t.role === 'assistant' && (
                  <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />
                )}
                <div
                  className={cn(
                    'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm shadow-2xs',
                    t.role === 'user'
                      ? 'rounded-br-sm bg-primary text-primary-foreground'
                      : 'rounded-bl-sm bg-muted/80 text-foreground border border-border/50',
                  )}
                >
                  {t.content && <p className="whitespace-pre-wrap leading-relaxed">{t.content}</p>}

                  {t.role === 'assistant' && (
                    <div className="mt-2 flex flex-col gap-1 border-t border-border/40 pt-1.5 text-[11px]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          {t.handoff ? (
                            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600 text-[10px] px-1.5 py-0">
                              <ShieldAlert className="mr-1 h-3 w-3" />
                              Handoff ({t.diagnostic?.decision?.boundary_type ? BOUNDARY_LABELS[t.diagnostic.decision.boundary_type] || t.diagnostic.decision.boundary_type : 'Fronteira'})
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 text-[10px] px-1.5 py-0">
                              <ShieldCheck className="mr-1 h-3 w-3" />
                              Território Livre
                            </Badge>
                          )}

                          {typeof t.diagnostic?.retrievedKnowledgeCount === 'number' && t.diagnostic.retrievedKnowledgeCount > 0 && (
                            <span className="text-muted-foreground text-[10px]">
                              📚 {t.diagnostic.retrievedKnowledgeCount} trechos
                            </span>
                          )}
                        </div>

                        {t.diagnostic?.systemPrompt && (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedTurnForInspect(t);
                              setPromptDialogOpen(true);
                            }}
                            className="text-[10px] font-medium text-primary hover:underline flex items-center gap-0.5 cursor-pointer"
                          >
                            <Code2 className="h-3 w-3" /> Inspecionar Prompt
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                {t.role === 'user' && (
                  <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
                )}
              </div>
            ))}

            {sending && (
              <div className="flex items-start gap-2 justify-start">
                <Bot className="mt-1 h-5 w-5 shrink-0 text-primary animate-pulse" />
                <div className="rounded-2xl rounded-bl-sm bg-muted/60 border border-border/50 px-4 py-2.5 text-xs text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                  <span>Consultando conhecimento do empreendimento e gerando resposta...</span>
                </div>
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="flex items-end gap-2 border-t border-border p-3 bg-muted/10">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Digite uma mensagem simulando o cliente (ex: 'Quanto custa?', 'Tem piscina?')..."
              rows={2}
              className="flex-1 resize-none rounded-xl border border-border bg-background px-3.5 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
            />
            <Button
              size="sm"
              onClick={() => send()}
              disabled={!input.trim() || sending}
              className="h-10 px-4 shrink-0"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Send className="mr-1.5 h-3.5 w-3.5" /> Enviar
                </>
              )}
            </Button>
          </div>
        </div>

      {/* Response Style Instructions Dialog — scoped to exactly one list at
          a time (global OR the selected property), never both together */}
      <Dialog open={styleDialogScope !== null} onOpenChange={(open) => !open && setStyleDialogScope(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              {styleDialogScope === 'property' ? (
                <Building2 className="h-4 w-4 text-primary" />
              ) : (
                <SlidersHorizontal className="h-4 w-4 text-primary" />
              )}
              {styleDialogScope === 'property'
                ? `Instruções de Estilo — ${selectedPropertyName ?? 'Empreendimento'}`
                : 'Instruções de Estilo Globais'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {styleDialogScope === 'property'
                ? 'Ajustes de estilo válidos apenas para este empreendimento. Em caso de conflito com as instruções globais, estas prevalecem.'
                : 'Ajustes de estilo válidos para qualquer atendimento, em qualquer empreendimento. Salva na hora e já vale a partir da próxima mensagem.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {styleDialogScope === 'property' ? (
              <ResponseStyleInstructionsEditor
                instructions={propertyInstructions}
                loading={loadingPropertyStyle}
                onAdd={handleAddPropertyInstruction}
                onRemove={handleRemovePropertyInstruction}
                onEdit={handleEditPropertyInstruction}
                className="flex flex-col"
              />
            ) : (
              <ResponseStyleInstructionsEditor
                instructions={globalInstructions}
                loading={loadingGlobalStyle}
                onAdd={handleAddGlobalInstruction}
                onRemove={handleRemoveGlobalInstruction}
                onEdit={handleEditGlobalInstruction}
                className="flex flex-col"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Inspect System Prompt Dialog */}
      <Dialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Code2 className="h-4 w-4 text-primary" />
              Inspeção do System Prompt Efetivo
            </DialogTitle>
            <DialogDescription className="text-xs">
              Composição modular exata das seções fornecidas ao modelo para este turno conversacional.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs whitespace-pre-wrap leading-relaxed text-foreground select-text">
            {selectedTurnForInspect?.diagnostic?.systemPrompt || 'Prompt indisponível.'}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
