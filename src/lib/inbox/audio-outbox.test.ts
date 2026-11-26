import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canTransitionAudioJob,
  isRetryableAudioJob,
  type AudioOutboxEntry,
} from "./audio-outbox-types";
import {
  getOutboxEntry,
  getRamVaultCount,
  listAllOutboxJobs,
  listOutboxJobsByConversation,
  migrateLegacyPendingAudioToOutbox,
  persistAudioToOutbox,
  pruneConfirmedOutboxEntries,
  resetOutboxConnectionForTests,
  retryPersistFromRamVault,
  updateOutboxJob,
} from "./audio-outbox-db";
import * as legacyDb from "./pending-audio-db";
import { resolveClientFileMime } from "@/lib/storage/upload-media-r2";

describe("audio-outbox-types state machine", () => {
  it("prevents unauthorized drafts from transitioning into send states", () => {
    expect(canTransitionAudioJob("saved_draft", "queued", false)).toBe(false);
    expect(canTransitionAudioJob("saved_draft", "queued", true)).toBe(true);
    expect(canTransitionAudioJob("saved_draft", "discarded", false)).toBe(true);
    expect(canTransitionAudioJob("sent", "queued", true)).toBe(false);
    expect(canTransitionAudioJob("delivered", "read", true)).toBe(true);
    expect(canTransitionAudioJob("discarded", "queued", true)).toBe(false);
  });

  it("never allows retryable UI affordance without recoverable audio bytes or mediaUrl", () => {
    const emptyEntry: AudioOutboxEntry = {
      job: {
        id: "j1",
        clientRef: "j1",
        accountId: "a1",
        userId: "u1",
        conversationId: "c1",
        status: "retryable_failure",
        sendAuthorized: true,
        storageOrigin: "idb_v2",
        attempts: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      blob: null,
    };
    expect(isRetryableAudioJob(emptyEntry)).toBe(false);

    const recoverable: AudioOutboxEntry = {
      ...emptyEntry,
      blob: {
        id: "j1",
        accountId: "a1",
        userId: "u1",
        conversationId: "c1",
        mimeType: "audio/ogg",
        codec: "opus",
        durationMs: 2500,
        sizeBytes: 4,
        createdAt: 1,
        sha256: null,
        data: new Uint8Array([0x4f, 0x67, 0x67, 0x53]).buffer,
      },
    };
    expect(isRetryableAudioJob(recoverable)).toBe(true);
  });
});

describe("audio-outbox-db & emergency RAM vault", () => {
  beforeEach(() => {
    resetOutboxConnectionForTests();
    delete (globalThis as Record<string, unknown>).indexedDB;
  });

  it("preserves audio in emergency RAM vault when IndexedDB is unavailable and enforces account/user isolation", async () => {
    const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]).buffer;
    const res = await persistAudioToOutbox({
      id: "rec-ram-1",
      accountId: "acct-A",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: bytes,
      mimeType: "audio/ogg",
      durationMs: 3200,
      sendAuthorized: false,
    });

    expect(res.persistedInIdb).toBe(false);
    expect(res.job.storageOrigin).toBe("ram_vault");
    expect(res.job.status).toBe("saved_draft");
    expect(getRamVaultCount({ accountId: "acct-A", userId: "user-1" })).toBe(1);
    expect(getRamVaultCount({ accountId: "acct-B", userId: "user-1" })).toBe(0);

    // Isolated by accountId + userId
    expect(await getOutboxEntry("rec-ram-1", { accountId: "acct-B" })).toBeNull();
    const fetched = await getOutboxEntry("rec-ram-1", { accountId: "acct-A", userId: "user-1" });
    expect(fetched?.blob?.data.byteLength).toBe(8);

    // Refuses unauthorized transition from saved_draft -> queued
    await expect(updateOutboxJob("rec-ram-1", { status: "queued" })).rejects.toThrow(/Invalid audio job transition/);

    // Succeeds when user explicitly authorizes send
    const authorized = await updateOutboxJob("rec-ram-1", {
      sendAuthorized: true,
      status: "queued",
    });
    expect(authorized?.status).toBe("queued");

    const byConv = await listOutboxJobsByConversation({
      accountId: "acct-A",
      conversationId: "conv-1",
    });
    expect(byConv).toHaveLength(1);
  });

  it("flushes RAM vault entry to IndexedDB once IndexedDB recovers, and retention preserves pending/failed items", async () => {
    const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 9, 9]).buffer;
    await persistAudioToOutbox({
      id: "rec-1",
      accountId: "acct-A",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: bytes,
      mimeType: "audio/ogg",
      durationMs: 1200,
      sendAuthorized: true,
      initialStatus: "retryable_failure",
    });
    await persistAudioToOutbox({
      id: "rec-confirmed-old",
      accountId: "acct-A",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: new Uint8Array([0x4f, 0x67, 0x67, 0x53]).buffer,
      mimeType: "audio/ogg",
      durationMs: 1000,
      sendAuthorized: true,
      initialStatus: "sent",
      createdAt: 1000,
    });
    await updateOutboxJob("rec-confirmed-old", { confirmedAt: 1000 });

    // Retention sweep removes >48h confirmed items but NEVER removes retryable_failure
    const pruned = await pruneConfirmedOutboxEntries(1000 + 49 * 60 * 60 * 1000);
    expect(pruned).toBe(1);
    const remaining = await listAllOutboxJobs({ accountId: "acct-A" });
    expect(remaining.map((r) => r.id)).toEqual(["rec-1"]);

    // Now mock a working IndexedDB and flush RAM vault
    const putMock = vi.fn();
    (globalThis as Record<string, unknown>).indexedDB = {
      open: vi.fn(() => {
        const req: Record<string, unknown> = {};
        setTimeout(() => {
          req.result = {
            objectStoreNames: { contains: () => true },
            transaction: () => {
              const tx: Record<string, unknown> = {
                objectStore: () => ({ put: putMock }),
              };
              setTimeout(() => (tx.oncomplete as (() => void) | undefined)?.(), 0);
              return tx;
            },
          };
          (req.onsuccess as (() => void) | undefined)?.();
        }, 0);
        return req;
      }),
    };

    const flushed = await retryPersistFromRamVault("rec-1");
    expect(flushed).toBe(true);
    expect(putMock).toHaveBeenCalledTimes(2);
    expect(getRamVaultCount()).toBe(0);
  });

  it("maps .ogg and .m4a audio extensions properly in resolveClientFileMime", () => {
    expect(resolveClientFileMime({ name: "voice-123.ogg", type: "" })).toBe("audio/ogg");
    expect(resolveClientFileMime({ name: "voice-123.opus", type: "application/octet-stream" })).toBe("audio/ogg");
    expect(resolveClientFileMime({ name: "voice-123.m4a", type: "" })).toBe("audio/mp4");
  });

  it("migrates legacy v1 records idempotently without auto-sending ambiguous drafts", async () => {
    const storeJobs = new Map<string, unknown>();
    const storeBlobs = new Map<string, unknown>();
    (globalThis as Record<string, unknown>).indexedDB = {
      open: vi.fn(() => {
        const req: Record<string, unknown> = {};
        setTimeout(() => {
          req.result = {
            objectStoreNames: { contains: () => true },
            transaction: (_stores: unknown, _mode?: string) => {
              const tx: Record<string, unknown> = {};
              tx.objectStore = (name: string) => ({
                put: (val: { id: string }) => {
                  if (name === "audio_jobs") storeJobs.set(val.id, val);
                  else storeBlobs.set(val.id, val);
                },
                get: (id: string) => {
                  const getReq: Record<string, unknown> = {
                    result: name === "audio_jobs" ? storeJobs.get(id) : storeBlobs.get(id),
                  };
                  queueMicrotask(() => (getReq.onsuccess as (() => void) | undefined)?.());
                  return getReq;
                },
              });
              setTimeout(() => (tx.oncomplete as (() => void) | undefined)?.(), 5);
              return tx;
            },
          };
          (req.onsuccess as (() => void) | undefined)?.();
        }, 0);
        return req;
      }),
    };

    const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);
    vi.spyOn(legacyDb, "listAllPendingAudio").mockResolvedValue([
      {
        id: "leg-draft",
        conversationId: "conv-1",
        blob: new Blob([bytes], { type: "audio/ogg" }),
        mimeType: "audio/ogg",
        sizeBytes: bytes.byteLength,
        createdAt: 100,
        updatedAt: 100,
        status: "uploading",
        attempts: 0,
      },
      {
        id: "leg-failed",
        conversationId: "conv-1",
        blob: new Blob([bytes], { type: "audio/ogg" }),
        mimeType: "audio/ogg",
        sizeBytes: bytes.byteLength,
        createdAt: 200,
        updatedAt: 200,
        status: "failed-send",
        mediaUrl: "acct-A/audio/1.ogg",
        path: "acct-A/audio/1.ogg",
        storageProvider: "r2",
        attempts: 1,
        lastError: "HTTP 502",
      },
    ]);

    const first = await migrateLegacyPendingAudioToOutbox({ accountId: "acct-A", userId: "u1" });
    expect(first).toEqual({ migrated: 2, skipped: 0, failed: 0 });

    const draftJob = storeJobs.get("leg-draft") as { status: string; sendAuthorized: boolean; requiresUserDecision?: boolean };
    expect(draftJob.status).toBe("saved_draft");
    expect(draftJob.sendAuthorized).toBe(false);
    expect(draftJob.requiresUserDecision).toBe(true);

    const failedJob = storeJobs.get("leg-failed") as { status: string; sendAuthorized: boolean; r2Key?: string };
    expect(failedJob.status).toBe("retryable_failure");
    expect(failedJob.sendAuthorized).toBe(true);
    expect(failedJob.r2Key).toBe("acct-A/audio/1.ogg");

    // Idempotent second run skips both
    const second = await migrateLegacyPendingAudioToOutbox({ accountId: "acct-A", userId: "u1" });
    expect(second).toEqual({ migrated: 0, skipped: 2, failed: 0 });
  });
});
