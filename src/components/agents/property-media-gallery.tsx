'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Check,
  Edit2,
  ImageIcon,
  Loader2,
  Plus,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'
import {
  PROPERTY_MEDIA_BUCKET,
  PROPERTY_MEDIA_MAX_BYTES,
} from '@/lib/storage/upload-media'
import { isVideoFile, preparePropertyVideo } from '@/lib/media/prepare-property-video'
import type { PropertyImage } from '@/types'

interface PropertyMediaGalleryProps {
  propertyId: string
  disabled?: boolean
}

// Supported input formats (JPEG, PNG, WEBP, GIF, BMP, TIFF, HEIC, HEIF, AVIF)
const ACCEPT_FILE_TYPES = 'image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.heic,.heif,.avif'

const ALLOWED_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
  'avif',
])

// Broad input accept — whatever format the user has (MOV/HEVC from an
// iPhone included), the client normalizes it via preparePropertyVideo()
// (reusing the existing transcode-mov-webcodecs.ts infra) before upload.
const ACCEPT_VIDEO_TYPES = 'video/*,.mp4,.mov,.m4v,.3gp,.3gpp,.mkv,.avi,.webm'

function isSupportedFile(file: File): boolean {
  if (file.type && file.type.startsWith('image/')) return true
  const ext = file.name.split('.').pop()?.toLowerCase()
  return Boolean(ext && ALLOWED_EXTENSIONS.has(ext))
}

/** Tells a photo row from a video row using the same `content_type` column — no separate media_type field. */
function isVideoMedia(img: Pick<PropertyImage, 'content_type'>): boolean {
  return Boolean(img.content_type && img.content_type.toLowerCase().startsWith('video/'))
}

