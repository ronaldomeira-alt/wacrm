import * as Sentry from "@sentry/nextjs";

// Same DSN as the client (src/instrumentation-client.ts) — Sentry DSNs
// are meant to be public, so there's no downside to sharing one across
// runtimes instead of managing separate server/client secrets.
// `enabled` short-circuits to a full no-op (not just "no events sent")
// when unset, so this is safe to ship before SENTRY_DSN exists in any
// environment (CI, local dev without the var, etc).
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});
