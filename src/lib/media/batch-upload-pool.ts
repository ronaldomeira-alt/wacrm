import { isHeicFile, normalizeImageForUpload } from "@/lib/media/image-compat";
import { presignAndUpload, resolveClientFileMime } from "@/lib/storage/upload-media-r2";
import {
  MEDIA_MAX_BYTES,
  ALLOWED_MIME_TYPES_BY_KIND,
} from "@/lib/storage/upload-media";
import {
  seedMediaResolution,
  registerLocalMediaBlob,
  revokeLocalMediaBlobImmediately,
} from "@/lib/inbox/use-resolved-media-src";
import { forensic } from "@/lib/media/forensic-tracer";

export type StagedItemStatus = "selected" | "uploading" | "processing" | "uploaded" | "failed";

export interface StagedMediaItem {
  id: string;
  file: File;
  previewUrl: string;
  localBlobUrl?: string;
  kind: "image";
  filename: string;
  size: number;
  status: StagedItemStatus;
  key?: string;
  originalKey?: string;
  error?: string;
  caption: string;
  order: number;
}

function createInitialPreviewUrl(file: File): string {
  forensic.log(9, "criação do preview", "info", {
    name: file.name,
    type: file.type,
    isHeic: isHeicFile(file),
  });
  let url = "";
  try {
    if (isHeicFile(file) && (!file.type || file.type === "application/octet-stream")) {
      const typedBlob = new Blob([file], { type: "image/heic" });
      url = URL.createObjectURL(typedBlob);
    } else {
      url = URL.createObjectURL(file);
    }
    forensic.log(10, "URL.createObjectURL", "ok", { name: file.name, previewUrl: url });
  } catch (err) {
    url = "";
    forensic.log(10, "URL.createObjectURL", "fail", {
      name: file.name,
      error: String(err),
    });
  }
  return url;
}

export function createStagedMediaItems(files: File[]): StagedMediaItem[] {
  const timestamp = Date.now();
  const items = files.map((file, index) => {
    const initialUrl = createInitialPreviewUrl(file);
    return {
      id: `stage-${timestamp}-${Math.random().toString(36).slice(2, 8)}-${index}`,
      file,
      previewUrl: initialUrl,
      localBlobUrl: initialUrl,
      kind: "image" as const,
      filename: file.name,
      size: file.size,
      status: "selected" as const,
      caption: "",
      order: index,
    };
  });

  forensic.log(14, "criação do staging item", "ok", {
    totalItems: items.length,
    items: items.map((it) => ({ id: it.id, name: it.filename, size: it.size })),
  });

  return items;
}

export interface BatchUploadPoolOptions {
  maxConcurrency?: number;
  onItemUpdate: (id: string, updates: Partial<StagedMediaItem>) => void;
  onAllComplete?: () => void;
}

export interface BatchUploadPoolController {
  cancel: () => void;
  retryItem: (id: string) => void;
  removeItem: (id: string) => void;
}

export interface NormalizationStatusResult {
  normalizedKey: string;
  resolvedUrl?: string;
}

export async function pollNormalizationStatus(
  key: string,
  signal?: AbortSignal,
): Promise<NormalizationStatusResult> {
  const maxAttempts = 170; // ~60s max (1x 250ms + 169x 350ms)
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new Error("Upload cancelado.");
    await new Promise((r) => setTimeout(r, i === 0 ? 250 : 350));
    if (signal?.aborted) throw new Error("Upload cancelado.");

    try {
      const res = await fetch("/api/media/process-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: [key] }),
        signal,
      });
      if (res.ok) {
        const data = await res.json();
        const info = data?.statuses?.[key];
        if (info) {
          if (info.status === "completed" && info.normalizedKey) {
            if (info.resolvedUrl) {
              seedMediaResolution(info.normalizedKey, info.resolvedUrl);
            }
            return {
              normalizedKey: info.normalizedKey,
              resolvedUrl: info.resolvedUrl,
            };
          }
          if (info.status === "failed") {
            throw new Error(info.error || "Falha ao processar imagem no servidor.");
          }
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e;
    }
  }
  throw new Error("Tempo limite ao processar imagem no servidor.");
}

/**
 * Executes uploads of staged media items with controlled concurrency (default max 2).
 * Designed for iOS Safari / PWA stability: bounds memory and connection pressure.
 */
