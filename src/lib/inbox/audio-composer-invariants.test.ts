import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural regression tests for the critical iOS PWA / Safari audio capture
 * invariants in MessageComposer and MessageThread.
 *
 * Background:
 *   1. Touch gestures wrapped in `setTimeout(..., 0)` lose transient
 *      `navigator.userActivation.isActive` on iOS WebKit, causing `opus-recorder`
 *      `AudioContext.resume()` to stall before `getUserMedia()`.
 *   2. Including `stopRecorder` (which transitively depended on inline parent props)
 *      in MessageComposer's unmount `useEffect` caused React to abort live
 *      recordings mid-session when MessageThread re-rendered, leaving phantom UI.
 */
describe("audio capture React integration invariants", () => {
  const composerSource = readFileSync(
    resolve(process.cwd(), "src/components/inbox/message-composer.tsx"),
    "utf8",
  );
  const threadSource = readFileSync(
    resolve(process.cwd(), "src/components/inbox/message-thread.tsx"),
    "utf8",
  );

  it("does not delay startRecordingGesture behind setTimeout in handleMicPointerDown", () => {
    const startIdx = composerSource.indexOf("const handleMicPointerDown");
    const endIdx = composerSource.indexOf("const handleMicPointerMove");
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);

    const handlerSlice = composerSource.slice(startIdx, endIdx);
    expect(handlerSlice).not.toContain("setTimeout");
    expect(handlerSlice).toContain("startRecordingGesture()");
  });

  it("runs MessageComposer unmount cleanup ONLY on true unmount (empty dependency array)", () => {
    const unmountIdx = composerSource.indexOf("const unmountCleanupRef");
    expect(unmountIdx).toBeGreaterThan(-1);

    const tailSlice = composerSource.slice(unmountIdx, unmountIdx + 650);
    expect(tailSlice).toContain("captureControllerRef.current?.destroy()");
    expect(tailSlice).toContain("}, []);");
    expect(tailSlice).not.toContain("stopRecorder");
  });

  it("memoizes onRecordAudio and onClearReply in MessageThread so re-renders never churn props", () => {
    expect(threadSource).toContain("onRecordAudio={handleRecordAudio}");
    expect(threadSource).toContain("onClearReply={handleClearReply}");
    expect(threadSource).not.toContain("onRecordAudio={(recordId, replyToId) =>");
    expect(threadSource).not.toContain("onClearReply={() => setReplyTo(null)}");
  });
});
