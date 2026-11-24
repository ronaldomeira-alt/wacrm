import type { SupabaseClient } from '@supabase/supabase-js'
import {
  canUseProvider,
  isEligibleForFallback,
  recordProviderFailure,
  recordProviderSuccess,
} from './circuit-breaker'
import { AI_PROVIDER_DEFAULT_MODEL, aiRequestTimeoutMs } from './defaults'
import { checkOpenCodeGoQuotaGate } from './opencode-quota'
import { generateAnthropic } from './providers/anthropic'
import { generateDeepSeek } from './providers/deepseek'
import { generateOpenAi } from './providers/openai'
import { generateOpenCodeGo } from './providers/opencode-go'
import {
  AiError,
  type AiConfig,
  type AiProvider,
  type AiUsage,
  type ChatMessage,
} from './types'
import { logAiUsage, type AiUsageMode } from './usage'

const BACKGROUND_MODES = new Set<AiUsageMode>([
  'lead_analysis',
  'followup',
  'learning',
  'ctwa_rescue',
])

const activePriorityCallsByAccount = new Map<string, number>()

function incrementPriority(accountId: string | null | undefined): () => void {
  if (!accountId) return () => {}
  activePriorityCallsByAccount.set(
    accountId,
    (activePriorityCallsByAccount.get(accountId) ?? 0) + 1,
  )
  return () => {
    const current = activePriorityCallsByAccount.get(accountId) ?? 0
    if (current <= 1) {
      activePriorityCallsByAccount.delete(accountId)
    } else {
      activePriorityCallsByAccount.set(accountId, current - 1)
    }
  }
}

