import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiProvider, CircuitBreakerState } from './types'

export interface CircuitRecord {
  provider: AiProvider
  state: CircuitBreakerState
  consecutiveFailures: number
  lastFailureAt: string | null
  lastFailureReason: string | null
  lastErrorCode: string | null
  openedAt: string | null
  nextProbeAt: string | null
  quotaResetAt: string | null
  probeInFlightUntil: string | null
  lastSuccessAt: string | null
  lastLatencyMs: number | null
}

export interface CircuitCheckResult {
  allowed: boolean
  state: CircuitBreakerState
  isProbe: boolean
  reason: string | null
}

export function isImmediateTripError(code: string): boolean {
  return (
    code === 'invalid_key' ||
    code === 'quota_exhausted' ||
    code === 'insufficient_balance'
  )
}

export function isEligibleForFallback(code: string): boolean {
  return (
    code === 'timeout' ||
    code === 'network_error' ||
    code === 'rate_limited' ||
    code === 'quota_exhausted' ||
    code === 'insufficient_balance' ||
    code === 'invalid_key' ||
    code === 'provider_error' ||
    code === 'empty_response' ||
    code === 'invalid_response'
  )
}

function rowToRecord(row: Record<string, unknown>): CircuitRecord {
  return {
    provider: row.provider as AiProvider,
    state: (row.state as CircuitBreakerState) ?? 'operational',
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    lastFailureAt: (row.last_failure_at as string | null) ?? null,
    lastFailureReason: (row.last_failure_reason as string | null) ?? null,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    openedAt: (row.opened_at as string | null) ?? null,
    nextProbeAt: (row.next_probe_at as string | null) ?? null,
    quotaResetAt: (row.quota_reset_at as string | null) ?? null,
    probeInFlightUntil: (row.probe_in_flight_until as string | null) ?? null,
    lastSuccessAt: (row.last_success_at as string | null) ?? null,
    lastLatencyMs:
      typeof row.last_latency_ms === 'number' ? row.last_latency_ms : null,
  }
}

export async function listProviderCircuits(
  db: SupabaseClient,
  accountId: string,
): Promise<CircuitRecord[]> {
  try {
    const { data, error } = await db
      .from('ai_provider_circuits')
      .select(
        'provider, state, consecutive_failures, last_failure_at, last_failure_reason, last_error_code, opened_at, next_probe_at, quota_reset_at, probe_in_flight_until, last_success_at, last_latency_ms',
      )
      .eq('account_id', accountId)

    if (error || !data) return []
    return (data as Record<string, unknown>[]).map(rowToRecord)
  } catch {
    return []
  }
}

/**
 * Check whether a provider can currently accept inference for this account.
 * When a cooldown/quota window has expired, atomically claims a 45s recovery
 * probe slot (`probe_in_flight_until`) so concurrent requests don't stampede.
 */
