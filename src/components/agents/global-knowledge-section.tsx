'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Globe,
  Loader2,
  CheckCircle2,
  FileText,
  Sparkles,
  Info,
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
  const [masterDocId, setMasterDocId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
          // Find a master doc or combine existing content
          const master = list.find((d) => d.title.toLowerCase().includes('conhecimento global') || d.title.toLowerCase().includes('manual'));
          if (master) {
            setMasterDocId(master.id);
            setContent(master.content || '');
          } else {
            // Join existing fragments into the editor for review
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
      } else {
        console.warn('[global-knowledge] GET /api/ai/knowledge error:', data.error);
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

  const handleSave = async () => {
    setSaving(true);
    try {
      const title = 'Conhecimento Global Transversal';
      const trimmedContent = content.trim();

      if (!trimmedContent) {
        // If empty, delete master doc if exists
        if (masterDocId) {
          await fetch(`/api/ai/knowledge/${masterDocId}`, { method: 'DELETE' });
          setMasterDocId(null);
        }
        toast.success('Conhecimento global limpo com sucesso.');
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

      toast.success('Conhecimento global transversal salvo e indexado com sucesso!');
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

      // 1. Create or update master doc
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

      // 2. Delete other legacy fragmented docs
      const others = docs.filter((d) => d.id !== masterDocId);
      for (const doc of others) {
        try {
          await fetch(`/api/ai/knowledge/${doc.id}`, { method: 'DELETE' });
        } catch {
          // ignore individual deletion errors
        }
      }

      toast.success(`Fragmentos consolidados com sucesso em um único documento transversal!`);
      setCleanupDialogOpen(false);
      loadDocs();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao consolidar fragmentos';
      toast.error(msg);
    } finally {
      setCleaningUp(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" />
            Conhecimento Global (Informações Transversais)
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Informações transversais que a IA pode utilizar em qualquer conversa, independentemente do empreendimento.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {docs.length > 1 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCleanupDialogOpen(true)}
              className="h-8 text-xs gap-1.5"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Unificar {docs.length} fragmentos
            </Button>
          )}

          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || loading}
            className="h-8 gap-1.5"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Salvar Conhecimento Global
          </Button>
        </div>
      </div>

      {/* Concept Clarification Alert */}
      <div className="rounded-xl border border-border/80 bg-muted/20 p-3.5 text-xs text-muted-foreground space-y-1.5">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Info className="h-4 w-4 text-primary shrink-0" />
          <span>Critério para este campo:</span>
        </div>
        <p>
          Insira aqui apenas informações que sejam <strong>verdadeiras e aplicáveis a qualquer atendimento</strong> (ex: apresentação institucional da equipe, papéis gerais de Ronaldo e Thatianna).
        </p>
        <p className="text-[11px] text-muted-foreground/80">
          • <em>Detalhes de imóveis (plantas, prazos, lazer)?</em> Cadastre no <strong>Empreendimento</strong> acima.<br />
          • <em>Regras de conduta, proibições e horário?</em> Configure na aba <strong>Comportamento</strong>.
        </p>
      </div>

      {/* Master Editor */}
      {loading ? (
        <div className="flex h-40 items-center justify-center rounded-xl border border-border bg-card">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-primary" />
              Conteúdo Transversal Disponível para a IA
            </span>
            <Badge variant="outline" className="text-[10px] font-normal">
              RAG Global Transversal
            </Badge>
          </div>

          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Digite aqui as informações institucionais transversais válidas para qualquer atendimento. Exemplo:

- Ronaldo Meira é o corretor responsável pelos atendimentos especializados e visitas.
- Thatianna é responsável pelo primeiro contato, suporte e acolhimento dos leads.
- Atuamos como corretores associados especialistas em lançamentos no litoral paraibano."
            rows={8}
            className="text-sm font-sans resize-y"
            disabled={saving}
          />

          <div className="flex items-center justify-between pt-2 border-t border-border/50 text-[11px] text-muted-foreground">
            <span>
              {content.trim() ? `${content.trim().length} caracteres cadastrados` : 'Nenhum conhecimento global cadastrado (opcional)'}
            </span>
            <span>Indexado automaticamente no RAG transversal</span>
          </div>
        </div>
      )}

      {/* Cleanup / Consolidate Dialog */}
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
            <p>✓ Todo o texto visível no editor acima será mantido como o Conhecimento Global oficial.</p>
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
