"use client";

/**
 * Local-First Audio Outbox (`wacrm-audio-outbox`) + Emergency RAM Vault
 * + Non-destructive idempotent migration from legacy `wacrm-pending-audio`.
 *
 * Key design choices (derived from WebKit/iOS audit):
 *  1. `audio_blobs` stores raw `ArrayBuffer` (NOT `Blob`/`File`) and is
 *     written ONCE per recording, never re-serialized on status updates.
 *     This eliminates WebKit's structured-clone `Blob` corruption bug.
 *  2. `audio_jobs` stores lightweight mutable metadata indexed by
 *     `conversationId`, `accountId`, and `status`.
 *  3. Saving a new recording uses ONE atomic `readwrite` transaction over
 *     `["audio_blobs", "audio_jobs"]`; a recording is persisted iff the
 *     transaction completes.
 *  4. Singleton managed `IDBDatabase` handle (`onversionchange` / `onclose`)
 *     so handles never leak across operations.
 *  5. If IndexedDB fails, `emergencyRamVault` preserves the `ArrayBuffer`
 *     in memory (isolated by account+user, capped at 30 MB) so playback,
 *     retry-persist, and explicit send stay available during the session.
 */

import {
  canTransitionAudioJob,
  isConfirmedAudioStatus,
  type AudioBlobRecord,
  type AudioJobRecord,
  type AudioJobStatus,
  type AudioOutboxEntry,
} from "./audio-outbox-types";
import {
  listAllPendingAudio,
  type PendingAudioRecord,
} from "./pending-audio-db";
import { audioLog, audioLogError } from "./pending-audio-log";

const OUTBOX_DB_NAME = "wacrm-audio-outbox";
const OUTBOX_DB_VERSION = 1;
const BLOBS_STORE = "audio_blobs";
const JOBS_STORE = "audio_jobs";

const CONFIRMED_RETENTION_MS = 48 * 60 * 60 * 1000;
const CONFIRMED_MAX_KEEP = 50;
const RAM_VAULT_MAX_BYTES = 30 * 1024 * 1024;
const RAM_VAULT_MAX_ENTRIES = 20;

let dbPromise: Promise<IDBDatabase> | null = null;

// Emergency RAM vault when IndexedDB is unavailable or fails
interface RamVaultEntry {
  blob: AudioBlobRecord;
  job: AudioJobRecord;
}
const ramVault = new Map<string, RamVaultEntry>();
const vaultListeners = new Set<() => void>();

// Shared in-flight lock preventing concurrent processing between v1 and v2
const inFlightJobIds = new Set<string>();

export function tryAcquireAudioJobLock(id: string): boolean {
  if (inFlightJobIds.has(id)) return false;
  inFlightJobIds.add(id);
  return true;
}

export function releaseAudioJobLock(id: string): void {
  inFlightJobIds.delete(id);
}

export function isAudioJobLocked(id: string): boolean {
  return inFlightJobIds.has(id);
}

function notifyVaultListeners(): void {
  for (const fn of vaultListeners) {
    try {
      fn();
    } catch {}
  }
}

export function subscribeOutboxUpdates(listener: () => void): () => void {
  vaultListeners.add(listener);
  return () => vaultListeners.delete(listener);
}

export function resetOutboxConnectionForTests(): void {
  dbPromise = null;
  ramVault.clear();
  inFlightJobIds.clear();
}

function openOutboxDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB_NAME, OUTBOX_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        const blobStore = db.createObjectStore(BLOBS_STORE, { keyPath: "id" });
        blobStore.createIndex("accountId", "accountId", { unique: false });
        blobStore.createIndex("conversationId", "conversationId", { unique: false });
      }
      if (!db.objectStoreNames.contains(JOBS_STORE)) {
        const jobStore = db.createObjectStore(JOBS_STORE, { keyPath: "id" });
        jobStore.createIndex("accountId", "accountId", { unique: false });
        jobStore.createIndex("conversationId", "conversationId", { unique: false });
        jobStore.createIndex("status", "status", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {}
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("Failed to open wacrm-audio-outbox"));
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error("IndexedDB open blocked"));
    };
  });

  return dbPromise;
}

export async function computeSha256Hex(buffer: ArrayBuffer): Promise<string | null> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle?.digest) return null;
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const bytes = new Uint8Array(digest);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

function getRamVaultTotalBytes(): number {
  let total = 0;
  for (const entry of ramVault.values()) {
    total += entry.blob.data.byteLength;
  }
  return total;
}

