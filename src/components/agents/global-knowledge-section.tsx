'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  BookOpen,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  CheckCircle2,
  FileText,
  HelpCircle,
  Building,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge');
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setDocs(data.documents || []);
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

  const handleSave = async () => {
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

      toast.success(isNew ? 'Documento adicionado ao conhecimento geral!' : 'Documento atualizado!');
      setDialogOpen(false);
      loadDocs();
    } catch (err: any) {
      toast.error(err.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Deseja realmente excluir este documento do conhecimento global?')) return;

    setDeletingId(id);
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Erro ao excluir');

      toast.success('Documento excluído com sucesso.');
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch (err: any) {
      toast.error(err.message || 'Falha ao excluir');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            Conhecimento Geral da Imobiliária
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Documentos e regras gerais compartilhados com todos os atendimentos (parcerias bancárias, regras de visita, equipe, estacionamento).
          </p>
        </div>

        <Button size="sm" onClick={handleOpenCreate} className="h-8">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Novo Documento
        </Button>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center rounded-xl border border-border bg-card">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      ) : docs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center">
          <FileText className="h-8 w-8 text-muted-foreground/40 mb-2" />
          <p className="text-sm font-medium text-foreground">Nenhum documento geral cadastrado</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Adicione orientações gerais da imobiliária que a IA deve saber para responder a qualquer cliente.
          </p>
          <Button variant="outline" size="sm" onClick={handleOpenCreate} className="mt-3">
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Adicionar Primeiro Documento
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {docs.map((doc) => (
            <div
              key={doc.id}
              className="flex flex-col justify-between rounded-xl border border-border bg-card p-4 transition-all hover:border-border/80"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground truncate flex-1">
                    {doc.title}
                  </h3>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => handleOpenEdit(doc)}
                      title="Editar"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      disabled={deletingId === doc.id}
                      onClick={() => handleDelete(doc.id)}
                      title="Excluir"
                    >
                      {deletingId === doc.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>

                <p className="mt-2 line-clamp-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {doc.content}
                </p>
              </div>

              <div className="mt-3 border-t border-border/40 pt-2 text-[11px] text-muted-foreground/80">
                Atualizado em {new Date(doc.updated_at).toLocaleDateString('pt-BR')}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit / Create Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingId ? 'Editar Documento Geral' : 'Novo Documento Geral'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Este conteúdo será indexado e consultado pela IA em conversas de qualquer empreendimento.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="doc-title" className="text-xs">Título do Documento</Label>
              <Input
                id="doc-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ex: Parcerias Bancárias e Financiamento Caixa"
                disabled={saving}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="doc-content" className="text-xs">Conteúdo do Documento</Label>
              <Textarea
                id="doc-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Ex: Trabalhamos com correspondentes bancários Caixa, Itaú, Santander e Bradesco. Aprovamos a carta de crédito em até 24h sem custo para o cliente..."
                rows={7}
                disabled={saving}
                className="text-sm"
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
            <Button type="button" onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editingId ? 'Atualizar Documento' : 'Salvar Documento'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
