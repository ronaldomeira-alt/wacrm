'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import {
  Building2,
  FileText,
  Trash2,
  Loader2,
  Sparkles,
  Megaphone,
  Plus,
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
  Copy,
  MoreHorizontal,
  ArrowRight,
  ExternalLink,
  Bot,
  RefreshCw,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { createClient } from '@/lib/supabase/client'
import { PROPERTY_MEDIA_BUCKET } from '@/lib/storage/upload-media'
import { STAGE_LABELS, type PropertyWithAiContext, type PropertyStage, type PropertyImage } from '@/types'
export { STAGE_LABELS }

interface AdMapping {
  id: string
  ad_source_id: string
  ad_name: string | null
  campaign_name?: string | null
  adset_name?: string | null
  creative_id?: string | null
  creative_type?: string | null
  created_at: string
  verified?: boolean
  image_url?: string | null
  thumbnail_url?: string | null
  headline?: string | null
  body?: string | null
  media_type?: string | null
  source_url?: string | null
  has_lead_telemetry?: boolean
  platform?: string
  image_origin_label?: string | null
  creative_synced_at?: string | null
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
  creative_id?: string | null
  creative_image_url?: string | null
  creative_thumbnail_url?: string | null
  creative_type?: string | null
  headline?: string | null
  body?: string | null
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

  // Cover photo (Aba Geral - visual identity only)
  const [coverImagePath, setCoverImagePath] = useState<string | null>(null)
  const [uploadingCover, setUploadingCover] = useState(false)
  const [deletingCover, setDeletingCover] = useState(false)
  const coverFileInputRef = useRef<HTMLInputElement>(null)

  // Media list for Clara's commercial media (Aba Mídia)
  const [propertyImages, setPropertyImages] = useState<PropertyImage[]>([])

  // CTWA Ad Mappings
  const [adMappings, setAdMappings] = useState<AdMapping[]>([])
  const [adSort, setAdSort] = useState<'recent' | 'oldest' | 'name'>('recent')
  const [loadingAds, setLoadingAds] = useState(false)
  const [showAddAd, setShowAddAd] = useState(false)
  const [newAdSourceId, setNewAdSourceId] = useState('')
  const [newAdName, setNewAdName] = useState('')
  const [validatingAd, setValidatingAd] = useState(false)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [addingAd, setAddingAd] = useState(false)
  const [syncingAdId, setSyncingAdId] = useState<string | null>(null)

  const supabase = createClient()

  const loadCover = useCallback(async (propId: string) => {
    try {
      const res = await fetch(`/api/ai/properties/${propId}/cover`)
      if (res.ok) {
        const data = await res.json()
        setCoverImagePath(data.cover_image_path || null)
      }
    } catch (err) {
      console.error('Failed to load property cover:', err)
    }
  }, [])

  const loadImages = useCallback(async (propId: string) => {
    try {
      const res = await fetch(`/api/ai/properties/${propId}/images`)
      if (res.ok) {
        const data = await res.json()
        setPropertyImages(data.images || [])
      }
    } catch (err) {
      console.error('Failed to load property images:', err)
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
      setCoverImagePath(property.cover_image_path || null)
      loadCover(property.id)
      loadImages(property.id)
      loadAdMappings(property.id)
      setShowAddAd(false)
      setNewAdSourceId('')
      setNewAdName('')
      setValidationResult(null)
    }
  }, [property, loadCover, loadImages, loadAdMappings])

  // When switching to 'midia' tab and back, reload images to keep counts in sync
  useEffect(() => {
    if (property?.id && activeTab === 'geral') {
      loadImages(property.id)
    }
  }, [activeTab, property?.id, loadImages])

  const publicImageUrl = useCallback(
    (storagePath: string) =>
      supabase.storage.from(PROPERTY_MEDIA_BUCKET).getPublicUrl(storagePath).data.publicUrl,
    [supabase],
  )