function putInRamVault(blob: AudioBlobRecord, job: AudioJobRecord): void {
  const incomingBytes = blob.data.byteLength;
  // Evict oldest confirmed entries first if over memory budget, never evicting
  // unsent/failed recordings unless strictly over cap with no confirmed left.
  while (
    ramVault.size >= RAM_VAULT_MAX_ENTRIES ||
    (getRamVaultTotalBytes() + incomingBytes > RAM_VAULT_MAX_BYTES && ramVault.size > 0)
  ) {
    let evictKey: string | null = null;
    for (const [k, v] of ramVault) {
      if (isConfirmedAudioStatus(v.job.status) || v.job.status === "discarded") {
        evictKey = k;
        break;
      }
    }
    if (!evictKey) {
      // No confirmed entries to evict; refuse to overwrite existing pending items
      // unless this single entry fits by itself
      if (ramVault.size >= RAM_VAULT_MAX_ENTRIES) {
        throw new Error("Emergency RAM vault full — pending recordings exist");
      }
      break;
    }
    ramVault.delete(evictKey);
  }

  ramVault.set(blob.id, {
    blob,
    job: { ...job, storageOrigin: "ram_vault" },
  });
  notifyVaultListeners();
}

export function getRamVaultCount(scope?: { accountId?: string; userId?: string }): number {
  if (!scope?.accountId && !scope?.userId) return ramVault.size;
  let count = 0;
  for (const entry of ramVault.values()) {
    if (scope.accountId && entry.job.accountId !== scope.accountId) continue;
    if (scope.userId && entry.job.userId !== scope.userId) continue;
    count++;
  }
  return count;
}

export function clearRamVaultScope(accountId?: string): void {
  if (!accountId) {
    ramVault.clear();
  } else {
    for (const [id, entry] of ramVault) {
      if (entry.job.accountId === accountId) ramVault.delete(id);
    }
  }
  notifyVaultListeners();
}

/**
 * Atomically persists a new recording's immutable `ArrayBuffer` and job
 * metadata into `wacrm-audio-outbox`. If IndexedDB fails, automatically
 * falls back to `emergencyRamVault` without losing the audio bytes.
 */
export async function persistAudioToOutbox(input: {
  id: string;
  accountId: string;
  userId: string;
  conversationId: string;
  replyToId?: string;
  arrayBuffer: ArrayBuffer;
  mimeType: string;
  codec?: string;
  durationMs: number;
  rmsPeak?: number;
  sendAuthorized: boolean;
  initialStatus?: AudioJobStatus;
  createdAt?: number;
}): Promise<{ persistedInIdb: boolean; job: AudioJobRecord; error?: string }> {
  const now = input.createdAt ?? Date.now();
  const sha256 = await computeSha256Hex(input.arrayBuffer);
  const initialStatus: AudioJobStatus =
    input.initialStatus ?? (input.sendAuthorized ? "queued" : "saved_draft");

  const blobRecord: AudioBlobRecord = {
    id: input.id,
    accountId: input.accountId,
    userId: input.userId,
    conversationId: input.conversationId,
    mimeType: input.mimeType || "audio/ogg",
    codec: input.codec || "opus",
    durationMs: input.durationMs,
    sizeBytes: input.arrayBuffer.byteLength,
    createdAt: now,
    sha256,
    rmsPeak: input.rmsPeak,
    data: input.arrayBuffer,
  };

  const jobRecord: AudioJobRecord = {
    id: input.id,
    clientRef: input.id,
    accountId: input.accountId,
    userId: input.userId,
    conversationId: input.conversationId,
    replyToId: input.replyToId,
    status: initialStatus,
    sendAuthorized: input.sendAuthorized,
    storageOrigin: "idb_v2",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const db = await openOutboxDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([BLOBS_STORE, JOBS_STORE], "readwrite");
      tx.objectStore(BLOBS_STORE).put(blobRecord);
      tx.objectStore(JOBS_STORE).put(jobRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Outbox write transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Outbox write transaction aborted"));
    });
    ramVault.delete(input.id);
    notifyVaultListeners();
    return { persistedInIdb: true, job: jobRecord };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    audioLogError("outbox:idb-persist-fallback-ram", err, { id: input.id });
    putInRamVault(blobRecord, jobRecord);
    return {
      persistedInIdb: false,
      job: { ...jobRecord, storageOrigin: "ram_vault" },
      error: msg,
    };
  }
}

