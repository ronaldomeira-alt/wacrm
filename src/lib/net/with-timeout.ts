/**
 * Generic timeout + retry helpers used to bound network calls that have no
 * cancellation mechanism of their own — see pending-audio-sync.ts for why
 * this exists: supabase-js's Storage `upload()` call doesn't accept an
 * `AbortSignal` (confirmed against the installed @supabase/storage-js
 * build), so on iOS Safari/WKWebView, a fetch that gets suspended mid
 * request when the PWA is backgrounded can leave that promise neither
 * resolving nor rejecting, ever. `withTimeout` can't cancel the
 * underlying request in that case, but it guarantees *this* promise chain
 * always settles, which is what keeps calling UI code from hanging.
 */

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Races `promise` against a timer. If the timer wins, this rejects with a
 * `TimeoutError` — the original `promise` is left running and its eventual
 * settlement (if any) is simply ignored by this wrapper. Callers that
 * retry after a timeout may end up with two attempts of the same
 * operation in flight; for a Storage upload that's a harmless orphaned
 * object at worst (each attempt writes to its own timestamped path).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface RetryOptions {
  /** Number of retries AFTER the first attempt (2 => 3 attempts total). */
  retries: number;
  baseDelayMs: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

/** Exponential backoff retry. Rethrows the last error once retries are exhausted. */
export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === opts.retries) break;
      opts.onRetry?.(attempt + 1, err);
      const delay = opts.baseDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
