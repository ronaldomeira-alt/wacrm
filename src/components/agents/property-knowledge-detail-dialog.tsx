'use client';

import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import {
  Building2,
  FileText,
  Upload,
  Trash2,
  Loader2,
  Sparkles,
  CheckCircle2,
  Megaphone,
  Plus,
  Tag,
} from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import type { PropertyWithAiContext, PropertyStage } from '@/types';

export const STAGE_LABELS: Record<PropertyStage, string> = {
  pre_lancamento: 'Pré-Lançamento',
  lancamento: 'Lançamento',
  pronto: 'Pronto para Morar',
};

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
  const [stage, setStage] = useState<PropertyStage>('lancamento');
  const [subjectiveKnowledge, setSubjectiveKnowledge] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingBook, setUploadingBook] = useState(false);
  const [removingBook, setRemovingBook] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      setStage(property.ai_context?.stage || 'lancamento');
      setSubjectiveKnowledge(property.ai_context?.subjective_knowledge || '');
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

  const ctx = property.ai_context;
  const hasBook = Boolean(ctx?.book_filename || ctx?.book_indexed_at);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/ai/properties/${property.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage,
          subjective_knowledge: subjectiveKnowledge.trim() || null,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao salvar conhecimento do empreendimento');
      }

      toast.success('Conhecimento do empreendimento atualizado com sucesso!');
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao salvar';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Por favor, selecione um arquivo PDF válido.');
      return;
    }

    if (file.size > 30 * 1024 * 1024) {
      toast.error('O arquivo PDF deve ter no máximo 30MB.');
      return;
    }

    setUploadingBook(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`/api/ai/properties/${property.id}/book`, {
        method: 'POST',
        body: formData,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao processar o Book PDF');
      }

      toast.success(`Book PDF processado com sucesso! (${data.pages ?? 1} páginas extraídas)`);
      onSaved();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro no upload do Book';
      toast.error(msg);
    } finally {
      setUploadingBook(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemoveBook = async () => {
    if (!confirm('Deseja realmente remover o Book PDF deste empreendimento? Os fragmentos indexados na IA serão removidos.')) {
      return;
    }

    setRemovingBook(true);
    try {
      const res = await fetch(`/api/ai/properties/${property.id}/book`, {
        method: 'DELETE',
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao remover o Book');
      }

      toast.success('Book PDF removido com sucesso!');
      onSaved();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao remover Book';
      toast.error(msg);
    } finally {
      setRemovingBook(false);
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
      <DialogContent className="w-full sm:max-w-2xl md:max-w-3xl max-h-[90vh] overflow-y-auto p-6">
        <DialogHeader className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Building2 className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold text-foreground">
                {property.name}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Empreendimento Imobiliário
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Estágio da Obra */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-foreground">Estágio da Obra / Status</Label>
            <Select
              value={stage}
              onValueChange={(val) => val && setStage(val as PropertyStage)}
            >
              <SelectTrigger className="w-full h-9 text-sm">
                <SelectValue>{STAGE_LABELS[stage]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(STAGE_LABELS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Ajuda a IA a contextualizar as respostas (ex: se está pronto para morar ou previsão de entrega).
            </p>
          </div>

          {/* Anúncios CTWA Vinculados */}
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
                    className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Tag className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="font-mono font-medium text-foreground">{ad.ad_source_id}</span>
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

          {/* Book do Empreendimento (PDF) */}
          <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <Label className="text-sm font-medium">Book do Empreendimento (PDF)</Label>
              </div>

              {hasBook && (
                <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 text-xs">
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                  Pronto {ctx?.book_page_count ? `(${ctx.book_page_count} págs)` : ''}
                </Badge>
              )}
            </div>

            {hasBook ? (
              <div className="flex items-center justify-between rounded-lg border border-border bg-background p-3">
                <div className="min-w-0 flex-1 pr-2">
                  <p className="truncate text-sm font-medium text-foreground">
                    {ctx?.book_filename || 'Book do Empreendimento.pdf'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {ctx?.book_page_count ? `${ctx.book_page_count} páginas extraídas` : 'PDF processado'}{' '}
                    {ctx?.book_indexed_at && `• ${new Date(ctx.book_indexed_at).toLocaleDateString('pt-BR')}`}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadingBook || removingBook}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploadingBook ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Substituir
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={uploadingBook || removingBook}
                    onClick={handleRemoveBook}
                  >
                    {removingBook ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/50 p-6 text-center">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  onChange={handleFileUpload}
                />
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  {uploadingBook ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Upload className="h-5 w-5" />
                  )}
                </div>
                <p className="mt-2 text-sm font-medium text-foreground">
                  {uploadingBook ? 'Processando e indexando PDF...' : 'Nenhum Book PDF anexado'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground max-w-sm">
                  Faça upload do Book comercial (PDF até 30MB) para que a IA extraia informações técnicas, plantas, tipologias e diferenciais.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  disabled={uploadingBook}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  Selecionar PDF
                </Button>
              </div>
            )}
          </div>

          {/* Meu conhecimento sobre este empreendimento / Visão do Corretor */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <Label htmlFor="subjective-knowledge" className="text-xs font-medium text-foreground">
                Visão do Corretor / Conhecimento Subjetivo
              </Label>
            </div>
            <Textarea
              id="subjective-knowledge"
              value={subjectiveKnowledge}
              onChange={(e) => setSubjectiveKnowledge(e.target.value)}
              placeholder="Digite ou escreva aqui detalhes e dicas práticas que a IA deve saber sobre este empreendimento."
              rows={4}
              disabled={saving}
              className="text-sm resize-y"
            />
            <p className="text-[11px] text-muted-foreground">
              Anotações e percepções práticas que a IA consulta exclusivamente ao atender interessados neste empreendimento.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving || uploadingBook}
            className="h-9 text-xs"
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || uploadingBook}
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
