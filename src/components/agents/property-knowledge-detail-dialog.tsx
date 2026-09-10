'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
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
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  Search,
  ExternalLink,
} from 'lucide-react'
import { ResponseStyleInstructionsEditor } from './response-style-instructions-editor'
import { ExpandableKnowledgeSection } from './expandable-knowledge-section'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { STAGE_LABELS, type PropertyWithAiContext, type PropertyStage } from '@/types'
export { STAGE_LABELS }

interface AdMapping {
  id: string
  ad_source_id: string
  ad_name: string | null
  created_at: string
}

interface ValidationResult {
  valid: boolean
  confirmed?: boolean
  source?: 'meta_api' | 'inbound_leads' | 'syntax_validated'
  ad_source_id?: string
  ad_name?: string | null
  campaign_name?: string | null
  referral_headline?: string | null
  referral_body?: string | null
  warning?: string | null
  message?: string
}

interface PropertyKnowledgeDetailDialogProps {
  property: PropertyWithAiContext | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

export function PropertyKnowledgeDetailDialog({
  property,
  open,
  onOpenChange,
  onSaved,
}: PropertyKnowledgeDetailDialogProps) {
  const [name, setName] = useState('')
  const [stage, setStage] = useState<PropertyStage>('lancamento')
  const [bookSummary, setBookSummary] = useState('')
  const [subjectiveKnowledge, setSubjectiveKnowledge] = useState('')
  const [styleInstructions, setStyleInstructions] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // CTWA Ad Mappings
  const [adMappings, setAdMappings] = useState<AdMapping[]>([])
  const [loadingAds, setLoadingAds] = useState(false)
  const [showAddAd, setShowAddAd] = useState(false)
  const [newAdSourceId, setNewAdSourceId] = useState('')
  const [newAdName, setNewAdName] = useState('')
  const [validatingAd, setValidatingAd] = useState(false)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [addingAd, setAddingAd] = useState(false)

  // Sync state when property changes
  useEffect(() => {
    if (property) {
      setName(property.name || '')
      setStage(property.ai_context?.stage || 'lancamento')
      setBookSummary(property.ai_context?.book_extracted_text || '')
      setSubjectiveKnowledge(property.ai_context?.subjective_knowledge || '')
      setStyleInstructions(
        Array.isArray(property.ai_context?.response_style_instructions)
          ? property.ai_context.response_style_instructions
          : [],
      )
      loadAdMappings(property.id)
      setShowAddAd(false)
      setNewAdSourceId('')
      setNewAdName('')
      setValidationResult(null)
    }
  }, [property])

  const loadAdMappings = async (propId: string) => {
    setLoadingAds(true)
    try {
      const res = await fetch(`/api/ai/properties/${propId}/ads`)
      if (res.ok) {
        const data = await res.json()
        setAdMappings(data.mappings || [])
      }
    } catch (err) {
      console.error('Failed to load ad mappings:', err)
    } finally {
      setLoadingAds(false)
    }
  }

  if (!property) return null

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('O nome do empreendimento não pode ficar vazio.')
      return
    }

