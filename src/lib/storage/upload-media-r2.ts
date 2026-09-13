"use client";

import { sha256Hex } from "@/lib/media/hash-file";
import { seedMediaResolution } from "@/lib/inbox/use-resolved-media-src";
import { forensic } from "@/lib/media/forensic-tracer";
import type { MediaKind } from "./r2-client";
import type { MediaPurpose } from "./media-purpose";

/**
 * Browser-side R2 upload flow — the direct replacement for
 * `uploadAccountMedia` (upload-media.ts) for every kind that's moving
 * off Supabase Storage. `upload-media.ts` itself is untouched: it still
 * serves the `avatars` and `flow-media` buckets, which stay on
 * Supabase.
 *
 * Never returns a URL — only an opaque R2 key (or, for public-purpose
 * uploads, also the permanent public URL handed back by
 * confirm-upload). Every caller that needs to *display* a private key
 * must resolve it first (see use-resolved-media-src.ts); this is
 * deliberate — it's what keeps R2 credentials and even a temporary
 * signed URL from ever being treated as a stable, storable value.
 */
export interface PresignAndUploadResult {
  key: string;
  normalizedKey?: string;
  resolvedUrl?: string;
  expiresAt?: number;
  /** Only set for a `visibility='public'` purpose (template-header) —
   *  a permanent, directly-usable URL. Undefined for private uploads. */
  publicUrl?: string;
  requiresProcessing?: boolean;
  processingStatus?: string;
}

