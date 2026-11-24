import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig, CONFIG_COLUMNS } from '@/lib/ai/config'
import { listProviderCircuits, setProviderCircuitState } from '@/lib/ai/circuit-breaker'
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults'
import { fetchOpenCodeGoQuota } from '@/lib/ai/opencode-quota'
import { executeAiInference, resolveProviderKey } from '@/lib/ai/provider-manager'
import { AiError, type AiProvider } from '@/lib/ai/types'
import { encrypt } from '@/lib/whatsapp/encryption'

export const dynamic = 'force-dynamic'

const VALID_PROVIDERS = new Set<AiProvider>([
  'openai',
  'anthropic',
  'deepseek',
  'opencode_go',
])

export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const adminDb = supabaseAdmin()

    const { data: rawCfg } = await adminDb
      .from('ai_configs')
      .select(CONFIG_COLUMNS)
      .eq('account_id', accountId)
      .maybeSingle()

    const config = await loadAiConfig(adminDb, accountId, {
      requireActive: false,
    }).catch(() => null)

    const circuits = await listProviderCircuits(adminDb, accountId)

    const [{ data: fallbackEvents }, { count: pendingQueueCount }, { count: supervisionCount }] =
      await Promise.all([
        adminDb
          .from('ai_fallback_events')
          .select(
            'id, conversation_id, mode, from_provider, from_model, to_provider, to_model, error_code, reason, latency_ms, recovered, created_at',
          )
          .eq('account_id', accountId)
          .order('created_at', { ascending: false })
          .limit(20),
        adminDb
          .from('ai_reply_queue')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .in('status', ['pending', 'processing']),
        adminDb
          .from('ai_reply_queue')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .eq('status', 'needs_human_supervision'),
      ])

    // Latency & recent provider usage via Postgres RPC (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: usage7d } = await adminDb.rpc('get_ai_usage_summary', {
      p_account_id: accountId,
      p_start_at: sevenDaysAgo,
      p_end_at: new Date().toISOString(),
    })

    // OpenCode Go live quota snapshot if key is configured
    const opencodeKey = config?.opencodeGoApiKey || null
    const opencodeQuota = opencodeKey
      ? await fetchOpenCodeGoQuota(opencodeKey)
      : null

    const row = (rawCfg ?? {}) as Record<string, unknown>

    return NextResponse.json({
      configured: Boolean(config),
      settings: {
        provider: (row.provider as AiProvider) ?? 'deepseek',
        model: (row.model as string) ?? AI_PROVIDER_DEFAULT_MODEL.deepseek,
        fallbackEnabled: Boolean(row.fallback_enabled ?? false),
        secondaryProvider: (row.secondary_provider as AiProvider | null) ?? null,
        secondaryModel: (row.secondary_model as string | null) ?? null,
        primaryTimeoutMs: Number(row.primary_timeout_ms ?? 45_000),
        secondaryTimeoutMs: Number(row.secondary_timeout_ms ?? 45_000),
        opencodeWacrmReservePct: Number(row.opencode_wacrm_reserve_pct ?? 15),
        opencodeGlobalPreventivePct: Number(row.opencode_global_preventive_pct ?? 75),
        opencodeMarginPct: Number(row.opencode_margin_pct ?? 25),
        circuitFailureThreshold: Number(row.circuit_failure_threshold ?? 3),
        circuitCooldownSeconds: Number(row.circuit_cooldown_seconds ?? 120),
        hasApiKey: Boolean(row.api_key),
        hasDeepseekKey: Boolean(row.deepseek_api_key),
        hasOpencodeGoKey: Boolean(row.opencode_go_api_key),
      },
      circuits,
      opencodeQuota,
      queue: {
        pendingCount: pendingQueueCount ?? 0,
        supervisionCount: supervisionCount ?? 0,
      },
      fallbackEvents: fallbackEvents ?? [],
      usage7d: usage7d ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const adminDb = supabaseAdmin()
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    if (
      body.action === 'reset_circuit' ||
      body.action === 'disable_provider' ||
      body.action === 'enable_provider'
    ) {
      const targetProvider = body.provider as AiProvider
      if (!VALID_PROVIDERS.has(targetProvider)) {
        return NextResponse.json({ error: 'Provedor inválido.' }, { status: 400 })
      }
      const nextState = body.action === 'disable_provider' ? 'disabled' : 'operational'
      await setProviderCircuitState(adminDb, accountId, targetProvider, nextState)
      return NextResponse.json({ ok: true, provider: targetProvider, state: nextState })
    }

    const { data: existing } = await adminDb
      .from('ai_configs')
      .select('provider, model, secondary_provider, secondary_model')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json(
        { error: 'Configure o agente de IA na aba Configuração antes de ajustar provedores.' },
        { status: 400 },
      )
    }

    if (body.action === 'swap_priorities') {
      if (!existing.secondary_provider) {
        return NextResponse.json(
          { error: 'Selecione um provedor secundário antes de inverter prioridades.' },
          { status: 400 },
        )
      }
      const newPrimary = existing.secondary_provider as AiProvider
      const newPrimaryModel =
        (existing.secondary_model as string | null) || AI_PROVIDER_DEFAULT_MODEL[newPrimary]
      const newSecondary = existing.provider as AiProvider
      const newSecondaryModel = existing.model as string

      const { error } = await adminDb
        .from('ai_configs')
        .update({
          provider: newPrimary,
          model: newPrimaryModel,
          secondary_provider: newSecondary,
          secondary_model: newSecondaryModel,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', accountId)

      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }

    if (typeof body.provider === 'string' && VALID_PROVIDERS.has(body.provider as AiProvider)) {
      update.provider = body.provider
    }
    if (typeof body.model === 'string' && body.model.trim()) {
      update.model = body.model.trim()
    }
    if (typeof body.fallbackEnabled === 'boolean') {
      update.fallback_enabled = body.fallbackEnabled
    }
    if (body.secondaryProvider === null || body.secondaryProvider === '') {
      update.secondary_provider = null
    } else if (
      typeof body.secondaryProvider === 'string' &&
      VALID_PROVIDERS.has(body.secondaryProvider as AiProvider)
    ) {
      update.secondary_provider = body.secondaryProvider
    }
    if (body.secondaryModel === null || body.secondaryModel === '') {
      update.secondary_model = null
    } else if (typeof body.secondaryModel === 'string' && body.secondaryModel.trim()) {
      update.secondary_model = body.secondaryModel.trim()
    }

    const clampInt = (v: unknown, min: number, max: number) =>
      typeof v === 'number' && Number.isFinite(v)
        ? Math.min(max, Math.max(min, Math.round(v)))
        : undefined
    const clampPct = (v: unknown, min: number, max: number) =>
      typeof v === 'number' && Number.isFinite(v)
        ? Math.min(max, Math.max(min, Math.round(v * 100) / 100))
        : undefined

    const pTimeout = clampInt(body.primaryTimeoutMs, 5000, 120000)
    if (pTimeout !== undefined) update.primary_timeout_ms = pTimeout

    const sTimeout = clampInt(body.secondaryTimeoutMs, 5000, 120000)
    if (sTimeout !== undefined) update.secondary_timeout_ms = sTimeout

    const reservePct = clampPct(body.opencodeWacrmReservePct, 0, 100)
    if (reservePct !== undefined) update.opencode_wacrm_reserve_pct = reservePct

    const globalPct = clampPct(body.opencodeGlobalPreventivePct, 1, 100)
    if (globalPct !== undefined) update.opencode_global_preventive_pct = globalPct

    const marginPct = clampPct(body.opencodeMarginPct, 0, 100)
    if (marginPct !== undefined) update.opencode_margin_pct = marginPct

    const threshold = clampInt(body.circuitFailureThreshold, 1, 20)
    if (threshold !== undefined) update.circuit_failure_threshold = threshold

    const cooldown = clampInt(body.circuitCooldownSeconds, 10, 3600)
    if (cooldown !== undefined) update.circuit_cooldown_seconds = cooldown

    if (typeof body.opencodeGoApiKey === 'string' && body.opencodeGoApiKey.trim()) {
      update.opencode_go_api_key = encrypt(body.opencodeGoApiKey.trim())
    }
    if (typeof body.deepseekApiKey === 'string' && body.deepseekApiKey.trim()) {
      update.deepseek_api_key = encrypt(body.deepseekApiKey.trim())
    }

    const { error } = await adminDb
      .from('ai_configs')
      .update(update)
      .eq('account_id', accountId)

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const adminDb = supabaseAdmin()
    const body = (await request.json().catch(() => ({}))) as {
      provider?: AiProvider
      model?: string
      apiKey?: string
    }

    const provider = body.provider
    if (!provider || !VALID_PROVIDERS.has(provider)) {
      return NextResponse.json({ error: 'Provedor inválido.' }, { status: 400 })
    }

    const config = await loadAiConfig(adminDb, accountId, {
      requireActive: false,
    })
    if (!config && !body.apiKey?.trim()) {
      return NextResponse.json(
        { error: 'Nenhuma chave configurada para testar.' },
        { status: 400 },
      )
    }

    const resolvedKey =
      body.apiKey?.trim() || (config ? resolveProviderKey(config, provider) : '')
    if (!resolvedKey) {
      return NextResponse.json(
        { error: `Chave de API para ${provider} não configurada.` },
        { status: 400 },
      )
    }

    const model = body.model?.trim() || AI_PROVIDER_DEFAULT_MODEL[provider]
    const testConfig = {
      ...(config ?? {
        systemPrompt: null,
        isActive: true,
        autoReplyEnabled: false,
        autoReplyMaxPerConversation: 0,
        handoffAgentId: null,
        embeddingsApiKey: null,
      }),
      provider,
      model,
      apiKey: resolvedKey,
      deepseekApiKey: provider === 'deepseek' ? resolvedKey : config?.deepseekApiKey,
      opencodeGoApiKey: provider === 'opencode_go' ? resolvedKey : config?.opencodeGoApiKey,
      fallbackEnabled: false,
      primaryTimeoutMs: 20_000,
    }

    const result = await executeAiInference({
      config: testConfig,
      db: adminDb,
      accountId,
      mode: 'test',
      systemPrompt: 'Você é um teste de conectividade. Responda apenas: OK.',
      messages: [{ role: 'user', content: 'ping' }],
      bypassCircuitBreaker: true,
      logUsage: true,
    })

    return NextResponse.json({
      ok: true,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      reply: result.text.slice(0, 80),
    })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { ok: false, error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