  const handleUploadCover = async (files: FileList | null) => {
    if (!property || !files || files.length === 0) return
    const file = files[0]
    setUploadingCover(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch(`/api/ai/properties/${property.id}/cover`, {
        method: 'POST',
        body: formData,
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao atualizar foto de capa')
      }

      setCoverImagePath(data.cover_image_path || null)
      toast.success('Foto de capa atualizada com sucesso!')
      onSaved()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao enviar foto de capa')
    } finally {
      setUploadingCover(false)
      if (coverFileInputRef.current) coverFileInputRef.current.value = ''
    }
  }

  const handleDeleteCover = async () => {
    if (!property || !coverImagePath) return
    const ok = window.confirm('Deseja realmente remover a foto de capa deste empreendimento?')
    if (!ok) return

    setDeletingCover(true)
    try {
      const res = await fetch(`/api/ai/properties/${property.id}/cover`, {
        method: 'DELETE',
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao remover foto de capa')
      }

      setCoverImagePath(null)
      toast.success('Foto de capa removida!')
      onSaved()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover foto de capa')
    } finally {
      setDeletingCover(false)
    }
  }

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

  const sortedAdMappings = useMemo(() => {
    const list = [...adMappings]
    if (adSort === 'recent') {
      return list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    }
    if (adSort === 'oldest') {
      return list.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    }
    if (adSort === 'name') {
      return list.sort((a, b) => (a.ad_name || a.ad_source_id).localeCompare(b.ad_name || b.ad_source_id))
    }
    return list
  }, [adMappings, adSort])

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
      const msg = err instanceof Error ? err.message : 'Erro ao desvincular anúncio'
      toast.error(msg)
    }
  }

  const handleSyncAdCreative = async (mappingId: string) => {
    if (!property) return
    setSyncingAdId(mappingId)
    try {
      const res = await fetch(`/api/ai/properties/${property.id}/ads`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping_id: mappingId }),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao sincronizar criativo na Meta')
      }

