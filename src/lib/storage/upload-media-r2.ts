"use client";

import { sha256Hex } from "@/lib/media/hash-file";
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
  /** Only set for a `visibility='public'` purpose (template-header) —
   *  a permanent, directly-usable URL. Undefined for private uploads. */
  publicUrl?: string;
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

export async function presignAndUpload(
  purpose: MediaPurpose,
  kind: MediaKind,
  file: File,
): Promise<PresignAndUploadResult> {
  const sha256 = await sha256Hex(file);

  const presign = await postJson<{
    dedup: boolean;
    key: string;
    publicUrl?: string;
    uploadUrl?: string;
  }>("/api/media/presign-upload", {
    purpose,
    kind,
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    sha256,
  });

  if (presign.dedup) {
    // Identical bytes already uploaded for this account+purpose — no
    // network transfer needed at all.
    return { key: presign.key, publicUrl: presign.publicUrl };
  }

  const putRes = await fetch(presign.uploadUrl!, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error(`Upload to storage failed (HTTP ${putRes.status})`);
  }

  const confirmed = await postJson<{ key: string; publicUrl?: string }>(
    "/api/media/confirm-upload",
    { key: presign.key },
  );

  return { key: confirmed.key, publicUrl: confirmed.publicUrl };
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
