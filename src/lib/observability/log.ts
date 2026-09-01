import * as Sentry from "@sentry/nextjs";

/**
 * Logs an error to the console AND reports it to Sentry (a no-op when
 * SENTRY_DSN/NEXT_PUBLIC_SENTRY_DSN isn't set — see instrumentation.ts).
 *
 * Use this at "swallowed" catch sites — a failure that's caught, logged,
 * and degrades gracefully instead of rethrowing. Those never reach
 * Next.js's onRequestError (that only fires for errors that escape a
 * Server Component/Route Handler/Action), so without an explicit call
 * here they're invisible outside the server's own console — exactly how
 * the PDF-thumbnail regression (2026-08-29/30) and the automation
 * dispatch bugs (#301, #409) went undetected for days.
 */
export function logError(
  scope: string,
  error: unknown,
  extra?: Record<string, unknown>
): void {
  console.error(`[${scope}]`, error);
  Sentry.captureException(error, { tags: { scope }, extra });
}
