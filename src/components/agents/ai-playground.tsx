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
  Save,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AiDecision, AiUsage } from '@/lib/ai/types';

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

  // Response-style instructions — edited here, saved to the same
  // ai_configs.response_style_instructions field the "Comportamento" tab
  // reads/writes, so a tweak made while testing here takes effect on the
  // very next message sent in this same Playground session, and on real
  // production auto-replies too.
  const [styleInstructions, setStyleInstructions] = useState('');
  const [savedStyleInstructions, setSavedStyleInstructions] = useState('');
  const [loadingStyle, setLoadingStyle] = useState(true);
  const [savingStyle, setSavingStyle] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Load properties + current style instructions on mount
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
        const value = typeof data.response_style_instructions === 'string' ? data.response_style_instructions : '';
        setStyleInstructions(value);
        setSavedStyleInstructions(value);
      })
      .catch((err) => {
        console.error('[ai-playground] failed to load style instructions:', err);
        toast.error('Falha ao carregar instruções de estilo — tente recarregar a página.');
      })
      .finally(() => setLoadingStyle(false));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  const styleDirty = styleInstructions.trim() !== savedStyleInstructions.trim();

  const saveStyleInstructions = async () => {
    setSavingStyle(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_style_instructions: styleInstructions.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao salvar instruções de estilo');
      }
      setSavedStyleInstructions(styleInstructions);
      toast.success('Instruções de estilo salvas — valendo a partir da próxima mensagem.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao salvar instruções de estilo';
      toast.error(msg);
    } finally {
      setSavingStyle(false);
    }
  };

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
      <div className="rounded-xl border border-border bg-card p-3 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* 1. Property Selector */}
            <div className="flex items-center gap-1.5">
              <Building2 className="h-4 w-4 text-primary shrink-0" />
              <div className="flex flex-col">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Empreendimento
                </span>
                <select
                  value={selectedPropertyId}
                  onChange={(e) => {
                    setSelectedPropertyId(e.target.value);
                    setTurns([]); // reset context to avoid mixing properties
                  }}
                  className="h-8 max-w-[220px] truncate rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">Nenhum / Desconhecido</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      🏢 {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 2. Simulated Hours */}
            <div className="flex items-center gap-1.5 border-l border-border/60 pl-3">
              <Clock className="h-4 w-4 text-primary shrink-0" />
              <div className="flex flex-col">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Horário Simulado
                </span>
                <select
                  value={simulatedHours}
                  onChange={(e) => setSimulatedHours(e.target.value as 'real_time' | 'business_hours' | 'off_hours')}
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="business_hours">🟢 Horário Comercial (14h30)</option>
                  <option value="off_hours">🌙 Fora do Horário / Plantão (22h30)</option>
                  <option value="real_time">⏱️ Horário Real Atual</option>
                </select>
              </div>
            </div>
          </div>

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

      {/* Main Container: Chat (Left/Center) + Style Instructions Composer (Right) */}
      <div className="grid gap-4 lg:grid-cols-12 items-start">
        {/* Chat Stream (7 cols on lg) */}
        <div className="lg:col-span-7 flex h-[620px] flex-col rounded-xl border border-border bg-card shadow-xs">
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

        {/* Response Style Composer (5 cols on lg) */}
        <div className="lg:col-span-5 flex h-[620px] flex-col rounded-xl border border-border bg-card p-4 space-y-3 shadow-xs">
          <div className="flex items-center justify-between border-b border-border pb-2.5">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Instruções de Estilo de Resposta</h3>
            </div>
            {styleDirty && (
              <span className="text-[10px] font-semibold bg-amber-500/10 text-amber-600 px-2 py-0.5 rounded uppercase">
                Não salvo
              </span>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Vá testando no chat ao lado e ajustando aqui como a IA deve escrever — comprimento, se deve
            terminar com pergunta, tom, etc. Ao salvar, a próxima mensagem já usa a versão nova, e o mesmo
            texto vale para as respostas reais no WhatsApp (fica armazenado na aba Comportamento).
          </p>

          <textarea
            value={styleInstructions}
            onChange={(e) => setStyleInstructions(e.target.value)}
            disabled={loadingStyle}
            placeholder={'Ex:\n- Responda em no máximo 2 frases curtas.\n- Sempre termine a resposta com uma pergunta que avance a conversa.\n- Evite emojis.'}
            className="flex-1 min-h-[280px] resize-none rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono leading-relaxed text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
          />

          <div className="flex items-center justify-end">
            <Button
              size="sm"
              onClick={saveStyleInstructions}
              disabled={savingStyle || loadingStyle || !styleDirty}
              className="h-8 text-xs"
            >
              {savingStyle ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-3.5 w-3.5" />
              )}
              Salvar
            </Button>
          </div>
        </div>
      </div>

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
