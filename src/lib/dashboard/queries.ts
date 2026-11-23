import type { SupabaseClient } from '@supabase/supabase-js'
import {
  daysAgoStart,
  formatDayMonth,
  formatShortWeekday,
  lastNSaoPauloDayKeys,
  saoPauloDayKey,
  saoPauloDayStartIso,
  startOfLocalDay,
} from './date-utils'
import { CLASSIFICATION_CATEGORY } from '@/lib/contacts/tag-categories'
import type {
  FirstResponseMetric,
  LeadsMovementData,
  LeadsMovementPeriod,
  LeadsMovementPoint,
  LeadsTodayMetric,
} from './types'

// ------------------------------------------------------------
// Client-side aggregation, same tradeoff noted in the previous
// version of this file: fine at the current scale (low thousands of
// messages), RLS scopes every query to the signed-in account
// automatically. count_unanswered_conversations is the one query that
// can't be time-windowed (an unanswered lead from weeks ago must
// still count), so that one is a real SQL RPC instead.
// ------------------------------------------------------------

type DB = SupabaseClient

// --- Card 1: Leads Hoje -------------------------------------------------

export async function loadLeadsToday(db: DB): Promise<LeadsTodayMetric> {
  const todayStart = startOfLocalDay().toISOString()
  const yesterdayStart = daysAgoStart(1).toISOString()

  const [today, yesterday] = await Promise.all([
    db.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),
    db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
  ])

  return { current: today.count ?? 0, previous: yesterday.count ?? 0 }
}

// --- Card 2: Leads Não Respondidos --------------------------------------

export async function loadUnansweredCount(db: DB): Promise<number> {
  const { data, error } = await db.rpc('count_unanswered_conversations')
  if (error) throw error
  return (data as number) ?? 0
}

// --- Card 3: Tempo Médio de Primeira Resposta ---------------------------

export async function loadFirstResponseAvg(db: DB): Promise<FirstResponseMetric> {
  // Trailing 7 days (today + 6 prior) — long enough to almost always
  // have samples, short enough to reflect current pace rather than a
  // stale average from months ago.
  const start = daysAgoStart(6).toISOString()
  const { data, error } = await db
    .from('messages')
    .select('conversation_id, sender_type, created_at')
    .gte('created_at', start)
    .order('conversation_id', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error

  const rows = (data ?? []) as {
    conversation_id: string
    sender_type: string
    created_at: string
  }[]

  // Pair each unreplied customer message with the next outbound
  // message in the same conversation — a customer message only counts
  // once, so a double-text while the agent is slow doesn't inflate
  // the average.
  const diffsMin: number[] = []
  let currentConv = ''
  let pendingCustomerAt: Date | null = null
  for (const row of rows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id
      pendingCustomerAt = null
    }
    const ts = new Date(row.created_at)
    if (row.sender_type === 'customer') {
      if (!pendingCustomerAt) pendingCustomerAt = ts
    } else if (pendingCustomerAt) {
      const diffMin = (ts.getTime() - pendingCustomerAt.getTime()) / 60_000
      if (diffMin >= 0) diffsMin.push(diffMin)
      pendingCustomerAt = null
    }
  }

  if (diffsMin.length === 0) return { avgMinutes: null, sampleCount: 0 }
  const avgMinutes = diffsMin.reduce((a, b) => a + b, 0) / diffsMin.length
  return { avgMinutes, sampleCount: diffsMin.length }
}

// --- Card 4: Leads Aguardando Classificação ------------------------------

/**
 * A lead counts as unclassified when it has a started conversation
 * but no tag under CLASSIFICATION_CATEGORY (migration 043). Category
 * membership, not a hardcoded tag-name list, so adding a new
 * classification tag later needs no code change here.
 */
export async function loadUnclassifiedLeadsCount(db: DB): Promise<number> {
  const { data, error } = await db.rpc('count_unclassified_leads', {
    p_classification_category: CLASSIFICATION_CATEGORY,
  })
  if (error) throw error
  return (data as number) ?? 0
}

// --- Card 4 (Sem supervisão): Conversas onde a Clara atuou após revisão humana ---

/**
 * Counts open/pending conversations flagged by the DB-generated `needs_review`
 * column (`idx_conversations_needs_review` partial index, migration
 * 20260914141753_conversation_supervision_queue). RLS scopes by account_id.
 */
export async function loadUnsupervisedLeadsCount(db: DB): Promise<number> {
  const { count, error } = await db
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('needs_review', true)
    .neq('status', 'closed')
  if (error) throw error
  return count ?? 0
}

// --- Movimentação de leads (série atual vs período anterior em America/Sao_Paulo) ---

export async function loadLeadsMovement(
  db: DB,
  period: LeadsMovementPeriod = 7,
  locale: string = 'pt-BR',
): Promise<LeadsMovementData> {
  const allKeys = lastNSaoPauloDayKeys(period * 2)
  const previousKeys = allKeys.slice(0, period)
  const currentKeys = allKeys.slice(period)
  const startIso = saoPauloDayStartIso(previousKeys[0])

  // Paginated fetch (1000-row PostgREST ceiling guard) in a single query path
  // rather than N per-day queries. Contacts are already deduplicated per account.
  const countsByDay = new Map<string, number>()
  const PAGE_SIZE = 1000
  const MAX_PAGES = 15

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const { data, error } = await db
      .from('contacts')
      .select('created_at')
      .gte('created_at', startIso)
      .order('created_at', { ascending: true })
      .range(from, to)

    if (error) throw error
    if (!data || data.length === 0) break

    for (const row of data as { created_at: string }[]) {
      if (!row.created_at) continue
      const key = saoPauloDayKey(row.created_at)
      countsByDay.set(key, (countsByDay.get(key) ?? 0) + 1)
    }

    if (data.length < PAGE_SIZE) break
  }

  let totalCurrent = 0
  let totalPrevious = 0

  const points: LeadsMovementPoint[] = currentKeys.map((currentKey, index) => {
    const previousKey = previousKeys[index]
    const current = countsByDay.get(currentKey) ?? 0
    const previous = countsByDay.get(previousKey) ?? 0
    totalCurrent += current
    totalPrevious += previous

    const dayLabel =
      period === 7
        ? formatShortWeekday(currentKey, locale)
        : formatDayMonth(currentKey)

    return {
      index,
      dayLabel,
      currentKey,
      previousKey,
      current,
      previous,
    }
  })

  return {
    period,
    points,
    totalCurrent,
    totalPrevious,
  }
}
