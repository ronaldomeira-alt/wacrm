import { describe, expect, it } from "vitest";
import { isSafariOrIOS, shouldUseIPhonePwaAudioUpload } from "./audio-upload-target";

describe("isSafariOrIOS", () => {
  it("detects iPhone user agents", () => {
    expect(
      isSafariOrIOS(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
    expect(
      isSafariOrIOS(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
  });

  it("detects macOS Safari", () => {
    expect(
      isSafariOrIOS(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      ),
    ).toBe(true);
  });

  it("returns false for Windows Chrome and Android", () => {
    expect(
      isSafariOrIOS(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(
      isSafariOrIOS(
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.102 Mobile Safari/537.36",
      ),
    ).toBe(false);
  });
});

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
