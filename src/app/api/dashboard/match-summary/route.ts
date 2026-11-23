import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { resolveMatchLifecycle, type RawMatchRowForLifecycle } from '@/lib/match/lifecycle'
import type { DashboardMatchPropertySummary, DashboardMatchSummary } from '@/lib/dashboard/types'

const MATCH_ACTIVE_QUEUE_MAX_DAYS = 45
const MATCH_ACTIVE_WINDOW_MS = MATCH_ACTIVE_QUEUE_MAX_DAYS * 24 * 60 * 60 * 1000
const MIN_ELIGIBLE_SCORE = 90
const CHUNK_SIZE = 1000
const MAX_SCAN_PAGES = 20

interface MatchSummaryRow extends RawMatchRowForLifecycle {
  id: string
  lead_id: string
  property_id: string
  commercial_priority: number | string | null
}

interface ActivePropertyRow {
  property_id: string
  title: string | null
  neighborhood: string | null
  cover_url: string | null
  status: string | null
  operation?: string | null
}

/**
 * GET /api/dashboard/match-summary
 *
 * Read-only summary for the Dashboard Match card:
 * - Only active pending statuses (`novo`, `em_analise`), `suppressed = false`, `match_score >= 90`
 * - Only active properties (`property_match_projections.status = 'ativo'`)
 * - Only active contacts (`archived_at IS NULL AND paused_at IS NULL`)
 * - Enforces the 45-day active queue window (`COALESCE(reopened_at, created_at) >= now - 45d`)
 *   without mutating the existing Match engine.
 */