export async function canUseProvider(
  db: SupabaseClient | null | undefined,
  accountId: string | null | undefined,
  provider: AiProvider,
): Promise<CircuitCheckResult> {
  if (!db || !accountId) {
    return { allowed: true, state: 'operational', isProbe: false, reason: null }
  }

  try {
    const { data, error } = await db
      .from('ai_provider_circuits')
      .select(
        'state, last_failure_reason, next_probe_at, quota_reset_at, probe_in_flight_until',
      )
      .eq('account_id', accountId)
      .eq('provider', provider)
      .maybeSingle()

    if (error || !data) {
      return { allowed: true, state: 'operational', isProbe: false, reason: null }
    }

    const state = (data.state as CircuitBreakerState) ?? 'operational'
    if (state === 'operational') {
      return { allowed: true, state, isProbe: false, reason: null }
    }
    if (state === 'disabled') {
      return {
        allowed: false,
        state,
        isProbe: false,
        reason: 'Provedor desabilitado manualmente',
      }
    }
    if (state === 'auth_failed') {
      return {
        allowed: false,
        state,
        isProbe: false,
        reason: (data.last_failure_reason as string | null) ?? 'Credencial inválida',
      }
    }

    const nowMs = Date.now()
    const probeUntilMs = data.probe_in_flight_until
      ? new Date(data.probe_in_flight_until as string).getTime()
      : 0

    if (state === 'half_open' && probeUntilMs > nowMs) {
      return {
        allowed: false,
        state,
        isProbe: false,
        reason: 'Verificação de recuperação em andamento por outra requisição',
      }
    }

    const readyAtMs =
      state === 'quota_exhausted'
        ? data.quota_reset_at
          ? new Date(data.quota_reset_at as string).getTime()
          : Number.POSITIVE_INFINITY
        : data.next_probe_at
          ? new Date(data.next_probe_at as string).getTime()
          : 0

    if (nowMs < readyAtMs) {
      return {
        allowed: false,
        state,
        isProbe: false,
        reason:
          (data.last_failure_reason as string | null) ??
          (state === 'quota_exhausted'
            ? 'Cota esgotada aguardando renovação'
            : 'Circuito temporariamente suspenso'),
      }
    }

    // Attempt to claim the single recovery probe slot
    const probeExpiry = new Date(nowMs + 45_000).toISOString()
    const { data: claimed } = await db
      .from('ai_provider_circuits')
      .update({
        state: 'half_open',
        probe_in_flight_until: probeExpiry,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)
      .eq('provider', provider)
      .or(`probe_in_flight_until.is.null,probe_in_flight_until.lt.${new Date(nowMs).toISOString()}`)
      .select('provider')
      .maybeSingle()

    if (!claimed) {
      return {
        allowed: false,
        state: 'half_open',
        isProbe: false,
        reason: 'Verificação de recuperação já reivindicada',
      }
    }

    return { allowed: true, state: 'half_open', isProbe: true, reason: null }
  } catch {
    return { allowed: true, state: 'operational', isProbe: false, reason: null }
  }
}

export async function recordProviderSuccess(
  db: SupabaseClient | null | undefined,
  accountId: string | null | undefined,
  provider: AiProvider,
  latencyMs: number,
): Promise<void> {
  if (!db || !accountId) return
  try {
    const now = new Date().toISOString()
    await db.from('ai_provider_circuits').upsert(
      {
        account_id: accountId,
        provider,
        state: 'operational',
        consecutive_failures: 0,
        next_probe_at: null,
        quota_reset_at: null,
        probe_in_flight_until: null,
        last_success_at: now,
        last_latency_ms: Math.max(0, Math.round(latencyMs)),
        updated_at: now,
      },
      { onConflict: 'account_id,provider' },
    )
  } catch (err) {
    console.warn('[circuit-breaker] recordProviderSuccess failed:', err)
  }
}

export async function recordProviderFailure(
  db: SupabaseClient | null | undefined,
  accountId: string | null | undefined,
  provider: AiProvider,
  opts: {
    errorCode: string
    reason: string
    failureThreshold?: number
    cooldownSeconds?: number
    quotaResetAt?: string | null
    wasProbe?: boolean
  },
): Promise<CircuitBreakerState> {
  const threshold = Math.max(1, opts.failureThreshold ?? 3)
  const cooldownMs = Math.max(10, opts.cooldownSeconds ?? 120) * 1000
  const now = new Date()
  const nowIso = now.toISOString()

  let nextState: CircuitBreakerState = 'operational'
  let failures = 1
  let nextProbeAt: string | null = null
  let quotaResetAt: string | null = null

  if (opts.errorCode === 'invalid_key') {
    nextState = 'auth_failed'
  } else if (
    opts.errorCode === 'quota_exhausted' ||
    opts.errorCode === 'insufficient_balance'
  ) {
    nextState = 'quota_exhausted'
    quotaResetAt =
      opts.quotaResetAt ?? new Date(now.getTime() + 60 * 60_000).toISOString()
  }

  if (!db || !accountId) return nextState

  try {
    const { data: existing } = await db
      .from('ai_provider_circuits')
      .select('consecutive_failures, state')
      .eq('account_id', accountId)
      .eq('provider', provider)
      .maybeSingle()

    failures = Number(existing?.consecutive_failures ?? 0) + 1

    if (nextState === 'operational') {
      if (opts.wasProbe || failures >= threshold) {
        nextState = 'suspended'
        nextProbeAt = new Date(now.getTime() + cooldownMs).toISOString()
      }
    }

    await db.from('ai_provider_circuits').upsert(
      {
        account_id: accountId,
        provider,
        state: nextState,
        consecutive_failures: failures,
        last_failure_at: nowIso,
        last_failure_reason: opts.reason.slice(0, 500),
        last_error_code: opts.errorCode,
        opened_at: nextState === 'operational' ? null : nowIso,
        next_probe_at: nextProbeAt,
        quota_reset_at: quotaResetAt,
        probe_in_flight_until: null,
        updated_at: nowIso,
      },
      { onConflict: 'account_id,provider' },
    )
  } catch (err) {
    console.warn('[circuit-breaker] recordProviderFailure failed:', err)
  }

  return nextState
}

export async function setProviderCircuitState(
  db: SupabaseClient,
  accountId: string,
  provider: AiProvider,
  state: 'operational' | 'disabled',
): Promise<void> {
  const now = new Date().toISOString()
  await db.from('ai_provider_circuits').upsert(
    {
      account_id: accountId,
      provider,
      state,
      consecutive_failures: 0,
      next_probe_at: null,
      quota_reset_at: null,
      probe_in_flight_until: null,
      updated_at: now,
    },
    { onConflict: 'account_id,provider' },
  )
}
