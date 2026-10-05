import { describe, expect, it } from "vitest";
import { shouldUseIPhonePwaAudioUpload } from "./audio-upload-target";

describe("shouldUseIPhonePwaAudioUpload", () => {
  it("selects the Safari-installed iPhone PWA", () => {
    expect(
      shouldUseIPhonePwaAudioUpload({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        standalone: true,
      }),
    ).toBe(true);
  });

  it("leaves desktop Chrome, iPhone Safari tabs, and iOS Chrome on the current upload path", () => {
    expect(
      shouldUseIPhonePwaAudioUpload({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36",
        standalone: true,
      }),
    ).toBe(false);
    expect(
      shouldUseIPhonePwaAudioUpload({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        standalone: false,
      }),
    ).toBe(false);
    expect(
      shouldUseIPhonePwaAudioUpload({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1",
        standalone: true,
      }),
    ).toBe(false);
  });
});
