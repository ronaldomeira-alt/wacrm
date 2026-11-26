import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOutboxEntry,
  persistAudioToOutbox,
  resetOutboxConnectionForTests,
  updateOutboxJob,
} from "./audio-outbox-db";
import {
  authorizeAndSendDraftJob,
  computeBackoffWithJitterMs,
  discardOutboxAudioJob,
  isPermanentSendError,
  processOutboxAudioJob,
  reconcileOutboxAudioJob,
  scanAndRetryOutboxAudio,
} from "./audio-outbox-sync";

const mocks = vi.hoisted(() => ({
  presignAndUpload: vi.fn(),
  deleteR2Media: vi.fn(),
  uploadAccountMedia: vi.fn(),
  deleteAccountMedia: vi.fn(),
  isIPhoneSafariPwa: vi.fn(),
  updateAudioDiagnosticSession: vi.fn(),
}));

vi.mock("@/lib/storage/upload-media-r2", () => ({
  presignAndUpload: mocks.presignAndUpload,
  deleteR2Media: mocks.deleteR2Media,
  resolveClientFileMime: vi.fn(() => "audio/ogg"),
}));

vi.mock("@/lib/storage/upload-media", () => ({
  CHAT_MEDIA_BUCKET: "chat-media",
  uploadAccountMedia: mocks.uploadAccountMedia,
  deleteAccountMedia: mocks.deleteAccountMedia,
}));

vi.mock("./audio-upload-target", () => ({
  isIPhoneSafariPwa: mocks.isIPhoneSafariPwa,
}));

vi.mock("./audio-telemetry", () => ({
  classifyUploadErrorCategory: vi.fn((msg: string) =>
    msg.toLowerCase().includes("timed out") ? "upload_timeout" : "upload_network",
  ),
  classifySendErrorCategory: vi.fn((_msg: string, httpStatus?: number) =>
    httpStatus === 422 ? "session_expired" : "send_http_5xx",
  ),
  updateAudioDiagnosticSession: mocks.updateAudioDiagnosticSession,
}));

function makeAudioBuffer(seed = 1): ArrayBuffer {
  return new Uint8Array([0x4f, 0x67, 0x67, 0x53, seed, 9, 8, 7]).buffer;
}

