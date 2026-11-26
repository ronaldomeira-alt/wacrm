"use client";

/**
 * Local-First Outbox upload & send worker (`wacrm-audio-outbox`).
 *
 * Guarantees:
 *  - Single-flight mutex per recording (`tryAcquireAudioJobLock`).
 *  - Never sends a job unless `sendAuthorized === true`.
 *  - Reuses already-uploaded `mediaUrl` / `r2Key` on retries.
 *  - Never deletes the local `ArrayBuffer` on HTTP 200; transitions the
 *    job to `sent` with `confirmedAt` and delegates cleanup to the 48h /
 *    50-item retention sweep (`pruneConfirmedOutboxEntries`).
 *  - Distinguishes permanent errors (e.g., 24h WhatsApp session expired)
 *    from retryable network/5xx failures with exponential backoff + jitter.
 */

import {
  buildUploadAudioFile,
  getOutboxEntry,
  listAllOutboxJobs,
  pruneConfirmedOutboxEntries,
  releaseAudioJobLock,
  retryPersistFromRamVault,
  tryAcquireAudioJobLock,
  updateOutboxJob,
} from "./audio-outbox-db";
import type { AudioJobRecord, AudioJobStatus } from "./audio-outbox-types";
import { audioLog, audioLogError } from "./pending-audio-log";
import {
  classifySendErrorCategory,
  classifyUploadErrorCategory,
  updateAudioDiagnosticSession,
} from "./audio-telemetry";
import { isIPhoneSafariPwa } from "./audio-upload-target";
import { retryAsync, withTimeout } from "@/lib/net/with-timeout";
import { uploadAccountMedia, deleteAccountMedia, CHAT_MEDIA_BUCKET } from "@/lib/storage/upload-media";
import { presignAndUpload, deleteR2Media } from "@/lib/storage/upload-media-r2";

const UPLOAD_TIMEOUT_MS = 25_000;
const UPLOAD_RETRIES = 2;
const SEND_TIMEOUT_MS = 45_000;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_AUTO_RETRIES = 6;

export interface OutboxRunCallbacks {
  onJobUpdate?: (job: AudioJobRecord) => void;
  onMediaUrl?: (job: AudioJobRecord, mediaUrl: string) => void;
}

class HttpStatusError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

export function computeBackoffWithJitterMs(attempts: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts));
  const jitter = Math.floor(Math.random() * Math.min(1500, exp * 0.25));
  return exp + jitter;
}

export function isPermanentSendError(err: unknown): boolean {
  if (err instanceof HttpStatusError) {
    if (err.code === "session_expired" || err.code === "bad_request") return true;
    if (err.status === 400 || err.status === 403 || err.status === 404 || err.status === 422) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes("session_expired") ||
    msg.includes("24h") ||
    msg.includes("janela") ||
    msg.includes("unsupported_mime_type")
  );
}

