import { createHash } from 'crypto'

const OPENCODE_GO_USAGE_URLS = [
  'https://opencode.ai/zen/go/v1/usage',
  'https://opencode.ai/inference/go/v1/usage',
]
const QUOTA_CACHE_TTL_MS = 60_000
const QUOTA_FETCH_TIMEOUT_MS = 5_000

export interface QuotaWindowSnapshot {
  usageDollars: number
  limitDollars: number
  usagePercent: number
  resetInSec: number | null
  resetAt: string | null
}

export interface OpenCodeQuotaStatus {
  status: 'ok' | 'unavailable' | 'auth_failed'
  fiveHour: QuotaWindowSnapshot | null
  weekly: QuotaWindowSnapshot | null
  monthly: QuotaWindowSnapshot | null
  fetchedAt: string
  error?: string
}

export interface OpenCodeQuotaDecision {
  allowed: boolean
  reason: string | null
  quotaExhausted: boolean
  resetAt: string | null
  snapshot: OpenCodeQuotaStatus
}

interface CacheEntry {
  expiresAt: number
  status: OpenCodeQuotaStatus
}

const quotaCache = new Map<string, CacheEntry>()

export function clearOpenCodeQuotaCache(): void {
  quotaCache.clear()
}

function keyHash(apiKey: string): string {
  return createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 16)
}

function parseWindow(raw: unknown): QuotaWindowSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0

  const usageDollars = num(r.usageDollars ?? r.usage_dollars ?? r.used)
  const limitDollars = num(r.limitDollars ?? r.limit_dollars ?? r.limit)
  let usagePercent = num(r.usagePercent ?? r.usage_percent ?? r.percent)
  if (usagePercent === 0 && limitDollars > 0 && usageDollars > 0) {
    usagePercent = Math.round((usageDollars / limitDollars) * 10_000) / 100
  }

  const resetInSecRaw = r.resetInSec ?? r.reset_in_sec ?? r.resetSeconds
  const resetInSec =
    typeof resetInSecRaw === 'number' && Number.isFinite(resetInSecRaw)
      ? Math.max(0, Math.floor(resetInSecRaw))
      : null

  const resetAtRaw = r.resetsAt ?? r.resetAt ?? r.reset_at
  const resetAt =
    typeof resetAtRaw === 'string' && resetAtRaw.trim()
      ? resetAtRaw
      : resetInSec !== null
        ? new Date(Date.now() + resetInSec * 1000).toISOString()
        : null

  return {
    usageDollars,
    limitDollars,
    usagePercent,
    resetInSec,
    resetAt,
  }
}

/**
 * Fetch live quota usage from OpenCode Go's official `/zen/go/v1/usage` endpoint.
 * Never throws: returns `status: 'unavailable'` on network/5xx errors so callers
 * do NOT falsely treat endpoint downtime as quota exhaustion.
 */
