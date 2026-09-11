'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ImageIcon, Loader2, Plus, Star, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import {
  PROPERTY_MEDIA_BUCKET,
  PROPERTY_MEDIA_MAX_BYTES,
  buildMediaPath,
  resolveAccountId,
} from '@/lib/storage/upload-media'
import type { PropertyImage } from '@/types'

interface PropertyMediaGalleryProps {
  propertyId: string
  disabled?: boolean
}

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

export function PropertyMediaGallery({ propertyId, disabled }: PropertyMediaGalleryProps) {
  const [images, setImages] = useState<PropertyImage[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
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

    setUploading(true)
    try {
      const accountId = await resolveAccountId()
      for (const file of Array.from(files)) {
        if (!ALLOWED_TYPES.includes(file.type)) {
          toast.error(`"${file.name}" não é PNG, JPEG ou WEBP.`)
          continue
        }
        if (file.size > PROPERTY_MEDIA_MAX_BYTES) {
          toast.error(`"${file.name}" passa de 8 MB.`)
          continue
        }

        const path = buildMediaPath(accountId, file.name)
        const { error: upErr } = await supabase.storage
          .from(PROPERTY_MEDIA_BUCKET)
          .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type })
        if (upErr) {
          toast.error(`Falha ao enviar "${file.name}": ${upErr.message}`)
          continue
        }

        const res = await fetch(`/api/ai/properties/${propertyId}/images`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storage_path: path,
            file_name: file.name,
            file_size: file.size,
            content_type: file.type,
          }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          toast.error(data.error || `Falha ao salvar "${file.name}"`)
        }
      }
      await load()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao enviar mídia'
      toast.error(msg)
    } finally {
      setUploading(false)
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
      await load()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover imagem')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Mídia do Empreendimento</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            A capa aparece para a IA e no card do imóvel na lista.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 text-xs gap-1.5 shrink-0"
          disabled={disabled || uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Adicionar mídia
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_TYPES.join(',')}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          Carregando mídia...
        </div>
      ) : images.length === 0 ? (
        <button
          type="button"
          onClick={() => !disabled && fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className="w-full rounded-lg border border-dashed border-border bg-background/50 p-8 text-center space-y-2 hover:bg-muted/40 transition-colors"
        >
          <ImageIcon className="h-6 w-6 mx-auto text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            Nenhuma mídia ainda. Clique para enviar fotos ou plantas (PNG, JPEG ou WEBP, até 8&nbsp;MB cada).
          </p>
        </button>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground font-mono">{images.length} arquivo(s)</p>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2.5">
            {images.map((img) => (
              <div
                key={img.id}
                className="group relative aspect-square rounded-lg border border-border overflow-hidden bg-muted"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={publicUrl(img.storage_path)}
                  alt={img.file_name}
                  className="h-full w-full object-cover"
                />
                {img.is_cover && (
                  <span className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[9.5px] font-semibold text-primary-foreground">
                    <Star className="h-2.5 w-2.5 fill-current" />
                    Capa
                  </span>
                )}
                {/* `[@media(hover:none)]:opacity-100` keeps these controls permanently
                    visible on touch devices (iPhone Safari included) — `group-hover`
                    alone would never reveal them there, since touch has no hover
                    state to trigger it. Devices with a mouse/trackpad still get the
                    reveal-on-hover treatment. */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100" />
                <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                  {!img.is_cover && (
                    <button
                      type="button"
                      title="Definir como capa"
                      disabled={disabled || busyId === img.id}
                      onClick={() => handleSetCover(img.id)}
                      className="h-7 w-7 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"
                    >
                      <Star className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    title="Remover"
                    disabled={disabled || busyId === img.id}
                    onClick={() => handleDelete(img.id, img.file_name)}
                    className="h-7 w-7 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="absolute bottom-1 left-1.5 right-1.5 truncate text-[9px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                  {img.file_name}
                </p>
              </div>
            ))}
            <button
              type="button"
              onClick={() => !disabled && fileInputRef.current?.click()}
              disabled={disabled || uploading}
              className="aspect-square rounded-lg border border-dashed border-border flex flex-col items-center justify-center gap-1.5 text-muted-foreground hover:bg-muted/40 transition-colors"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              <span className="text-[10px] font-medium">Enviar</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}
