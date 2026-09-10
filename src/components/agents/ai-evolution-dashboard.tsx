'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Sparkles,
  CheckCircle2,
  XCircle,
  EyeOff,
  RotateCcw,
  Loader2,
  Building2,
  ShieldAlert,
  MessageSquare,
  Globe,
  ArrowRight,
  TrendingUp,
  History,
  Layers,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import type { AiSuggestion } from '@/types';

interface LearningPayload {
  type?: string;
  info?: string;
  context_summary?: string | null;
  application?: string | null;
  occurrence_count?: number;
  confidence?: string;
  property_name?: string | null;
  property_id?: string | null;
  applied_target?: string | null;
  [key: string]: unknown;
}

const TYPE_CONFIG: Record<
  string,
  { label: string; icon: typeof Sparkles; color: string; targetDesc: string }
> = {
  property_subjective: {
    label: 'Conhecimento Subjetivo do Imóvel',
    icon: Building2,
    color: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
    targetDesc: 'Será adicionado ao Conhecimento do Empreendimento',
  },
  never_rule: {
    label: 'Regra Proibitiva (Nunca Fazer)',
    icon: ShieldAlert,
    color: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
    targetDesc: 'Será adicionado às Regras Globais "Nunca Fazer"',
  },
  language_style: {
    label: 'Estilo & Linguagem',
    icon: MessageSquare,
    color: 'border-purple-500/30 bg-purple-500/10 text-purple-400',
    targetDesc: 'Será adicionado à Personalidade/Apresentação da Equipe',
  },
  global_knowledge: {
    label: 'Conhecimento Institucional',
    icon: Globe,
    color: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    targetDesc: 'Será adicionado à Base de Conhecimento Global',
  },
  boundary_suggestion: {
    label: 'Fronteira Operacional',
    icon: Layers,
    color: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    targetDesc: 'Recomendação de transferência para atendimento humano',
  },
  process_suggestion: {
    label: 'Melhoria de Processo',
    icon: TrendingUp,
    color: 'border-teal-500/30 bg-teal-500/10 text-teal-400',
    targetDesc: 'Sugestão operacional para a equipe',
  },
};

