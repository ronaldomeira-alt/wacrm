'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Globe,
  Loader2,
  CheckCircle2,
  Sparkles,
  Eye,
  Pencil,
  FileText,
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

      if (masterDocId) {
        const res = await fetch(`/api/ai/knowledge/${masterDocId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content: trimmedContent }),
        });
        if (!res.ok) throw new Error('Falha ao atualizar conhecimento global');
      } else {
        const res = await fetch('/api/ai/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content: trimmedContent }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao salvar');
        if (data.id) setMasterDocId(data.id);
      }

      setContent(trimmedContent);
      toast.success('Conhecimento global transversal salvo e indexado no RAG!');
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
    setCleaningUp(true);
    try {
      const title = 'Conhecimento Global Transversal';
      const trimmedContent = content.trim();

      if (masterDocId) {
        await fetch(`/api/ai/knowledge/${masterDocId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content: trimmedContent }),
        });
      } else {
        const res = await fetch('/api/ai/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content: trimmedContent }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.id) setMasterDocId(data.id);
      }

      const others = docs.filter((d) => d.id !== masterDocId);
      for (const doc of others) {
        try {
          await fetch(`/api/ai/knowledge/${doc.id}`, { method: 'DELETE' });
        } catch {
          // ignore
        }
      }

      toast.success('Fragmentos consolidados com sucesso!');
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
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
            {docs.length > 1 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCleanupDialogOpen(true)}
                className="h-8 text-xs gap-1.5"
                title="Unificar fragmentos"
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

      {/* View Full Content Dialog */}
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="w-full sm:max-w-2xl md:max-w-3xl max-h-[85vh] overflow-y-auto p-6">
          <DialogHeader className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                <Globe className="h-4 w-4" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold text-foreground">
                  Conhecimento Global Transversal
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  Informações institucionais aplicadas em todos os atendimentos da IA.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="rounded-xl border border-border bg-muted/20 p-4 mt-2">
            <div className="prose prose-sm dark:prose-invert max-w-none text-xs text-foreground/90 whitespace-pre-wrap font-sans leading-relaxed">
              {content}
            </div>
          </div>

          <DialogFooter className="flex items-center justify-between sm:justify-between w-full pt-2">
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
        <DialogContent className="w-full sm:max-w-2xl md:max-w-3xl max-h-[90vh] overflow-y-auto p-6">
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

      {/* Cleanup Dialog */}
      <Dialog open={cleanupDialogOpen} onOpenChange={setCleanupDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Unificar Fragmentos em Documento Único
            </DialogTitle>
            <DialogDescription className="text-xs">
              Você possui <strong>{docs.length} registros fragmentados</strong> na base de conhecimento. Deseja unificá-los neste documento único e remover os fragmentos soltos?
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground space-y-1">
            <p>✓ Todo o texto visível no editor será mantido como o Conhecimento Global oficial.</p>
            <p>✓ Os registros soltos antigos serão limpos, deixando a base organizada e sem poluição.</p>
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
              disabled={cleaningUp}
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