/**
 * Attempts to flush an entry currently living only in `emergencyRamVault`
 * into IndexedDB. Safe to call repeatedly.
 */
export async function retryPersistFromRamVault(id: string): Promise<boolean> {
  const vaultEntry = ramVault.get(id);
  if (!vaultEntry) return false;
  try {
    const db = await openOutboxDb();
    const idbJob: AudioJobRecord = {
      ...vaultEntry.job,
      storageOrigin: "idb_v2",
      updatedAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([BLOBS_STORE, JOBS_STORE], "readwrite");
      tx.objectStore(BLOBS_STORE).put(vaultEntry.blob);
      tx.objectStore(JOBS_STORE).put(idbJob);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Outbox retry-persist failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Outbox retry-persist aborted"));
    });
    ramVault.delete(id);
    notifyVaultListeners();
    return true;
  } catch {
    return false;
  }
}

export async function getOutboxEntry(
  id: string,
  scope?: { accountId?: string; userId?: string },
): Promise<AudioOutboxEntry | null> {
  const ramEntry = ramVault.get(id);
  if (ramEntry) {
    if (scope?.accountId && ramEntry.job.accountId !== scope.accountId) return null;
    if (scope?.userId && ramEntry.job.userId !== scope.userId) return null;
    return { job: ramEntry.job, blob: ramEntry.blob };
  }

  try {
    const db = await openOutboxDb();
    const entry = await new Promise<AudioOutboxEntry | null>((resolve, reject) => {
      const tx = db.transaction([JOBS_STORE, BLOBS_STORE], "readonly");
      const jobReq = tx.objectStore(JOBS_STORE).get(id);
      const blobReq = tx.objectStore(BLOBS_STORE).get(id);
      tx.oncomplete = () => {
        const job = jobReq.result as AudioJobRecord | undefined;
        if (!job) {
          resolve(null);
          return;
        }
        resolve({
          job,
          blob: (blobReq.result as AudioBlobRecord | undefined) ?? null,
        });
      };
      tx.onerror = () => reject(tx.error ?? new Error("Outbox read failed"));
    });
    if (!entry) return null;
    if (scope?.accountId && entry.job.accountId !== scope.accountId) return null;
    if (scope?.userId && entry.job.userId !== scope.userId) return null;
    return entry;
  } catch {
    return null;
  }
}

export async function updateOutboxJob(
  id: string,
  patch: Partial<Omit<AudioJobRecord, "id" | "clientRef" | "accountId" | "userId" | "conversationId" | "createdAt">>,
): Promise<AudioJobRecord | null> {
  const ramEntry = ramVault.get(id);
  if (ramEntry) {
    const nextAuthorized = patch.sendAuthorized ?? ramEntry.job.sendAuthorized;
    if (
      patch.status &&
      !canTransitionAudioJob(ramEntry.job.status, patch.status, nextAuthorized)
    ) {
      throw new Error(
        `Invalid audio job transition ${ramEntry.job.status} -> ${patch.status} (authorized=${nextAuthorized})`,
      );
    }
    const updated: AudioJobRecord = {
      ...ramEntry.job,
      ...patch,
      updatedAt: Date.now(),
    };
    ramVault.set(id, { ...ramEntry, job: updated });
    notifyVaultListeners();
    return updated;
  }

  const db = await openOutboxDb();
  const updated = await new Promise<AudioJobRecord | null>((resolve, reject) => {
    const tx = db.transaction(JOBS_STORE, "readwrite");
    const store = tx.objectStore(JOBS_STORE);
    const getReq = store.get(id);
    let nextRecord: AudioJobRecord | null = null;
    getReq.onsuccess = () => {
      const existing = getReq.result as AudioJobRecord | undefined;
      if (!existing) {
        return;
      }
      const nextAuthorized = patch.sendAuthorized ?? existing.sendAuthorized;
      if (
        patch.status &&
        !canTransitionAudioJob(existing.status, patch.status, nextAuthorized)
      ) {
        tx.abort();
        reject(
          new Error(
            `Invalid audio job transition ${existing.status} -> ${patch.status} (authorized=${nextAuthorized})`,
          ),
        );
        return;
      }
      nextRecord = { ...existing, ...patch, updatedAt: Date.now() };
      store.put(nextRecord);
    };
    getReq.onerror = () => reject(getReq.error ?? new Error("Outbox job get failed"));
    tx.oncomplete = () => resolve(nextRecord);
    tx.onerror = () => reject(tx.error ?? new Error("Outbox job update failed"));
  });
  notifyVaultListeners();
  return updated;
}