export function AiEvolutionDashboard() {
  const [subTab, setSubTab] = useState<'pending' | 'history'>('pending');
  const [suggestions, setSuggestions] = useState<AiSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/suggestions?category=learning');
      if (res.ok) {
        const data = await res.json();
        setSuggestions(data.suggestions || []);
      }
    } catch (err) {
      console.error('Failed to load evolution suggestions:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  const handleAction = async (
    id: string,
    action: 'approved' | 'rejected' | 'ignored' | 'revert',
  ) => {
    setProcessingId(id);
    try {
      const body =
        action === 'revert'
          ? { action: 'revert' }
          : { status: action };

      const res = await fetch(`/api/ai/suggestions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao processar evolução');
      }

      if (action === 'approved') {
        toast.success('Sugestão aprovada e incorporada à IA com sucesso!');
      } else if (action === 'revert') {
        toast.success('Evolução revertida com sucesso!');
      } else if (action === 'rejected') {
        toast.info('Sugestão rejeitada.');
      } else {
        toast.info('Sugestão ignorada.');
      }

      fetchSuggestions();
    } catch (err: any) {
      toast.error(err.message || 'Erro ao processar ação');
    } finally {
      setProcessingId(null);
    }
  };

  const pendingList = suggestions.filter((s) => s.status === 'pending');
  const historyList = suggestions.filter((s) => s.status !== 'pending');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Evolução e Aprendizado Supervisionado
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            A IA observa conversas reais, identifica padrões de argumentos e correções humanas e sugere melhorias para sua aprovação.
          </p>
        </div>

        <Tabs value={subTab} onValueChange={(v) => setSubTab(v as any)}>
          <TabsList className="h-9">
            <TabsTrigger value="pending" className="text-xs gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              Pendentes ({pendingList.length})
            </TabsTrigger>
            <TabsTrigger value="history" className="text-xs gap-1.5">
              <History className="h-3.5 w-3.5" />
              Histórico & Rollback ({historyList.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center p-12 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Carregando sugestões de evolução...
        </div>
      ) : subTab === 'pending' ? (
        pendingList.length === 0 ? (
          <Card className="border-border bg-card/40">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-3">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">Nenhuma sugestão pendente</h3>
              <p className="text-xs text-muted-foreground max-w-sm mt-1">
                A IA continuará observando as conversas da equipe em segundo plano e apresentará novos padrões detectados aqui.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {pendingList.map((suggestion) => {
              const p = (suggestion.payload || {}) as LearningPayload;
              const typeKey = String(p.type || 'global_knowledge');
              const cfg = TYPE_CONFIG[typeKey] || TYPE_CONFIG.global_knowledge;
              const Icon = cfg.icon;
              const isProcessing = processingId === suggestion.id;

              return (
                <Card key={suggestion.id} className="border-border bg-card/60 shadow-sm transition-all hover:bg-card">
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`gap-1 text-xs font-normal ${cfg.color}`}>
                          <Icon className="h-3 w-3" />
                          {cfg.label}
                        </Badge>
                        {p.property_name && (
                          <Badge variant="secondary" className="text-xs">
                            <Building2 className="mr-1 h-3 w-3" />
                            {p.property_name}
                          </Badge>
                        )}
                      </div>

                      {p.occurrence_count && p.occurrence_count > 1 && (
                        <span className="text-xs text-muted-foreground">
                          Observado em <strong>{p.occurrence_count} conversas</strong>
                        </span>
                      )}
                    </div>

                    <CardTitle className="text-base font-semibold text-foreground mt-2">
                      {suggestion.title}
                    </CardTitle>
                    {suggestion.description && (
                      <CardDescription className="text-xs text-muted-foreground">
                        {suggestion.description}
                      </CardDescription>
                    )}
                  </CardHeader>

                  <CardContent className="space-y-4 pt-0">
                    {/* Detalhe da observação e aplicação */}
                    <div className="rounded-lg border border-border bg-background/50 p-3 space-y-2 text-xs">
                      {p.context_summary && (
                        <div>
                          <span className="font-medium text-foreground">O que foi observado: </span>
                          <span className="text-muted-foreground">{p.context_summary}</span>
                        </div>
                      )}
                      {p.application && (
                        <div>
                          <span className="font-medium text-foreground">Impacto esperado: </span>
                          <span className="text-muted-foreground">{p.application}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 text-primary pt-1">
                        <ArrowRight className="h-3 w-3" />
                        <span className="font-medium">{cfg.targetDesc}</span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap items-center justify-end gap-2 pt-1 border-t border-border">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 text-xs text-muted-foreground"
                        disabled={isProcessing}
                        onClick={() => handleAction(suggestion.id, 'ignored')}
                      >
                        <EyeOff className="mr-1.5 h-3.5 w-3.5" />
                        Ignorar
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs text-destructive hover:bg-destructive/10"
                        disabled={isProcessing}
                        onClick={() => handleAction(suggestion.id, 'rejected')}
                      >
                        <XCircle className="mr-1.5 h-3.5 w-3.5" />
                        Rejeitar
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                        disabled={isProcessing}
                        onClick={() => handleAction(suggestion.id, 'approved')}
                      >
                        {isProcessing ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        Aprovar e Incorporar
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )
      ) : (
        /* History & Rollback */
        historyList.length === 0 ? (
          <Card className="border-border bg-card/40">
            <CardContent className="py-10 text-center text-xs text-muted-foreground">
              Nenhuma sugestão no histórico ainda.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {historyList.map((suggestion) => {
              const p = (suggestion.payload || {}) as LearningPayload;
              const typeKey = String(p.type || 'global_knowledge');
              const cfg = TYPE_CONFIG[typeKey] || TYPE_CONFIG.global_knowledge;
              const isApproved = suggestion.status === 'approved';
              const isProcessing = processingId === suggestion.id;

              return (
                <div
                  key={suggestion.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 text-xs"
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={
                          isApproved
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                            : 'border-slate-500/30 bg-slate-500/10 text-muted-foreground'
                        }
                      >
                        {isApproved ? 'Aprovada' : suggestion.status === 'rejected' ? 'Rejeitada' : 'Ignorada / Revertida'}
                      </Badge>
                      <span className="font-semibold text-foreground truncate">{suggestion.title}</span>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {cfg.label} • {suggestion.resolved_at ? new Date(suggestion.resolved_at).toLocaleDateString('pt-BR') : 'Data não registrada'}
                    </p>
                  </div>

                  {isApproved && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 border-amber-500/30 shrink-0"
                      disabled={isProcessing}
                      onClick={() => handleAction(suggestion.id, 'revert')}
                    >
                      {isProcessing ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="mr-1 h-3 w-3" />
                      )}
                      Desfazer / Reverter
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