export async function GET() {
  try {
    const ctx = await requireRole('agent')
    const nowMs = Date.now()
    const cutoffIso = new Date(nowMs - MATCH_ACTIVE_WINDOW_MS).toISOString()

    // Fetch active properties in parallel with the paginated active-window matches
    const propertiesPromise = ctx.supabase
      .from('property_match_projections')
      .select('property_id, title, neighborhood, cover_url, status, operation')
      .eq('account_id', ctx.accountId)
      .eq('status', 'ativo')

    const candidateRows: MatchSummaryRow[] = []
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const from = page * CHUNK_SIZE
      const to = from + CHUNK_SIZE - 1
      const { data: batch, error: batchErr } = await ctx.supabase
        .from('lead_property_matches')
        .select(
          'id, lead_id, property_id, match_score, profile_maturity, commercial_priority, match_status, suppressed, created_at, reopened_at, score_breakdown',
        )
        .eq('account_id', ctx.accountId)
        .eq('suppressed', false)
        .in('match_status', ['novo', 'em_analise'])
        .gte('match_score', MIN_ELIGIBLE_SCORE)
        .or(`reopened_at.gte.${cutoffIso},and(reopened_at.is.null,created_at.gte.${cutoffIso})`)
        .order('id', { ascending: true })
        .range(from, to)

      if (batchErr) {
        console.error('[GET /api/dashboard/match-summary] match query error:', batchErr)
        return NextResponse.json({ error: 'Falha ao carregar resumo de matches' }, { status: 500 })
      }
      if (!batch || batch.length === 0) break
      candidateRows.push(...(batch as unknown as MatchSummaryRow[]))
      if (batch.length < CHUNK_SIZE) break
    }

    const { data: activePropsData, error: propsErr } = await propertiesPromise
    if (propsErr) {
      console.error('[GET /api/dashboard/match-summary] properties query error:', propsErr)
      return NextResponse.json({ error: 'Falha ao carregar imóveis do Match' }, { status: 500 })
    }

    const activePropertiesMap = new Map<string, ActivePropertyRow>()
    for (const p of (activePropsData ?? []) as ActivePropertyRow[]) {
      if (p.property_id && (p.operation || 'venda') === 'venda') {
        activePropertiesMap.set(p.property_id, p)
      }
    }

    // Fetch only the distinct contact IDs referenced by eligible property/window rows
    const distinctLeadIds = Array.from(
      new Set(
        candidateRows
          .filter((r) => activePropertiesMap.has(r.property_id))
          .map((r) => r.lead_id)
          .filter(Boolean),
      ),
    )

    const activeLeadIds = new Set<string>()
    const leadAiScoreMap = new Map<string, number>()
    const CONTACT_CHUNK = 200
    for (let i = 0; i < distinctLeadIds.length; i += CONTACT_CHUNK) {
      const chunk = distinctLeadIds.slice(i, i + CONTACT_CHUNK)
      const { data: contactsBatch, error: contactsErr } = await ctx.supabase
        .from('contacts')
        .select('id, ai_score, paused_at, archived_at')
        .eq('account_id', ctx.accountId)
        .in('id', chunk)

      if (contactsErr) {
        console.error('[GET /api/dashboard/match-summary] contacts query error:', contactsErr)
        return NextResponse.json({ error: 'Falha ao validar leads do Match' }, { status: 500 })
      }

      for (const c of contactsBatch ?? []) {
        if (!c.paused_at && !c.archived_at) {
          const cid = c.id as string
          activeLeadIds.add(cid)
          leadAiScoreMap.set(cid, Number((c as { ai_score?: number | null }).ai_score ?? 0))
        }
      }
    }

    interface PropertyAccumulator {
      propertyId: string
      title: string
      neighborhood: string
      coverUrl: string | null
      leadIds: Set<string>
      maxMatchScore: number
      maxProfileMaturity: number
      maxAiScore: number
      maxCommercialPriority: number
      topLeadId: string
      topLeadScore: number
      topLeadMaturity: number
      topLeadAiScore: number
    }

    const byProperty = new Map<string, PropertyAccumulator>()
    const totalEligibleLeadIds = new Set<string>()
    let totalPendingMatches = 0

    for (const row of candidateRows) {
      const prop = activePropertiesMap.get(row.property_id)
      if (!prop) continue
      if (!activeLeadIds.has(row.lead_id)) continue

      const lc = resolveMatchLifecycle(row, nowMs)
      if (lc.effectiveStatus !== 'novo' && lc.effectiveStatus !== 'em_analise') continue

      // Enforce 45-day active queue window on resolved lifecycle reference timestamp
      const refStr = lc.reopenedAt || row.created_at || ''
      const refMs = refStr ? new Date(refStr).getTime() : 0
      if (!refMs || Number.isNaN(refMs) || nowMs - refMs > MATCH_ACTIVE_WINDOW_MS) continue

      const score = Number(row.match_score || 0)
      if (score < MIN_ELIGIBLE_SCORE) continue
      const maturity = Number(row.profile_maturity || 0)
      const aiScore = leadAiScoreMap.get(row.lead_id) ?? 0
      const priority = Number(row.commercial_priority || 0)

      totalPendingMatches++
      totalEligibleLeadIds.add(row.lead_id)

      let acc = byProperty.get(row.property_id)
      if (!acc) {
        acc = {
          propertyId: row.property_id,
          title: (prop.title || 'Imóvel sem título').trim(),
          neighborhood: (prop.neighborhood || '').trim(),
          coverUrl: prop.cover_url || null,
          leadIds: new Set<string>(),
          maxMatchScore: score,
          maxProfileMaturity: maturity,
          maxAiScore: aiScore,
          maxCommercialPriority: priority,
          topLeadId: row.lead_id,
          topLeadScore: score,
          topLeadMaturity: maturity,
          topLeadAiScore: aiScore,
        }
        byProperty.set(row.property_id, acc)
      }

      acc.leadIds.add(row.lead_id)
      if (score > acc.maxMatchScore) acc.maxMatchScore = score
      if (maturity > acc.maxProfileMaturity) acc.maxProfileMaturity = maturity
      if (aiScore > acc.maxAiScore) acc.maxAiScore = aiScore
      if (priority > acc.maxCommercialPriority) acc.maxCommercialPriority = priority

      if (
        score > acc.topLeadScore ||
        (score === acc.topLeadScore && maturity > acc.topLeadMaturity) ||
        (score === acc.topLeadScore && maturity === acc.topLeadMaturity && aiScore > acc.topLeadAiScore)
      ) {
        acc.topLeadId = row.lead_id
        acc.topLeadScore = score
        acc.topLeadMaturity = maturity
        acc.topLeadAiScore = aiScore
      }
    }

    const sortedItems: DashboardMatchPropertySummary[] = Array.from(byProperty.values())
      .map((acc) => ({
        propertyId: acc.propertyId,
        title: acc.title,
        neighborhood: acc.neighborhood,
        coverUrl: acc.coverUrl,
        leadsCount: acc.leadIds.size,
        maxMatchScore: Math.round(acc.maxMatchScore),
        maxCommercialPriority: Math.round(acc.maxCommercialPriority * 10) / 10,
        topLeadId: acc.topLeadId,
      }))
      .sort((a, b) => {
        if (b.leadsCount !== a.leadsCount) return b.leadsCount - a.leadsCount
        if (b.maxMatchScore !== a.maxMatchScore) return b.maxMatchScore - a.maxMatchScore
        if (b.maxCommercialPriority !== a.maxCommercialPriority) {
          return b.maxCommercialPriority - a.maxCommercialPriority
        }
        return a.propertyId.localeCompare(b.propertyId)
      })

    const payload: DashboardMatchSummary = {
      totalPendingLeads: totalEligibleLeadIds.size,
      totalPendingMatches,
      activeWindowDays: MATCH_ACTIVE_QUEUE_MAX_DAYS,
      items: sortedItems.slice(0, 3),
    }

    return NextResponse.json(payload)
  } catch (err) {
    return toErrorResponse(err)
  }
}
