'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Building2,
  FileText,
  Search,
  Sparkles,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Plus,
  Trash2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  PropertyKnowledgeDetailDialog,
  STAGE_LABELS,
} from './property-knowledge-detail-dialog';
import { PropertyCreateDialog } from './property-create-dialog';
import type { PropertyWithAiContext } from '@/types';

export function PropertyKnowledgeList() {
  const [properties, setProperties] = useState<PropertyWithAiContext[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [selectedProperty, setSelectedProperty] = useState<PropertyWithAiContext | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const loadProperties = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/properties');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao carregar empreendimentos');
      }
      setProperties(data.properties || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao carregar lista de empreendimentos';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProperties();
  }, [loadProperties]);

  const filteredProperties = useMemo(() => {
    return properties.filter((p) => {
      const matchesSearch =
        !search.trim() ||
        p.name.toLowerCase().includes(search.toLowerCase());

      const stage = p.ai_context?.stage || 'lancamento';
      const matchesStage = stageFilter === 'all' || stage === stageFilter;

      return matchesSearch && matchesStage;
    });
  }, [properties, search, stageFilter]);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleOpenDetail = (prop: PropertyWithAiContext) => {
    setSelectedProperty(prop);
    setDialogOpen(true);
  };

  const handleDeleteProperty = async (e: React.MouseEvent, prop: PropertyWithAiContext) => {
    e.stopPropagation();
    const confirmDelete = window.confirm(
      `Deseja realmente excluir o empreendimento "${prop.name}"?\n\nEsta ação apagará todas as fichas técnicas, anotações e fragmentos de IA deste empreendimento.`,
    );
    if (!confirmDelete) return;

    setDeletingId(prop.id);
    try {
      const res = await fetch(`/api/ai/properties/${prop.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao excluir empreendimento');
      }
      toast.success(`Empreendimento "${prop.name}" excluído com sucesso!`);
      loadProperties();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao excluir';
      toast.error(msg);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Search, Filter & Add Header */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar empreendimento por nome..."
            className="pl-9 h-9 text-sm"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">Todos os estágios</option>
            {Object.entries(STAGE_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>

          <Button
            variant="outline"
            size="sm"
            onClick={loadProperties}
            disabled={loading}
            className="h-9 px-2.5"
            title="Recarregar"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>

          <Button
            size="sm"
            onClick={() => setCreateDialogOpen(true)}
            className="h-9 gap-1.5 font-medium shadow-sm"
          >
            <Plus className="h-4 w-4" />
            Novo Empreendimento
          </Button>
        </div>
      </div>

      {/* Empreendimentos Cards / List */}
      {loading ? (
        <div className="flex h-48 items-center justify-center rounded-xl border border-border bg-card">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : filteredProperties.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 p-8 text-center">
          <Building2 className="h-10 w-10 text-muted-foreground/50 mb-2" />
          <p className="text-sm font-medium text-foreground">
            {search.trim() ? 'Nenhum empreendimento encontrado para esta busca' : 'Nenhum empreendimento cadastrado'}
          </p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md">
            {search.trim()
              ? 'Tente ajustar os filtros ou termo de busca.'
              : 'Cadastre seus empreendimentos com fichas técnicas e anotações do corretor para a IA.'}
          </p>
          {!search.trim() && (
            <Button
              size="sm"
              onClick={() => setCreateDialogOpen(true)}
              className="mt-4 gap-1.5"
            >
              <Plus className="h-4 w-4" />
              Adicionar Primeiro Empreendimento
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProperties.map((prop) => {
            const ctx = prop.ai_context;
            const stage = ctx?.stage || 'lancamento';
            const hasBookSummary = Boolean(ctx?.book_extracted_text?.trim() || ctx?.book_indexed_at);
            const hasSubjective = Boolean(ctx?.subjective_knowledge?.trim());
            const isDeleting = deletingId === prop.id;

            return (
              <div
                key={prop.id}
                onClick={() => handleOpenDetail(prop)}
                className="group relative flex flex-col justify-between rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/50 hover:shadow-sm cursor-pointer"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-base font-semibold text-foreground group-hover:text-primary transition-colors">
                        {prop.name}
                      </h3>
                      <p className="truncate text-xs text-muted-foreground mt-0.5">
                        Empreendimento Imobiliário
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge variant="outline" className="text-[11px] font-normal">
                        {STAGE_LABELS[stage] || stage}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isDeleting}
                        onClick={(e) => handleDeleteProperty(e, prop)}
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md"
                        title="Excluir empreendimento"
                      >
                        {isDeleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-destructive" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Status Badges */}
                  <div className="mt-4 flex flex-wrap items-center gap-1.5">
                    {/* Ficha Técnica / Book Status */}
                    {hasBookSummary ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                        <CheckCircle2 className="h-3 w-3" />
                        Ficha Técnica
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground/60">
                        <FileText className="h-3 w-3 opacity-60" />
                        Sem ficha técnica
                      </span>
                    )}

                    {/* Subjective Notes Status */}
                    {hasSubjective ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        <Sparkles className="h-3 w-3" />
                        Visão do corretor
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground/60">
                        Sem anotações
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-4 border-t border-border/50 pt-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Clique para editar</span>
                  <span className="font-medium text-primary group-hover:underline">
                    Configurar IA &rarr;
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Dialog */}
      <PropertyKnowledgeDetailDialog
        property={selectedProperty}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={loadProperties}
      />

      {/* Create Dialog */}
      <PropertyCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={loadProperties}
      />
    </div>
  );
}
