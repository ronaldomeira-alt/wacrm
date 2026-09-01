import * as Sentry from "@sentry/nextjs";

// Browser-side init. NEXT_PUBLIC_SENTRY_DSN is intentionally public —
// Sentry DSNs are safe to ship in client bundles by design (they're
// write-only and rate-limited server-side). Unset in an environment
// (e.g. CI, a fresh local checkout) means `enabled: false`, a full
// no-op — nothing about the app's behavior changes either way.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});
