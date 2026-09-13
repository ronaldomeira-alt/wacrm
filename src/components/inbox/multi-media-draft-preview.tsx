"use client";

import { useMemo } from "react";
import { X, Check, Loader2, AlertCircle, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StagedMediaItem } from "@/lib/media/batch-upload-pool";
import { isHeicFile } from "@/lib/media/image-compat";
import { forensic } from "@/lib/media/forensic-tracer";

interface MultiMediaDraftPreviewProps {
  items: StagedMediaItem[];
  onRemoveItem: (id: string) => void;
  onRetryItem: (id: string) => void;
  onDiscardAll: () => void;
  disabled?: boolean;
}

export function MultiMediaDraftPreview({
  items,
  onRemoveItem,
  onRetryItem,
  onDiscardAll,
  disabled,
}: MultiMediaDraftPreviewProps) {
  const counts = useMemo(() => {
    let uploaded = 0;
    let uploading = 0;
    let processing = 0;
    let failed = 0;
    for (const item of items) {
      if (item.status === "uploaded") uploaded++;
      else if (item.status === "uploading") uploading++;
      else if (item.status === "processing") processing++;
      else if (item.status === "failed") failed++;
    }
    return { uploaded, uploading, processing, failed, total: items.length };
  }, [items]);

  return (
    <div className="mb-2 rounded-xl border border-border bg-muted/50 p-2.5 shadow-sm transition-all duration-200">
      {/* Header bar */}
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <ImageIcon className="h-3.5 w-3.5 text-primary" />
          <span>
            {items.length === 1
              ? "1 foto selecionada"
              : `${items.length} fotos selecionadas`}
          </span>

          {counts.uploading > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground font-normal">
              <Loader2 className="h-3 w-3 animate-spin text-primary" />
              <span>{`Enviando ${counts.uploaded}/${items.length}...`}</span>
            </span>
          )}

          {counts.uploading === 0 && counts.processing > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground font-normal">
              <Loader2 className="h-3 w-3 animate-spin text-primary" />
              <span>{`Processando ${counts.uploaded}/${items.length}...`}</span>
            </span>
          )}

          {counts.uploading === 0 && counts.processing === 0 && counts.uploaded === items.length && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
              <Check className="h-3 w-3 stroke-[2.5]" />
              <span>Prontas para envio</span>
            </span>
          )}

          {counts.failed > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-destructive font-medium">
              <AlertCircle className="h-3 w-3" />
              <span>{`${counts.failed} com falha (toque para tentar)`}</span>
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={onDiscardAll}
          disabled={disabled}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
          title="Descartar lote"
          aria-label="Descartar lote de fotos"
        >
          <X className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Descartar</span>
        </button>
      </div>

      {/* Horizontal thumbnail scroll track */}
      <div
        className="flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:thin] [-webkit-overflow-scrolling:touch]"
        style={{ WebkitTouchCallout: "none" }}
      >
        {items.map((item, index) => (
          <div
            key={item.id}
            className={cn(
              "group relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border bg-background transition-transform",
              item.status === "failed" && "border-destructive/50 ring-1 ring-destructive/30"
            )}
          >
            <div className="absolute inset-0 flex items-center justify-center bg-muted text-muted-foreground">
              <ImageIcon className="h-6 w-6 opacity-40" />
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={item.previewUrl}
              src={item.previewUrl}
              alt={item.filename}
              draggable={false}
              className="relative z-0 h-full w-full object-cover select-none transition-opacity duration-200"
              onError={(e) => {
                forensic.log(13, "evento error", "fail", {
                  index: index + 1,
                  filename: item.filename,
                  previewUrl: item.previewUrl,
                  status: item.status,
                });
                e.currentTarget.style.opacity = "0";
              }}
              onLoad={(e) => {
                forensic.log(12, "evento load", "ok", {
                  index: index + 1,
                  filename: item.filename,
                  previewUrl: item.previewUrl,
                  status: item.status,
                });
                e.currentTarget.style.opacity = "1";
              }}
            />

            {/* Position badge */}
            <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.2 text-[9px] font-mono text-white">
              {index + 1}
            </span>

            {/* HEIC badge */}
            {isHeicFile(item.file) && (
              <span className="pointer-events-none absolute top-1 left-1 rounded bg-black/60 px-1 py-0.2 text-[8px] font-semibold text-white/90">
                HEIC
              </span>
            )}

            {/* Remove button */}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRemoveItem(item.id)}
              className="absolute right-1 top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-black/65 text-white transition-colors hover:bg-destructive active:scale-90"
              title="Remover foto"
              aria-label={`Remover foto ${index + 1}`}
            >
              <X className="h-2.5 w-2.5 stroke-[2.5]" />
            </button>

            {/* Uploading spinner overlay */}
            {item.status === "uploading" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-[1px]">
                <Loader2 className="h-4 w-4 animate-spin text-white" />
              </div>
            )}

            {/* Processing spinner overlay */}
            {item.status === "processing" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/45 backdrop-blur-[1px]">
                <Loader2 className="h-4 w-4 animate-spin text-white" />
                <span className="mt-0.5 text-[8px] font-medium text-white/90">Processando</span>
              </div>
            )}

            {/* Uploaded checkmark badge */}
            {item.status === "uploaded" && (
              <div className="absolute bottom-1 right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-600 text-white shadow">
                <Check className="h-2 w-2 stroke-[3]" />
              </div>
            )}

            {/* Failed retry button overlay */}
            {item.status === "failed" && (
              <button
                type="button"
                onClick={() => onRetryItem(item.id)}
                className="absolute inset-0 flex flex-col items-center justify-center bg-destructive/70 text-white transition-opacity hover:opacity-90"
                title={`Falha: ${item.error || "Toque para tentar novamente"}`}
              >
                <AlertCircle className="h-4 w-4" />
                <span className="text-[8px] font-bold uppercase tracking-wider">Retry</span>
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