export function PropertyMediaGallery({ propertyId, disabled }: PropertyMediaGalleryProps) {
  const [images, setImages] = useState<PropertyImage[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null)
  const [videoUploading, setVideoUploading] = useState(false)
  const [videoStatus, setVideoStatus] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingDescId, setEditingDescId] = useState<string | null>(null)
  const [editingDescText, setEditingDescText] = useState('')
  const [savingDescId, setSavingDescId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/ai/properties/${propertyId}/images`)
      const data = await res.json().catch(() => ({}))
      if (res.ok) setImages(data.images || [])
    } catch (err) {
      console.error('Failed to load property images:', err)
    } finally {
      setLoading(false)
    }
  }, [propertyId])

  useEffect(() => {
    load()
  }, [load])

  // Same GET/list endpoint already returns both kinds (is_cover=false);
  // split client-side so the two galleries below render/limit independently
  // without a second fetch or a new table.
  const photos = useMemo(() => images.filter((img) => !isVideoMedia(img)), [images])
  const videoItems = useMemo(() => images.filter((img) => isVideoMedia(img)), [images])

  const publicUrl = (storagePath: string) =>
    supabase.storage.from(PROPERTY_MEDIA_BUCKET).getPublicUrl(storagePath).data.publicUrl

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return

    const fileList = Array.from(files)
    setUploading(true)
    setUploadProgress({ current: 0, total: fileList.length })

    try {
      let uploadedCount = 0

      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i]
        setUploadProgress({ current: i + 1, total: fileList.length })

        if (!isSupportedFile(file)) {
          toast.error(`"${file.name}" não é um formato de imagem suportado (JPG, PNG, WEBP, GIF, BMP, TIFF, HEIC, HEIF, AVIF).`)
          continue
        }

        if (file.size > PROPERTY_MEDIA_MAX_BYTES) {
          toast.error(`"${file.name}" ultrapassa o limite de 16 MB.`)
          continue
        }

        // Send via FormData to server API for normalization (EXIF rotation, conversion, compression <=5MB)
        const formData = new FormData()
        formData.append('file', file)

        const res = await fetch(`/api/ai/properties/${propertyId}/images`, {
          method: 'POST',
          body: formData,
        })

        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          toast.error(data.error || `Falha ao processar "${file.name}"`)
        } else {
          uploadedCount++
        }
      }

      if (uploadedCount > 0) {
        toast.success(
          uploadedCount === 1
            ? '1 foto comercial adicionada com sucesso!'
            : `${uploadedCount} fotos comerciais adicionadas com sucesso!`,
        )
      }
      await load()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao enviar mídia'
      toast.error(msg)
    } finally {
      setUploading(false)
      setUploadProgress(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // Mirrors handleFiles above, but for the video slot: each file goes
  // through preparePropertyVideo() first (transcodes ONLY if needed,
  // reusing the existing transcode-mov-webcodecs.ts infra — no new
  // transcoder), and only the resulting already-compatible/normalized
  // file is uploaded, one at a time (so "Preparando vídeo..." reflects
  // the file actually being converted).
  const handleVideoFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return

    const fileList = Array.from(files)
    setVideoUploading(true)

    try {
      let uploadedCount = 0

      for (const file of fileList) {
        if (!isVideoFile(file)) {
          toast.error(`"${file.name}" não é um formato de vídeo suportado.`)
          continue
        }

        let prepared: File
        try {
          setVideoStatus('Preparando vídeo...')
          prepared = await preparePropertyVideo(file)
        } catch (err) {
          toast.error(err instanceof Error ? err.message : `Não foi possível preparar "${file.name}".`)
          continue
        }

        setVideoStatus('Enviando vídeo...')
        const formData = new FormData()
        formData.append('file', prepared)

        const res = await fetch(`/api/ai/properties/${propertyId}/images`, {
          method: 'POST',
          body: formData,
        })

        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          toast.error(data.error || `Falha ao processar "${file.name}"`)
        } else {
          uploadedCount++
        }
      }

      if (uploadedCount > 0) {
        toast.success(
          uploadedCount === 1 ? 'Vídeo adicionado com sucesso!' : `${uploadedCount} vídeos adicionados com sucesso!`,
        )
      }
      await load()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao enviar vídeo'
      toast.error(msg)
    } finally {
      setVideoUploading(false)
      setVideoStatus(null)
      if (videoInputRef.current) videoInputRef.current.value = ''
    }
  }

  const handleDelete = async (imageId: string, fileName: string) => {
    const ok = window.confirm(`Remover "${fileName}" da galeria de mídias deste empreendimento?`)
    if (!ok) return

    setBusyId(imageId)
    try {
      const res = await fetch(`/api/ai/properties/${propertyId}/images/${imageId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Falha ao remover imagem')
      }
      toast.success('Mídia comercial removida')
      await load()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover imagem')
    } finally {
      setBusyId(null)
    }
  }

  const startEditDescription = (img: PropertyImage) => {
    setEditingDescId(img.id)
    setEditingDescText(img.description || '')
  }

  const cancelEditDescription = () => {
    setEditingDescId(null)
    setEditingDescText('')
  }

  const handleSaveDescription = async (imageId: string) => {
    setSavingDescId(imageId)
    try {
      const newDesc = editingDescText.trim() || null
      const res = await fetch(`/api/ai/properties/${propertyId}/images/${imageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: newDesc }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Falha ao salvar descrição')
      }

      setImages((prev) =>
        prev.map((img) => (img.id === imageId ? { ...img, description: newDesc } : img)),
      )
      setEditingDescId(null)
      toast.success('Descrição salva')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar descrição')
    } finally {
      setSavingDescId(null)
    }
  }

  const isAtPhotoLimit = photos.length >= 5
  const isAtVideoLimit = videoItems.length >= 5

  const renderDescriptionBox = (img: PropertyImage, placeholder: string) => {
    const isEditingThisDesc = editingDescId === img.id
    const isSavingThisDesc = savingDescId === img.id

    return (
      <div className="p-2 flex flex-col flex-1 justify-between bg-card text-[11px] gap-1.5 border-t border-border/50">
        {isEditingThisDesc ? (
          <div className="space-y-1.5">
            <Input
              value={editingDescText}
              onChange={(e) => setEditingDescText(e.target.value)}
              placeholder={placeholder}
              disabled={isSavingThisDesc}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleSaveDescription(img.id)
                } else if (e.key === 'Escape') {
                  cancelEditDescription()
                }
              }}
              className="h-7 text-[11px] px-2 py-0"
            />
            <div className="flex items-center justify-end gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isSavingThisDesc}
                onClick={cancelEditDescription}
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={isSavingThisDesc}
                onClick={() => handleSaveDescription(img.id)}
                className="h-6 px-2 text-[10px] gap-1"
              >
                {isSavingThisDesc ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Salvar
              </Button>
            </div>
          </div>
        ) : (
          <div
            onClick={() => !disabled && startEditDescription(img)}
            className="group/desc cursor-pointer rounded px-1.5 py-1 hover:bg-muted/60 transition-colors min-h-[32px] flex items-start justify-between gap-1"
            title="Clique para editar a descrição"
          >
            {img.description ? (
              <p className="line-clamp-2 text-[11px] text-foreground font-normal leading-tight">{img.description}</p>
            ) : (
              <p className="text-[10.5px] text-muted-foreground/70 italic flex items-center gap-1">
                Adicionar descrição...
              </p>
            )}
            <Edit2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground opacity-0 group-hover/desc:opacity-100 transition-opacity mt-0.5" />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ============================= FOTOS ============================= */}
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-foreground">
              Fotos Comerciais para Envio pela Clara (até 5)
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Cadastre fotos com descrições individuais. A Clara utilizará exclusivamente estas fotos para enviar aos clientes quando solicitado. A foto de capa não é incluída nesta biblioteca.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs gap-1.5 shrink-0"
            disabled={disabled || uploading || isAtPhotoLimit}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>
                  {uploadProgress
                    ? `Processando ${uploadProgress.current}/${uploadProgress.total}...`
                    : 'Processando...'}
                </span>
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" />
                <span>{isAtPhotoLimit ? 'Limite atingido (5/5)' : 'Adicionar fotos'}</span>
              </>
            )}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_FILE_TYPES}
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Carregando mídias...
          </div>
        ) : photos.length === 0 ? (
          <button
            type="button"
            onClick={() => !disabled && fileInputRef.current?.click()}
            disabled={disabled || uploading}
            className="w-full rounded-lg border border-dashed border-border bg-background/50 p-8 text-center space-y-2 hover:bg-muted/40 transition-colors cursor-pointer"
          >
            <ImageIcon className="h-7 w-7 mx-auto text-muted-foreground" />
            <p className="text-xs font-medium text-foreground">Nenhuma foto comercial cadastrada ainda</p>
            <p className="text-[11px] text-muted-foreground max-w-sm mx-auto">
              Adicione até 5 fotos comerciais (JPG, PNG, WEBP, GIF, BMP, TIFF, HEIC, HEIF, AVIF). A Clara poderá enviar estas fotos nas conversas com clientes.
            </p>
          </button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="font-mono font-medium text-foreground">
                {photos.length} / 5 fotos comerciais cadastradas
              </span>
              <span>
                {isAtPhotoLimit
                  ? 'Limite máximo de 5 fotos atingido'
                  : `Você pode adicionar mais ${5 - photos.length} foto(s)`}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {photos.map((img) => (
                <div
                  key={img.id}
                  className="group flex flex-col rounded-lg border border-border bg-card overflow-hidden shadow-xs transition-shadow hover:shadow-sm"
                >
                  <div className="relative aspect-4/3 w-full overflow-hidden bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={publicUrl(img.storage_path)}
                      alt={img.description || img.file_name}
                      className="h-full w-full object-cover transition-transform group-hover:scale-105 duration-200"
                      loading="lazy"
                    />

                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100" />
                    <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      <button
                        type="button"
                        title="Remover mídia"
                        disabled={disabled || busyId === img.id}
                        onClick={() => handleDelete(img.id, img.file_name)}
                        className="h-6.5 w-6.5 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-destructive transition-colors cursor-pointer"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>

                    <p className="absolute bottom-1 left-1.5 right-1.5 truncate text-[9px] font-medium text-white/90 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      {img.file_name}
                    </p>
                  </div>

                  {renderDescriptionBox(img, 'Ex: Piscina e área de lazer')}
                </div>
              ))}

              {!isAtPhotoLimit && (
                <button
                  type="button"
                  onClick={() => !disabled && fileInputRef.current?.click()}
                  disabled={disabled || uploading}
                  className="aspect-4/3 rounded-lg border border-dashed border-border flex flex-col items-center justify-center gap-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors cursor-pointer"
                >
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  <span className="text-[10px] font-medium">Adicionar foto</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ============================= VÍDEOS ============================= */}
      <div className="space-y-4 border-t border-border/60 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-foreground">
              Vídeos Comerciais para Envio pela Clara (até 5)
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Cadastre vídeos curtos (ex: área de lazer, fachada). O arquivo é convertido e comprimido automaticamente para o padrão do WhatsApp (MP4, até 16 MB) antes de ser salvo — a Clara envia esse arquivo pronto, sem converter de novo a cada atendimento.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs gap-1.5 shrink-0"
            disabled={disabled || videoUploading || isAtVideoLimit}
            onClick={() => videoInputRef.current?.click()}
          >
            {videoUploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>{videoStatus || 'Processando...'}</span>
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" />
                <span>{isAtVideoLimit ? 'Limite atingido (5/5)' : 'Adicionar vídeo'}</span>
              </>
            )}
          </Button>
          <input
            ref={videoInputRef}
            type="file"
            accept={ACCEPT_VIDEO_TYPES}
            className="hidden"
            onChange={(e) => handleVideoFiles(e.target.files)}
          />
        </div>

        {loading ? null : videoItems.length === 0 ? (
          <button
            type="button"
            onClick={() => !disabled && videoInputRef.current?.click()}
            disabled={disabled || videoUploading}
            className="w-full rounded-lg border border-dashed border-border bg-background/50 p-8 text-center space-y-2 hover:bg-muted/40 transition-colors cursor-pointer"
          >
            <Video className="h-7 w-7 mx-auto text-muted-foreground" />
            <p className="text-xs font-medium text-foreground">Nenhum vídeo comercial cadastrado ainda</p>
            <p className="text-[11px] text-muted-foreground max-w-sm mx-auto">
              Adicione até 5 vídeos (qualquer formato do celular ou PC — MOV/HEVC do iPhone é convertido automaticamente). A Clara poderá enviar estes vídeos nas conversas com clientes.
            </p>
          </button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="font-mono font-medium text-foreground">
                {videoItems.length} / 5 vídeos comerciais cadastrados
              </span>
              <span>
                {isAtVideoLimit
                  ? 'Limite máximo de 5 vídeos atingido'
                  : `Você pode adicionar mais ${5 - videoItems.length} vídeo(s)`}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {videoItems.map((img) => (
                <div
                  key={img.id}
                  className="group flex flex-col rounded-lg border border-border bg-card overflow-hidden shadow-xs transition-shadow hover:shadow-sm"
                >
                  <div className="relative aspect-4/3 w-full overflow-hidden bg-muted">
                    <video
                      src={publicUrl(img.storage_path)}
                      className="h-full w-full object-cover"
                      muted
                      playsInline
                      preload="metadata"
                      controls
                    />

                    <div className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[9px] font-medium text-white pointer-events-none">
                      <Video className="h-2.5 w-2.5" />
                      Vídeo
                    </div>

                    <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      <button
                        type="button"
                        title="Remover vídeo"
                        disabled={disabled || busyId === img.id}
                        onClick={() => handleDelete(img.id, img.file_name)}
                        className="h-6.5 w-6.5 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-destructive transition-colors cursor-pointer"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>

                  {renderDescriptionBox(img, 'Ex: Vídeo da área de lazer')}
                </div>
              ))}

              {!isAtVideoLimit && (
                <button
                  type="button"
                  onClick={() => !disabled && videoInputRef.current?.click()}
                  disabled={disabled || videoUploading}
                  className="aspect-4/3 rounded-lg border border-dashed border-border flex flex-col items-center justify-center gap-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors cursor-pointer"
                >
                  {videoUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  <span className="text-[10px] font-medium">Adicionar vídeo</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