      toast.success('Criativo sincronizado com sucesso da Meta!')
      loadAdMappings(property.id)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao sincronizar'
      toast.error(msg)
    } finally {
      setSyncingAdId(null)
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
                  {coverImagePath ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={publicImageUrl(coverImagePath)}
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
                      <p className="text-xs font-semibold text-foreground">Nenhuma foto de capa definida</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 max-w-xs">
                        Adicione uma imagem de capa para a identidade visual deste empreendimento no CRM.
                      </p>
                    </div>
                  )}

                  {/* Hidden file input for cover photo */}
                  <input
                    ref={coverFileInputRef}
                    type="file"
                    accept="image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.heic,.heif,.avif"
                    className="hidden"
                    onChange={(e) => handleUploadCover(e.target.files)}
                  />

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
                        <span className="text-[11px] text-white/80 truncate max-w-sm hidden sm:inline">
                          • Identidade visual do CRM (não enviada ao cliente)
                        </span>
                      </div>
                    </div>

                    {/* Cover action buttons */}
                    <div className="flex items-center gap-2 shrink-0">
                      {coverImagePath && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={uploadingCover || deletingCover}
                          onClick={handleDeleteCover}
                          className="h-8 text-xs gap-1.5 bg-black/60 hover:bg-destructive text-white border-white/20 backdrop-blur-xs shadow-sm transition-all"
                        >
                          {deletingCover ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                          <span className="hidden sm:inline">Remover capa</span>
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={uploadingCover || deletingCover}
                        onClick={() => coverFileInputRef.current?.click()}
                        className="h-8 text-xs gap-1.5 bg-black/60 hover:bg-black/80 text-white border-white/20 backdrop-blur-xs shadow-sm transition-all"
                      >
                        {uploadingCover ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Camera className="h-3.5 w-3.5" />
                        )}
                        <span>{coverImagePath ? 'Alterar foto de capa' : 'Adicionar foto de capa'}</span>
                      </Button>
                    </div>
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
                          {mediaCount} <span className="text-sm font-normal text-muted-foreground">/ 5</span>
                        </span>
                        <p className="text-xs font-medium text-foreground mt-0.5">
                          Mídias para envio
                        </p>
                        <p className="text-[10.5px] text-muted-foreground">
                          {mediaCount === 1 ? '1 foto comercial' : `${mediaCount} de 5 fotos cadastradas`}
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
              <div className="space-y-4">
                {/* 1. Header Section */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 border border-primary/20 text-primary shrink-0 mt-0.5">
                      <Megaphone className="h-4.5 w-4.5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground tracking-tight">
                        Anúncios vinculados
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Anúncios da Meta que direcionam leads para este empreendimento.
                      </p>
                    </div>
                  </div>

                  {!showAddAd && (
                    <Button
                      type="button"
                      size="sm"
                      className="h-8.5 px-3.5 gap-1.5 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs shrink-0 self-start sm:self-auto cursor-pointer"
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

                {/* 2. Informative Explanatory Banner */}
                <div className="relative overflow-hidden rounded-xl border border-sky-500/30 bg-gradient-to-r from-sky-500/10 via-sky-500/5 to-transparent p-3.5 sm:p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <Info className="h-4 w-4 text-sky-400 shrink-0 mt-0.5" />
                      <p className="text-xs text-sky-200/90 leading-relaxed font-normal">
                        Quando um lead chega pelo WhatsApp através de um destes anúncios, a Clara identifica automaticamente o empreendimento e já utiliza o conhecimento e as regras configuradas para este imóvel.
                      </p>
                    </div>

                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background/60 border border-border/60 shrink-0 self-start sm:self-auto">
                      <svg className="h-4 w-4 text-[#0081FB] shrink-0" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.477 2 2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.879V14.89h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.989C18.343 21.129 22 16.99 22 12c0-5.523-4.477-10-10-10z" />
                      </svg>
                      <div className="text-[11px] leading-tight">
                        <div className="font-semibold text-foreground">Meta Ads</div>
                        <div className="text-[10px] text-muted-foreground">Click to WhatsApp</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 3. Link Ad Form (Collapsible) */}
                {showAddAd && (
                  <form
                    onSubmit={handleAddAdMapping}
                    className="rounded-xl border border-border bg-card/70 p-4 space-y-3.5 shadow-xs"
                  >
                    <div className="flex items-center justify-between border-b border-border/50 pb-2.5">
                      <div className="flex items-center gap-2">
                        <Plus className="h-4 w-4 text-primary" />
                        <h4 className="text-xs font-semibold text-foreground">
                          Vincular novo anúncio da Meta
                        </h4>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setShowAddAd(false)
                          setValidationResult(null)
                        }}
                      >
                        ✕
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                      <div>
                        <Label className="text-xs font-medium text-foreground">
                          ID do Anúncio (source_id Meta) <span className="text-destructive">*</span>
                        </Label>
                        <Input
                          placeholder="Ex: 120251178888720493"
                          value={newAdSourceId}
                          onChange={(e) => {
                            setNewAdSourceId(e.target.value)
                            setValidationResult(null)
                          }}
                          required
                          className="h-8.5 text-xs mt-1.5 font-mono"
                          autoFocus
                        />
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Copie o ID numérico do anúncio no Gerenciador de Anúncios da Meta.
                        </p>
                      </div>

                      <div>
                        <Label className="text-xs font-medium text-foreground">
                          Nome de Identificação / Campanha (Opcional)
                        </Label>
                        <Input
                          placeholder="Ex: Anúncio Avant"
                          value={newAdName}
                          onChange={(e) => setNewAdName(e.target.value)}
                          className="h-8.5 text-xs mt-1.5"
                        />
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Nome amigável para identificar visualmente o criativo.
                        </p>
                      </div>
                    </div>

                    {validationResult && (
                      <div
                        className={`rounded-xl p-3.5 text-xs space-y-2.5 transition-all border ${
                          validationResult.valid
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                            : 'border-destructive/30 bg-destructive/10 text-destructive'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 font-semibold">
                            {validationResult.valid ? (
                              <>
                                <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                                <span className="text-emerald-300 font-medium">
                                  {validationResult.confirmed
                                    ? 'Anúncio identificado com sucesso'
                                    : 'Formato de ID validado'}
                                </span>
                              </>
                            ) : (
                              <>
                                <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                                <span className="text-destructive font-medium">
                                  Não foi possível validar este anúncio
                                </span>
                              </>
                            )}
                          </div>

                          {validationResult.valid && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full font-mono font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                              {validationResult.source === 'meta_api'
                                ? 'Meta Graph API'
                                : validationResult.source === 'inbound_leads'
                                  ? 'Lead CTWA'
                                  : 'Sintaxe'}
                            </span>
                          )}
                        </div>

                        {validationResult.valid ? (
                          <div className="rounded-lg bg-background/80 border border-emerald-500/20 p-3 space-y-2.5 text-[11px] leading-relaxed">
                            {validationResult.creative_image_url && (
                              <div className="flex items-center gap-3 p-2 rounded-lg bg-background border border-emerald-500/30">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={validationResult.creative_image_url}
                                  alt="Preview do Criativo Meta"
                                  className="h-14 w-14 rounded-md object-cover border border-border shrink-0"
                                  referrerPolicy="no-referrer"
                                />
                                <div className="min-w-0 flex-1 space-y-0.5">
                                  <span className="text-[10px] font-semibold text-emerald-400 block uppercase tracking-wider">
                                    Criativo identificado na Meta
                                  </span>
                                  <span className="text-[11px] font-medium text-foreground truncate block">
                                    {validationResult.ad_name || 'Criativo do Anúncio'}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground truncate block">
                                    {validationResult.campaign_name || 'Campanha Meta Ads'}
                                  </span>
                                </div>
                              </div>
                            )}

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                              <div>
                                <span className="text-muted-foreground font-medium">ID do Anúncio:</span>{' '}
                                <span className="font-mono text-emerald-400 font-semibold">
                                  {validationResult.ad_source_id || newAdSourceId}
                                </span>
                              </div>

                              {(validationResult.ad_name || newAdName.trim()) && (
                                <div>
                                  <span className="text-muted-foreground font-medium">Identificação:</span>{' '}
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
                                  <span className="text-muted-foreground font-medium">Conjunto:</span>{' '}
                                  <span className="text-foreground">{validationResult.adset_name}</span>
                                </div>
                              )}
                            </div>

                            {validationResult.warning && (
                              <p className="text-amber-400 font-medium pt-1.5 border-t border-border/40">
                                ⚠️ {validationResult.warning}
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="text-[11px] text-destructive/90">
                            <p>{validationResult.message}</p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-border/50">
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

                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs gap-1.5 cursor-pointer"
                        onClick={handleValidateAd}
                        disabled={validatingAd || !newAdSourceId.trim()}
                      >
                        {validatingAd ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Conferindo...
                          </>
                        ) : (
                          <>
                            <Search className="h-3.5 w-3.5 text-primary" />
                            Conferir anúncio
                          </>
                        )}
                      </Button>

                      <Button
                        type="submit"
                        size="sm"
                        className="h-8 text-xs gap-1.5 font-medium cursor-pointer"
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

                {/* 4. Controls Bar: Dynamic Count + Ordering */}
                <div className="flex items-center justify-between gap-3 pt-1">
                  <span className="text-xs font-semibold text-foreground">
                    {adMappings.length === 1
                      ? '1 anúncio vinculado'
                      : `${adMappings.length} anúncios vinculados`}
                  </span>

                  {adMappings.length > 1 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground hidden sm:inline">
                        Ordenar por
                      </span>
                      <Select
                        value={adSort}
                        onValueChange={(val) => {
                          if (val === 'recent' || val === 'oldest' || val === 'name') {
                            setAdSort(val)
                          }
                        }}
                      >
                        <SelectTrigger className="h-7.5 w-[130px] text-xs bg-card/60 border-border">
                          <SelectValue placeholder="Ordenar" />
                        </SelectTrigger>
                        <SelectContent align="end">
                          <SelectItem value="recent" className="text-xs">
                            Mais recentes
                          </SelectItem>
                          <SelectItem value="oldest" className="text-xs">
                            Mais antigos
                          </SelectItem>
                          <SelectItem value="name" className="text-xs">
                            Nome
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {/* 5. Main Content: Loading / List / Empty State */}
                {loadingAds ? (
                  <div className="flex flex-col items-center justify-center p-12 text-xs text-muted-foreground space-y-2 rounded-xl border border-border/40 bg-card/30">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    <span>Carregando anúncios vinculados...</span>
                  </div>
                ) : sortedAdMappings.length > 0 ? (
                  <div className="space-y-3.5">
                    {sortedAdMappings.map((ad) => {
                      const formattedDate = ad.created_at
                        ? new Date(ad.created_at).toLocaleDateString('pt-BR', {
                            day: 'numeric',
                            month: 'long',
                            year: 'numeric',
                          })
                        : null
                      const formattedTime = ad.created_at
                        ? new Date(ad.created_at).toLocaleTimeString('pt-BR', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : null

                      return (
                        <div
                          key={ad.id}
                          className="group relative overflow-hidden rounded-2xl border border-border/80 bg-card/80 hover:bg-card hover:border-border transition-all duration-200 shadow-xs"
                        >
                          <div className="flex flex-col md:flex-row items-stretch">
                            {/* Left Column: Real Creative Image or Honest Placeholder */}
                            <div className="relative w-full md:w-[280px] lg:w-[320px] shrink-0 bg-muted/40 aspect-16/10 md:aspect-auto overflow-hidden border-b md:border-b-0 md:border-r border-border/60">
                              {ad.image_url ? (
                                <>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={ad.image_url}
                                    alt={ad.ad_name || 'Criativo do Anúncio Meta'}
                                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-103"
                                    loading="lazy"
                                    referrerPolicy="no-referrer"
                                  />
                                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent opacity-70" />
                                  <div className="absolute top-2.5 left-2.5">
                                    <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium bg-black/70 text-white backdrop-blur-md border border-white/15 shadow-xs">
                                      <ImageIcon className="h-2.5 w-2.5 text-primary" />
                                      {ad.image_origin_label || 'Criativo Meta'}
                                    </span>
                                  </div>
                                </>
                              ) : (
                                <div className="w-full h-full min-h-[160px] flex flex-col items-center justify-center p-6 text-center space-y-2 bg-gradient-to-b from-muted/30 to-muted/60">
                                  <div className="h-10 w-10 rounded-xl bg-background/80 border border-border flex items-center justify-center text-muted-foreground shadow-xs">
                                    <ImageIcon className="h-5 w-5" />
                                  </div>
                                  <span className="text-[11px] font-semibold text-foreground/80">
                                    Criativo indisponível
                                  </span>
                                  <span className="text-[10px] text-muted-foreground max-w-[200px] leading-tight">
                                    Nenhum criativo visual retornado pela Meta para este anúncio.
                                  </span>
                                </div>
                              )}
                            </div>

                            {/* Right Column: Metadata & Intelligent Clara Context */}
                            <div className="flex-1 p-4 sm:p-5 flex flex-col justify-between space-y-4">
                              {/* Card Header: Title, Platform, Verified Badge, Actions */}
                              <div className="flex items-start justify-between gap-3">
                                <div className="space-y-1 min-w-0">
                                  <div className="flex flex-wrap items-center gap-2.5">
                                    <h4 className="text-base font-semibold text-foreground tracking-tight truncate">
                                      {ad.ad_name || `Anúncio ${property.name}`}
                                    </h4>
                                    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                      <CheckCircle2 className="h-3 w-3" />
                                      Vínculo verificado
                                    </span>
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    {ad.platform || 'Meta Ads · Click to WhatsApp'}
                                  </p>
                                </div>

                                {/* Actions Menu */}
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    type="button"
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/80 cursor-pointer shrink-0 transition-colors focus-visible:outline-none"
                                    aria-label="Opções do anúncio"
                                  >
                                    <MoreHorizontal className="h-4 w-4" />
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-52">
                                    <DropdownMenuItem
                                      onClick={() => handleSyncAdCreative(ad.id)}
                                      disabled={syncingAdId === ad.id}
                                      className="text-xs cursor-pointer gap-2"
                                    >
                                      <RefreshCw className={`h-3.5 w-3.5 ${syncingAdId === ad.id ? 'animate-spin text-primary' : ''}`} />
                                      Sincronizar criativo da Meta
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => {
                                        navigator.clipboard.writeText(ad.ad_source_id)
                                        toast.success('ID copiado para a área de transferência!')
                                      }}
                                      className="text-xs cursor-pointer gap-2"
                                    >
                                      <Copy className="h-3.5 w-3.5" />
                                      Copiar ID do Anúncio
                                    </DropdownMenuItem>
                                    {ad.source_url && (
                                      <DropdownMenuItem
                                        onClick={() => window.open(ad.source_url!, '_blank')}
                                        className="text-xs cursor-pointer gap-2"
                                      >
                                        <ExternalLink className="h-3.5 w-3.5" />
                                        Abrir Link do Anúncio
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem
                                      onClick={() => {
                                        const confirmDelete = window.confirm(
                                          `Desvincular o anúncio "${ad.ad_name || ad.ad_source_id}" deste empreendimento?`,
                                        )
                                        if (confirmDelete) {
                                          handleDeleteAdMapping(ad.id)
                                        }
                                      }}
                                      className="text-xs text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer gap-2"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                      Desvincular anúncio
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>

                              {/* Grid of Identifiers: ID, Campanha, Conjunto, Formato */}
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs pt-1 border-t border-border/50">
                                <div>
                                  <span className="text-[11px] text-muted-foreground block mb-0.5">
                                    ID do anúncio
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      navigator.clipboard.writeText(ad.ad_source_id)
                                      toast.success('ID copiado!')
                                    }}
                                    className="group/id inline-flex items-center gap-1 font-mono text-xs font-semibold text-foreground hover:text-primary transition-colors text-left"
                                    title="Clique para copiar"
                                  >
                                    <span className="truncate max-w-[110px] sm:max-w-[130px]">
                                      {ad.ad_source_id}
                                    </span>
                                    <Copy className="h-3 w-3 text-muted-foreground group-hover/id:text-primary shrink-0 opacity-70 group-hover/id:opacity-100" />
                                  </button>
                                </div>

                                <div>
                                  <span className="text-[11px] text-muted-foreground block mb-0.5">
                                    Campanha
                                  </span>
                                  <span className="text-xs font-medium text-foreground truncate block">
                                    {ad.campaign_name || ad.ad_name || `${property.name} - Campanha`}
                                  </span>
                                </div>

                                <div>
                                  <span className="text-[11px] text-muted-foreground block mb-0.5">
                                    Conjunto de anúncios
                                  </span>
                                  <span className="text-xs font-medium text-foreground truncate block">
                                    {ad.adset_name || (ad.headline ? ad.headline : 'Conversões WhatsApp')}
                                  </span>
                                </div>

                                <div>
                                  <span className="text-[11px] text-muted-foreground block mb-0.5">
                                    Formato
                                  </span>
                                  <span className="text-xs font-medium text-foreground block">
                                    {ad.media_type === 'video' || ad.creative_type === 'video'
                                      ? 'Vídeo'
                                      : ad.creative_type === 'carousel'
                                        ? 'Carrossel'
                                        : 'Imagem'}
                                  </span>
                                </div>
                              </div>

                              {/* Two Context Intelligence Cards */}
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {/* Card A: Empreendimento Vinculado */}
                                <div className="rounded-xl border border-border/70 bg-muted/20 p-3 flex items-center gap-3">
                                  <div className="h-8.5 w-8.5 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
                                    <Building2 className="h-4 w-4" />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold block">
                                      Empreendimento vinculado
                                    </span>
                                    <span className="text-xs font-semibold text-foreground truncate block">
                                      {property.name}
                                    </span>
                                  </div>
                                </div>

                                {/* Card B: Contexto da Clara */}
                                <div className="rounded-xl border border-border/70 bg-muted/20 p-3 flex items-center gap-3">
                                  <div className="h-8.5 w-8.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                                    <Bot className="h-4 w-4" />
                                  </div>
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                                        Contexto da Clara
                                      </span>
                                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400">
                                        ● Ativo
                                      </span>
                                    </div>
                                    <span className="text-[11px] text-muted-foreground truncate block">
                                      Leads deste anúncio entram com o contexto do {property.name}.
                                    </span>
                                  </div>
                                </div>
                              </div>

                              {/* Card Footer: Flow Summary & Timestamp */}
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-border/50 text-[11px]">
                                <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
                                  <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                                  <span>
                                    Leads deste anúncio <span className="text-muted-foreground">→</span>{' '}
                                    contexto inicial:{' '}
                                    <strong className="text-foreground font-semibold">
                                      {property.name}
                                    </strong>
                                  </span>
                                </div>

                                {formattedDate && (
                                  <span className="text-muted-foreground text-[10px] sm:text-[11px]">
                                    Vinculado em {formattedDate}
                                    {formattedTime ? ` às ${formattedTime}` : ''}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      )
                    })}

                    {/* 6. Discreet Additional Link Footer Prompt */}
                    <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 p-5 text-center space-y-2">
                      <div className="h-9 w-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mx-auto">
                        <Megaphone className="h-4 w-4" />
                      </div>
                      <h4 className="text-xs font-semibold text-foreground">
                        Vincule mais anúncios
                      </h4>
                      <p className="text-[11px] text-muted-foreground max-w-md mx-auto">
                        As associações adicionais permitem que diferentes campanhas direcionem leads para este mesmo empreendimento com total precisão.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 px-3 text-xs gap-1.5 mt-1 cursor-pointer"
                        onClick={() => {
                          setShowAddAd(true)
                          setValidationResult(null)
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Vincular Anúncio
                      </Button>
                    </div>
                  </div>
                ) : (
                  /* 7. Empty State (When no ads mapped yet) */
                  !showAddAd && (
                    <div className="rounded-2xl border border-dashed border-border bg-card/30 p-8 sm:p-12 text-center space-y-3">
                      <div className="h-12 w-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mx-auto shadow-xs">
                        <Megaphone className="h-6 w-6" />
                      </div>
                      <div className="space-y-1">
                        <h4 className="text-sm font-semibold text-foreground">
                          Você ainda não possui anúncios vinculados.
                        </h4>
                        <p className="text-xs text-muted-foreground max-w-md mx-auto">
                          Vincule anúncios da Meta para que a Clara identifique automaticamente o empreendimento de origem dos leads.
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="h-8.5 px-4 text-xs gap-1.5 font-medium cursor-pointer mt-2 shadow-xs"
                        onClick={() => {
                          setShowAddAd(true)
                          setValidationResult(null)
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Vincular Anúncio
                      </Button>
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
    </Dialog>
  )
}
