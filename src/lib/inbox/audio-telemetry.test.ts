import { beforeEach, describe, expect, it } from "vitest";
import {
  classifySendErrorCategory,
  classifyUploadErrorCategory,
  clearAudioDiagnosticSessions,
  detectIosVersion,
  getAudioDiagnosticSession,
  getAudioDiagnosticSessions,
  startAudioDiagnosticSession,
  updateAudioDiagnosticSession,
} from "./audio-telemetry";

describe("audio-telemetry", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
      navigator: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15",
      },
    };
    clearAudioDiagnosticSessions();
  });

  it("extracts iOS version safely from user agent", () => {
    expect(
      detectIosVersion(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4_1 like Mac OS X) AppleWebKit/605.1.15",
      ),
    ).toBe("18.4.1");
    expect(detectIosVersion("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBeNull();
  });

  it("caps ring buffer at 60 sessions and redacts URLs/Bearer tokens in errorDetail", () => {
    for (let i = 0; i < 65; i++) {
      startAudioDiagnosticSession({ recordingId: `rec-${i}` });
    }
    const all = getAudioDiagnosticSessions();
    expect(all.length).toBe(60);
    expect(getAudioDiagnosticSession("rec-0")).toBeNull();
    expect(getAudioDiagnosticSession("rec-64")).not.toBeNull();

    const updated = updateAudioDiagnosticSession("rec-64", (prev) => ({
      ...prev,
      errorDetail: "Failed https://secret-signed.r2.dev/foo?X-Amz-Signature=abc Bearer tok123",
    }));
    expect(updated.errorDetail).not.toContain("secret-signed.r2.dev");
    expect(updated.errorDetail).not.toContain("tok123");
    expect(updated.errorDetail).toContain("[url]");
    expect(updated.errorDetail).toContain("Bearer [redacted]");
  });

  it("classifies upload and send failure categories accurately", () => {
    expect(classifySendErrorCategory("A send for this client_ref is already in progress", 409)).toBe(
      "send_conflict",
    );
    expect(classifySendErrorCategory("session_expired")).toBe("send_session_expired");
    expect(classifySendErrorCategory("AbortError: The operation was aborted")).toBe("send_timeout");
    expect(classifyUploadErrorCategory("voice-note upload timed out")).toBe("upload_timeout");
    expect(classifyUploadErrorCategory("HTTP 502")).toBe("upload_http_error");
  });
});
