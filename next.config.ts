import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Baseline security headers applied to every response.
 *
 * CSP ships as `Content-Security-Policy-Report-Only` so the browser
 * surfaces violations in the console without blocking anything — once
 * we have confidence nothing legit trips it (two deploys, a pass on
 * every route), flip the key to `Content-Security-Policy` to enforce.
 *
 * The rest of the headers are straight blocks, safe to enforce today:
 *   - HSTS: only meaningful on HTTPS (no-op on http://localhost).
 *   - X-Content-Type-Options / X-Frame-Options / Referrer-Policy:
 *     baseline OWASP hardening, no behavioural cost.
 *   - Permissions-Policy: we don't use camera / microphone / etc, so
 *     deny them. A supply-chain compromise or a forgotten plugin
 *     can't silently opt back in.
 */
const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // Microphone is allowed for same-origin (`self`) so the inbox
    // composer can record voice notes via MediaRecorder. Everything
    // else stays denied — a compromised dependency can't silently grab
    // the camera / geolocation / etc.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      // Next.js needs 'unsafe-inline' for its inline hydration script
      // and 'unsafe-eval' in dev + some production optimisations.
      // Nonce-based CSP is a later project.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // Tailwind + inline style attributes on lots of components.
      "style-src 'self' 'unsafe-inline'",
      // Supabase public-bucket avatars, contact avatars (arbitrary
      // https URLs paste-able from the UI), OG images, data URLs for
      // tiny inline assets.
      "img-src 'self' data: blob: https:",
      // Outbound media previews (blob: from MediaRecorder + file picker)
      // and Supabase public-bucket audio/video the inbox renders.
      "media-src 'self' blob: https://*.supabase.co",
      "font-src 'self' data:",
      // Supabase REST + realtime (WSS). All Meta API calls happen
      // server-side, so graph.facebook.com does not belong here.
      // unpkg.com: the "more reactions" full emoji picker (frimousse)
      // fetches its emoji dataset from Emojibase's CDN client-side,
      // cached in localStorage afterwards — see message-actions.tsx.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://unpkg.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
] as const;

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the
  // Docker image can run without node_modules or the Next CLI.
  // Harmless outside Docker: `next start` keeps working as before.
  output: "standalone",

  // pdf-to-img's PDF-preview generation (src/lib/documents/pdf-preview.ts)
  // pulls in @napi-rs/canvas, a native-binding package. Letting Turbopack
  // bundle it broke `next build`'s page-data collection for every route
  // that transitively imports send-message.ts (even ones that never
  // touch documents) with "the 'path' argument must be of type string" —
  // a native .node loader path getting mangled by the bundler. Excluding
  // it from bundling (plain require() at runtime instead) fixes that.
  // "baileys" (src/lib/baileys/) is a plain-Node library never meant to
  // be bundled — pino uses dynamic file-based transport loading and ws
  // does native-ish binary framing, both of which break under
  // Turbopack's static bundling the same way @napi-rs/canvas did above.
  // Keeping it external (plain require() at runtime) avoids that class
  // of bug entirely.
  //
  // "pdfjs-dist" is deliberately NOT listed here (it was, until the
  // pre-send PDF viewer added a client-side use of it — see
  // document-fullscreen-preview.tsx): pdf-to-img being external already
  // covers its own nested pdfjs-dist copy via plain Node require()
  // resolution, so listing it again here bought nothing server-side —
  // but it did make Turbopack try to treat the *client* bundle's
  // `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`
  // worker-asset reference as an external require() target too, which
  // fails at build time since pdfjs-dist ships ESM-only ("Package
  // pdfjs-dist can't be external ... require() resolves to a EcmaScript
  // module"). Removing it here fixes that warning without touching the
  // server-side PDF-preview path at all.
  serverExternalPackages: ["pdf-to-img", "@napi-rs/canvas", "baileys"],

  /**
   * pdfjs-dist runtime assets that Next's file tracing cannot see.
   *
   * `output: "standalone"` only ships files `@vercel/nft` can
   * statically prove are reachable. pdf-to-img's nested pdfjs-dist
   * loads its worker through a *computed* specifier — on Node it
   * defaults `GlobalWorkerOptions.workerSrc` to "./pdf.worker.mjs"
   * and then does `await import(this.workerSrc)` (a variable, and
   * additionally marked `webpackIgnore`/`vite-ignore`), so nft has
   * nothing to follow. Result: `.next/standalone` received
   * `legacy/build/pdf.mjs` but not the `legacy/build/pdf.worker.mjs`
   * that sits next to it, and production failed with `Setting up
   * fake worker failed: "Cannot find module .../pdf.worker.mjs"`.
   * Locally it always worked because `next dev` / `next start`
   * resolve out of the real, complete node_modules rather than the
   * traced standalone tree.
   *
   * cmaps/ and standard_fonts/ are the same class of miss:
   * pdf-to-img hands them to `getDocument()` as filesystem paths
   * built at runtime with `path.join(...)` (its dist/index.js),
   * which nft cannot trace either. Without standard_fonts a page
   * using any of the 14 non-embedded standard fonts renders with
   * the wrong glyphs; without cmaps, CJK text renders blank. wasm/
   * and iccs/ back pdfjs's JPEG2000 decoder and ICC colour
   * handling — only some PDFs need them, but they load the same
   * untraceable way.
   *
   * The paths target the *nested* copy on purpose: pdf-to-img pins
   * `pdfjs-dist@~5.6` while this app depends on `^6.3` for the
   * client-side viewer, so npm keeps 5.6 under
   * `pdf-to-img/node_modules/` (pinned in package-lock.json) and
   * that is the copy the server-side thumbnail path actually loads.
   */
  outputFileTracingIncludes: {
    "/*": [
      "node_modules/pdf-to-img/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "node_modules/pdf-to-img/node_modules/pdfjs-dist/standard_fonts/**/*",
      "node_modules/pdf-to-img/node_modules/pdfjs-dist/cmaps/**/*",
      "node_modules/pdf-to-img/node_modules/pdfjs-dist/wasm/**/*",
      "node_modules/pdf-to-img/node_modules/pdfjs-dist/iccs/**/*",
    ],
  },

  /**
   * Cross-origin dev access (Next.js 16).
   *
   * Next 16 blocks requests to dev-only resources (`/_next/*` internals,
   * the HMR websocket, the dev overlay) unless the browser's Origin is
   * the host the dev server booted on — `localhost` by default. Tunnels
   * like ngrok serve the app from a public HTTPS host, so without
   * allow-listing that host those dev requests come back 403: HMR stops
   * working and the dev session degrades over the tunnel (issue #365).
   *
   * Wildcards match subdomains only (Next's CSRF matcher), so the
   * randomised tunnel subdomain is covered. Add any other host via
   * `ALLOWED_DEV_ORIGINS` (comma-separated). This key is dev-only and
   * has no effect on a production build.
   */
  allowedDevOrigins: [
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.ngrok.io",
    "*.trycloudflare.com",
    "*.loca.lt",
    ...(process.env.ALLOWED_DEV_ORIGINS
      ? process.env.ALLOWED_DEV_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
      : []),
  ],

  /**
   * Cache-Control policy.
   *
   * Why this exists:
   *   Hostinger's CDN was applying `s-maxage=31536000` (1 year) to
   *   prerendered HTML pages by default. When a new deploy shipped
   *   fresh Turbopack chunk hashes, the edge kept serving year-old
   *   HTML referencing chunk filenames that no longer existed on
   *   disk — result: HTML 200, every /_next/static/*.js and .css
   *   came back 404, the page rendered unstyled. Private/incognito
   *   did nothing because the cache is server-side.
   *
   * Strategy:
   *   - /_next/static/* — leave to Next. Turbopack dev chunks can go
   *     stale if we force immutable caching here; Next already emits
   *     the correct production headers for hashed assets.
   *   - /api/*          — no-store. API responses are per-user and
   *     must never be shared across requests at the edge.
   *   - Everything else — public, brief s-maxage + generous
   *     stale-while-revalidate. The edge serves instantly from cache
   *     for the first 5 min, then returns cached content while
   *     refreshing in the background for up to 24 h. A deploy's
   *     chunk-hash drift self-heals within ~5 min with no user-
   *     visible latency.
   *
   *   Note: dynamic dashboard routes (/inbox, /contacts, /pipelines,
   *   /broadcasts, etc.) are server-rendered per request — Next.js
   *   and Supabase auth already prevent them from being served
   *   from a shared cache. The s-maxage here is a ceiling; Next.js
   *   and auth middleware still set `private` / `no-store` for
   *   per-user responses.
   *
   * Security headers are appended via a separate catch-all rule
   * below — Next.js merges headers from every matching rule, so
   * they apply to every response regardless of which cache rule
   * matched.
   */
  // Broadcasts → Campaigns (migration 075): the tab was renamed, not
  // duplicated — old bookmarks/links to /broadcasts still land on the
  // right campaign instead of 404ing.
  async redirects() {
    return [
      { source: "/broadcasts", destination: "/campaigns", permanent: false },
      { source: "/broadcasts/:id", destination: "/campaigns/:id", permanent: false },
    ];
  },

  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        source: "/:path((?!_next/static|_next/image|api).*)",
        headers: [
          {
            key: "Cache-Control",
            value:
              "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
          },
        ],
      },
      {
        // Security headers on every response, including /_next/static
        // assets (nosniff matters there) and /api/* (HSTS + referrer-
        // policy don't hurt).
        source: "/:path*",
        headers: [...SECURITY_HEADERS],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
