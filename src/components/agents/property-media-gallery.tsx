'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Check,
  Edit2,
  ImageIcon,
  Loader2,
  Plus,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'
import {
  PROPERTY_MEDIA_BUCKET,
  PROPERTY_MEDIA_MAX_BYTES,
} from '@/lib/storage/upload-media'
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

function isSupportedFile(file: File): boolean {
  if (file.type && file.type.startsWith('image/')) return true
  const ext = file.name.split('.').pop()?.toLowerCase()
  return Boolean(ext && ALLOWED_EXTENSIONS.has(ext))
}

export function PropertyMediaGallery({ propertyId, disabled }: PropertyMediaGalleryProps) {
  const [images, setImages] = useState<PropertyImage[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingDescId, setEditingDescId] = useState<string | null>(null)
  const [editingDescText, setEditingDescText] = useState('')
  const [savingDescId, setSavingDescId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
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
            ? '1 foto adicionada e otimizada com sucesso!'
            : `${uploadedCount} fotos adicionadas e otimizadas com sucesso!`,
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

  const handleSetCover = async (imageId: string) => {
    setBusyId(imageId)
    try {
      const res = await fetch(`/api/ai/properties/${propertyId}/images/${imageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_cover: true }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Falha ao definir capa')
      }
      toast.success('Foto definida como capa do empreendimento')
      await load()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao definir capa')
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (imageId: string, fileName: string) => {
    const ok = window.confirm(`Remover "${fileName}" da galeria deste empreendimento?`)
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
      toast.success('Mídia removida com sucesso')
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
      toast.success('Descrição atualizada com sucesso')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar descrição')
    } finally {
      setSavingDescId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Mídias do Empreendimento</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Cadastre fotos com descrições individuais. A IA Clara utilizará essas descrições para enviar fotos pontuais quando o cliente solicitar.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 text-xs gap-1.5 shrink-0"
          disabled={disabled || uploading}
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
              <span>Adicionar fotos</span>
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
      ) : images.length === 0 ? (
        <button
          type="button"
          onClick={() => !disabled && fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className="w-full rounded-lg border border-dashed border-border bg-background/50 p-8 text-center space-y-2 hover:bg-muted/40 transition-colors"
        >
          <ImageIcon className="h-7 w-7 mx-auto text-muted-foreground" />
          <p className="text-xs font-medium text-foreground">Nenhuma mídia cadastrada ainda</p>
          <p className="text-[11px] text-muted-foreground max-w-sm mx-auto">
            Selecione uma ou mais fotos (JPG, PNG, WEBP, GIF, BMP, TIFF, HEIC, HEIF, AVIF até 16 MB). Todas serão otimizadas automaticamente para envio instantâneo pelo WhatsApp.
          </p>
        </button>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="font-mono">{images.length} mídia(s) cadastrada(s)</span>
            <span>Selecione várias fotos para upload em lote</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {images.map((img) => {
              const isEditingThisDesc = editingDescId === img.id
              const isSavingThisDesc = savingDescId === img.id

              return (
                <div
                  key={img.id}
                  className="group flex flex-col rounded-lg border border-border bg-card overflow-hidden shadow-xs transition-shadow hover:shadow-sm"
                >
                  {/* Photo Container */}
                  <div className="relative aspect-4/3 w-full overflow-hidden bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={publicUrl(img.storage_path)}
                      alt={img.description || img.file_name}
                      className="h-full w-full object-cover transition-transform group-hover:scale-105 duration-200"
                      loading="lazy"
                    />

                    {/* Cover badge */}
                    {img.is_cover && (
                      <span className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[9.5px] font-semibold text-primary-foreground shadow-xs">
                        <Star className="h-2.5 w-2.5 fill-current" />
                        Capa
                      </span>
                    )}

                    {/* Action Overlay */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100" />
                    <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      {!img.is_cover && (
                        <button
                          type="button"
                          title="Definir como capa"
                          disabled={disabled || busyId === img.id}
                          onClick={() => handleSetCover(img.id)}
                          className="h-6.5 w-6.5 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors"
                        >
                          <Star className="h-3 w-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        title="Remover mídia"
                        disabled={disabled || busyId === img.id}
                        onClick={() => handleDelete(img.id, img.file_name)}
                        className="h-6.5 w-6.5 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-destructive transition-colors"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>

                    <p className="absolute bottom-1 left-1.5 right-1.5 truncate text-[9px] font-medium text-white/90 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      {img.file_name}
                    </p>
                  </div>

                  {/* Description Box */}
                  <div className="p-2 flex flex-col flex-1 justify-between bg-card text-[11px] gap-1.5 border-t border-border/50">
                    {isEditingThisDesc ? (
                      <div className="space-y-1.5">
                        <Input
                          value={editingDescText}
                          onChange={(e) => setEditingDescText(e.target.value)}
                          placeholder="Ex: Piscina e área de lazer"
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
                            {isSavingThisDesc ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Check className="h-3 w-3" />
                            )}
                            Salvar
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div
                        onClick={() => !disabled && startEditDescription(img)}
                        className="group/desc cursor-pointer rounded px-1.5 py-1 hover:bg-muted/60 transition-colors min-h-[32px] flex items-start justify-between gap-1"
                        title="Clique para editar a descrição desta foto"
                      >
                        {img.description ? (
                          <p className="line-clamp-2 text-[11px] text-foreground font-normal leading-tight">
                            {img.description}
                          </p>
                        ) : (
                          <p className="text-[10.5px] text-muted-foreground/70 italic flex items-center gap-1">
                            Adicionar descrição...
                          </p>
                        )}
                        <Edit2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground opacity-0 group-hover/desc:opacity-100 transition-opacity mt-0.5" />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            {/* Upload more card tile */}
            <button
              type="button"
              onClick={() => !disabled && fileInputRef.current?.click()}
              disabled={disabled || uploading}
              className="aspect-4/3 rounded-lg border border-dashed border-border flex flex-col items-center justify-center gap-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              <span className="text-[10px] font-medium">Adicionar fotos</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