export function resolveClientFileMime(file: { name?: string; type?: string }): string {
  const ext = file.name?.split(".").pop()?.toLowerCase();
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "mp4" || ext === "m4v") return "video/mp4";
  if (ext === "3gp" || ext === "3gpp") return "video/3gpp";
  if (ext === "mov") return "video/quicktime";
  if (ext === "pdf") return "application/pdf";

  const rawType = file.type?.toLowerCase().trim();
  if (rawType && rawType !== "application/octet-stream") {
    if (rawType === "image/x-heic" || rawType === "image/heic-sequence") return "image/heic";
    if (rawType === "image/heif-sequence") return "image/heif";
    if (rawType === "video/quicktime") return "video/quicktime";
    return rawType;
  }

  return "application/octet-stream";
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Request to ${url} failed (HTTP ${res.status})`);
  }
  return data as T;
}

function isOriginDirectR2Allowed(): boolean {
  if (typeof window === "undefined") return false;
  const origin = window.location.origin.toLowerCase();
  if (
    origin === "https://crmronaldomeira.com" ||
    origin === "https://www.crmronaldomeira.com" ||
    origin.endsWith(".crmronaldomeira.com")
  ) {
    return true;
  }
  if (
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:") ||
    origin.startsWith("http://192.168.") ||
    origin.startsWith("http://10.")
  ) {
    return true;
  }
  return false;
}

export async function presignAndUpload(
  purpose: MediaPurpose,
  kind: MediaKind,
  file: File,
): Promise<PresignAndUploadResult> {
  const sha256 = await sha256Hex(file);
  const contentType = resolveClientFileMime(file);

  forensic.log(16, "chamada de presign", "info", {
    purpose,
    kind,
    filename: file.name,
    contentType,
    sizeBytes: file.size,
    sha256,
  });

  let presign: {
    dedup: boolean;
    key: string;
    normalizedKey?: string;
    publicUrl?: string;
    resolvedUrl?: string;
    expiresAt?: number;
    requiresProcessing?: boolean;
    processingStatus?: string;
    uploadUrl?: string;
  };

  try {
    presign = await postJson<{
      dedup: boolean;
      key: string;
      normalizedKey?: string;
      publicUrl?: string;
      resolvedUrl?: string;
      expiresAt?: number;
      requiresProcessing?: boolean;
      processingStatus?: string;
      uploadUrl?: string;
    }>("/api/media/presign-upload", {
      purpose,
      kind,
      filename: file.name,
      contentType,
      sizeBytes: file.size,
      sha256,
    });

    forensic.log(17, "resposta do presign", "ok", {
      dedup: presign.dedup,
      key: presign.key,
      hasUploadUrl: !!presign.uploadUrl,
      requiresProcessing: !!presign.requiresProcessing,
    });
  } catch (err) {
    forensic.log(17, "resposta do presign", "fail", {
      error: String(err),
      filename: file.name,
    });
    throw err;
  }

  if (presign.dedup) {
    // Identical bytes already uploaded for this account+purpose — no
    // network transfer needed at all.
    if (presign.resolvedUrl) {
      seedMediaResolution(presign.key, presign.resolvedUrl, presign.expiresAt);
      if (presign.normalizedKey) {
        seedMediaResolution(presign.normalizedKey, presign.resolvedUrl, presign.expiresAt);
      }
    }
    return {
      key: presign.normalizedKey || presign.key,
      normalizedKey: presign.normalizedKey,
      publicUrl: presign.publicUrl,
      resolvedUrl: presign.resolvedUrl,
      expiresAt: presign.expiresAt,
      requiresProcessing: presign.requiresProcessing,
      processingStatus: presign.processingStatus,
    };
  }

  // If the current origin is allowed in R2's CORS (production / localhost),
  // attempt direct PUT to R2 first.
  const directAllowed = isOriginDirectR2Allowed();

  if (directAllowed && presign.uploadUrl) {
    let directOk = false;
    forensic.log(18, "PUT/fallback", "info", {
      route: "direct-r2-put",
      uploadUrl: presign.uploadUrl.split("?")[0],
    });
    try {
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
      });
      if (putRes.ok) directOk = true;
    } catch (directErr) {
      forensic.log(18, "PUT/fallback", "fail", {
        route: "direct-r2-put-failed",
        error: String(directErr),
      });
      console.warn("Direct R2 upload failed, falling back to upload stream proxy:", directErr);
    }

    if (directOk) {
      forensic.log(19, "confirm", "info", { route: "confirm-upload", key: presign.key });
      const confirmed = await postJson<{
        key: string;
        publicUrl?: string;
        resolvedUrl?: string;
        expiresAt?: number;
        requiresProcessing?: boolean;
        processingStatus?: string;
      }>("/api/media/confirm-upload", { key: presign.key });

      forensic.log(19, "confirm", "ok", {
        key: confirmed.key,
        requiresProcessing: !!confirmed.requiresProcessing,
      });

      if (confirmed.resolvedUrl) {
        seedMediaResolution(confirmed.key, confirmed.resolvedUrl, confirmed.expiresAt);
      }

      return {
        key: confirmed.key,
        publicUrl: confirmed.publicUrl,
        resolvedUrl: confirmed.resolvedUrl,
        expiresAt: confirmed.expiresAt,
        requiresProcessing: confirmed.requiresProcessing,
        processingStatus: confirmed.processingStatus,
      };
    }
  }

  // Tunnel / non-CORS origin (or direct PUT failure fallback):
  // Upload via same-origin /api/media/upload-stream using FormData.
  // This avoids CORS preflight failures on TryCloudflare and prevents stream disturbance on WebKit / Safari.
  forensic.log(18, "PUT/fallback", "info", {
    route: "upload-stream-proxy",
    key: presign.key,
    sizeBytes: file.size,
  });

  const formData = new FormData();
  formData.append("file", file);

  const streamRes = await fetch(
    `/api/media/upload-stream?key=${encodeURIComponent(presign.key)}&contentType=${encodeURIComponent(contentType)}`,
    {
      method: "POST",
      body: formData,
    }
  );

  if (!streamRes.ok) {
    const data = await streamRes.json().catch(() => ({}));
    const errText = data?.error || `Upload to storage failed (HTTP ${streamRes.status})`;
    forensic.log(18, "PUT/fallback", "fail", {
      route: "upload-stream-proxy",
      status: streamRes.status,
      error: errText,
    });
    throw new Error(errText);
  }

  const confirmed = (await streamRes.json()) as {
    key: string;
    publicUrl?: string;
    resolvedUrl?: string;
    expiresAt?: number;
    requiresProcessing?: boolean;
    processingStatus?: string;
  };

  forensic.log(19, "confirm", "ok", {
    route: "upload-stream-atomic-confirm",
    key: confirmed.key,
    requiresProcessing: !!confirmed.requiresProcessing,
  });

  if (confirmed.resolvedUrl) {
    seedMediaResolution(confirmed.key, confirmed.resolvedUrl, confirmed.expiresAt);
  }

  return {
    key: confirmed.key,
    publicUrl: confirmed.publicUrl,
    resolvedUrl: confirmed.resolvedUrl,
    expiresAt: confirmed.expiresAt,
    requiresProcessing: confirmed.requiresProcessing,
    processingStatus: confirmed.processingStatus,
  };
}

/** Best-effort GC of a staged-but-never-sent private upload. Mirrors
 *  `deleteAccountMedia`'s fire-and-forget calling convention. */
export async function deleteR2Media(key: string): Promise<void> {
  const res = await fetch("/api/media/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `Delete failed (HTTP ${res.status})`);
  }
}
