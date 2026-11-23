"use client"

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  UserPlus,
  MessageCircleWarning,
  Clock,
  Layers,
} from 'lucide-react'

import {
  loadFirstResponseAvg,
  loadLeadsToday,
  loadUnsupervisedLeadsCount,
} from '@/lib/dashboard/queries'
import type { FirstResponseMetric, LeadsTodayMetric } from '@/lib/dashboard/types'
import { useTotalUnread } from '@/hooks/use-total-unread'

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { LeadsMovementChart } from '@/components/dashboard/leads-movement-chart'
import { MatchSummaryCard } from '@/components/dashboard/match-summary-card'
import { FollowupRecommendationsCard } from '@/components/dashboard/followup-recommendations-card'
import { TooltipProvider } from '@/components/ui/tooltip'

import { useTranslations } from 'next-intl'

export default function DashboardPage() {
  const t = useTranslations('Dashboard.page')

  const [leadsToday, setLeadsToday] = useState<LeadsTodayMetric | null>(null)
  const [leadsLoading, setLeadsLoading] = useState(true)

  // Same live/realtime count the sidebar's Inbox nav dot already uses
  // (unread_count > 0 across conversations) — reused as-is so the
  // Dashboard card can never disagree with what the Inbox itself
  // considers unread. See use-total-unread.ts.
  const unreadCount = useTotalUnread()

  const [firstResponse, setFirstResponse] = useState<FirstResponseMetric | null>(null)
  const [firstResponseLoading, setFirstResponseLoading] = useState(true)

  const [unsupervised, setUnsupervised] = useState<number | null>(null)
  const [unsupervisedLoading, setUnsupervisedLoading] = useState(true)

  const loadAll = useCallback(() => {
    const db = createClient()

    // Each card fetches and fails independently — a slow or broken
    // query never blocks the other three skeletons from resolving.
    void loadLeadsToday(db)
      .then(setLeadsToday)
      .catch((err) => console.error('[dashboard] leads today failed:', err))
      .finally(() => setLeadsLoading(false))

    void loadFirstResponseAvg(db)
      .then(setFirstResponse)
      .catch((err) => console.error('[dashboard] first response failed:', err))
      .finally(() => setFirstResponseLoading(false))

    void loadUnsupervisedLeadsCount(db)
      .then(setUnsupervised)
      .catch((err) => console.error('[dashboard] unsupervised leads failed:', err))
      .finally(() => setUnsupervisedLoading(false))
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {/* 4 KPI cards */}
      <TooltipProvider>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {leadsLoading || !leadsToday ? (
            <SkeletonCard />
          ) : (
            <MetricCard
              title={t('leadsToday')}
              value={leadsToday.current.toLocaleString()}
              icon={UserPlus}
              tint="purple"
              delta={{
                sign: leadsToday.current - leadsToday.previous,
                label: t('vsYesterday', { value: leadsDeltaValue(leadsToday) }),
              }}
              href="/inbox"
            />
          )}

          <MetricCard
            title={t('unansweredLeads')}
            value={unreadCount.toLocaleString()}
            icon={MessageCircleWarning}
            tint="orange"
            highlighted
            subtitle={t('awaitingService')}
            href="/inbox?filter=unread"
            tooltip={t('unansweredLeadsTooltip')}
          />

          {firstResponseLoading || !firstResponse ? (
            <SkeletonCard />
          ) : (
            <MetricCard
              title={t('avgFirstResponse')}
              value={
                firstResponse.avgMinutes === null
                  ? '—'
                  : formatMinutesSeconds(firstResponse.avgMinutes)
              }
              icon={Clock}
              tint="blue"
              subtitle={t('target', { minutes: 5 })}
            />
          )}

          {unsupervisedLoading || unsupervised === null ? (
            <SkeletonCard />
          ) : (
            <MetricCard
              title={t('unsupervisedLeads')}
              value={unsupervised.toLocaleString()}
              icon={Layers}
              tint="purple"
              highlighted
              subtitle={t('awaitingAnalysis')}
              href="/inbox"
              tooltip={t('unsupervisedLeadsTooltip')}
            />
          )}
        </div>
      </TooltipProvider>

      {/* Quick actions */}
      <QuickActions />

      {/* Row 1: Leads movement (~60%) + Match summary (~40%) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          <LeadsMovementChart />
        </div>
        <div className="min-w-0 lg:col-span-5">
          <MatchSummaryCard />
        </div>
      </div>

      {/* Row 2: Follow-up recommendations (100% width) */}
      <FollowupRecommendationsCard />
    </div>
  )
}

// ------------------------------------------------------------

function leadsDeltaValue(metric: LeadsTodayMetric): string {
  const { current, previous } = metric
  if (previous === 0) return current === 0 ? '—' : `+${current}`
  const pct = Math.round(((current - previous) / previous) * 100)
  return `${pct > 0 ? '+' : ''}${pct}%`
}

function formatMinutesSeconds(avgMinutes: number): string {
  const totalSeconds = Math.round(avgMinutes * 60)
  const min = Math.floor(totalSeconds / 60)
  const sec = totalSeconds % 60
  return `${min}min ${sec}s`
}
