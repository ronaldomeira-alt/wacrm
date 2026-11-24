import { createHash } from 'crypto'

const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
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

  const resetAtRaw = r.resetAt ?? r.reset_at
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
    const res = await fetch(OPENCODE_GO_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${trimmed}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
    })

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

    const status: OpenCodeQuotaStatus = {
      status: 'ok',
      fiveHour: parseWindow(body.rolling5h ?? body.five_hour ?? body.rolling),
      weekly: parseWindow(body.weekly ?? body.week),
      monthly: parseWindow(body.monthly ?? body.month),
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

/**
 * Evaluate whether WACRM is allowed to send inference to OpenCode Go based
 * on the global preventive threshold (default 75% across 5h/weekly/monthly)
 * and hard 100% exhaustion.
 *
 * Note: If the usage endpoint is unavailable, we return `allowed: true`
 * (fail-open to inference; actual 429/quota errors on inference still
 * trigger immediate fallback).
 */
export async function checkOpenCodeGoQuotaGate(args: {
  apiKey: string
  globalPreventivePct?: number
  bypassCache?: boolean
}): Promise<OpenCodeQuotaDecision> {
  const preventivePct = args.globalPreventivePct ?? 75
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

  const windows: Array<{ label: string; win: QuotaWindowSnapshot | null }> = [
    { label: 'janela de 5 horas', win: snapshot.fiveHour },
    { label: 'limite semanal', win: snapshot.weekly },
    { label: 'limite mensal', win: snapshot.monthly },
  ]

  for (const { label, win } of windows) {
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
    if (win.usagePercent >= preventivePct) {
      return {
        allowed: false,
        reason: `Limite preventivo global atingido (${label}: ${win.usagePercent.toFixed(1)}% >= ${preventivePct}%)`,
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