export async function fetchOpenCodeGoQuota(
  apiKey: string,
  opts: { bypassCache?: boolean } = {},
): Promise<OpenCodeQuotaStatus> {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    return {
      status: 'auth_failed',
      fiveHour: null,
      weekly: null,
      monthly: null,
      fetchedAt: new Date().toISOString(),
      error: 'Missing OpenCode Go API key',
    }
  }

  const cacheKey = keyHash(trimmed)
  const cached = quotaCache.get(cacheKey)
  if (!opts.bypassCache && cached && cached.expiresAt > Date.now()) {
    return cached.status
  }

  const fetchedAt = new Date().toISOString()
  try {
    let res: Response | null = null
    for (const url of OPENCODE_GO_USAGE_URLS) {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmed}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
      })
      if (res.status !== 404) break
    }
    if (!res) {
      return {
        status: 'unavailable',
        fiveHour: null,
        weekly: null,
        monthly: null,
        fetchedAt,
        error: 'No usage endpoint responded',
      }
    }

    if (res.status === 401 || res.status === 403) {
      const authStatus: OpenCodeQuotaStatus = {
        status: 'auth_failed',
        fiveHour: null,
        weekly: null,
        monthly: null,
        fetchedAt,
        error: `HTTP ${res.status}`,
      }
      quotaCache.set(cacheKey, { expiresAt: Date.now() + QUOTA_CACHE_TTL_MS, status: authStatus })
      return authStatus
    }

    if (!res.ok) {
      return {
        status: 'unavailable',
        fiveHour: null,
        weekly: null,
        monthly: null,
        fetchedAt,
        error: `HTTP ${res.status}`,
      }
    }

    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) {
      return {
        status: 'unavailable',
        fiveHour: null,
        weekly: null,
        monthly: null,
        fetchedAt,
        error: 'Invalid JSON response from usage endpoint',
      }
    }

    const root = (
      body.usage && typeof body.usage === 'object' ? body.usage : body
    ) as Record<string, unknown>

    const status: OpenCodeQuotaStatus = {
      status: 'ok',
      fiveHour: parseWindow(root.rolling5h ?? root.five_hour ?? root.rolling),
      weekly: parseWindow(root.weekly ?? root.week),
      monthly: parseWindow(root.monthly ?? root.month),
      fetchedAt,
    }
    quotaCache.set(cacheKey, { expiresAt: Date.now() + QUOTA_CACHE_TTL_MS, status })
    return status
  } catch (err) {
    return {
      status: 'unavailable',
      fiveHour: null,
      weekly: null,
      monthly: null,
      fetchedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface WindowPreventiveRule {
  enabled: boolean
  pct: number
}

export interface OpenCodeWindowRules {
  fiveHour?: WindowPreventiveRule
  weekly?: WindowPreventiveRule
  monthly?: WindowPreventiveRule
}

/**
 * Evaluate whether WACRM is allowed to send inference to OpenCode Go based
 * on independent per-window preventive limits and hard 100% exhaustion:
 * - Real exhaustion (>= 100%) on ANY window ALWAYS blocks and triggers fallback
 *   until that window's `resetAt`.
 * - Preventive threshold only blocks a window when `enabled` is true for that
 *   specific window (defaults: 5h=disabled, weekly=90% enabled, monthly=disabled).
 *
 * Note: If the usage endpoint is unavailable, we return `allowed: true`
 * (fail-open to inference; actual 429/quota errors on inference still
 * trigger immediate fallback).
 */
export async function checkOpenCodeGoQuotaGate(args: {
  apiKey: string
  windows?: OpenCodeWindowRules
  bypassCache?: boolean
}): Promise<OpenCodeQuotaDecision> {
  const rules = {
    fiveHour: args.windows?.fiveHour ?? { enabled: false, pct: 90 },
    weekly: args.windows?.weekly ?? { enabled: true, pct: 90 },
    monthly: args.windows?.monthly ?? { enabled: false, pct: 90 },
  }
  const snapshot = await fetchOpenCodeGoQuota(args.apiKey, {
    bypassCache: args.bypassCache,
  })

  if (snapshot.status === 'auth_failed') {
    return {
      allowed: false,
      reason: 'OpenCode Go API key rejected by usage endpoint',
      quotaExhausted: false,
      resetAt: null,
      snapshot,
    }
  }

  if (snapshot.status === 'unavailable') {
    return {
      allowed: true,
      reason: null,
      quotaExhausted: false,
      resetAt: null,
      snapshot,
    }
  }

  const windows: Array<{
    label: string
    win: QuotaWindowSnapshot | null
    rule: WindowPreventiveRule
  }> = [
    { label: 'janela de 5 horas', win: snapshot.fiveHour, rule: rules.fiveHour },
    { label: 'limite semanal', win: snapshot.weekly, rule: rules.weekly },
    { label: 'limite mensal', win: snapshot.monthly, rule: rules.monthly },
  ]

  for (const { label, win, rule } of windows) {
    if (!win) continue
    if (win.usagePercent >= 100) {
      return {
        allowed: false,
        reason: `Cota OpenCode Go esgotada (${label}: ${win.usagePercent.toFixed(1)}%)`,
        quotaExhausted: true,
        resetAt: win.resetAt,
        snapshot,
      }
    }
    if (rule.enabled && win.usagePercent >= rule.pct) {
      return {
        allowed: false,
        reason: `Limite preventivo atingido (${label}: ${win.usagePercent.toFixed(1)}% >= ${rule.pct}%)`,
        quotaExhausted: true,
        resetAt: win.resetAt,
        snapshot,
      }
    }
  }

  return {
    allowed: true,
    reason: null,
    quotaExhausted: false,
    resetAt: null,
    snapshot,
  }
}