async function yieldIfPriorityActive(
  accountId: string | null | undefined,
  mode: AiUsageMode,
): Promise<void> {
  if (!accountId || !BACKGROUND_MODES.has(mode)) return
  const deadline = Date.now() + 500
  while ((activePriorityCallsByAccount.get(accountId) ?? 0) > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
}

export type InferenceConfig = Pick<
  AiConfig,
  'provider' | 'model' | 'apiKey' | 'deepseekApiKey' | 'opencodeGoApiKey'
> &
  Partial<AiConfig>

export function resolveProviderKey(config: InferenceConfig, provider: AiProvider): string {
  if (provider === 'deepseek') {
    return config.deepseekApiKey || (config.provider === 'deepseek' ? config.apiKey : '')
  }
  if (provider === 'opencode_go') {
    return config.opencodeGoApiKey || (config.provider === 'opencode_go' ? config.apiKey : '')
  }
  return config.apiKey
}

async function invokeAdapter(args: {
  provider: AiProvider
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
  signal?: AbortSignal
  structuredOutputRequired?: boolean
  maxOutputTokens?: number
}): Promise<{ text: string; usage: AiUsage | null }> {
  switch (args.provider) {
    case 'openai':
      return generateOpenAi(args)
    case 'anthropic':
      return generateAnthropic(args)
    case 'deepseek':
      return generateDeepSeek(args)
    case 'opencode_go':
      return generateOpenCodeGo(args)
    default:
      throw new AiError(`Unsupported AI provider: ${String(args.provider)}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }
}

export interface ExecuteInferenceArgs {
  config: InferenceConfig
  db?: SupabaseClient | null
  accountId?: string | null
  conversationId?: string | null
  mode: AiUsageMode
  systemPrompt: string
  messages: ChatMessage[]
  structuredOutputRequired?: boolean
  maxOutputTokens?: number
  signal?: AbortSignal
  /** Bypass persistent circuit breaker (e.g., manual connectivity test). */
  bypassCircuitBreaker?: boolean
  /** Override whether attempts are logged to `ai_usage_log` (default true when db+accountId provided). */
  logUsage?: boolean
}

export interface ExecuteInferenceResult {
  text: string
  usage: AiUsage | null
  provider: AiProvider
  model: string
  fallbackUsed: boolean
  latencyMs: number
  attemptCount: number
}

interface CandidateRoute {
  provider: AiProvider
  model: string
  apiKey: string
  timeoutMs: number
  isFallback: boolean
}

/**
 * Centralized AI inference manager with:
 * - Independent per-provider timeouts (45s default) & AbortController global budget
 * - OpenCode Go quota gate (5h / weekly / monthly preventive limits)
 * - Persistent PostgreSQL circuit breaker
 * - Automatic transparent fallback on eligible provider/infrastructure failures
 * - Priority yielding for real-time Clara turns over background crons
 * - Full attempt logging (including failed/timeout attempts and fallback events)
 */
export async function executeAiInference(
  args: ExecuteInferenceArgs,
): Promise<ExecuteInferenceResult> {
  const {
    config,
    db,
    accountId,
    conversationId = null,
    mode,
    systemPrompt,
    messages,
    structuredOutputRequired,
    maxOutputTokens,
    signal,
    bypassCircuitBreaker = false,
    logUsage = true,
  } = args

  const isPriorityMode = mode === 'auto_reply' || mode === 'recovery' || mode === 'draft'
  const releasePriority = isPriorityMode ? incrementPriority(accountId) : () => {}
  let globalTimer: ReturnType<typeof setTimeout> | null = null
  let onCallerAbort: (() => void) | null = null

  try {
    await yieldIfPriorityActive(accountId, mode)

    const defaultTimeout = aiRequestTimeoutMs()
    const primaryTimeout = config.primaryTimeoutMs ?? defaultTimeout
    const secondaryTimeout = config.secondaryTimeoutMs ?? defaultTimeout
    const globalBudgetMs = primaryTimeout + (config.fallbackEnabled ? secondaryTimeout : 0) + 2_000
    const globalController = new AbortController()
    onCallerAbort = () => globalController.abort(signal?.reason)
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    globalTimer = setTimeout(() => {
      globalController.abort(new DOMException('GlobalInferenceBudgetExceeded', 'TimeoutError'))
    }, globalBudgetMs)
    const effectiveSignal = globalController.signal

    const candidates: CandidateRoute[] = [
      {
        provider: config.provider,
        model: config.model || AI_PROVIDER_DEFAULT_MODEL[config.provider],
        apiKey: resolveProviderKey(config, config.provider),
        timeoutMs: primaryTimeout,
        isFallback: false,
      },
    ]

    if (config.fallbackEnabled && config.secondaryProvider) {
      const secKey = resolveProviderKey(config, config.secondaryProvider)
      const secModel =
        config.secondaryModel || AI_PROVIDER_DEFAULT_MODEL[config.secondaryProvider]
      const isDifferentRoute =
        config.secondaryProvider !== config.provider || secModel !== candidates[0].model
      if (isDifferentRoute && secKey && secKey.trim()) {
        candidates.push({
          provider: config.secondaryProvider,
          model: secModel,
          apiKey: secKey,
          timeoutMs: secondaryTimeout,
          isFallback: true,
        })
      }
    }

    let lastError: AiError | null = null
    let primaryFailure: { provider: AiProvider; model: string; code: string; reason: string } | null = null
    let attemptNumber = 0

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]
      if (effectiveSignal.aborted) {
        throw new AiError('Inference aborted by caller or global budget.', { code: 'timeout', status: 504 })
      }

      if (!candidate.apiKey || !candidate.apiKey.trim()) {
        const missingErr = new AiError(`${candidate.provider} API key is not configured.`, {
          code: 'missing_key',
          status: 400,
        })
        lastError = missingErr
        if (i === 0) {
          primaryFailure = {
            provider: candidate.provider,
            model: candidate.model,
            code: missingErr.code,
            reason: missingErr.message,
          }
          continue
        }
        break
      }

      // 1. Circuit breaker check
      let isProbe = false
      if (!bypassCircuitBreaker) {
        const circuit = await canUseProvider(db, accountId, candidate.provider)
        if (!circuit.allowed) {
          const circuitErr = new AiError(
            circuit.reason ?? `${candidate.provider} circuit is open (${circuit.state})`,
            {
              code:
                circuit.state === 'quota_exhausted'
                  ? 'quota_exhausted'
                  : circuit.state === 'auth_failed'
                    ? 'invalid_key'
                    : 'provider_error',
              status: 502,
            },
          )
          lastError = circuitErr
          if (i === 0) {
            primaryFailure = {
              provider: candidate.provider,
              model: candidate.model,
              code: circuitErr.code,
              reason: circuitErr.message,
            }
            continue
          }
          break
        }
        isProbe = circuit.isProbe
      }

      // 2. OpenCode Go proactive per-window quota check
      if (candidate.provider === 'opencode_go' && !bypassCircuitBreaker) {
        const quotaGate = await checkOpenCodeGoQuotaGate({
          apiKey: candidate.apiKey,
          windows: {
            fiveHour: {
              enabled: config.opencode5hPreventiveEnabled ?? false,
              pct: config.opencode5hPreventivePct ?? 90,
            },
            weekly: {
              enabled: config.opencodeWeeklyPreventiveEnabled ?? true,
              pct: config.opencodeWeeklyPreventivePct ?? 90,
            },
            monthly: {
              enabled: config.opencodeMonthlyPreventiveEnabled ?? false,
              pct: config.opencodeMonthlyPreventivePct ?? 90,
            },
          },
        })
        if (!quotaGate.allowed) {
          const code = quotaGate.quotaExhausted ? 'quota_exhausted' : 'invalid_key'
          const reason = quotaGate.reason ?? 'OpenCode Go quota gate blocked request'
          await recordProviderFailure(db, accountId, candidate.provider, {
            errorCode: code,
            reason,
            quotaResetAt: quotaGate.resetAt,
            failureThreshold: config.circuitFailureThreshold,
            cooldownSeconds: config.circuitCooldownSeconds,
            wasProbe: isProbe,
          })
          const quotaErr = new AiError(reason, { code, status: 502 })
          lastError = quotaErr
          if (i === 0) {
            primaryFailure = {
              provider: candidate.provider,
              model: candidate.model,
              code,
              reason,
            }
            continue
          }
          break
        }
      }

      // 3. Execute provider call with strict AbortController timeout
      attemptNumber += 1
      const controller = new AbortController()
      const onParentAbort = () => controller.abort(effectiveSignal.reason)
      effectiveSignal.addEventListener('abort', onParentAbort, { once: true })
      const timer = setTimeout(() => {
        controller.abort(new DOMException('TimeoutError', 'TimeoutError'))
      }, candidate.timeoutMs)

      const startedAt = Date.now()
      try {
        const res = await invokeAdapter({
          provider: candidate.provider,
          apiKey: candidate.apiKey,
          model: candidate.model,
          systemPrompt,
          messages,
          timeoutMs: candidate.timeoutMs,
          signal: controller.signal,
          structuredOutputRequired,
          maxOutputTokens,
        })
        const latencyMs = Date.now() - startedAt

        await recordProviderSuccess(db, accountId, candidate.provider, latencyMs)

        if (logUsage && db && accountId) {
          await logAiUsage(db, {
            accountId,
            conversationId,
            mode,
            provider: candidate.provider,
            model: candidate.model,
            usage: res.usage,
            latencyMs,
            status: 'completed',
            fallbackUsed: candidate.isFallback,
            attemptNumber,
            logUnknown: true,
          })

          if (candidate.isFallback && primaryFailure) {
            void db
              .from('ai_fallback_events')
              .insert({
                account_id: accountId,
                conversation_id: conversationId,
                mode,
                from_provider: primaryFailure.provider,
                from_model: primaryFailure.model,
                to_provider: candidate.provider,
                to_model: candidate.model,
                error_code: primaryFailure.code,
                reason: primaryFailure.reason.slice(0, 500),
                latency_ms: latencyMs,
                recovered: true,
              })
              .then(({ error }) => {
                if (error) console.warn('[provider-manager] fallback event log failed:', error)
              })
          }
        }

        return {
          text: res.text,
          usage: res.usage,
          provider: candidate.provider,
          model: candidate.model,
          fallbackUsed: candidate.isFallback,
          latencyMs,
          attemptCount: attemptNumber,
        }
      } catch (err) {
        const latencyMs = Date.now() - startedAt
        const aiErr =
          err instanceof AiError
            ? err
            : new AiError(err instanceof Error ? err.message : String(err), {
                code: 'provider_error',
                status: 502,
              })
        lastError = aiErr

        if (logUsage && db && accountId) {
          await logAiUsage(db, {
            accountId,
            conversationId,
            mode,
            provider: candidate.provider,
            model: candidate.model,
            usage: null,
            latencyMs,
            status: aiErr.code === 'timeout' ? 'timeout' : 'failed',
            errorCode: aiErr.code,
            errorReason: aiErr.message,
            fallbackUsed: candidate.isFallback,
            attemptNumber,
            consumptionType: 'unknown',
            logUnknown: true,
          })
        }

        if (!bypassCircuitBreaker) {
          await recordProviderFailure(db, accountId, candidate.provider, {
            errorCode: aiErr.code,
            reason: aiErr.message,
            failureThreshold: config.circuitFailureThreshold,
            cooldownSeconds: config.circuitCooldownSeconds,
            wasProbe: isProbe,
          })
        }

        const hasNext = i + 1 < candidates.length
        if (hasNext && isEligibleForFallback(aiErr.code)) {
          primaryFailure = {
            provider: candidate.provider,
            model: candidate.model,
            code: aiErr.code,
            reason: aiErr.message,
          }
          console.warn(
            `[provider-manager] Primary ${candidate.provider} failed (${aiErr.code}); triggering fallback to ${candidates[i + 1].provider}.`,
          )
          continue
        }

        throw aiErr
      } finally {
        clearTimeout(timer)
        effectiveSignal.removeEventListener('abort', onParentAbort)
      }
    }

    throw (
      lastError ??
      new AiError('All configured AI providers failed.', {
        code: 'all_providers_failed',
        status: 502,
      })
    )
  } finally {
    if (globalTimer) clearTimeout(globalTimer)
    if (onCallerAbort) signal?.removeEventListener('abort', onCallerAbort)
    releasePriority()
  }
}
