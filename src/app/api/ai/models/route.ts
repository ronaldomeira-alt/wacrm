import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadAiConfig } from '@/lib/ai/config'
import { getProviderModelCatalog, type ProviderCatalogResult } from '@/lib/ai/model-catalog'
import type { AiProvider } from '@/lib/ai/types'

const VALID_PROVIDERS: AiProvider[] = ['deepseek', 'opencode_go', 'openai', 'anthropic']

/**
 * GET /api/ai/models?provider=opencode_go&refresh=1
 *
 * Returns the conversational model catalog for the requested provider (or all
 * supported providers when omitted), using the server-stored API key when
 * available. Never leaks credentials to the client.
 */
export async function GET(req: NextRequest) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const url = new URL(req.url)
    const providerParam = url.searchParams.get('provider')
    const forceRefresh = url.searchParams.get('refresh') === '1'

    if (providerParam && !VALID_PROVIDERS.includes(providerParam as AiProvider)) {
      return NextResponse.json(
        { error: 'Provedor inválido.' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId).catch(() => null)
    const targets: AiProvider[] = providerParam
      ? [providerParam as AiProvider]
      : VALID_PROVIDERS

    const entries = await Promise.all(
      targets.map(async (p): Promise<[AiProvider, ProviderCatalogResult]> => {
        const key =
          p === 'opencode_go'
            ? config?.opencodeGoApiKey || (config?.provider === 'opencode_go' ? config.apiKey : '')
            : p === 'deepseek'
              ? config?.deepseekApiKey || (config?.provider === 'deepseek' ? config.apiKey : '')
              : config?.provider === p
                ? config.apiKey
                : ''
        const res = await getProviderModelCatalog({
          provider: p,
          apiKey: key,
          forceRefresh,
        })
        return [p, res]
      }),
    )

    const providers = Object.fromEntries(entries) as Record<string, ProviderCatalogResult>

    return NextResponse.json({
      providers,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