async function ensureOutboxUploaded(
  id: string,
  cb?: OutboxRunCallbacks,
): Promise<AudioJobRecord> {
  const entry = await getOutboxEntry(id);
  if (!entry) throw new Error("Audio outbox entry not found");
  if (entry.job.mediaUrl) return entry.job;
  if (!entry.blob || entry.blob.data.byteLength === 0) {
    throw new Error("Local audio binary is missing");
  }

  const uploadingJob = await updateOutboxJob(id, { status: "uploading" });
  if (uploadingJob) cb?.onJobUpdate?.(uploadingJob);

  const file = buildUploadAudioFile(entry.blob);
  const useR2 = isIPhoneSafariPwa();
  const uploadStartedAt = Date.now();
  let uploadAttempts = 0;

  try {
    const result = await retryAsync(
      (attempt) => {
        uploadAttempts = attempt + 1;
        const upload = useR2
          ? presignAndUpload("chat-attachment", "audio", file, {
              preferSameOriginProxy: true,
            }).then((r) => ({ publicUrl: r.key, path: r.key }))
          : uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        return withTimeout(upload, UPLOAD_TIMEOUT_MS, "voice-note upload");
      },
      {
        retries: UPLOAD_RETRIES,
        baseDelayMs: 1500,
        onRetry: (attempt, err) => audioLogError("outbox:upload:retry", err, { id, attempt }),
      },
    );

    updateAudioDiagnosticSession(id, (prev) => ({
      ...prev,
      stage: "uploaded",
      uploadResult: {
        ok: true,
        provider: useR2 ? "r2" : "supabase",
        latencyMs: Date.now() - uploadStartedAt,
        attempts: uploadAttempts,
      },
    }));

    const uploaded = await updateOutboxJob(id, {
      status: "uploaded",
      mediaUrl: result.publicUrl,
      r2Key: result.path,
      storageProvider: useR2 ? "r2" : "supabase",
    });
    if (uploaded) {
      cb?.onMediaUrl?.(uploaded, result.publicUrl);
      cb?.onJobUpdate?.(uploaded);
      return uploaded;
    }
    return {
      ...entry.job,
      status: "uploaded",
      mediaUrl: result.publicUrl,
      r2Key: result.path,
      storageProvider: useR2 ? "r2" : "supabase",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateAudioDiagnosticSession(id, (prev) => ({
      ...prev,
      stage: "upload_failed",
      uploadResult: {
        ok: false,
        provider: useR2 ? "r2" : "supabase",
        latencyMs: Date.now() - uploadStartedAt,
        attempts: uploadAttempts,
        error: msg,
      },
      failureCategory: classifyUploadErrorCategory(msg),
      errorDetail: msg,
    }));
    throw err;
  }
}

async function dispatchOutboxSend(
  job: AudioJobRecord,
  cb?: OutboxRunCallbacks,
): Promise<AudioJobRecord> {
  if (!job.mediaUrl) throw new Error("Outbox job has no uploaded mediaUrl");

  const sendingJob = await updateOutboxJob(job.id, { status: "sending" });
  if (sendingJob) cb?.onJobUpdate?.(sendingJob);

  const sendStartedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let httpStatus: number | undefined;

  try {
    const res = await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-correlation-id": job.clientRef,
      },
      body: JSON.stringify({
        conversation_id: job.conversationId,
        message_type: "audio",
        media_url: job.mediaUrl,
        reply_to_message_id: job.replyToId,
        client_ref: job.clientRef,
      }),
      signal: controller.signal,
    });
    httpStatus = res.status;
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      message_id?: string;
      whatsapp_message_id?: string;
      deduplicated?: boolean;
    };
    if (!res.ok) {
      throw new HttpStatusError(
        payload.error || `HTTP ${res.status}`,
        res.status,
        payload.code,
      );
    }

    const confirmed = await updateOutboxJob(job.id, {
      status: "sent",
      messageDbId: payload.message_id,
      wamid: payload.whatsapp_message_id,
      confirmedAt: Date.now(),
      lastError: undefined,
      lastErrorCategory: undefined,
    });

    updateAudioDiagnosticSession(
      job.id,
      (prev) => ({
        ...prev,
        stage: "sent",
        recorderState: "stopped",
        sendResult: {
          ok: true,
          latencyMs: Date.now() - sendStartedAt,
          attempts: job.attempts + 1,
          httpStatus,
          deduplicated: Boolean(payload.deduplicated),
        },
        failureCategory: "none",
      }),
      { flush: true },
    );

    if (confirmed) cb?.onJobUpdate?.(confirmed);
    return confirmed ?? { ...job, status: "sent", confirmedAt: Date.now() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateAudioDiagnosticSession(job.id, (prev) => ({
      ...prev,
      stage: "send_failed",
      sendResult: {
        ok: false,
        latencyMs: Date.now() - sendStartedAt,
        attempts: job.attempts + 1,
        httpStatus,
        error: msg,
      },
      failureCategory: classifySendErrorCategory(msg, httpStatus),
      errorDetail: msg,
    }));
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one authorized outbox audio job through upload → send.
 * Never deletes the local `ArrayBuffer` on error or even on immediate
 * HTTP 200 (retention sweep cleans up confirmed entries after 48h / cap 50).
 */
export async function processOutboxAudioJob(
  id: string,
  cb?: OutboxRunCallbacks,
): Promise<{ ok: true; job: AudioJobRecord } | { ok: false; error: string; job?: AudioJobRecord | null }> {
  if (!tryAcquireAudioJobLock(id)) {
    return { ok: false, error: "Audio job already in flight" };
  }

  try {
    const entry = await getOutboxEntry(id);
    if (!entry) {
      return { ok: false, error: "Audio recording is no longer available locally." };
    }
    if (!entry.job.sendAuthorized) {
      return { ok: false, error: "Draft has not been authorized for sending.", job: entry.job };
    }
    if (entry.job.requiresUserDecision) {
      return {
        ok: false,
        error: "Confirmation required before resending after ambiguous connection loss.",
        job: entry.job,
      };
    }

    if (entry.job.storageOrigin === "ram_vault") {
      await retryPersistFromRamVault(id);
    }

    if (entry.job.status === "retryable_failure" || entry.job.status === "permanent_failure") {
      const queued = await updateOutboxJob(id, { status: "queued" });
      if (queued) cb?.onJobUpdate?.(queued);
    }

    const uploaded = await ensureOutboxUploaded(id, cb);
    const sent = await dispatchOutboxSend(uploaded, cb);
    void pruneConfirmedOutboxEntries().catch(() => {});
    return { ok: true, job: sent };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audioLogError("outbox:pipeline-failed", err, { id });
    const latest = await getOutboxEntry(id);
    const currentAttempts = (latest?.job.attempts ?? 0) + 1;
    const isPerm = isPermanentSendError(err) || currentAttempts >= MAX_AUTO_RETRIES;
    const isAmbiguousAbort =
      err instanceof Error &&
      (err.name === "AbortError" || message.toLowerCase().includes("abort"));
    const nextStatus: AudioJobStatus =
      isAmbiguousAbort && latest?.job.mediaUrl
        ? "awaiting_confirmation"
        : isPerm
          ? "permanent_failure"
          : "retryable_failure";

    let updated: AudioJobRecord | null = null;
    try {
      updated = await updateOutboxJob(id, {
        status: nextStatus,
        attempts: currentAttempts,
        lastError: message,
        lastErrorCategory: latest?.job.mediaUrl
          ? classifySendErrorCategory(message)
          : classifyUploadErrorCategory(message),
        nextRetryAt:
          nextStatus === "retryable_failure"
            ? Date.now() + computeBackoffWithJitterMs(currentAttempts)
            : undefined,
      });
    } catch {
      // Preserve existing job if transition check blocked
    }
    if (updated) cb?.onJobUpdate?.(updated);
    return { ok: false, error: message, job: updated ?? latest?.job };
  } finally {
    releaseAudioJobLock(id);
  }
}

export async function authorizeAndSendDraftJob(
  id: string,
  cb?: OutboxRunCallbacks,
): Promise<{ ok: true; job: AudioJobRecord } | { ok: false; error: string; job?: AudioJobRecord | null }> {
  await updateOutboxJob(id, {
    sendAuthorized: true,
    status: "queued",
    requiresUserDecision: false,
  });
  return processOutboxAudioJob(id, cb);
}

/**
 * Reconciles a job whose HTTP send ended ambiguously (`awaiting_confirmation`)
 * via read-only `GET /api/whatsapp/send/reconcile?client_ref=...` BEFORE ever
 * attempting a resend. Guarantees zero duplicate Meta sends.
 */
export async function reconcileOutboxAudioJob(
  id: string,
  cb?: OutboxRunCallbacks,
): Promise<{ reconciled: boolean; job?: AudioJobRecord | null }> {
  if (!tryAcquireAudioJobLock(id)) {
    return { reconciled: false };
  }

  try {
    const entry = await getOutboxEntry(id);
    if (!entry || entry.job.status !== "awaiting_confirmation") {
      return { reconciled: false, job: entry?.job };
    }

    const res = await fetch(
      `/api/whatsapp/send/reconcile?client_ref=${encodeURIComponent(entry.job.clientRef)}`,
      { method: "GET", cache: "no-store" },
    );
    if (!res.ok) {
      return { reconciled: false, job: entry.job };
    }
    const payload = (await res.json().catch(() => ({}))) as {
      state?: "confirmed" | "in_flight" | "ambiguous_dispatch" | "safe_to_retry";
      message_id?: string;
      whatsapp_message_id?: string | null;
      status?: string;
    };

    if (payload.state === "confirmed") {
      const updated = await updateOutboxJob(id, {
        status: payload.status === "read" ? "read" : payload.status === "delivered" ? "delivered" : "sent",
        messageDbId: payload.message_id,
        wamid: payload.whatsapp_message_id ?? undefined,
        confirmedAt: Date.now(),
        requiresUserDecision: false,
        lastError: undefined,
        lastErrorCategory: undefined,
      });
      if (updated) cb?.onJobUpdate?.(updated);
      return { reconciled: true, job: updated };
    }

    if (payload.state === "in_flight") {
      return { reconciled: false, job: entry.job };
    }

    if (payload.state === "ambiguous_dispatch") {
      // Server started calling Meta and lost acknowledgment without returning —
      // require explicit user decision instead of risking a duplicate audio.
      const updated = await updateOutboxJob(id, {
        status: "permanent_failure",
        requiresUserDecision: true,
        lastError: "Conexão caiu durante confirmação com o WhatsApp. Toque em Reenviar se o cliente não recebeu.",
        lastErrorCategory: "send_timeout",
      });
      if (updated) cb?.onJobUpdate?.(updated);
      return { reconciled: true, job: updated };
    }

    if (payload.state === "safe_to_retry") {
      const updated = await updateOutboxJob(id, {
        status: "retryable_failure",
        requiresUserDecision: false,
        nextRetryAt: Date.now(),
      });
      if (updated) cb?.onJobUpdate?.(updated);
      releaseAudioJobLock(id);
      await processOutboxAudioJob(id, cb);
      return { reconciled: true, job: (await getOutboxEntry(id))?.job };
    }

    return { reconciled: false, job: entry.job };
  } catch (err) {
    audioLogError("outbox:reconcile-failed", err, { id });
    return { reconciled: false };
  } finally {
    releaseAudioJobLock(id);
  }
}

/**
 * Discards an outbox entry safely. Never triggers remote R2 deletion when
 * the job is confirmed, sending, or awaiting confirmation.
 */
export async function discardOutboxAudioJob(id: string): Promise<void> {
  const entry = await getOutboxEntry(id);
  if (!entry) return;
  const status = entry.job.status;
  const safeToGcRemote =
    Boolean(entry.job.r2Key) &&
    status !== "sending" &&
    status !== "awaiting_confirmation" &&
    status !== "sent" &&
    status !== "delivered" &&
    status !== "read";

  if (safeToGcRemote && entry.job.r2Key) {
    const remove =
      entry.job.storageProvider === "r2"
        ? deleteR2Media(entry.job.r2Key)
        : deleteAccountMedia(CHAT_MEDIA_BUCKET, entry.job.r2Key);
    void remove.catch((err) => audioLogError("outbox:discard-gc-failed", err, { id }));
  }

  await updateOutboxJob(id, { status: "discarded" }).catch(() => {});
  const { deleteOutboxEntry } = await import("./audio-outbox-db");
  await deleteOutboxEntry(id);
  audioLog("outbox:discarded", { id, safeToGcRemote });
}

/**
 * Resumes eligible `queued` / `retryable_failure` jobs whose backoff has
 * elapsed, and reconciles `awaiting_confirmation` jobs via read-only server check.
 * NEVER auto-sends `saved_draft` or jobs requiring explicit user decision.
 */
export async function scanAndRetryOutboxAudio(
  scope: { accountId: string; userId?: string },
  cb?: OutboxRunCallbacks,
): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const jobs = await listAllOutboxJobs(scope);
  const now = Date.now();

  const awaiting = jobs.filter((j) => j.sendAuthorized && j.status === "awaiting_confirmation");
  for (const job of awaiting) {
    await reconcileOutboxAudioJob(job.id, cb);
  }

  const eligible = jobs.filter(
    (j) =>
      j.sendAuthorized &&
      !j.requiresUserDecision &&
      (j.status === "queued" ||
        (j.status === "retryable_failure" && (!j.nextRetryAt || j.nextRetryAt <= now))),
  );
  for (const job of eligible) {
    await processOutboxAudioJob(job.id, cb);
  }
}