export function runBatchUploadPool(
  initialItems: StagedMediaItem[],
  options: BatchUploadPoolOptions
): BatchUploadPoolController {
  const maxConcurrency = options.maxConcurrency ?? 2;
  const itemsMap = new Map<string, StagedMediaItem>();
  for (const item of initialItems) {
    itemsMap.set(item.id, { ...item });
  }

  let cancelled = false;
  let activeWorkers = 0;
  const activeAbortControllers = new Map<string, AbortController>();

  const isEligible = (item: StagedMediaItem) =>
    item.status === "selected";

  const processQueue = () => {
    if (cancelled) return;

    while (activeWorkers < maxConcurrency) {
      // Pick next eligible item by original order
      const nextItem = Array.from(itemsMap.values())
        .filter(isEligible)
        .sort((a, b) => a.order - b.order)[0];

      if (!nextItem) break;

      activeWorkers++;
      void uploadWorker(nextItem);
    }

    const checkCompletion = () => {
      if (activeWorkers === 0) {
        const remainingUnfinished = Array.from(itemsMap.values()).some(
          (it) => it.status === "selected" || it.status === "uploading" || it.status === "processing"
        );
        if (!remainingUnfinished) {
          options.onAllComplete?.();
        }
      }
    };

    if (activeWorkers === 0) {
      checkCompletion();
    }
  };

  const uploadWorker = async (item: StagedMediaItem) => {
    if (cancelled || !itemsMap.has(item.id)) {
      activeWorkers--;
      processQueue();
      return;
    }

    // Mark uploading
    itemsMap.set(item.id, { ...item, status: "uploading" });
    options.onItemUpdate(item.id, { status: "uploading", error: undefined });

    const abortCtrl = new AbortController();
    activeAbortControllers.set(item.id, abortCtrl);

    forensic.log(15, "início do upload", "info", {
      id: item.id,
      filename: item.filename,
      size: item.size,
    });

    let uploadSlotReleased = false;

    try {
      let fileToUpload = item.file;
      const isHeic = isHeicFile(fileToUpload);

      // 1. Client-side auto-orientation for non-HEIC images
      if (!isHeic) {
        try {
          const normResult = await normalizeImageForUpload(fileToUpload);
          fileToUpload = normResult.file;
        } catch (err) {
          console.warn("Client-side auto-orient failed, proceeding with original:", err);
        }
      }

      if (cancelled || !itemsMap.has(item.id)) return;

      // 2. Size and MIME validations
      // Mobile and HEIC photos allow up to MEDIA_MAX_BYTES (16MB); server compresses > 5MB
      const maxBytes = MEDIA_MAX_BYTES;
      if (fileToUpload.size > maxBytes) {
        const limitMb = Math.round(maxBytes / 1024 / 1024);
        const actualMb = (fileToUpload.size / 1024 / 1024).toFixed(1);
        throw new Error(`Imagem excede o limite de ${limitMb}MB (${actualMb}MB).`);
      }

      const clientMime = resolveClientFileMime(fileToUpload);
      const allowedMimes = ALLOWED_MIME_TYPES_BY_KIND.image as readonly string[];
      if (!allowedMimes.includes(clientMime) && !isHeic) {
        throw new Error(`Tipo de imagem não suportado (${fileToUpload.type || clientMime}).`);
      }

      // 3. Upload directly to R2 (hash + presign + PUT + confirm)
      const uploadResult = await presignAndUpload("chat-attachment", "image", fileToUpload);

      if (cancelled || !itemsMap.has(item.id)) return;

      if (uploadResult.requiresProcessing) {
        // HEIC requires server-side asynchronous normalization
        const origKey = uploadResult.key;
        forensic.log(20, "processamento", "info", {
          id: item.id,
          key: origKey,
          filename: item.filename,
        });

        itemsMap.set(item.id, {
          ...item,
          status: "processing",
          key: origKey,
          originalKey: origKey,
        });
        options.onItemUpdate(item.id, {
          status: "processing",
          key: origKey,
          originalKey: origKey,
          error: undefined,
        });

        // Pre-register local blob for original key so preview never flickers
        if (item.localBlobUrl) {
          registerLocalMediaBlob(origKey, item.localBlobUrl);
        }

        // DESACOPLAMENTO CIRÚRGICO:
        // O upload do arquivo ao R2 foi concluído com sucesso.
        // Liberamos o slot de concorrência imediatamente para que os próximos
        // uploads da fila continuem sem bloqueio (eliminando Head-of-Line Blocking).
        uploadSlotReleased = true;
        activeWorkers--;
        processQueue();

        // O polling de normalização continua em segundo plano
        void (async () => {
          try {
            const { normalizedKey, resolvedUrl } = await pollNormalizationStatus(origKey, abortCtrl.signal);
            if (cancelled || !itemsMap.has(item.id)) return;

            forensic.log(21, "status", "ok", {
              id: item.id,
              key: normalizedKey,
              resolvedUrl: !!resolvedUrl,
              filename: item.filename,
            });

            // Pre-register local blob so downstream MessageAlbum / MessageBubble render 0ms
            if (item.localBlobUrl) {
              registerLocalMediaBlob(normalizedKey, item.localBlobUrl);
              registerLocalMediaBlob(origKey, item.localBlobUrl);
            }
            if (resolvedUrl) {
              seedMediaResolution(normalizedKey, resolvedUrl);
            }

            // Keep localBlobUrl active so preview never reloads or flickers
            const newPreview = item.localBlobUrl || resolvedUrl || item.previewUrl;
            itemsMap.set(item.id, {
              ...item,
              status: "uploaded",
              key: normalizedKey,
              originalKey: origKey,
              previewUrl: newPreview,
            });
            options.onItemUpdate(item.id, {
              status: "uploaded",
              key: normalizedKey,
              originalKey: origKey,
              previewUrl: newPreview,
              error: undefined,
            });
          } catch (pollErr) {
            if (cancelled || !itemsMap.has(item.id)) return;
            const errorMsg = pollErr instanceof Error ? pollErr.message : "Falha ao processar imagem no servidor.";
            forensic.log(21, "status", "fail", {
              id: item.id,
              filename: item.filename,
              error: errorMsg,
            });
            itemsMap.set(item.id, { ...item, status: "failed", error: errorMsg });
            options.onItemUpdate(item.id, { status: "failed", error: errorMsg });
          } finally {
            activeAbortControllers.delete(item.id);
            // Trigger checkCompletion if all workers and background polling are finished
            if (activeWorkers === 0) {
              const remainingUnfinished = Array.from(itemsMap.values()).some(
                (it) => it.status === "selected" || it.status === "uploading" || it.status === "processing"
              );
              if (!remainingUnfinished) {
                options.onAllComplete?.();
              }
            }
          }
        })();

        return;
      } else {
        // Standard already-compliant JPEG/PNG (or dedup completed item)
        forensic.log(21, "status", "ok", {
          id: item.id,
          key: uploadResult.key,
          resolvedUrl: !!uploadResult.resolvedUrl,
          filename: item.filename,
        });

        if (item.localBlobUrl) {
          registerLocalMediaBlob(uploadResult.key, item.localBlobUrl);
        }
        if (uploadResult.resolvedUrl) {
          seedMediaResolution(uploadResult.key, uploadResult.resolvedUrl);
        }

        const newPreview = item.localBlobUrl || uploadResult.resolvedUrl || item.previewUrl;
        itemsMap.set(item.id, {
          ...item,
          status: "uploaded",
          key: uploadResult.key,
          previewUrl: newPreview,
        });
        options.onItemUpdate(item.id, {
          status: "uploaded",
          key: uploadResult.key,
          previewUrl: newPreview,
          error: undefined,
        });
      }
    } catch (err) {
      if (cancelled || !itemsMap.has(item.id)) return;
      const errorMsg = err instanceof Error ? err.message : "Falha no upload.";
      forensic.log(21, "status", "fail", {
        id: item.id,
        filename: item.filename,
        error: errorMsg,
      });
      itemsMap.set(item.id, { ...item, status: "failed", error: errorMsg });
      options.onItemUpdate(item.id, { status: "failed", error: errorMsg });
    } finally {
      if (!uploadSlotReleased) {
        activeAbortControllers.delete(item.id);
        activeWorkers--;
        processQueue();
      }
    }
  };

  // Kick off initial workers
  processQueue();

  return {
    cancel: () => {
      cancelled = true;
      for (const ctrl of activeAbortControllers.values()) {
        ctrl.abort();
      }
      activeAbortControllers.clear();
    },
    retryItem: (id: string) => {
      const item = itemsMap.get(id);
      if (!item || item.status !== "failed") return;
      itemsMap.set(id, { ...item, status: "selected", error: undefined });
      options.onItemUpdate(id, { status: "selected", error: undefined });
      processQueue();
    },
    removeItem: (id: string) => {
      const item = itemsMap.get(id);
      if (item?.key) {
        revokeLocalMediaBlobImmediately(item.key);
      }
      if (item?.originalKey && item.originalKey !== item.key) {
        revokeLocalMediaBlobImmediately(item.originalKey);
      }
      const ctrl = activeAbortControllers.get(id);
      if (ctrl) {
        ctrl.abort();
        activeAbortControllers.delete(id);
      }
      itemsMap.delete(id);
      processQueue();
    },
  };
}
