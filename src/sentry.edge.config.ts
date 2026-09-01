import * as Sentry from "@sentry/nextjs";

// Runs for the Edge runtime (middleware.ts). Same DSN/rationale as
// sentry.server.config.ts.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});
