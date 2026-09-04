import { describe, expect, it, vi } from "vitest";
import { withTimeout, retryAsync, TimeoutError } from "./with-timeout";

describe("withTimeout", () => {
  it("resolves with the original value when it settles before the timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "test")).resolves.toBe("ok");
  });

  it("rejects with TimeoutError once the timeout elapses, even if the original promise never settles", async () => {
    // A promise that never resolves/rejects — simulates the exact iOS
    // Safari/WKWebView fetch-hang this pipeline exists to survive.
    const neverSettles = new Promise<string>(() => {});
    await expect(withTimeout(neverSettles, 20, "hung upload")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("propagates the original rejection when it rejects before the timeout", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 50, "test")).rejects.toThrow("boom");
  });
});

describe("retryAsync", () => {
  it("returns the first successful attempt without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("done");
    const result = await retryAsync(fn, { retries: 2, baseDelayMs: 0 });
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to the configured count then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce("done");
    const result = await retryAsync(fn, { retries: 2, baseDelayMs: 0 });
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error once retries are exhausted, never hanging", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(retryAsync(fn, { retries: 2, baseDelayMs: 0 })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("calls onRetry with the attempt number and error for each retry", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("first")).mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    await retryAsync(fn, { retries: 2, baseDelayMs: 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });
});