describe("audio-outbox-sync worker", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetOutboxConnectionForTests();
    delete (globalThis as Record<string, unknown>).indexedDB;
    mocks.isIPhoneSafariPwa.mockReturnValue(true);
    mocks.presignAndUpload.mockResolvedValue({ key: "acct-1/audio/rec-default.ogg" });
    mocks.deleteR2Media.mockResolvedValue(undefined);
    mocks.uploadAccountMedia.mockResolvedValue({
      publicUrl: "https://supa.example/audio.ogg",
      path: "acct-1/audio.ogg",
    });
    mocks.deleteAccountMedia.mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("enforces single-flight mutex per recording id", async () => {
    await persistAudioToOutbox({
      id: "job-lock-1",
      accountId: "acct-1",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: makeAudioBuffer(1),
      mimeType: "audio/ogg",
      durationMs: 3000,
      sendAuthorized: true,
    });

    let releaseUpload!: () => void;
    mocks.presignAndUpload.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseUpload = () => resolve({ key: "acct-1/audio/job-lock-1.ogg" });
        }),
    );

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ message_id: "db-1", whatsapp_message_id: "wamid.1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const firstPromise = processOutboxAudioJob("job-lock-1");
    await new Promise((r) => setTimeout(r, 15));

    const secondResult = await processOutboxAudioJob("job-lock-1");
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) {
      expect(secondResult.error).toContain("already in flight");
    }

    releaseUpload();
    const firstResult = await firstPromise;
    expect(firstResult.ok).toBe(true);
    expect(mocks.presignAndUpload).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to send unauthorized saved_draft jobs and preserves local ArrayBuffer on HTTP 200", async () => {
    await persistAudioToOutbox({
      id: "job-draft-1",
      accountId: "acct-1",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: makeAudioBuffer(2),
      mimeType: "audio/ogg",
      durationMs: 4000,
      sendAuthorized: false,
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ message_id: "db-2", whatsapp_message_id: "wamid.2" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    // Attempting to process directly or via scan must NEVER upload/send saved_draft
    const blocked = await processOutboxAudioJob("job-draft-1");
    expect(blocked.ok).toBe(false);
    await scanAndRetryOutboxAudio({ accountId: "acct-1", userId: "user-1" });
    expect(mocks.presignAndUpload).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    // Explicit user authorization proceeds and retains local ArrayBuffer after HTTP 200
    const sent = await authorizeAndSendDraftJob("job-draft-1");
    expect(sent.ok).toBe(true);
    expect(sent.job?.status).toBe("sent");
    expect(sent.job?.wamid).toBe("wamid.2");
    expect(sent.job?.confirmedAt).toBeTypeOf("number");

    const postSendEntry = await getOutboxEntry("job-draft-1");
    expect(postSendEntry?.blob?.data.byteLength).toBe(8);
  });

  it("reuses previously uploaded mediaUrl/r2Key on retry instead of re-uploading", async () => {
    await persistAudioToOutbox({
      id: "job-reuse-1",
      accountId: "acct-1",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: makeAudioBuffer(3),
      mimeType: "audio/ogg",
      durationMs: 2500,
      sendAuthorized: true,
    });
    await updateOutboxJob("job-reuse-1", {
      status: "retryable_failure",
      mediaUrl: "acct-1/audio/already-uploaded.ogg",
      r2Key: "acct-1/audio/already-uploaded.ogg",
      storageProvider: "r2",
      attempts: 1,
      nextRetryAt: Date.now() - 1000,
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ message_id: "db-3", whatsapp_message_id: "wamid.3" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const res = await processOutboxAudioJob("job-reuse-1");
    expect(res.ok).toBe(true);
    expect(mocks.presignAndUpload).not.toHaveBeenCalled();
    expect(mocks.uploadAccountMedia).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.media_url).toBe("acct-1/audio/already-uploaded.ogg");
    expect(body.client_ref).toBe("job-reuse-1");
    expect((init.headers as Record<string, string>)["x-correlation-id"]).toBe("job-reuse-1");
  });

  it("classifies permanent 422 errors, retryable 502 errors, and ambiguous AbortErrors while preserving ArrayBuffer", async () => {
    // 1) Permanent 422 error
    await persistAudioToOutbox({
      id: "job-perm-422",
      accountId: "acct-1",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: makeAudioBuffer(4),
      mimeType: "audio/ogg",
      durationMs: 1800,
      sendAuthorized: true,
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Janela 24h expirada", code: "session_expired" }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );
    const permRes = await processOutboxAudioJob("job-perm-422");
    expect(permRes.ok).toBe(false);
    expect(permRes.job?.status).toBe("permanent_failure");
    expect((await getOutboxEntry("job-perm-422"))?.blob?.data.byteLength).toBe(8);

    // 2) Retryable 502 error
    await persistAudioToOutbox({
      id: "job-retry-502",
      accountId: "acct-1",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: makeAudioBuffer(5),
      mimeType: "audio/ogg",
      durationMs: 1800,
      sendAuthorized: true,
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Bad Gateway" }), { status: 502 }),
    );
    const retryRes = await processOutboxAudioJob("job-retry-502");
    expect(retryRes.ok).toBe(false);
    expect(retryRes.job?.status).toBe("retryable_failure");
    expect(retryRes.job?.nextRetryAt).toBeGreaterThan(Date.now() - 100);
    expect((await getOutboxEntry("job-retry-502"))?.blob?.data.byteLength).toBe(8);

    // 3) Ambiguous AbortError after upload -> awaiting_confirmation (never blindly resend)
    await persistAudioToOutbox({
      id: "job-abort-ambig",
      accountId: "acct-1",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: makeAudioBuffer(6),
      mimeType: "audio/ogg",
      durationMs: 1800,
      sendAuthorized: true,
    });
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    globalThis.fetch = vi.fn().mockRejectedValue(abortErr);

    const abortRes = await processOutboxAudioJob("job-abort-ambig");
    expect(abortRes.ok).toBe(false);
    expect(abortRes.job?.status).toBe("awaiting_confirmation");
    expect((await getOutboxEntry("job-abort-ambig"))?.blob?.data.byteLength).toBe(8);

    expect(isPermanentSendError(new Error("unsupported_mime_type"))).toBe(true);
    expect(computeBackoffWithJitterMs(2)).toBeGreaterThanOrEqual(8000);
  });

  it("refuses remote media deletion when discarding sending/sent/awaiting_confirmation jobs, but cleans unsent failures", async () => {
    for (const status of ["sending", "awaiting_confirmation", "sent"] as const) {
      const id = `job-protected-${status}`;
      await persistAudioToOutbox({
        id,
        accountId: "acct-1",
        userId: "user-1",
        conversationId: "conv-1",
        arrayBuffer: makeAudioBuffer(7),
        mimeType: "audio/ogg",
        durationMs: 1200,
        sendAuthorized: true,
        initialStatus: status,
      });
      await updateOutboxJob(id, {
        r2Key: `acct-1/audio/${id}.ogg`,
        mediaUrl: `acct-1/audio/${id}.ogg`,
        storageProvider: "r2",
      });
      await discardOutboxAudioJob(id);
    }
    expect(mocks.deleteR2Media).not.toHaveBeenCalled();

    await persistAudioToOutbox({
      id: "job-safe-discard",
      accountId: "acct-1",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: makeAudioBuffer(8),
      mimeType: "audio/ogg",
      durationMs: 1200,
      sendAuthorized: true,
      initialStatus: "retryable_failure",
    });
    await updateOutboxJob("job-safe-discard", {
      r2Key: "acct-1/audio/job-safe-discard.ogg",
      mediaUrl: "acct-1/audio/job-safe-discard.ogg",
      storageProvider: "r2",
    });
    await discardOutboxAudioJob("job-safe-discard");
    expect(mocks.deleteR2Media).toHaveBeenCalledWith("acct-1/audio/job-safe-discard.ogg");
    expect(await getOutboxEntry("job-safe-discard")).toBeNull();
  });

  it("reconciles awaiting_confirmation jobs read-only without blind resends", async () => {
    // 1) Server already confirmed -> marks sent, never calls send POST
    await persistAudioToOutbox({
      id: "job-rec-confirmed",
      accountId: "acct-1",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: makeAudioBuffer(9),
      mimeType: "audio/ogg",
      durationMs: 2200,
      sendAuthorized: true,
      initialStatus: "awaiting_confirmation",
    });
    const fetchMock1 = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          state: "confirmed",
          message_id: "db-confirmed",
          whatsapp_message_id: "wamid.confirmed",
          status: "delivered",
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock1;
    const res1 = await reconcileOutboxAudioJob("job-rec-confirmed");
    expect(res1.reconciled).toBe(true);
    expect(res1.job?.status).toBe("delivered");
    expect(res1.job?.wamid).toBe("wamid.confirmed");
    expect(fetchMock1).toHaveBeenCalledTimes(1);

    // 2) Ambiguous dispatch -> blocks automatic resend and requires user confirmation
    await persistAudioToOutbox({
      id: "job-rec-ambiguous",
      accountId: "acct-1",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: makeAudioBuffer(10),
      mimeType: "audio/ogg",
      durationMs: 2200,
      sendAuthorized: true,
      initialStatus: "awaiting_confirmation",
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ state: "ambiguous_dispatch" }), { status: 200 }),
    );
    const res2 = await reconcileOutboxAudioJob("job-rec-ambiguous");
    expect(res2.reconciled).toBe(true);
    expect(res2.job?.status).toBe("permanent_failure");
    expect(res2.job?.requiresUserDecision).toBe(true);

    // 3) safe_to_retry -> retries send automatically using existing mediaUrl
    await persistAudioToOutbox({
      id: "job-rec-retry",
      accountId: "acct-1",
      userId: "user-1",
      conversationId: "conv-1",
      arrayBuffer: makeAudioBuffer(11),
      mimeType: "audio/ogg",
      durationMs: 2200,
      sendAuthorized: true,
      initialStatus: "awaiting_confirmation",
    });
    await updateOutboxJob("job-rec-retry", {
      mediaUrl: "acct-1/audio/job-rec-retry.ogg",
      r2Key: "acct-1/audio/job-rec-retry.ogg",
      storageProvider: "r2",
    });
    const fetchMock3 = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/reconcile")) {
        return new Response(JSON.stringify({ state: "safe_to_retry" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ message_id: "db-retry-ok", whatsapp_message_id: "wamid.retry" }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock3;
    const res3 = await reconcileOutboxAudioJob("job-rec-retry");
    expect(res3.reconciled).toBe(true);
    expect(res3.job?.status).toBe("sent");
    expect(res3.job?.wamid).toBe("wamid.retry");
  });
});
