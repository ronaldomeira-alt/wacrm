"use client";

/**
 * Upload → send pipeline for voice notes persisted by
 * message-composer.tsx into pending-audio-db.ts, plus the app-wide
 * background sweep that resumes ones a previous attempt left stuck.
 *
 * Every network step here is timeout-bounded and retried a fixed number
 * of times, so `runPendingAudio` always settles — it never leaves a
 * caller (the composer, a message bubble's retry tap, or the background
 * sweep) waiting forever the way the old inline upload in
 * message-composer.tsx could on iOS Safari/WKWebView. See that file's
 * `finalizeRecording` for the full root-cause writeup.
 */

import {
  deletePendingAudio,
  getPendingAudio,
  listAllPendingAudio,
  patchPendingAudio,
  type PendingAudioRecord,
} from "./pending-audio-db";
import { audioLog, audioLogError } from "./pending-audio-log";
import { retryAsync, withTimeout } from "@/lib/net/with-timeout";
import { uploadAccountMedia, deleteAccountMedia, CHAT_MEDIA_BUCKET } from "@/lib/storage/upload-media";

/** Generous for a voice note (opus VOIP encoding keeps these small — a
 *  few hundred KB even at the 5-minute cap) but still finite: the whole
 *  point is that this can never turn into the old "forever" hang. */
const UPLOAD_TIMEOUT_MS = 20_000;
const UPLOAD_RETRIES = 2;
/** Hits our own API route, not third-party infra — short timeout, one retry. */
const SEND_TIMEOUT_MS = 15_000;
const SEND_RETRIES = 1;

export type PendingAudioLifecycleStatus =
  | "uploading"
  | "uploaded"
  | "sending"
  | "sent"
  | "failed";

export interface PendingAudioCallbacks {
  onStatus?: (status: PendingAudioLifecycleStatus) => void;
  /** Fired once the storage upload resolves, so a live bubble can swap
   *  its local blob: preview URL for the real one. */
  onMediaUrl?: (mediaUrl: string) => void;
}

function buildAudioFile(record: PendingAudioRecord): File {
  return new File([record.blob], `voice-${record.createdAt}.ogg`, {
    type: record.mimeType || "audio/ogg",
  });
}

async function ensureUploaded(
  record: PendingAudioRecord,
  cb?: PendingAudioCallbacks,
): Promise<PendingAudioRecord> {
  if (record.mediaUrl && record.path) return record;

  cb?.onStatus?.("uploading");
  await patchPendingAudio(record.id, { status: "uploading" });
  audioLog("upload:start", { id: record.id, sizeBytes: record.sizeBytes });
  const file = buildAudioFile(record);

  const result = await retryAsync(
    (attempt) => {
      audioLog("upload:attempt", { id: record.id, attempt: attempt + 1 });
      return withTimeout(uploadAccountMedia(CHAT_MEDIA_BUCKET, file), UPLOAD_TIMEOUT_MS, "voice-note upload");
    },
    {
      retries: UPLOAD_RETRIES,
      baseDelayMs: 1500,
      onRetry: (attempt, err) => audioLogError("upload:retry", err, { id: record.id, attempt }),
    },
  );

  audioLog("upload:success", { id: record.id, path: result.path });
  const updated = await patchPendingAudio(record.id, {
    status: "uploaded",
    mediaUrl: result.publicUrl,
    path: result.path,
  });
  cb?.onMediaUrl?.(result.publicUrl);
  cb?.onStatus?.("uploaded");
  return updated ?? { ...record, status: "uploaded", mediaUrl: result.publicUrl, path: result.path };
}

