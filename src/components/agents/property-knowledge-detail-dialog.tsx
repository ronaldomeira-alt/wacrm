'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Building2,
  FileText,
  Trash2,
  Loader2,
  Sparkles,
  Megaphone,
  Plus,
  Tag,
  SlidersHorizontal,
} from 'lucide-react';
import { ResponseStyleInstructionsEditor } from './response-style-instructions-editor';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { STAGE_LABELS, type PropertyWithAiContext, type PropertyStage } from '@/types';
export { STAGE_LABELS };

interface AdMapping {
  id: string;
  ad_source_id: string;
  ad_name: string | null;
  created_at: string;
}

interface PropertyKnowledgeDetailDialogProps {
  property: PropertyWithAiContext | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function PropertyKnowledgeDetailDialog({
  property,
  open,
  onOpenChange,
  onSaved,
}: PropertyKnowledgeDetailDialogProps) {
  const [name, setName] = useState('');
  const [stage, setStage] = useState<PropertyStage>('lancamento');
  const [bookSummary, setBookSummary] = useState('');
  const [subjectiveKnowledge, setSubjectiveKnowledge] = useState('');
  const [styleInstructions, setStyleInstructions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // CTWA Ad Mappings
  const [adMappings, setAdMappings] = useState<AdMapping[]>([]);
  const [loadingAds, setLoadingAds] = useState(false);
  const [showAddAd, setShowAddAd] = useState(false);
  const [newAdSourceId, setNewAdSourceId] = useState('');
  const [newAdName, setNewAdName] = useState('');
  const [addingAd, setAddingAd] = useState(false);

  // Sync state when property changes
  useEffect(() => {
    if (property) {
      setName(property.name || '');
      setStage(property.ai_context?.stage || 'lancamento');
      setBookSummary(property.ai_context?.book_extracted_text || '');
      setSubjectiveKnowledge(property.ai_context?.subjective_knowledge || '');
      setStyleInstructions(
        Array.isArray(property.ai_context?.response_style_instructions)
          ? property.ai_context.response_style_instructions
          : [],
      );
      loadAdMappings(property.id);
    }
  }, [property]);

  const loadAdMappings = async (propId: string) => {
    setLoadingAds(true);
    try {
      const res = await fetch(`/api/ai/properties/${propId}/ads`);
      if (res.ok) {
        const data = await res.json();
        setAdMappings(data.mappings || []);
      }
    } catch (err) {
      console.error('Failed to load ad mappings:', err);
    } finally {
      setLoadingAds(false);
    }
  };

  if (!property) return null;

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('O nome do empreendimento não pode ficar vazio.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/ai/properties/${property.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          stage,
          book_summary: bookSummary.trim() || null,
          subjective_knowledge: subjectiveKnowledge.trim() || null,
          response_style_instructions: styleInstructions,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao salvar conhecimento do empreendimento');
      }

      if (data.warning) {
        toast.warning(data.warning);
      } else {
        toast.success('Conhecimento do empreendimento atualizado e indexado com sucesso!');
      }
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao salvar';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProperty = async () => {
    const confirmDelete = window.confirm(
      `Tem certeza que deseja excluir o empreendimento "${property.name}"?\n\nTodas as anotações, fichas técnicas, índices da IA e vínculos de anúncios associados serão excluídos permanentemente.`,
    );
    if (!confirmDelete) return;

    setDeleting(true);
    try {
      const res = await fetch(`/api/ai/properties/${property.id}`, {
        method: 'DELETE',
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao excluir empreendimento');
      }

      toast.success(`Empreendimento "${property.name}" excluído com sucesso!`);
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao excluir empreendimento';
      toast.error(msg);
    } finally {
      setDeleting(false);
    }
  };

  const handleAddAdMapping = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAdSourceId.trim()) return;

    setAddingAd(true);
    try {
      const res = await fetch(`/api/ai/properties/${property.id}/ads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ad_source_id: newAdSourceId.trim(),
          ad_name: newAdName.trim() || null,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao vincular anúncio');
      }

      toast.success('Anúncio CTWA vinculado com sucesso!');
      setNewAdSourceId('');
      setNewAdName('');
      setShowAddAd(false);
      loadAdMappings(property.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao vincular anúncio';
      toast.error(msg);
    } finally {
      setAddingAd(false);
    }
  };

  const handleDeleteAdMapping = async (mappingId: string) => {
    try {
      const res = await fetch(`/api/ai/properties/${property.id}/ads?mappingId=${mappingId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Falha ao desvincular anúncio');
      }

      toast.success('Vínculo do anúncio removido');
      loadAdMappings(property.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao desvincular';
      toast.error(msg);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full sm:max-w-2xl md:max-w-3xl max-h-[90dvh] sm:max-h-[90vh] overflow-y-auto p-4 sm:p-6 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-6">
        <DialogHeader className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                <Building2 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-base font-semibold text-foreground truncate">
                  {property.name}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  Configuração de Conhecimento e Ficha Técnica da IA
                </DialogDescription>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDeleteProperty}
              disabled={saving || deleting}
              className="h-8 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive shrink-0 gap-1.5"
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Excluir Empreendimento
            </Button>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Nome e Estágio */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-start">
            <div className="sm:col-span-7 space-y-1.5">
              <Label htmlFor="edit-prop-name" className="text-xs font-medium text-foreground flex items-center h-5 leading-none">
                Nome do Empreendimento
              </Label>
              <Input
                id="edit-prop-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving || deleting}
                className="h-9 text-sm"
              />
            </div>

            <div className="sm:col-span-5 space-y-1.5">
              <Label htmlFor="edit-prop-stage" className="text-xs font-medium text-foreground flex items-center h-5 leading-none">
                Estágio do Empreendimento
              </Label>
              <Select
                value={stage}
                onValueChange={(val) => val && setStage(val as PropertyStage)}
                disabled={saving || deleting}
              >
                <SelectTrigger id="edit-prop-stage" className="w-full h-9 text-sm">
                  <SelectValue>{STAGE_LABELS[stage]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(STAGE_LABELS).map(([k, label]) => (
                    <SelectItem key={k} value={k} className="text-sm">
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Ficha Técnica / Resumo do Book */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-primary" />
              <Label htmlFor="edit-book-summary" className="text-xs font-medium text-foreground">
                Ficha Técnica / Resumo do Book Técnico
              </Label>
            </div>
            <Textarea
              id="edit-book-summary"
              value={bookSummary}
              onChange={(e) => setBookSummary(e.target.value)}
              placeholder="Cole aqui o resumo gerado pela IA ou a ficha técnica completa: localização exata, tipologias, metragens, quantidade de quartos/suítes, itens da área de lazer, acabamentos, diferenciais construtivos e previsão de entrega."
              rows={6}
              disabled={saving || deleting}
              className="text-sm resize-y"
            />
            <p className="text-[11px] text-muted-foreground">
              A IA usa estes dados técnicos para responder aos interessados sobre características, lazer, metragens e previsão da obra.
            </p>
          </div>

          {/* Visão do Corretor / Dicas Práticas */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <Label htmlFor="edit-subjective-knowledge" className="text-xs font-medium text-foreground">
                Visão do Corretor / Dicas Práticas
              </Label>
            </div>
            <Textarea
              id="edit-subjective-knowledge"
              value={subjectiveKnowledge}
              onChange={(e) => setSubjectiveKnowledge(e.target.value)}
              placeholder="Digite argumentos de venda, perfil do comprador ideal (investidor, família, veraneio), pontos fortes da região, dicas para quebrar objeções e orientações práticas para a IA."
              rows={3}
              disabled={saving || deleting}
              className="text-sm resize-y"
            />
            <p className="text-[11px] text-muted-foreground">
              Anotações e percepções comerciais consultadas exclusivamente no atendimento aos interessados neste empreendimento.
            </p>
          </div>

          {/* Instruções de Estilo Específicas do Empreendimento */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
              <Label className="text-xs font-medium text-foreground">
                Instruções de Estilo Específicas deste Empreendimento
              </Label>
            </div>
            <ResponseStyleInstructionsEditor
              instructions={styleInstructions}
              onAdd={async (text) => setStyleInstructions((prev) => [...prev, text])}
              onRemove={async (index) => setStyleInstructions((prev) => prev.filter((_, i) => i !== index))}
              onEdit={async (index, text) =>
                setStyleInstructions((prev) => prev.map((v, i) => (i === index ? text : v)))
              }
            />
            <p className="text-[11px] text-muted-foreground">
              Ajustes de estilo válidos apenas neste empreendimento — em caso de conflito, prevalecem sobre as instruções globais de estilo. Só grava ao clicar em &quot;Salvar Conhecimento&quot;; para efeito imediato, ajuste pelo Playground.
            </p>
          </div>

          {/* Anúncios CTWA Vinculados (Meta Ads) */}
          <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Megaphone className="h-4 w-4 text-primary" />
                <Label className="text-sm font-medium">Anúncios CTWA Vinculados (Meta Ads)</Label>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={() => setShowAddAd(!showAddAd)}
              >
                <Plus className="h-3.5 w-3.5" />
                Vincular Anúncio
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Leads que clicarem nesses anúncios da Meta terão este empreendimento resolvido de forma determinística e imediata.
            </p>

            {showAddAd && (
              <form onSubmit={handleAddAdMapping} className="rounded-lg border border-border bg-background p-3 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">ID do Anúncio (source_id Meta)</Label>
                    <Input
                      placeholder="Ex: 12021234567890"
                      value={newAdSourceId}
                      onChange={(e) => setNewAdSourceId(e.target.value)}
                      required
                      className="h-8 text-xs mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Identificação / Campanha (Opcional)</Label>
                    <Input
                      placeholder="Ex: Campanha 2Q Bessa - Set/2026"
                      value={newAdName}
                      onChange={(e) => setNewAdName(e.target.value)}
                      className="h-8 text-xs mt-1"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setShowAddAd(false)}
                    disabled={addingAd}
                  >
                    Cancelar
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={addingAd || !newAdSourceId.trim()}
                  >
                    {addingAd && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                    Salvar Vínculo
                  </Button>
                </div>
              </form>
            )}

            {loadingAds ? (
              <div className="flex items-center justify-center p-3 text-xs text-muted-foreground">
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Carregando anúncios...
              </div>
            ) : adMappings.length > 0 ? (
              <div className="space-y-1.5">
                {adMappings.map((ad) => (
                  <div
                    key={ad.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-xs gap-2"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Tag className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="font-mono font-medium text-foreground truncate">{ad.ad_source_id}</span>
                      {ad.ad_name && (
                        <span className="truncate text-muted-foreground">({ad.ad_name})</span>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => handleDeleteAdMapping(ad.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              !showAddAd && (
                <div className="rounded-lg border border-dashed border-border bg-background/50 p-3 text-center text-xs text-muted-foreground">
                  Nenhum anúncio explicitamente mapeado. O sistema usará reconhecimento de texto do anúncio como fallback.
                </div>
              )
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0 pt-2 flex items-center justify-between sm:justify-between w-full">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving || deleting}
            className="h-9 text-xs"
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || deleting}
            className="h-9 text-xs font-medium"
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar Conhecimento
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
