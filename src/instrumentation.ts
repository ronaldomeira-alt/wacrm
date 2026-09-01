import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Captures errors that escape a Server Component, Route Handler, Server
// Action, or the proxy layer — the ones Next.js itself catches. Errors
// caught and swallowed inside a try/catch (the vast majority in this
// codebase — see src/lib/observability/log.ts) need an explicit
// logError() call instead, since they never reach this hook.
export const onRequestError = Sentry.captureRequestError;