export async function listOutboxJobsByConversation(input: {
  accountId: string;
  userId?: string;
  conversationId: string;
}): Promise<AudioJobRecord[]> {
  const results = new Map<string, AudioJobRecord>();

  for (const entry of ramVault.values()) {
    if (
      entry.job.accountId === input.accountId &&
      entry.job.conversationId === input.conversationId &&
      (!input.userId || entry.job.userId === input.userId)
    ) {
      results.set(entry.job.id, entry.job);
    }
  }

  try {
    const db = await openOutboxDb();
    const idbJobs = await new Promise<AudioJobRecord[]>((resolve, reject) => {
      const tx = db.transaction(JOBS_STORE, "readonly");
      const req = tx.objectStore(JOBS_STORE).index("conversationId").getAll(input.conversationId);
      req.onsuccess = () => resolve((req.result as AudioJobRecord[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error("Outbox list by conversation failed"));
    });
    for (const job of idbJobs) {
      if (job.accountId !== input.accountId) continue;
      if (input.userId && job.userId !== input.userId) continue;
      results.set(job.id, job);
    }
  } catch {
    // Return RAM vault entries even if IDB fails
  }

  return Array.from(results.values()).sort((a, b) => a.createdAt - b.createdAt);
}

export async function listAllOutboxJobs(scope?: {
  accountId?: string;
  userId?: string;
}): Promise<AudioJobRecord[]> {
  const results = new Map<string, AudioJobRecord>();

  for (const entry of ramVault.values()) {
    if (scope?.accountId && entry.job.accountId !== scope.accountId) continue;
    if (scope?.userId && entry.job.userId !== scope.userId) continue;
    results.set(entry.job.id, entry.job);
  }

  try {
    const db = await openOutboxDb();
    const idbJobs = await new Promise<AudioJobRecord[]>((resolve, reject) => {
      const tx = db.transaction(JOBS_STORE, "readonly");
      const req = tx.objectStore(JOBS_STORE).getAll();
      req.onsuccess = () => resolve((req.result as AudioJobRecord[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error("Outbox listAll failed"));
    });
    for (const job of idbJobs) {
      if (scope?.accountId && job.accountId !== scope.accountId) continue;
      if (scope?.userId && job.userId !== scope.userId) continue;
      results.set(job.id, job);
    }
  } catch {
    // Return RAM vault entries even if IDB fails
  }

  return Array.from(results.values()).sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteOutboxEntry(id: string): Promise<void> {
  ramVault.delete(id);
  try {
    const db = await openOutboxDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([BLOBS_STORE, JOBS_STORE], "readwrite");
      tx.objectStore(BLOBS_STORE).delete(id);
      tx.objectStore(JOBS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Outbox delete failed"));
    });
  } catch {
    // Best-effort IDB delete
  }
  notifyVaultListeners();
}

/**
 * Rebuilds a playable `Blob` from an outbox entry's raw `ArrayBuffer` without
 * mutating the stored record.
 */
export function buildPlayableAudioBlob(blob: AudioBlobRecord): Blob {
  return new Blob([blob.data], { type: blob.mimeType || "audio/ogg" });
}

export function buildUploadAudioFile(blob: AudioBlobRecord): File {
  const mime = blob.mimeType || "audio/ogg";
  const ext = mime.includes("mp4") ? "m4a" : "ogg";
  return new File([blob.data], `voice-${blob.createdAt}.${ext}`, { type: mime });
}

/**
 * Non-destructive, idempotent migration from legacy `wacrm-pending-audio`
 * into `wacrm-audio-outbox`.
 *
 * Rules:
 *  - Legacy DB records are NEVER deleted automatically during migration.
 *  - Never duplicates already-migrated IDs.
 *  - Never converts an ambiguous legacy `uploading` (0 attempts, no mediaUrl)
 *    into an auto-authorized send; marks it `saved_draft` with
 *    `requiresUserDecision: true` so the user chooses safely.
 */
export async function migrateLegacyPendingAudioToOutbox(scope: {
  accountId: string;
  userId: string;
}): Promise<{ migrated: number; skipped: number; failed: number }> {
  let legacyRecords: PendingAudioRecord[];
  try {
    legacyRecords = await listAllPendingAudio();
  } catch {
    return { migrated: 0, skipped: 0, failed: 0 };
  }
  if (legacyRecords.length === 0) {
    return { migrated: 0, skipped: 0, failed: 0 };
  }

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const legacy of legacyRecords) {
    if (!tryAcquireAudioJobLock(legacy.id)) {
      skipped++;
      continue;
    }
    try {
      const existing = await getOutboxEntry(legacy.id);
      if (existing) {
        skipped++;
        continue;
      }

      const arrayBuffer = await legacy.blob.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        failed++;
        continue;
      }

      const isAmbiguousPauseOrInFlight =
        legacy.status === "uploading" && legacy.attempts === 0 && !legacy.mediaUrl;
      const isSendingInFlight = legacy.status === "sending";

      let mappedStatus: AudioJobStatus = "retryable_failure";
      let sendAuthorized = true;
      let requiresUserDecision = false;

      if (isAmbiguousPauseOrInFlight) {
        mappedStatus = "saved_draft";
        sendAuthorized = false;
        requiresUserDecision = true;
      } else if (isSendingInFlight) {
        mappedStatus = "awaiting_confirmation";
        sendAuthorized = true;
        requiresUserDecision = true;
      } else if (legacy.status === "uploaded") {
        mappedStatus = "retryable_failure";
        sendAuthorized = true;
      }

      const sha256 = await computeSha256Hex(arrayBuffer);
      const blobRecord: AudioBlobRecord = {
        id: legacy.id,
        accountId: scope.accountId,
        userId: scope.userId,
        conversationId: legacy.conversationId,
        mimeType: legacy.mimeType || "audio/ogg",
        codec: "opus",
        durationMs: 0,
        sizeBytes: arrayBuffer.byteLength,
        createdAt: legacy.createdAt,
        sha256,
        data: arrayBuffer,
      };

      const jobRecord: AudioJobRecord = {
        id: legacy.id,
        clientRef: legacy.id,
        accountId: scope.accountId,
        userId: scope.userId,
        conversationId: legacy.conversationId,
        replyToId: legacy.replyToId,
        status: mappedStatus,
        sendAuthorized,
        storageOrigin: "idb_v2",
        storageProvider: legacy.storageProvider,
        r2Key: legacy.path,
        mediaUrl: legacy.mediaUrl,
        attempts: legacy.attempts ?? 0,
        lastError: legacy.lastError,
        createdAt: legacy.createdAt,
        updatedAt: Date.now(),
        migratedFromV1: true,
        requiresUserDecision,
      };

      const db = await openOutboxDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([BLOBS_STORE, JOBS_STORE], "readwrite");
        tx.objectStore(BLOBS_STORE).put(blobRecord);
        tx.objectStore(JOBS_STORE).put(jobRecord);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("Migration write failed"));
      });

      // Verify post-copy integrity
      const verified = await getOutboxEntry(legacy.id);
      if (!verified?.blob || verified.blob.data.byteLength !== arrayBuffer.byteLength) {
        failed++;
      } else {
        migrated++;
      }
    } catch (err) {
      failed++;
      audioLogError("outbox:migrate-v1-failed", err, { id: legacy.id });
    } finally {
      releaseAudioJobLock(legacy.id);
    }
  }

  if (migrated > 0) {
    audioLog("outbox:migrated-v1", { migrated, skipped, failed });
    notifyVaultListeners();
  }
  return { migrated, skipped, failed };
}

/**
 * Retention sweep: removes ONLY confirmed (`sent` / `delivered` / `read`) or
 * `discarded` outbox records older than 48h or exceeding the cap of 50
 * confirmed recordings. NEVER deletes drafts, queued, in-flight, or failed
 * recordings.
 */
export async function pruneConfirmedOutboxEntries(now = Date.now()): Promise<number> {
  const all = await listAllOutboxJobs();
  const confirmed = all
    .filter((j) => isConfirmedAudioStatus(j.status) || j.status === "discarded")
    .sort((a, b) => (b.confirmedAt ?? b.updatedAt) - (a.confirmedAt ?? a.updatedAt));

  const toDelete: string[] = [];
  confirmed.forEach((job, index) => {
    const refTime = job.confirmedAt ?? job.updatedAt;
    if (index >= CONFIRMED_MAX_KEEP || now - refTime > CONFIRMED_RETENTION_MS) {
      toDelete.push(job.id);
    }
  });

  for (const id of toDelete) {
    await deleteOutboxEntry(id);
  }
  return toDelete.length;
}
