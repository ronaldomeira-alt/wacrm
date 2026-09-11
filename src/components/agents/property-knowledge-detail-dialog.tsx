'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
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
  ImageIcon,
  Camera,
  ChevronRight,
  Info,
  Clock,
  Calendar,
  User,
  Star,
  Check,
} from 'lucide-react'
import { ResponseStyleInstructionsEditor } from './response-style-instructions-editor'
import { ExpandableKnowledgeSection } from './expandable-knowledge-section'
import { PropertyMediaGallery } from './property-media-gallery'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createClient } from '@/lib/supabase/client'
import { PROPERTY_MEDIA_BUCKET } from '@/lib/storage/upload-media'
import { STAGE_LABELS, type PropertyWithAiContext, type PropertyStage, type PropertyImage } from '@/types'
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
  adset_name?: string | null
  ad_status?: string | null
  referral_headline?: string | null
  referral_body?: string | null
  referral_image_url?: string | null
  warning?: string | null
  message?: string
}

interface PropertyKnowledgeDetailDialogProps {
  property: PropertyWithAiContext | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

type DetailTab = 'geral' | 'saber' | 'regras' | 'midia' | 'anuncios'

const TABS: { id: DetailTab; label: string; icon: typeof Building2 }[] = [
  { id: 'geral', label: 'Geral', icon: Building2 },
  { id: 'saber', label: 'Saber', icon: FileText },
  { id: 'regras', label: 'Regras', icon: SlidersHorizontal },
  { id: 'midia', label: 'Mídia', icon: ImageIcon },
  { id: 'anuncios', label: 'Anúncios', icon: Megaphone },
]

export function PropertyKnowledgeDetailDialog({
  property,
  open,
  onOpenChange,
  onSaved,
}: PropertyKnowledgeDetailDialogProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>('geral')
  const [name, setName] = useState('')
  const [stage, setStage] = useState<PropertyStage>('lancamento')
  const [bookSummary, setBookSummary] = useState('')
  const [subjectiveKnowledge, setSubjectiveKnowledge] = useState('')
  const [styleInstructions, setStyleInstructions] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [promoting, setPromoting] = useState(false)

  // Media list for Cover Photo & Stats
  const [propertyImages, setPropertyImages] = useState<PropertyImage[]>([])
  const [loadingImages, setLoadingImages] = useState(false)
  const [coverModalOpen, setCoverModalOpen] = useState(false)
  const [settingCoverId, setSettingCoverId] = useState<string | null>(null)

  // CTWA Ad Mappings
  const [adMappings, setAdMappings] = useState<AdMapping[]>([])
  const [loadingAds, setLoadingAds] = useState(false)
  const [showAddAd, setShowAddAd] = useState(false)
  const [newAdSourceId, setNewAdSourceId] = useState('')
  const [newAdName, setNewAdName] = useState('')
  const [validatingAd, setValidatingAd] = useState(false)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [addingAd, setAddingAd] = useState(false)

  const supabase = createClient()

  const loadImages = useCallback(async (propId: string) => {
    setLoadingImages(true)
    try {
      const res = await fetch(`/api/ai/properties/${propId}/images`)
      if (res.ok) {
        const data = await res.json()
        setPropertyImages(data.images || [])
      }
    } catch (err) {
      console.error('Failed to load property images:', err)
    } finally {
      setLoadingImages(false)
    }
  }, [])

  const loadAdMappings = useCallback(async (propId: string) => {
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
  }, [])

  // Sync state when property changes
  useEffect(() => {
    if (property) {
      setActiveTab('geral')
      setName(property.name || '')
      setStage(property.ai_context?.stage || 'lancamento')
      setBookSummary(property.ai_context?.book_extracted_text || '')
      setSubjectiveKnowledge(property.ai_context?.subjective_knowledge || '')
      setStyleInstructions(
        Array.isArray(property.ai_context?.response_style_instructions)
          ? property.ai_context.response_style_instructions
          : [],
      )
      loadImages(property.id)
      loadAdMappings(property.id)
      setShowAddAd(false)
      setNewAdSourceId('')
      setNewAdName('')
      setValidationResult(null)
    }
  }, [property, loadImages, loadAdMappings])

  // When switching to 'midia' tab and back, reload images to keep cover & counts in sync
  useEffect(() => {
    if (property?.id && activeTab === 'geral') {
      loadImages(property.id)
    }
  }, [activeTab, property?.id, loadImages])

  // Cover Image computation
  const coverImage = useMemo(() => {
    return propertyImages.find((img) => img.is_cover) || propertyImages[0] || null
  }, [propertyImages])

  const publicImageUrl = useCallback(
    (storagePath: string) =>
      supabase.storage.from(PROPERTY_MEDIA_BUCKET).getPublicUrl(storagePath).data.publicUrl,
    [supabase],
  )

  // Dynamic Metrics Calculation
  const knowledgeCount = useMemo(() => {
    let count = 0
    if (bookSummary.trim().length > 0) count++
    if (subjectiveKnowledge.trim().length > 0) count++
    return count
  }, [bookSummary, subjectiveKnowledge])

  const rulesCount = useMemo(() => {
    return styleInstructions.length
  }, [styleInstructions])

  const mediaCount = useMemo(() => {
    return propertyImages.length
  }, [propertyImages])

  const adsCount = useMemo(() => {
    return adMappings.length
  }, [adMappings])

  // AI Configuration Status
  const aiStatus = useMemo(() => {
    const hasKnowledge = knowledgeCount > 0
    const hasMedia = mediaCount > 0
    const hasRules = rulesCount > 0

    if (hasKnowledge && (hasMedia || hasRules)) {
      return {
        label: 'Configurado',
        description: 'Este empreendimento está pronto para ser utilizado pela Clara.',
        color: 'emerald',
      }
    }
    if (hasKnowledge) {
      return {
        label: 'Configuração parcial',
        description: 'Conhecimento cadastrado. Adicione mídias ou regras para enriquecer o atendimento.',
        color: 'amber',
      }
    }
    return {
      label: 'Requer atenção',
      description: 'Cadastre a ficha técnica ou visão do corretor na aba Saber.',
      color: 'rose',
    }
  }, [knowledgeCount, mediaCount, rulesCount])

  // Last Update display
  const lastUpdatedDisplay = useMemo(() => {
    const rawDate = property?.ai_context?.updated_at || property?.updated_at || property?.created_at
    if (!rawDate) return null
    try {
      const d = new Date(rawDate)
      return {
        dateStr: d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }),
        timeStr: d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      }
    } catch {
      return null
    }
  }, [property])

  const handleSelectCover = async (image: PropertyImage) => {
    if (!property) return
    setSettingCoverId(image.id)
    try {
      const res = await fetch(`/api/ai/properties/${property.id}/images/${image.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_cover: true }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Falha ao atualizar foto de capa')
      }
      toast.success('Foto de capa atualizada!')
      setPropertyImages((prev) =>
        prev.map((img) => ({
          ...img,
          is_cover: img.id === image.id,
        })),
      )
      setCoverModalOpen(false)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao definir capa')
    } finally {
      setSettingCoverId(null)
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

  const handlePromoteToActive = async () => {
    setPromoting(true)
    try {
      const res = await fetch(`/api/ai/properties/${property.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ativo' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao promover empreendimento')
      }
      toast.success(`"${property.name}" promovido para empreendimento ativo!`)
      onSaved()
      onOpenChange(false)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao promover empreendimento'
      toast.error(msg)
    } finally {
      setPromoting(false)
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
        // Auto-fill input field if empty and we found a name/campaign/headline
        const detectedName =
          data.ad_name ||
          data.campaign_name ||
          data.referral_headline ||
          data.adset_name ||
          ''
        if (detectedName && !newAdName.trim()) {
          setNewAdName(detectedName)
        }

        if (data.confirmed) {
          toast.success('Anúncio identificado com sucesso!')
        } else {
          toast.success('Formato do ID validado!')
        }
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
          ad_name:
            newAdName.trim() ||
            validationResult.ad_name ||
            validationResult.campaign_name ||
            validationResult.referral_headline ||
            null,
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
      <DialogContent className="w-full sm:max-w-[63rem] md:max-w-[84rem] h-[calc(100dvh-2rem)] sm:h-[960px] max-h-[90dvh] sm:max-h-[90vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 gap-1 border-b border-border px-4 py-4 sm:px-6">
          <div className="flex items-center justify-between gap-2 pr-8">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                <Building2 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <DialogTitle className="text-base font-semibold text-foreground truncate">
                    {property.name}
                  </DialogTitle>
                  {property.status === 'provisorio' && (
                    <Badge
                      variant="outline"
                      className="text-[11px] font-normal border-amber-500/30 bg-amber-500/10 text-amber-600 shrink-0"
                    >
                      Em aprendizagem
                    </Badge>
                  )}
                </div>
                <DialogDescription className="text-xs text-muted-foreground">
                  Configuração de Conhecimento e Ficha Técnica da IA
                </DialogDescription>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {property.status === 'provisorio' && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handlePromoteToActive}
                  disabled={saving || deleting || promoting}
                  className="h-8 text-xs gap-1.5"
                >
                  {promoting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  <span className="hidden sm:inline">Promover para Ativo</span>
                  <span className="sm:hidden">Promover</span>
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDeleteProperty}
                disabled={saving || deleting || promoting}
                className="h-8 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive gap-1.5"
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                <span className="hidden sm:inline">Excluir Empreendimento</span>
                <span className="sm:hidden">Excluir</span>
              </Button>
            </div>
          </div>
        </DialogHeader>

        {/* Mobile: horizontal scrollable tab strip (rail below is desktop-only) */}
        <div className="flex sm:hidden shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium transition-colors',
                  activeTab === tab.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground active:bg-muted',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            )
          })}
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Desktop: vertical icon rail */}
          <nav className="hidden sm:flex sm:w-20 md:w-[92px] shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/30 py-4">
            {TABS.map((tab) => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex w-16 flex-col items-center gap-1 rounded-lg py-2.5 text-[10px] font-medium transition-colors',
                    activeTab === tab.id
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="h-[18px] w-[18px]" />
                  {tab.label}
                </button>
              )
            })}
          </nav>

          <div className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
            {/* ========================================================================= */}
            {/* ABA GERAL REDESENHADA (Identidade + Resumo IA + Indicadores + Status)     */}
            {/* ========================================================================= */}
            {activeTab === 'geral' && (
              <div className="space-y-6 max-w-5xl mx-auto">
                {/* 1. HERO COVER BANNER */}
                <div className="relative w-full h-44 sm:h-52 md:h-56 rounded-xl overflow-hidden border border-border bg-card shadow-xs group">
                  {coverImage ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={publicImageUrl(coverImage.storage_path)}
                        alt={name || 'Capa do empreendimento'}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-102"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent" />
                    </>
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center bg-muted/20 text-muted-foreground p-6 text-center">
                      <div className="h-10 w-10 rounded-full bg-muted/40 flex items-center justify-center mb-2">
                        <Camera className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <p className="text-xs font-semibold text-foreground">Nenhuma foto de capa</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 max-w-xs">
                        Adicione fotos na aba Mídia para exibir a capa deste empreendimento.
                      </p>
                    </div>
                  )}

                  {/* Top Left / Bottom Info on Cover */}
                  <div className="absolute bottom-3 sm:bottom-4 left-4 sm:left-5 right-4 flex items-end justify-between gap-3">
                    <div className="min-w-0 text-white space-y-1 drop-shadow-sm">
                      <h2 className="text-lg sm:text-xl md:text-2xl font-bold tracking-tight truncate">
                        {name || 'Nome do Empreendimento'}
                      </h2>
                      <div className="flex items-center gap-2 flex-wrap text-xs text-white/90">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-black/50 backdrop-blur-xs border border-white/20 text-[11px] font-medium text-white">
                          <Building2 className="h-3 w-3 text-primary" />
                          {STAGE_LABELS[stage]}
                        </span>
                        {coverImage?.description && (
                          <span className="text-[11px] text-white/80 truncate max-w-sm hidden sm:inline">
                            • {coverImage.description}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Change cover button */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (propertyImages.length === 0) {
                          setActiveTab('midia')
                        } else {
                          setCoverModalOpen(true)
                        }
                      }}
                      className="h-8 text-xs gap-1.5 shrink-0 bg-black/60 hover:bg-black/80 text-white border-white/20 backdrop-blur-xs shadow-sm transition-all"
                    >
                      <Camera className="h-3.5 w-3.5" />
                      <span>{propertyImages.length === 0 ? 'Adicionar fotos' : 'Alterar foto de capa'}</span>
                    </Button>
                  </div>
                </div>

                {/* 2. INFORMAÇÕES BÁSICAS (Campos editáveis mantidos) */}
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    <div>
                      <h3 className="text-xs font-semibold text-foreground">Informações básicas</h3>
                      <p className="text-[11px] text-muted-foreground">
                        Dados principais do empreendimento, utilizados pela Clara nas conversas.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 pt-1">
                    <div className="sm:col-span-7 space-y-1.5">
                      <Label htmlFor="edit-prop-name" className="text-xs font-medium text-foreground">
                        Nome do Empreendimento
                      </Label>
                      <Input
                        id="edit-prop-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={saving || deleting}
                        placeholder="Ex: Avant Home"
                        className="h-9 text-sm"
                      />
                    </div>

                    <div className="sm:col-span-5 space-y-1.5">
                      <Label htmlFor="edit-prop-stage" className="text-xs font-medium text-foreground">
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
                </div>

                {/* 3. RESUMO DA CONFIGURAÇÃO DA IA (4 Cards Indicadores Dinâmicos Clicáveis) */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-semibold text-foreground">Resumo da configuração da IA</h3>
                      <p className="text-[11px] text-muted-foreground">
                        Visão geral dos dados que alimentam a Clara sobre este empreendimento.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1">
                    {/* CARD 1: Conhecimentos específicos */}
                    <button
                      type="button"
                      onClick={() => setActiveTab('saber')}
                      className="group flex flex-col justify-between p-3.5 rounded-xl border border-border bg-card hover:bg-muted/40 hover:border-primary/40 transition-all text-left shadow-2xs cursor-pointer"
                    >
                      <div className="flex items-start justify-between w-full">
                        <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                          <FileText className="h-4 w-4" />
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                      </div>
                      <div className="mt-3">
                        <span className="text-2xl font-bold font-mono tracking-tight text-foreground">
                          {knowledgeCount}
                        </span>
                        <p className="text-xs font-medium text-foreground mt-0.5">
                          Conhecimentos específicos
                        </p>
                        <p className="text-[10.5px] text-muted-foreground">
                          {knowledgeCount === 1 ? '1 cadastrado' : `${knowledgeCount} cadastrados`}
                        </p>
                      </div>
                    </button>

                    {/* CARD 2: Regras cadastradas */}
                    <button
                      type="button"
                      onClick={() => setActiveTab('regras')}
                      className="group flex flex-col justify-between p-3.5 rounded-xl border border-border bg-card hover:bg-muted/40 hover:border-primary/40 transition-all text-left shadow-2xs cursor-pointer"
                    >
                      <div className="flex items-start justify-between w-full">
                        <div className="h-8 w-8 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center">
                          <SlidersHorizontal className="h-4 w-4" />
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                      </div>
                      <div className="mt-3">
                        <span className="text-2xl font-bold font-mono tracking-tight text-foreground">
                          {rulesCount}
                        </span>
                        <p className="text-xs font-medium text-foreground mt-0.5">
                          Regras
                        </p>
                        <p className="text-[10.5px] text-muted-foreground">
                          {rulesCount === 1 ? '1 ativa/cadastrada' : `${rulesCount} ativas/cadastradas`}
                        </p>
                      </div>
                    </button>

                    {/* CARD 3: Mídias */}
                    <button
                      type="button"
                      onClick={() => setActiveTab('midia')}
                      className="group flex flex-col justify-between p-3.5 rounded-xl border border-border bg-card hover:bg-muted/40 hover:border-primary/40 transition-all text-left shadow-2xs cursor-pointer"
                    >
                      <div className="flex items-start justify-between w-full">
                        <div className="h-8 w-8 rounded-lg bg-purple-500/10 text-purple-600 flex items-center justify-center">
                          <ImageIcon className="h-4 w-4" />
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                      </div>
                      <div className="mt-3">
                        <span className="text-2xl font-bold font-mono tracking-tight text-foreground">
                          {mediaCount}
                        </span>
                        <p className="text-xs font-medium text-foreground mt-0.5">
                          Mídias
                        </p>
                        <p className="text-[10.5px] text-muted-foreground">
                          {mediaCount === 1 ? '1 foto cadastrada' : `${mediaCount} fotos cadastradas`}
                        </p>
                      </div>
                    </button>

                    {/* CARD 4: Anúncios */}
                    <button
                      type="button"
                      onClick={() => setActiveTab('anuncios')}
                      className="group flex flex-col justify-between p-3.5 rounded-xl border border-border bg-card hover:bg-muted/40 hover:border-primary/40 transition-all text-left shadow-2xs cursor-pointer"
                    >
                      <div className="flex items-start justify-between w-full">
                        <div className="h-8 w-8 rounded-lg bg-amber-500/10 text-amber-600 flex items-center justify-center">
                          <Megaphone className="h-4 w-4" />
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                      </div>
                      <div className="mt-3">
                        <span className="text-2xl font-bold font-mono tracking-tight text-foreground">
                          {adsCount}
                        </span>
                        <p className="text-xs font-medium text-foreground mt-0.5">
                          Anúncios
                        </p>
                        <p className="text-[10.5px] text-muted-foreground">
                          {adsCount === 1 ? '1 vinculado' : `${adsCount} vinculados`}
                        </p>
                      </div>
                    </button>
                  </div>
                </div>

                {/* 4. STATUS DA CONFIGURAÇÃO & ÚLTIMA ATUALIZAÇÃO */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                  {/* Status da Configuração Card */}
                  <div className="p-4 rounded-xl border border-border bg-card space-y-3 shadow-2xs">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-primary" />
                      <div>
                        <h4 className="text-xs font-semibold text-foreground">Status da configuração</h4>
                        <p className="text-[11px] text-muted-foreground">
                          Acompanhe o nível de preparo da Clara para este empreendimento.
                        </p>
                      </div>
                    </div>

                    <div
                      className={cn(
                        'p-3 rounded-lg border text-xs space-y-1',
                        aiStatus.color === 'emerald'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
                          : aiStatus.color === 'amber'
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-600'
                            : 'border-rose-500/30 bg-rose-500/10 text-rose-600',
                      )}
                    >
                      <div className="flex items-center gap-1.5 font-semibold text-xs">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        <span>{aiStatus.label}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        {aiStatus.description}
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground pt-1 border-t border-border/50">
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            knowledgeCount > 0 ? 'text-emerald-500' : 'text-muted-foreground/40',
                          )}
                        />
                        <span>Conhecimento específico</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            rulesCount > 0 ? 'text-emerald-500' : 'text-muted-foreground/40',
                          )}
                        />
                        <span>Regras configuradas</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            mediaCount > 0 ? 'text-emerald-500' : 'text-muted-foreground/40',
                          )}
                        />
                        <span>Mídias disponíveis</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            adsCount > 0 ? 'text-emerald-500' : 'text-muted-foreground/40',
                          )}
                        />
                        <span>Anúncio vinculado</span>
                      </div>
                    </div>
                  </div>

                  {/* Informações Secundárias / Última Atualização */}
                  <div className="p-4 rounded-xl border border-border bg-card space-y-3 shadow-2xs flex flex-col justify-between">
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-primary" />
                        <div>
                          <h4 className="text-xs font-semibold text-foreground">Última atualização</h4>
                          <p className="text-[11px] text-muted-foreground">
                            Informações sobre a última alteração neste empreendimento.
                          </p>
                        </div>
                      </div>

                      {lastUpdatedDisplay ? (
                        <div className="space-y-1.5 text-xs text-foreground bg-muted/30 p-2.5 rounded-lg border border-border/50">
                          <div className="flex items-center gap-2 text-[11px]">
                            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="font-medium">{lastUpdatedDisplay.dateStr}</span>
                            <span className="text-muted-foreground">às {lastUpdatedDisplay.timeStr}</span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <User className="h-3.5 w-3.5" />
                            <span>Administrador / Corretor da conta</span>
                          </div>
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted-foreground italic">
                          Data de atualização não disponível.
                        </p>
                      )}
                    </div>

                    <div className="p-2.5 rounded-lg bg-primary/5 border border-primary/10 flex items-start gap-2 text-[11px] text-muted-foreground">
                      <Info className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                      <p>
                        As informações deste empreendimento são utilizadas pela Clara para responder perguntas, apresentar o imóvel e qualificar leads no WhatsApp.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'saber' && (
              <div className="space-y-4">
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
              </div>
            )}

            {activeTab === 'regras' && (
              <div className="space-y-3">
                <p className="text-[11px] text-muted-foreground leading-relaxed max-w-xl">
                  Ajustes específicos deste empreendimento que sobrepõem apenas as regras globais com as quais entram em conflito.
                </p>

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
            )}

            {activeTab === 'midia' && (
              <PropertyMediaGallery propertyId={property.id} disabled={saving || deleting} />
            )}

            {activeTab === 'anuncios' && (
              <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground max-w-md">
                Mapeamento determinístico de anúncios Click to WhatsApp (Meta Ads).
              </p>

              {!showAddAd && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1 text-xs shrink-0"
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

                {validationResult && (
                  <div
                    className={`rounded-lg p-3 text-xs space-y-2 transition-all border ${
                      validationResult.valid
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
                        : 'border-destructive/30 bg-destructive/10 text-destructive'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 font-semibold">
                        {validationResult.valid ? (
                          <>
                            <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0" />
                            <span className="text-emerald-600 font-medium">
                              {validationResult.confirmed
                                ? 'Anúncio identificado com sucesso'
                                : 'Anúncio validado (Formato correto)'}
                            </span>
                          </>
                        ) : (
                          <>
                            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                            <span className="text-destructive font-medium">Não foi possível validar este anúncio</span>
                          </>
                        )}
                      </div>

                      {validationResult.valid && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-medium bg-emerald-500/15 text-emerald-600 border border-emerald-500/30">
                          {validationResult.source === 'meta_api'
                            ? 'Meta Ads API'
                            : validationResult.source === 'inbound_leads'
                              ? 'Lead CTWA'
                              : 'Formato'}
                        </span>
                      )}
                    </div>

                    {validationResult.valid ? (
                      <div className="rounded-md bg-background/60 border border-emerald-500/20 p-2.5 space-y-1.5 text-[11px] leading-relaxed">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5">
                          <div>
                            <span className="text-muted-foreground font-medium">ID do Anúncio:</span>{' '}
                            <span className="font-mono text-emerald-600 font-semibold">
                              {validationResult.ad_source_id || newAdSourceId}
                            </span>
                          </div>

                          {(validationResult.ad_name || newAdName.trim()) && (
                            <div>
                              <span className="text-muted-foreground font-medium">Identificação / Anúncio:</span>{' '}
                              <span className="text-foreground font-medium">
                                {validationResult.ad_name || newAdName.trim()}
                              </span>
                            </div>
                          )}

                          {validationResult.campaign_name && (
                            <div>
                              <span className="text-muted-foreground font-medium">Campanha:</span>{' '}
                              <span className="text-foreground">{validationResult.campaign_name}</span>
                            </div>
                          )}

                          {validationResult.adset_name && (
                            <div>
                              <span className="text-muted-foreground font-medium">Conjunto de Anúncios:</span>{' '}
                              <span className="text-foreground">{validationResult.adset_name}</span>
                            </div>
                          )}

                          {validationResult.referral_headline && !validationResult.ad_name && (
                            <div>
                              <span className="text-muted-foreground font-medium">Título (Criativo):</span>{' '}
                              <span className="text-foreground">{validationResult.referral_headline}</span>
                            </div>
                          )}

                          {validationResult.referral_body && (
                            <div className="sm:col-span-2">
                              <span className="text-muted-foreground font-medium">Texto do Criativo:</span>{' '}
                              <span className="text-foreground">{validationResult.referral_body}</span>
                            </div>
                          )}
                        </div>

                        {validationResult.warning && (
                          <p className="text-amber-600 font-medium pt-1 border-t border-border/30">
                            ⚠️ {validationResult.warning}
                          </p>
                        )}

                        <p className="pt-1 text-[11px] font-medium border-t border-emerald-500/20 text-emerald-600">
                          {validationResult.confirmed
                            ? '✓ Confira os dados acima para confirmar que este é o anúncio correto antes de salvar.'
                            : '✓ Formato do ID validado. Digite o nome da campanha acima para fácil identificação e clique em Salvar Vínculo.'}
                        </p>
                      </div>
                    ) : (
                      <div className="text-[11px] leading-relaxed text-destructive/90 pl-5.5">
                        <p>{validationResult.message}</p>
                      </div>
                    )}
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
                    className="flex items-center justify-between rounded-lg border border-border bg-background/80 hover:bg-background px-3 py-2 text-xs gap-2 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Tag className="h-3.5 w-3.5 text-primary shrink-0" />
                      <span className="font-mono font-semibold text-foreground shrink-0">{ad.ad_source_id}</span>
                      {ad.ad_name ? (
                        <span className="truncate text-foreground font-medium bg-muted/60 px-2 py-0.5 rounded border border-border/50 text-[11px]">
                          {ad.ad_name}
                        </span>
                      ) : (
                        <span className="truncate text-muted-foreground italic text-[11px]">(Sem identificação)</span>
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
            )}
          </div>
        </div>

        <DialogFooter className="mx-0 mb-0 shrink-0 gap-2 rounded-b-xl border-t bg-muted/30 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-4 sm:flex-row sm:justify-between">
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

      {/* MODAL PARA SELEÇÃO DE FOTO DE CAPA ENTRE AS MÍDIAS EXISTENTES */}
      <Dialog open={coverModalOpen} onOpenChange={setCoverModalOpen}>
        <DialogContent className="w-full sm:max-w-2xl max-h-[85vh] flex flex-col p-0">
          <DialogHeader className="p-4 sm:p-5 border-b border-border">
            <DialogTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Camera className="h-4 w-4 text-primary" />
              Selecionar Foto de Capa
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Escolha uma das fotos cadastradas no empreendimento para ser a capa principal.
            </DialogDescription>
          </DialogHeader>

          <div className="p-4 sm:p-5 overflow-y-auto flex-1">
            {loadingImages ? (
              <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Carregando mídias...
              </div>
            ) : propertyImages.length === 0 ? (
              <div className="text-center p-8 space-y-2">
                <ImageIcon className="h-8 w-8 mx-auto text-muted-foreground" />
                <p className="text-xs font-medium text-foreground">Nenhuma mídia cadastrada</p>
                <p className="text-[11px] text-muted-foreground">
                  Adicione fotos na aba Mídia para selecioná-las como capa.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCoverModalOpen(false)
                    setActiveTab('midia')
                  }}
                  className="h-8 text-xs mt-2"
                >
                  Ir para aba Mídia
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {propertyImages.map((img) => {
                  const isCover = img.is_cover || coverImage?.id === img.id
                  const isBusy = settingCoverId === img.id

                  return (
                    <button
                      key={img.id}
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleSelectCover(img)}
                      className={cn(
                        'group relative aspect-4/3 rounded-lg overflow-hidden border text-left transition-all cursor-pointer',
                        isCover
                          ? 'border-primary ring-2 ring-primary/30 shadow-sm'
                          : 'border-border hover:border-foreground/40 hover:shadow-xs',
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={publicImageUrl(img.storage_path)}
                        alt={img.description || img.file_name}
                        className="w-full h-full object-cover transition-transform group-hover:scale-103"
                        loading="lazy"
                      />

                      {/* Cover Badge */}
                      {isCover && (
                        <span className="absolute top-2 left-2 flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground shadow-xs">
                          <Star className="h-2.5 w-2.5 fill-current" />
                          Capa Atual
                        </span>
                      )}

                      {/* Hover Overlay */}
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        {isBusy ? (
                          <Loader2 className="h-5 w-5 text-white animate-spin" />
                        ) : isCover ? (
                          <span className="text-xs font-semibold text-white flex items-center gap-1">
                            <Check className="h-3.5 w-3.5" /> Selecionada
                          </span>
                        ) : (
                          <span className="text-xs font-medium text-white bg-black/60 px-2.5 py-1 rounded-full backdrop-blur-xs">
                            Definir como Capa
                          </span>
                        )}
                      </div>

                      {img.description && (
                        <p className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-2 text-[10px] text-white truncate">
                          {img.description}
                        </p>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <DialogFooter className="p-3 border-t bg-muted/20 flex justify-between sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setCoverModalOpen(false)}
              className="h-8 text-xs"
            >
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}
