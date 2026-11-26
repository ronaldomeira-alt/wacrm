/**
 * Explicit state machine and immutable data contracts for the Local-First
 * Audio Outbox (`wacrm-audio-outbox`).
 *
 * Separates capture lifecycle states (`AudioCaptureState`) from durable
 * job/delivery lifecycle states (`AudioJobStatus`) so a capture error can
 * never masquerade as a send failure (or vice versa), and impossible
 * states (such as retrying without recoverable bytes or auto-sending an
 * unauthorized draft) are structurally prevented.
 */

export type AudioCaptureState =
  | "idle"
  | "requesting_permission"
  | "initializing"
  | "recording"
  | "finalizing"
  | "validating"
  | "persisting"
  | "capture_failed";

export type AudioJobStatus =
  | "saved_draft"
  | "queued"
  | "uploading"
  | "uploaded"
  | "sending"
  | "awaiting_confirmation"
  | "sent"
  | "delivered"
  | "read"
  | "retryable_failure"
  | "permanent_failure"
  | "discarded";

export type AudioStorageOrigin = "idb_v2" | "ram_vault";

export interface AudioBlobRecord {
  id: string;
  accountId: string;
  userId: string;
  conversationId: string;
  mimeType: string;
  codec: string;
  durationMs: number;
  sizeBytes: number;
  createdAt: number;
  sha256: string | null;
  rmsPeak?: number;
  data: ArrayBuffer;
}

export interface AudioJobRecord {
  id: string;
  clientRef: string;
  accountId: string;
  userId: string;
  conversationId: string;
  replyToId?: string;
  status: AudioJobStatus;
  /** Explicit user authorization to transmit. A `saved_draft` NEVER
   *  transitions to `queued`/`uploading`/`sending` while this is false. */
  sendAuthorized: boolean;
  storageOrigin: AudioStorageOrigin;
  storageProvider?: "r2" | "supabase";
  r2Key?: string;
  mediaUrl?: string;
  messageDbId?: string;
  wamid?: string;
  attempts: number;
  nextRetryAt?: number;
  lastErrorCategory?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number;
  migratedFromV1?: boolean;
  /** True when migrated from an ambiguous v1 state (`status: "uploading"`
   *  with 0 attempts and no mediaUrl) so the UI asks the user explicitly
   *  instead of silently auto-sending. */
  requiresUserDecision?: boolean;
}

export interface AudioOutboxEntry {
  job: AudioJobRecord;
  blob: AudioBlobRecord | null;
}

const VALID_JOB_TRANSITIONS: Record<AudioJobStatus, readonly AudioJobStatus[]> = {
  saved_draft: ["queued", "discarded"],
  queued: ["uploading", "uploaded", "sending", "retryable_failure", "permanent_failure", "discarded"],
  uploading: ["uploaded", "retryable_failure", "permanent_failure", "discarded"],
  uploaded: ["sending", "retryable_failure", "permanent_failure", "discarded"],
  sending: [
    "awaiting_confirmation",
    "sent",
    "delivered",
    "read",
    "retryable_failure",
    "permanent_failure",
  ],
  awaiting_confirmation: [
    "sent",
    "delivered",
    "read",
    "retryable_failure",
    "permanent_failure",
  ],
  sent: ["delivered", "read", "retryable_failure", "permanent_failure", "discarded"],
  delivered: ["read", "discarded"],
  read: ["discarded"],
  retryable_failure: ["queued", "uploading", "uploaded", "sending", "awaiting_confirmation", "sent", "discarded"],
  permanent_failure: ["queued", "discarded"],
  discarded: [],
};

export function canTransitionAudioJob(
  from: AudioJobStatus,
  to: AudioJobStatus,
  sendAuthorized: boolean,
): boolean {
  if (from === to) return true;
  if (!VALID_JOB_TRANSITIONS[from].includes(to)) return false;
  if (
    !sendAuthorized &&
    (to === "queued" || to === "uploading" || to === "sending" || to === "awaiting_confirmation")
  ) {
    return false;
  }
  return true;
}

export function isConfirmedAudioStatus(status: AudioJobStatus): boolean {
  return status === "sent" || status === "delivered" || status === "read";
}

export function isPendingOrFailedAudioStatus(status: AudioJobStatus): boolean {
  return (
    status === "saved_draft" ||
    status === "queued" ||
    status === "uploading" ||
    status === "uploaded" ||
    status === "sending" ||
    status === "awaiting_confirmation" ||
    status === "retryable_failure" ||
    status === "permanent_failure"
  );
}

export function isRetryableAudioJob(entry: AudioOutboxEntry): boolean {
  if (!entry.blob || entry.blob.data.byteLength === 0) {
    // Only allow retry without local bytes if already uploaded to R2/Supabase
    if (!entry.job.mediaUrl) return false;
  }
  return (
    entry.job.status === "retryable_failure" ||
    entry.job.status === "permanent_failure" ||
    entry.job.status === "awaiting_confirmation"
  );
}
