import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { fetchOpenCodeGoQuota } from '@/lib/ai/opencode-quota'
import { AI_USAGE_MODES } from '@/lib/ai/usage'

export const dynamic = 'force-dynamic'

type DatePreset = 'today' | '3d' | '7d' | '15d' | '30d' | 'month' | 'custom'

function saoPauloStartOfDay(date: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const y = parts.find((p) => p.type === 'year')?.value ?? '2026'
  const m = parts.find((p) => p.type === 'month')?.value ?? '01'
  const d = parts.find((p) => p.type === 'day')?.value ?? '01'
  return new Date(`${y}-${m}-${d}T00:00:00-03:00`)
}

function resolveDateRange(url: URL): {
  preset: DatePreset
  startAt: Date
  endAt: Date
  days: number
} {
  const presetParam = (url.searchParams.get('preset') || '') as DatePreset
  const legacyDays = Number(url.searchParams.get('days'))
  const now = new Date()
  const todayStart = saoPauloStartOfDay(now)

  if (presetParam === 'custom') {
    const startRaw = url.searchParams.get('startDate')
    const endRaw = url.searchParams.get('endDate')
    const startParsed = startRaw ? new Date(`${startRaw}T00:00:00-03:00`) : null
    const endParsed = endRaw ? new Date(`${endRaw}T23:59:59.999-03:00`) : null
    if (
      startParsed &&
      endParsed &&
      !Number.isNaN(startParsed.getTime()) &&
      !Number.isNaN(endParsed.getTime()) &&
      startParsed <= endParsed
    ) {
      const days = Math.max(
        1,
        Math.ceil((endParsed.getTime() - startParsed.getTime()) / 86_400_000),
      )
      return { preset: 'custom', startAt: startParsed, endAt: endParsed, days }
    }
  }

  if (presetParam === 'today') {
    return { preset: 'today', startAt: todayStart, endAt: now, days: 1 }
  }
  if (presetParam === 'month') {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(now)
    const y = parts.find((p) => p.type === 'year')?.value ?? '2026'
    const m = parts.find((p) => p.type === 'month')?.value ?? '01'
    const monthStart = new Date(`${y}-${m}-01T00:00:00-03:00`)
    const days = Math.max(
      1,
      Math.ceil((now.getTime() - monthStart.getTime()) / 86_400_000),
    )
    return { preset: 'month', startAt: monthStart, endAt: now, days }
  }

  const presetDaysMap: Record<string, number> = {
    '3d': 3,
    '7d': 7,
    '15d': 15,
    '30d': 30,
  }
  const days =
    presetDaysMap[presetParam] ??
    (Number.isFinite(legacyDays) && legacyDays >= 1
      ? Math.min(365, Math.floor(legacyDays))
      : 30)

  const startAt = new Date(todayStart.getTime() - (days - 1) * 86_400_000)
  const effectivePreset: DatePreset =
    presetParam in presetDaysMap
      ? presetParam
      : days === 3
        ? '3d'
        : days === 7
          ? '7d'
          : days === 15
            ? '15d'
            : '30d'

  return { preset: effectivePreset, startAt, endAt: now, days }
}

/**
 * GET /api/ai/usage  (admin+)
 *
 * Uses PostgreSQL aggregation RPC `get_ai_usage_summary` to aggregate
 * over arbitrary row counts (1k, 10k, 20k+) without PostgREST's 1,000-row cap.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const adminDb = supabaseAdmin()
    const url = new URL(request.url)

    const { preset, startAt, endAt, days } = resolveDateRange(url)
    const provider = url.searchParams.get('provider') || null
    const model = url.searchParams.get('model') || null
    const mode = url.searchParams.get('mode') || null

    const { data, error } = await adminDb.rpc('get_ai_usage_summary', {
      p_account_id: accountId,
      p_start_at: startAt.toISOString(),
      p_end_at: endAt.toISOString(),
      p_provider: provider,
      p_model: model,
      p_mode: mode,
    })

    if (error) {
      console.error('[ai/usage GET] RPC error:', error)
      return NextResponse.json(
        { error: 'Falha ao carregar consumo de IA.' },
        { status: 500 },
      )
    }

    const summary = (data ?? {}) as {
      totals?: Record<string, unknown>
      by_provider?: unknown[]
      by_mode?: unknown[]
      by_model?: unknown[]
      daily?: unknown[]
    }

    // Fetch OpenCode Go global subscription quota when configured (separate from WACRM logs)
    const config = await loadAiConfig(adminDb, accountId, {
      requireActive: false,
    }).catch(() => null)
    const opencodeQuota = config?.opencodeGoApiKey
      ? await fetchOpenCodeGoQuota(config.opencodeGoApiKey)
      : null

    return NextResponse.json({
      preset,
      window_days: days,
      start_at: startAt.toISOString(),
      end_at: endAt.toISOString(),
      truncated: false,
      modes: AI_USAGE_MODES,
      totals: summary.totals ?? {
        attempts: 0,
        completed_calls: 0,
        failed_calls: 0,
        fallback_calls: 0,
        confirmed_calls: 0,
        estimated_calls: 0,
        unknown_calls: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
        cost_brl: 0,
        avg_latency_ms: null,
      },
      by_provider: summary.by_provider ?? [],
      by_mode: summary.by_mode ?? [],
      by_model: summary.by_model ?? [],
      daily: summary.daily ?? [],
      opencode_subscription: opencodeQuota
        ? {
            quota: opencodeQuota,
            wacrmReservePct: config?.opencodeWacrmReservePct ?? 15,
            globalPreventivePct: config?.opencodeGlobalPreventivePct ?? 75,
          }
        : null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
