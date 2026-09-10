'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Globe,
  Loader2,
  CheckCircle2,
  Sparkles,
  Eye,
  Pencil,
  FileText,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface GlobalDoc {
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export function GlobalKnowledgeSection() {
  const [docs, setDocs] = useState<GlobalDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [editContent, setEditContent] = useState('');
  const [masterDocId, setMasterDocId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [unifyDraft, setUnifyDraft] = useState('');
  const [expandedFragmentIds, setExpandedFragmentIds] = useState<Set<string>>(new Set());
  const [deletingFragmentId, setDeletingFragmentId] = useState<string | null>(null);

  // Every doc other than the one loaded into the editable `content` above —
  // these still feed the AI's retrieval (any global doc is used in every
  // conversation) but are otherwise invisible in this card. Surfacing them
  // is the whole point of the fragment list below: before merging, the
  // user needs to actually read what's in them.
  const otherDocs = useMemo(
    () => docs.filter((d) => d.id !== masterDocId),
    [docs, masterDocId],
  );

  const toggleFragmentExpanded = (id: string) => {
    setExpandedFragmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge');
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const list: GlobalDoc[] = data.documents || [];
        setDocs(list);

        if (list.length === 1) {
          setMasterDocId(list[0].id);
          setContent(list[0].content || '');
        } else if (list.length > 1) {
          const master = list.find((d) =>
            d.title.toLowerCase().includes('conhecimento global') ||
            d.title.toLowerCase().includes('manual'),
          );
          if (master) {
            setMasterDocId(master.id);
            setContent(master.content || '');
          } else {
            const combined = list
              .map((d) => `### ${d.title}\n${d.content}`)
              .join('\n\n');
            setContent(combined);
            setMasterDocId(null);
          }
        } else {
          setMasterDocId(null);
          setContent('');
        }
      }
    } catch (err) {
      console.warn('[global-knowledge] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  const handleOpenEdit = () => {
    setEditContent(content);
    setEditDialogOpen(true);
  };

  // Builds the merge draft from EVERY fragment's own content — not just
  // the master's — so opening this dialog never starts from a text that
  // has already silently dropped the other N-1 documents.
  const handleOpenCleanup = () => {
    const master = docs.find((d) => d.id === masterDocId);
    const parts: string[] = [];
    if (master) parts.push(master.content || '');
    for (const d of otherDocs) {
      parts.push(`### ${d.title}\n${d.content || ''}`);
    }
    setUnifyDraft(parts.filter((p) => p.trim()).join('\n\n'));
    setExpandedFragmentIds(new Set());
    setCleanupDialogOpen(true);
  };

  const handleDeleteFragment = async (docId: string) => {
    setDeletingFragmentId(docId);
    try {
      const res = await fetch(`/api/ai/knowledge/${docId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Falha ao remover fragmento');
      }
      toast.success('Fragmento removido.');
      await loadDocs();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover fragmento');
    } finally {
      setDeletingFragmentId(null);
    }
  };

  // Recovers documents that were saved with a "semantic indexing failed"
  // warning — this is the only reachable entry point to POST
  // /api/ai/knowledge/reindex today (it re-chunks + re-embeds every
  // document in the account, not just the global ones shown here).
  const handleReindex = async () => {
    setReindexing(true);
    try {
      const res = await fetch('/api/ai/knowledge/reindex', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Falha ao reindexar');
      }
      toast.success(`Reindexação concluída: ${data.reindexed} documento(s) atualizados.`);
      loadDocs();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao reindexar';
      toast.error(msg);
    } finally {
      setReindexing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const title = 'Conhecimento Global Transversal';
      const trimmedContent = editContent.trim();

      if (!trimmedContent) {
        if (masterDocId) {
          await fetch(`/api/ai/knowledge/${masterDocId}`, { method: 'DELETE' });
          setMasterDocId(null);
        }
        setContent('');
        toast.success('Conhecimento global limpo com sucesso.');
        setEditDialogOpen(false);
        loadDocs();
        return;
      }

      let warning: string | undefined;
      if (masterDocId) {
        const res = await fetch(`/api/ai/knowledge/${masterDocId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content: trimmedContent }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao atualizar conhecimento global');
        warning = data.warning;
      } else {
        const res = await fetch('/api/ai/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content: trimmedContent }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao salvar');
        if (data.id) setMasterDocId(data.id);
        warning = data.warning;
      }

      setContent(trimmedContent);
      if (warning) {
        toast.warning(warning);
      } else {
        toast.success('Conhecimento global transversal salvo e indexado no RAG!');
      }
      setEditDialogOpen(false);
      loadDocs();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao salvar';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleConsolidateAndCleanup = async () => {
    const trimmedContent = unifyDraft.trim();
    if (!trimmedContent) {
      toast.error('O texto unificado não pode ficar vazio — isso apagaria todo o conhecimento global.');
      return;
    }

    setCleaningUp(true);
    try {
      const title = 'Conhecimento Global Transversal';

      let warning: string | undefined;
      if (masterDocId) {
        const res = await fetch(`/api/ai/knowledge/${masterDocId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content: trimmedContent }),
        });
        const data = await res.json().catch(() => ({}));
        warning = data.warning;
      } else {
        const res = await fetch('/api/ai/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content: trimmedContent }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.id) setMasterDocId(data.id);
        warning = data.warning;
      }

      const others = docs.filter((d) => d.id !== masterDocId);
      for (const doc of others) {
        try {
          await fetch(`/api/ai/knowledge/${doc.id}`, { method: 'DELETE' });
        } catch {
          // ignore
        }
      }

      if (warning) {
        toast.warning(warning);
      } else {
        toast.success('Fragmentos consolidados com sucesso!');
      }
      setCleanupDialogOpen(false);
      loadDocs();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao consolidar';
      toast.error(msg);
    } finally {
      setCleaningUp(false);
    }
  };

  const hasContent = Boolean(content.trim());

  return (
    <div className="space-y-3">
      {/* Compact Minimalist Card */}
      <div className="rounded-xl border border-border bg-card p-4 transition-all hover:border-border/80 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary mt-0.5">
              <Globe className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-foreground">
                  Conhecimento Global Transversal
                </h3>
                {hasContent ? (
                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[11px] font-normal gap-1 py-0 h-5">
                    <CheckCircle2 className="h-3 w-3" />
                    Ativo • {content.trim().length.toLocaleString('pt-BR')} caracteres
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground text-[11px] font-normal py-0 h-5">
                    Sem conteúdo cadastrado
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                {hasContent
                  ? content.trim()
                  : 'Informações institucionais transversais que a IA utiliza em todas as conversas (papéis da equipe, perfil da imobiliária e orientações gerais).'}
              </p>
              {otherDocs.length > 0 && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-600">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  +{otherDocs.length} fragmento{otherDocs.length > 1 ? 's' : ''} adicional{otherDocs.length > 1 ? 'is' : ''} não exibido{otherDocs.length > 1 ? 's' : ''} acima — também usado{otherDocs.length > 1 ? 's' : ''} pela IA. Clique em Unificar para revisar.
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0 self-end sm:self-center justify-end">
            {docs.length > 1 && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleOpenCleanup}
                className="h-8 text-xs gap-1.5"
                title="Revisar e unificar fragmentos"
              >
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                Unificar ({docs.length})
              </Button>
            )}

            {hasContent && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setViewDialogOpen(true)}
                className="h-8 text-xs gap-1.5 font-medium"
              >
                <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                Mostrar
              </Button>
            )}

            <Button
              size="sm"
              variant="outline"
              onClick={handleReindex}
              disabled={reindexing}
              className="h-8 text-xs gap-1.5"
              title="Reprocessar embeddings de todos os documentos da conta (recupera indexações que falharam)"
            >
              <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${reindexing ? 'animate-spin' : ''}`} />
              Reindexar
            </Button>

            <Button
              size="sm"
              onClick={handleOpenEdit}
              disabled={loading}
              className="h-8 text-xs gap-1.5 font-medium shadow-xs"
            >
              <Pencil className="h-3.5 w-3.5" />
              Editar
            </Button>
          </div>
        </div>
      </div>

      {/* View Full Content Dialog — fixed header/footer, only the middle
          content region scrolls; capped at 90vw/90vh so long text (either
          the master content or a fragment) can never push the dialog
          itself wider or taller than the viewport. */}
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="flex h-auto max-h-[90vh] w-full max-w-[min(90vw,48rem)] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 px-4 py-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-2 pr-8">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Globe className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-base font-semibold text-foreground">
                  Conhecimento Global Transversal
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  Informações institucionais aplicadas em todos os atendimentos da IA.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Scrollable content — the only region that scrolls */}
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 sm:px-6">
            <div className="min-w-0 rounded-xl border border-border bg-muted/20 p-4">
              <div className="min-w-0 text-xs leading-relaxed whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere]">
                {content}
              </div>
            </div>

            {otherDocs.length > 0 && (
              <div className="mt-3 min-w-0 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">
                    {otherDocs.length} fragmento{otherDocs.length > 1 ? 's' : ''} adicional{otherDocs.length > 1 ? 'is' : ''} — também usado{otherDocs.length > 1 ? 's' : ''} pela IA, mas fora do texto acima
                  </span>
                </div>
                <div className="max-h-64 min-w-0 space-y-1.5 overflow-x-hidden overflow-y-auto rounded-lg border border-amber-500/20 bg-amber-500/5 p-2">
                  {otherDocs.map((d) => {
                    const isExpanded = expandedFragmentIds.has(d.id);
                    return (
                      <div key={d.id} className="min-w-0 rounded-lg border border-border/60 bg-card px-3 py-2 text-xs">
                        <button
                          type="button"
                          onClick={() => toggleFragmentExpanded(d.id)}
                          className="flex w-full min-w-0 items-center justify-between gap-2 text-left cursor-pointer"
                        >
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{d.title}</span>
                          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                            {(d.content || '').trim().length.toLocaleString('pt-BR')} caracteres
                            {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </span>
                        </button>
                        {isExpanded && (
                          <p className="mt-2 min-w-0 border-t border-border/40 pt-2 whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere] leading-relaxed">
                            {d.content}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setViewDialogOpen(false);
                    handleOpenCleanup();
                  }}
                  className="h-8 text-xs gap-1.5"
                >
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  Revisar e Unificar Fragmentos
                </Button>
              </div>
            )}
          </div>

          <DialogFooter className="mx-0 mb-0 flex w-full shrink-0 items-center justify-between gap-2 border-t border-border/60 bg-muted/50 px-4 py-3 sm:justify-between sm:px-6">
            <span className="text-xs text-muted-foreground">
              {content.trim().length.toLocaleString('pt-BR')} caracteres • Indexado no RAG
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setViewDialogOpen(false);
                  handleOpenEdit();
                }}
                className="h-8 text-xs gap-1.5"
              >
                <Pencil className="h-3.5 w-3.5" />
                Editar Conteúdo
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setViewDialogOpen(false)}
                className="h-8 text-xs"
              >
                Fechar
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Content Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="w-full sm:max-w-2xl md:max-w-3xl max-h-[90dvh] sm:max-h-[90vh] overflow-y-auto p-4 sm:p-6 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-6">
          <DialogHeader className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                <FileText className="h-4 w-4" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold text-foreground">
                  Editar Conhecimento Global Transversal
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  Defina as diretrizes institucionais válidas para qualquer cliente e empreendimento.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="rounded-lg border border-border/80 bg-muted/20 p-3 text-xs text-muted-foreground">
              <p>
                <strong>Critério:</strong> Insira informações institucionais verdadeiras para qualquer atendimento (ex: papéis de Ronaldo e Thatianna, acolhimento da IA). Detalhes de imóveis devem ser cadastrados no respectivo <strong>Empreendimento</strong>.
              </p>
            </div>

            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              placeholder="Digite aqui o conhecimento institucional transversal..."
              rows={12}
              className="text-xs font-sans leading-relaxed resize-y"
              disabled={saving}
            />

            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{editContent.trim().length.toLocaleString('pt-BR')} caracteres digitados</span>
              <span>Indexado automaticamente no RAG transversal</span>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setEditDialogOpen(false)}
              disabled={saving}
              className="h-9 text-xs"
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="h-9 text-xs font-medium"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Salvando e Indexando...
                </>
              ) : (
                <>
                  <CheckCircle2 className="mr-1.5 h-4 w-4" />
                  Salvar Conhecimento Global
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cleanup Dialog — review every fragment before merging, since
          confirming permanently deletes everything except the merged
          text below. */}
      <Dialog open={cleanupDialogOpen} onOpenChange={setCleanupDialogOpen}>
        <DialogContent className="w-full sm:max-w-2xl md:max-w-3xl max-h-[90dvh] sm:max-h-[90vh] overflow-y-auto p-4 sm:p-6 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-6">
          <DialogHeader className="min-w-0">
            <DialogTitle className="text-base font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Revisar e Unificar Fragmentos
            </DialogTitle>
            <DialogDescription className="text-xs">
              Você possui <strong>{docs.length} registros</strong> na base. Leia cada um abaixo antes de decidir.
            </DialogDescription>
          </DialogHeader>

          <div className="min-w-0 space-y-3 py-2">
            <div>
              <p className="text-xs font-medium text-foreground mb-1.5">
                Fragmentos atuais ({docs.length}) — clique para ler o conteúdo de cada um
              </p>
              <div className="max-h-56 overflow-y-auto space-y-1.5 rounded-lg border border-border bg-muted/20 p-2">
                {docs.map((d) => {
                  const isExpanded = expandedFragmentIds.has(d.id);
                  const isMaster = d.id === masterDocId;
                  return (
                    <div key={d.id} className="min-w-0 rounded-lg border border-border/60 bg-card px-3 py-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggleFragmentExpanded(d.id)}
                          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left cursor-pointer"
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span className="min-w-0 truncate font-medium text-foreground">{d.title}</span>
                            {isMaster && (
                              <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 shrink-0">
                                atual
                              </Badge>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                            {(d.content || '').trim().length.toLocaleString('pt-BR')} caracteres
                            {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteFragment(d.id)}
                          disabled={deletingFragmentId !== null}
                          className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-40 cursor-pointer"
                          title="Remover apenas este fragmento (sem unificar os demais)"
                        >
                          {deletingFragmentId === d.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                      {isExpanded && (
                        <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed text-foreground/90 border-t border-border/40 pt-2">
                          {d.content}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-foreground mb-1.5">
                Texto unificado que ficará salvo (edite antes de confirmar)
              </p>
              <Textarea
                value={unifyDraft}
                onChange={(e) => setUnifyDraft(e.target.value)}
                rows={10}
                className="text-xs font-sans leading-relaxed resize-y"
                disabled={cleaningUp}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                {unifyDraft.trim().length.toLocaleString('pt-BR')} caracteres — pré-preenchido com o conteúdo de todos os fragmentos acima; remova duplicidades antes de confirmar.
              </p>
            </div>

            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
              Ao confirmar, os {docs.length} registros acima são apagados e substituídos por um único documento com o texto revisado.
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCleanupDialogOpen(false)}
              disabled={cleaningUp}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={handleConsolidateAndCleanup}
              disabled={cleaningUp || !unifyDraft.trim()}
            >
              {cleaningUp && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Unificar e Limpar Base
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