async function sendToWhatsapp(record: PendingAudioRecord, cb?: PendingAudioCallbacks): Promise<void> {
  if (!record.mediaUrl) throw new Error("Voice note has no uploaded media to send");

  cb?.onStatus?.("sending");
  await patchPendingAudio(record.id, { status: "sending" });
  audioLog("send:start", { id: record.id, conversationId: record.conversationId });

  await retryAsync(
    async (attempt) => {
      audioLog("send:attempt", { id: record.id, attempt: attempt + 1 });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: record.conversationId,
            message_type: "audio",
            media_url: record.mediaUrl,
            reply_to_message_id: record.replyToId,
            // record.id is stable across every retry of this recording
            // (this call, a later manual retry, or the recovery sweep) —
            // see migration 20260903230000 for why this is required: a
            // client-side timeout/abort here does not mean the server
            // didn't already reach Meta, so a retry must be idempotent.
            client_ref: record.id,
          }),
          signal: controller.signal,
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
    {
      retries: SEND_RETRIES,
      baseDelayMs: 1000,
      onRetry: (attempt, err) => audioLogError("send:retry", err, { id: record.id, attempt }),
    },
  );

  audioLog("send:success", { id: record.id });
}

/**
 * Runs (or resumes) one voice note's upload → send pipeline to
 * completion. On success the local record is deleted — the server has
 * confirmed receipt, satisfying "never delete before the server
 * confirms". On failure the record is left in place (with the failure
 * reason attached) for a manual retry from the failed bubble, or a later
 * pass of `scanAndRetryAllPendingAudio`.
 */
export async function runPendingAudio(
  id: string,
  cb?: PendingAudioCallbacks,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const record = await getPendingAudio(id);
  if (!record) {
    return { ok: false, error: "Voice note is no longer available locally." };
  }
  try {
    const uploaded = await ensureUploaded(record, cb);
    await sendToWhatsapp(uploaded, cb);
    await deletePendingAudio(id);
    cb?.onStatus?.("sent");
    audioLog("cleanup", { id });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audioLogError("pipeline:failed", err, { id });
    const current = await getPendingAudio(id);
    await patchPendingAudio(id, {
      status: current?.mediaUrl ? "failed-send" : "failed-upload",
      lastError: message,
      attempts: (current?.attempts ?? 0) + 1,
    });
    cb?.onStatus?.("failed");
    return { ok: false, error: message };
  }
}

/** Discards a pending/failed voice note — deletes the IndexedDB record
 *  and GCs the storage object if the upload had already succeeded. */
export async function discardPendingAudio(id: string): Promise<void> {
  const record = await getPendingAudio(id);
  if (record?.path) {
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, record.path).catch((err) =>
      audioLogError("discard:gc-failed", err, { id }),
    );
  }
  await deletePendingAudio(id);
  audioLog("discard", { id });
}

/**
 * App-wide recovery sweep — call on mount, on the `online` event, and on
 * the tab regaining visibility (see inbox/page.tsx). Only resumes records
 * already in a definite terminal failure state ("failed-upload" /
 * "failed-send"). A record still marked "uploading"/"sending" means an
 * earlier attempt was interrupted mid-flight (most likely the exact
 * WebKit hang this module exists for) and its true server-side outcome is
 * unknown — silently auto-resuming it here risks a duplicate send if that
 * older attempt lands late, so those are surfaced for the agent to retry
 * explicitly instead (see message-composer.tsx's rehydration effect).
 */
export async function scanAndRetryAllPendingAudio(
  onRecordUpdate?: (record: PendingAudioRecord, status: PendingAudioLifecycleStatus, mediaUrl?: string) => void,
): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  let all: PendingAudioRecord[];
  try {
    all = await listAllPendingAudio();
  } catch (err) {
    audioLogError("scan:list-failed", err);
    return;
  }
  const retryable = all.filter((r) => r.status === "failed-upload" || r.status === "failed-send");
  if (retryable.length === 0) return;
  audioLog("scan:retrying", { count: retryable.length });
  for (const record of retryable) {
    await runPendingAudio(record.id, {
      onStatus: (status) => onRecordUpdate?.(record, status),
      onMediaUrl: (url) => onRecordUpdate?.(record, "uploaded", url),
    });
  }
}