    setSaving(true)
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
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao salvar conhecimento do empreendimento')
      }

      if (data.warning) {
        toast.warning(data.warning)
      } else {
        toast.success('Conhecimento do empreendimento atualizado e indexado com sucesso!')
      }
      onSaved()
      onOpenChange(false)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Falha ao salvar'
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteProperty = async () => {
    const confirmDelete = window.confirm(
      `Tem certeza que deseja excluir o empreendimento "${property.name}"?\n\nTodas as anotações, fichas técnicas, índices da IA e vínculos de anúncios associados serão excluídos permanentemente.`,
    )
    if (!confirmDelete) return

    setDeleting(true)
    try {
      const res = await fetch(`/api/ai/properties/${property.id}`, {
        method: 'DELETE',
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao excluir empreendimento')
      }

      toast.success(`Empreendimento "${property.name}" excluído com sucesso!`)
      onSaved()
      onOpenChange(false)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao excluir empreendimento'
      toast.error(msg)
    } finally {
      setDeleting(false)
    }
  }

  const handleValidateAd = async () => {
    if (!newAdSourceId.trim()) {
      toast.error('Informe o ID do anúncio antes de validar.')
      return
    }

    setValidatingAd(true)
    try {
      const res = await fetch(`/api/ai/properties/${property.id}/ads/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ad_source_id: newAdSourceId.trim(),
          ad_name: newAdName.trim() || null,
        }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setValidationResult({
          valid: false,
          message: data.message || data.error || 'Falha ao validar anúncio no servidor.',
        })
        return
      }

      setValidationResult(data)
      if (data.valid) {
        toast.success('Anúncio validado com sucesso!')
      } else {
        toast.error(data.message || 'ID do anúncio inválido.')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro na conexão de validação'
      setValidationResult({
        valid: false,
        message: msg,
      })
      toast.error(msg)
    } finally {
      setValidatingAd(false)
    }
  }

  const handleAddAdMapping = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validationResult?.valid || !newAdSourceId.trim()) return

    setAddingAd(true)
    try {
      const res = await fetch(`/api/ai/properties/${property.id}/ads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ad_source_id: newAdSourceId.trim(),
          ad_name: newAdName.trim() || validationResult.campaign_name || null,
        }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao vincular anúncio')
      }

      toast.success('Anúncio CTWA vinculado com sucesso!')
      setNewAdSourceId('')
      setNewAdName('')
      setValidationResult(null)
      setShowAddAd(false)
      loadAdMappings(property.id)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao vincular anúncio'
      toast.error(msg)
    } finally {
      setAddingAd(false)
    }
  }

  const handleDeleteAdMapping = async (mappingId: string) => {
    try {
      const res = await fetch(`/api/ai/properties/${property.id}/ads?mappingId=${mappingId}`, {
        method: 'DELETE',
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Falha ao desvincular anúncio')
      }

      toast.success('Vínculo do anúncio removido')
      loadAdMappings(property.id)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao desvincular'
      toast.error(msg)
    }
  }

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
              <span className="hidden sm:inline">Excluir Empreendimento</span>
              <span className="sm:hidden">Excluir</span>
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

          {/* Ficha Técnica / Resumo do Book (Expandable & Compact) */}
          <ExpandableKnowledgeSection
            id="edit-book-summary"
            title="Ficha Técnica / Resumo do Book Técnico"
            icon={<FileText className="h-4 w-4" />}
            subtitle="A IA usa estes dados técnicos para responder aos interessados sobre características, lazer, metragens e previsão da obra."
            value={bookSummary}
            onChange={setBookSummary}
            placeholder="Cole aqui o resumo gerado pela IA ou a ficha técnica completa: localização exata, tipologias, metragens, quantidade de quartos/suítes, itens da área de lazer, acabamentos, diferenciais construtivos e previsão de entrega."
            emptyPrompt="Nenhuma ficha técnica cadastrada para este empreendimento."
            addButtonText="Adicionar Ficha Técnica"
            disabled={saving || deleting}
            rows={6}
          />

          {/* Visão do Corretor / Dicas Práticas (Expandable & Compact) */}
          <ExpandableKnowledgeSection
            id="edit-subjective-knowledge"
            title="Visão do Corretor / Dicas Práticas"
            icon={<Sparkles className="h-4 w-4" />}
            subtitle="Anotações e percepções comerciais consultadas exclusivamente no atendimento aos interessados neste empreendimento."
            value={subjectiveKnowledge}
            onChange={setSubjectiveKnowledge}
            placeholder="Digite argumentos de venda, perfil do comprador ideal (investidor, família, veraneio), pontos fortes da região, dicas para quebrar objeções e orientações práticas para a IA."
            emptyPrompt="Nenhuma visão do corretor cadastrada para este empreendimento."
            addButtonText="Adicionar Visão do Corretor"
            disabled={saving || deleting}
            rows={4}
          />

          {/* Exceções de Comportamento (100% Preserved) */}
          <div className="rounded-xl border border-border/80 bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                <SlidersHorizontal className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <Label className="text-xs font-semibold text-foreground uppercase tracking-wide">
                  Exceções de Comportamento
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Ajustes específicos deste empreendimento que sobrepõem apenas as regras globais com as quais entram em conflito.
                </p>
              </div>
            </div>

            <ResponseStyleInstructionsEditor
              mode="property_exceptions"
              propertyName={property.name}
              instructions={styleInstructions}
              onAdd={async (text) => setStyleInstructions((prev) => [...prev, text])}
              onRemove={async (index) => setStyleInstructions((prev) => prev.filter((_, i) => i !== index))}
              onEdit={async (index, text) =>
                setStyleInstructions((prev) => prev.map((v, i) => (i === index ? text : v)))
              }
            />

            <p className="text-[11px] text-muted-foreground">
              As alterações feitas aqui são gravadas ao clicar em &quot;Salvar Conhecimento&quot; abaixo. Para efeito e teste imediatos em tempo real, você também pode ajustá-las pelo Playground.
            </p>
          </div>

          {/* Anúncios CTWA Vinculados (Meta Ads) com Validação Prévia */}
          <div className="rounded-xl border border-border/80 bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                  <Megaphone className="h-4 w-4" />
                </div>
                <div>
                  <Label className="text-xs font-semibold text-foreground">
                    Anúncios CTWA Vinculados (Meta Ads)
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    Mapeamento determinístico de anúncios Click to WhatsApp.
                  </p>
                </div>
              </div>

              {!showAddAd && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1 text-xs"
                  onClick={() => {
                    setShowAddAd(true)
                    setValidationResult(null)
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Vincular Anúncio
                </Button>
              )}
            </div>

            {showAddAd && (
              <form onSubmit={handleAddAdMapping} className="rounded-lg border border-border bg-background p-3.5 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs font-medium">ID do Anúncio (source_id Meta) *</Label>
                    <Input
                      placeholder="Ex: 120250622441180493"
                      value={newAdSourceId}
                      onChange={(e) => {
                        setNewAdSourceId(e.target.value)
                        setValidationResult(null) // Invalida validação anterior se alterar ID
                      }}
                      required
                      className="h-8 text-xs mt-1 font-mono"
                      autoFocus
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Copie o ID numérico do anúncio no Gerenciador de Anúncios da Meta.
                    </p>
                  </div>

                  <div>
                    <Label className="text-xs font-medium">Identificação / Campanha (Opcional)</Label>
                    <Input
                      placeholder="Ex: Campanha 2Q Bessa - Set/2026"
                      value={newAdName}
                      onChange={(e) => setNewAdName(e.target.value)}
                      className="h-8 text-xs mt-1"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Nome descritivo para fácil identificação da equipe.
                    </p>
                  </div>
                </div>

                {/* Validation Feedback Banner */}
                {validationResult && (
                  <div
                    className={`rounded-lg p-3 text-xs space-y-1.5 transition-all border ${
                      validationResult.valid
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-950 dark:text-emerald-200'
                        : 'border-destructive/30 bg-destructive/10 text-destructive'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 font-semibold">
                      {validationResult.valid ? (
                        <>
                          <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                          <span>Anúncio validado com sucesso</span>
                        </>
                      ) : (
                        <>
                          <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                          <span>Não foi possível validar este anúncio</span>
                        </>
                      )}
                    </div>

                    <div className="text-[11px] leading-relaxed space-y-0.5 opacity-90 pl-5.5">
                      <p>
                        <span className="font-medium">ID Meta:</span>{' '}
                        <span className="font-mono">{validationResult.ad_source_id || newAdSourceId}</span>
                      </p>
                      {validationResult.campaign_name && (
                        <p>
                          <span className="font-medium">Campanha:</span> {validationResult.campaign_name}
                        </p>
                      )}
                      {validationResult.referral_headline && (
                        <p>
                          <span className="font-medium">Criativo/Título:</span> {validationResult.referral_headline}
                        </p>
                      )}
                      {validationResult.warning && (
                        <p className="text-amber-600 dark:text-amber-400 font-medium pt-0.5">
                          ⚠️ {validationResult.warning}
                        </p>
                      )}
                      <p className="pt-0.5 text-muted-foreground">{validationResult.message}</p>
                    </div>
                  </div>
                )}

                {/* Buttons: Validate vs Save */}
                <div className="flex flex-wrap items-center justify-end gap-2 pt-1 border-t border-border/50">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => {
                      setShowAddAd(false)
                      setValidationResult(null)
                    }}
                    disabled={addingAd || validatingAd}
                  >
                    Cancelar
                  </Button>

                  {/* Step 1: Validate Button */}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs gap-1.5"
                    onClick={handleValidateAd}
                    disabled={validatingAd || !newAdSourceId.trim()}
                  >
                    {validatingAd ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Conferindo anúncio...
                      </>
                    ) : (
                      <>
                        <Search className="h-3.5 w-3.5 text-primary" />
                        Conferir anúncio
                      </>
                    )}
                  </Button>

                  {/* Step 2: Save Button (Enabled only when validated) */}
                  <Button
                    type="submit"
                    size="sm"
                    className="h-8 text-xs gap-1.5 font-medium"
                    disabled={addingAd || !validationResult?.valid}
                  >
                    {addingAd ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Salvando...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Salvar Vínculo
                      </>
                    )}
                  </Button>
                </div>
              </form>
            )}

            {loadingAds ? (
              <div className="flex items-center justify-center p-3 text-xs text-muted-foreground">
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Carregando anúncios vinculados...
              </div>
            ) : adMappings.length > 0 ? (
              <div className="space-y-1.5">
                {adMappings.map((ad) => (
                  <div
                    key={ad.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-xs gap-2"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Tag className="h-3.5 w-3.5 text-primary shrink-0" />
                      <span className="font-mono font-medium text-foreground truncate">{ad.ad_source_id}</span>
                      {ad.ad_name && (
                        <span className="truncate text-muted-foreground">({ad.ad_name})</span>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => handleDeleteAdMapping(ad.id)}
                      title="Remover vínculo"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              !showAddAd && (
                <div className="rounded-lg border border-dashed border-border bg-background/50 p-3 text-center text-xs text-muted-foreground">
                  Nenhum anúncio explicitamente mapeado. O sistema usará reconhecimento textual de título e mensagem do anúncio como fallback.
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
  )
}
