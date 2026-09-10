'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  BookOpen,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  CheckCircle2,
  FileText,
  Search,
  Sparkles,
  Layers,
  FileCheck,
  ArrowRight,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  const [viewMode, setViewMode] = useState<'consolidated' | 'list'>('consolidated');
  const [search, setSearch] = useState('');

  // Single Edit / Create Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Consolidated Master Document Editor
  const [consolidatedText, setConsolidatedText] = useState('');
  const [savingConsolidated, setSavingConsolidated] = useState(false);
  const [consolidatingAll, setConsolidatingAll] = useState(false);
  const [consolidateConfirmOpen, setConsolidateConfirmOpen] = useState(false);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge');
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const list: GlobalDoc[] = data.documents || [];
        setDocs(list);

        // Prepopulate consolidated text if there are docs
        if (list.length === 1 && list[0].title.toLowerCase().includes('manual')) {
          setConsolidatedText(list[0].content);
        } else if (list.length > 0) {
          const combined = list
            .map((d) => `## ${d.title}\n\n${d.content}`)
            .join('\n\n---\n\n');
          setConsolidatedText(combined);
        } else {
          setConsolidatedText('');
        }
      } else {
        toast.error(data.error || 'Falha ao carregar documentos gerais');
      }
    } catch {
      toast.error('Erro de conexão ao carregar documentos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  const filteredDocs = useMemo(() => {
    if (!search.trim()) return docs;
    const q = search.toLowerCase();
    return docs.filter(
      (d) => d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q),
    );
  }, [docs, search]);

  const handleOpenCreate = () => {
    setEditingId(null);
    setTitle('');
    setContent('');
    setDialogOpen(true);
  };

  const handleOpenEdit = (doc: GlobalDoc) => {
    setEditingId(doc.id);
    setTitle(doc.title);
    setContent(doc.content);
    setDialogOpen(true);
  };

  const handleSaveDoc = async () => {
    if (!title.trim() || !content.trim()) {
      toast.error('Título e conteúdo são obrigatórios.');
      return;
    }

    setSaving(true);
    try {
      const isNew = !editingId;
      const url = isNew ? '/api/ai/knowledge' : `/api/ai/knowledge/${editingId}`;
      const method = isNew ? 'POST' : 'PATCH';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          content: content.trim(),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao salvar documento');
      }

      toast.success(isNew ? 'Tópico adicionado com sucesso!' : 'Tópico atualizado!');
      setDialogOpen(false);
      loadDocs();
    } catch (err: any) {
      toast.error(err.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Deseja realmente excluir este tópico do conhecimento global?')) return;

    setDeletingId(id);
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Erro ao excluir');

      toast.success('Tópico excluído com sucesso.');
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch (err: any) {
      toast.error(err.message || 'Falha ao excluir');
    } finally {
      setDeletingId(null);
    }
  };

  // Action: Consolidate all multiple docs into a single clean Master Manual
  const handleConsolidateAll = async () => {
    if (docs.length === 0 && !consolidatedText.trim()) {
      toast.error('Não há conteúdo para consolidar.');
      return;
    }

    setConsolidatingAll(true);
    try {
      const combined = consolidatedText.trim()
        ? consolidatedText.trim()
        : docs.map((d) => `## ${d.title}\n\n${d.content}`).join('\n\n---\n\n');

      // 1. Create or overwrite master document
      const masterTitle = 'Manual Geral e Diretrizes da Imobiliária';
      const existingMaster = docs.find((d) => d.title === masterTitle);

      if (existingMaster) {
        // Update existing master
        await fetch(`/api/ai/knowledge/${existingMaster.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: masterTitle, content: combined }),
        });
      } else {
        // Create new master
        await fetch('/api/ai/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: masterTitle, content: combined }),
        });
      }

      // 2. Delete the fragmented docs if requested
      const fragmentsToDelete = docs.filter((d) => d.id !== existingMaster?.id);
      for (const f of fragmentsToDelete) {
        try {
          await fetch(`/api/ai/knowledge/${f.id}`, { method: 'DELETE' });
        } catch {
          // continue best effort
        }
      }

      toast.success(
        `Conhecimento unificado com sucesso em um único Manual Geral (${docs.length} tópicos consolidados)!`,
      );
      setConsolidateConfirmOpen(false);
      setViewMode('consolidated');
      loadDocs();
    } catch (err: any) {
      toast.error(err.message || 'Erro ao consolidar conhecimento');
    } finally {
      setConsolidatingAll(false);
    }
  };

  const handleSaveConsolidatedDirect = async () => {
    if (!consolidatedText.trim()) {
      toast.error('O conteúdo do manual não pode ficar vazio.');
      return;
    }

    setSavingConsolidated(true);
    try {
      const masterTitle = 'Manual Geral e Diretrizes da Imobiliária';
      const existingMaster = docs.find(
        (d) =>
          d.title === masterTitle ||
          (docs.length === 1 && d.title.toLowerCase().includes('manual')),
      );

      if (existingMaster) {
        const res = await fetch(`/api/ai/knowledge/${existingMaster.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: existingMaster.title,
            content: consolidatedText.trim(),
          }),
        });
        if (!res.ok) throw new Error('Erro ao salvar manual');
      } else {
        const res = await fetch('/api/ai/knowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: masterTitle,
            content: consolidatedText.trim(),
          }),
        });
        if (!res.ok) throw new Error('Erro ao criar manual');
      }

      toast.success('Manual Geral da Imobiliária salvo e reindexado com sucesso!');
      loadDocs();
    } catch (err: any) {
      toast.error(err.message || 'Falha ao salvar');
    } finally {
      setSavingConsolidated(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header & Mode Switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            Conhecimento Geral da Imobiliária
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Diretrizes corporativas compartilhadas com todos os atendimentos (parcerias bancárias, regras de visita, equipe, estacionamento).
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Toggle View */}
          <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setViewMode('consolidated')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-all ${
                viewMode === 'consolidated'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <FileCheck className="h-3.5 w-3.5" />
              Manual Unificado
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-all ${
                viewMode === 'list'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              Tópicos Detalhados ({docs.length})
            </button>
          </div>

          {viewMode === 'list' && (
            <Button size="sm" onClick={handleOpenCreate} className="h-8 gap-1">
              <Plus className="h-3.5 w-3.5" />
              Novo Tópico
            </Button>
          )}
        </div>
      </div>

      {/* Multiple Fragments Notice & Unify Button */}
      {docs.length > 1 && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3.5">
          <div className="flex items-start gap-2.5">
            <Sparkles className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-foreground">
                Você possui {docs.length} tópicos fragmentados de conhecimento geral
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Para manter a IA mais rápida e organizada, você pode unificar todos os fragmentos em um único Manual Geral estruturado.
              </p>
            </div>
          </div>

          <Button
            size="sm"
            variant="default"
            onClick={() => setConsolidateConfirmOpen(true)}
            className="h-7 text-xs shrink-0 gap-1.5"
          >
            <Sparkles className="h-3 w-3" />
            Unificar em 1 Manual Único
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex h-32 items-center justify-center rounded-xl border border-border bg-card">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      ) : viewMode === 'consolidated' ? (
        /* ================= Consolidated Unified View ================= */
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold text-foreground">
                Manual Geral Consolidado da Imobiliária (Texto Único para IA)
              </span>
            </div>
            <Badge variant="outline" className="text-[10px] font-normal">
              RAG Global Ativo
            </Badge>
          </div>

          <Textarea
            value={consolidatedText}
            onChange={(e) => setConsolidatedText(e.target.value)}
            placeholder="Digite ou edite o conhecimento geral da sua imobiliária de forma unificada. Exemplo:

## Sobre a Imobiliária
Somos uma imobiliária especializada no litoral paraibano, com foco em lançamentos e imóveis de alto padrão. Nossos corretores responsáveis são Ronaldo Meira e Thatianna.

## Parcerias Bancárias e Financiamento
Trabalhamos com os principais bancos (Caixa Econômica, Itaú, Bradesco e Santander). Temos correspondente bancário interno que cuida de toda a aprovação de crédito.

## Regras de Visitas e Atendimento
As visitas aos estandes e obras são realizadas mediante agendamento prévio com os corretores. Temos plantão de atendimento e transporte próprio para clientes em visita."
            rows={12}
            className="text-sm font-sans resize-y"
          />

          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-2 border-t border-border/50">
            <p className="text-[11px] text-muted-foreground">
              Todo o texto deste manual é indexado de forma contínua e consultado pela IA em conversas de qualquer imóvel.
            </p>

            <Button
              size="sm"
              onClick={handleSaveConsolidatedDirect}
              disabled={savingConsolidated}
              className="gap-1.5 shrink-0"
            >
              {savingConsolidated ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
              Salvar Manual Consolidado
            </Button>
          </div>
        </div>
      ) : (
        /* ================= Detailed Compact List View ================= */
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar nos tópicos gerais..."
              className="pl-8 h-8 text-xs"
            />
          </div>

          {filteredDocs.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center">
              <FileText className="h-7 w-7 text-muted-foreground/40 mb-2" />
              <p className="text-xs font-medium text-foreground">Nenhum tópico encontrado</p>
              <Button variant="outline" size="sm" onClick={handleOpenCreate} className="mt-2.5 h-7 text-xs">
                <Plus className="mr-1 h-3 w-3" /> Adicionar Tópico
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border/60 rounded-xl border border-border bg-card overflow-hidden">
              {filteredDocs.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between gap-3 p-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="text-xs font-semibold text-foreground truncate">{doc.title}</h4>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {new Date(doc.updated_at).toLocaleDateString('pt-BR')}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                      {doc.content}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => handleOpenEdit(doc)}
                      title="Editar"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      disabled={deletingId === doc.id}
                      onClick={() => handleDelete(doc.id)}
                      title="Excluir"
                    >
                      {deletingId === doc.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Edit / Create Single Topic Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {editingId ? 'Editar Tópico Geral' : 'Novo Tópico Geral'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Este conteúdo será indexado e consultado pela IA em conversas de qualquer imóvel.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="doc-title" className="text-xs">Título do Tópico</Label>
              <Input
                id="doc-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ex: Parcerias Bancárias e Financiamento"
                disabled={saving}
                className="h-9 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="doc-content" className="text-xs">Conteúdo</Label>
              <Textarea
                id="doc-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Ex: Trabalhamos com correspondentes Caixa, Itaú e Santander. Aprovamos a carta de crédito em até 24h sem custo para o cliente..."
                rows={7}
                disabled={saving}
                className="text-sm resize-y"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button type="button" onClick={handleSaveDoc} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editingId ? 'Atualizar Tópico' : 'Salvar Tópico'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unify / Consolidate Confirmation Dialog */}
      <Dialog open={consolidateConfirmOpen} onOpenChange={setConsolidateConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Unificar Conhecimento Geral
            </DialogTitle>
            <DialogDescription className="text-xs">
              Esta ação irá consolidar os <strong>{docs.length} tópicos</strong> existentes em um único <strong>Manual Geral da Imobiliária</strong> estruturado por seções.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground space-y-1.5">
            <p>✓ Nenhum texto será perdido; todos os tópicos serão unidos em seções organizadas.</p>
            <p>✓ O RAG global será reindexado de forma unificada e muito mais rápida.</p>
            <p>✓ Você poderá editar todo o manual consolidado diretamente na tela.</p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConsolidateConfirmOpen(false)}
              disabled={consolidatingAll}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={handleConsolidateAll}
              disabled={consolidatingAll}
            >
              {consolidatingAll && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirmar e Unificar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
