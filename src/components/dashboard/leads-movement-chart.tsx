'use client'

import { useEffect, useId, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { TrendingUp, RefreshCw } from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { createClient } from '@/lib/supabase/client'
import { loadLeadsMovement } from '@/lib/dashboard/queries'
import { formatDayMonth } from '@/lib/dashboard/date-utils'
import type {
  LeadsMovementData,
  LeadsMovementPeriod,
  LeadsMovementPoint,
} from '@/lib/dashboard/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Skeleton } from './skeleton'

interface CustomTooltipProps {
  active?: boolean
  payload?: Array<{
    dataKey?: string
    value?: number
    payload?: LeadsMovementPoint
  }>
  currentLabel: string
  previousLabel: string
  leadsSuffix: string
}

function LeadsMovementTooltip({
  active,
  payload,
  currentLabel,
  previousLabel,
  leadsSuffix,
}: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0]?.payload
  if (!point) return null

  return (
    <div className="rounded-lg border border-border bg-popover/95 px-3 py-2.5 text-xs shadow-lg backdrop-blur-sm">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-foreground">
            <span className="h-2 w-2 rounded-full bg-blue-500" />
            <span>
              {currentLabel} ({formatDayMonth(point.currentKey)})
            </span>
          </span>
          <span className="font-semibold tabular-nums text-foreground">
            {point.current} {leadsSuffix}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-purple-500" />
            <span>
              {previousLabel} ({formatDayMonth(point.previousKey)})
            </span>
          </span>
          <span className="font-semibold tabular-nums text-foreground">
            {point.previous} {leadsSuffix}
          </span>
        </div>
      </div>
    </div>
  )
}

export function LeadsMovementChart() {
  const t = useTranslations('Dashboard.leadsMovement')
  const locale = useLocale()
  const gradUid = useId().replace(/:/g, '')

  const [period, setPeriod] = useState<LeadsMovementPeriod>(7)
  const [data, setData] = useState<LeadsMovementData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let active = true
    const db = createClient()
    void loadLeadsMovement(db, period, locale)
      .then((res) => {
        if (!active) return
        setData(res)
        setError(false)
      })
      .catch((err) => {
        console.error('[dashboard] leads movement failed:', err)
        if (active) setError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [locale, period, reloadTick])

  const handlePeriodChange = (val: string | null) => {
    const next = Number(val) as LeadsMovementPeriod
    if ((next === 7 || next === 14 || next === 30) && next !== period) {
      setLoading(true)
      setError(false)
      setPeriod(next)
    }
  }

  const handleRetry = () => {
    setLoading(true)
    setError(false)
    setReloadTick((n) => n + 1)
  }

  const periodLabels: Record<LeadsMovementPeriod, string> = {
    7: t('period7'),
    14: t('period14'),
    30: t('period30'),
  }

  const previousLegendLabel =
    period === 7 ? t('previousSeries7d') : t('previousSeriesOther')

  const isEmpty =
    !loading &&
    !error &&
    data !== null &&
    data.totalCurrent === 0 &&
    data.totalPrevious === 0

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card p-4 sm:p-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-400">
            <TrendingUp className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-foreground">
              {t('title')}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {t('description')}
            </p>
          </div>
        </div>

        <Select
          value={String(period)}
          onValueChange={handlePeriodChange}
        >
          <SelectTrigger
            size="sm"
            aria-label={t('periodAria')}
            className="h-8 rounded-lg border-border bg-muted/50 px-2.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            <SelectValue>{periodLabels[period]}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end" className="text-xs">
            <SelectItem value="7">{t('period7')}</SelectItem>
            <SelectItem value="14">{t('period14')}</SelectItem>
            <SelectItem value="30">{t('period30')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Chart Area */}
      <div className="mt-4 flex-1">
        {loading ? (
          <div className="flex h-[215px] flex-col justify-between py-2 sm:h-[235px]">
            <Skeleton className="h-3 w-full opacity-40" />
            <Skeleton className="h-32 w-full opacity-50" />
            <Skeleton className="h-3 w-3/4 opacity-40" />
          </div>
        ) : error ? (
          <div className="flex h-[215px] flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-border/70 px-4 text-center sm:h-[235px]">
            <p className="text-sm text-muted-foreground">{t('error')}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRetry}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t('retry')}
            </Button>
          </div>
        ) : isEmpty ? (
          <div className="flex h-[215px] flex-col items-center justify-center rounded-lg border border-dashed border-border/70 px-4 text-center sm:h-[235px]">
            <p className="text-sm font-medium text-foreground">{t('emptyTitle')}</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              {t('emptyDescription')}
            </p>
          </div>
        ) : (
          <div className="h-[215px] w-full min-w-0 select-none sm:h-[235px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data?.points ?? []}
                margin={{ top: 10, right: 16, left: -12, bottom: 0 }}
              >
                <defs>
                  <linearGradient
                    id={`leadsCurr-${gradUid}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient
                    id={`leadsPrev-${gradUid}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#a855f7" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="#a855f7" stopOpacity={0.02} />
                  </linearGradient>
                </defs>

                <CartesianGrid
                  vertical={false}
                  stroke="rgba(148, 163, 184, 0.12)"
                />

                <XAxis
                  dataKey="dayLabel"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#94a3b8', fontSize: 12 }}
                  tickMargin={8}
                  interval={period === 30 ? 4 : period === 14 ? 1 : 0}
                />

                <YAxis
                  allowDecimals={false}
                  axisLine={false}
                  tickLine={false}
                  width={38}
                  tick={{ fill: '#94a3b8', fontSize: 12 }}
                />

                <Tooltip
                  cursor={{
                    stroke: 'rgba(148, 163, 184, 0.25)',
                    strokeWidth: 1,
                    strokeDasharray: '3 3',
                  }}
                  content={
                    <LeadsMovementTooltip
                      currentLabel={t('currentSeries')}
                      previousLabel={previousLegendLabel}
                      leadsSuffix={t('leadsUnit')}
                    />
                  }
                />

                <Area
                  type="monotone"
                  dataKey="previous"
                  stroke="#a855f7"
                  strokeWidth={2.25}
                  fill={`url(#leadsPrev-${gradUid})`}
                  fillOpacity={1}
                  dot={false}
                  activeDot={{
                    r: 4,
                    fill: '#a855f7',
                    stroke: '#0f172a',
                    strokeWidth: 2,
                  }}
                  isAnimationActive={false}
                />

                <Area
                  type="monotone"
                  dataKey="current"
                  stroke="#3b82f6"
                  strokeWidth={2.5}
                  fill={`url(#leadsCurr-${gradUid})`}
                  fillOpacity={1}
                  dot={false}
                  activeDot={{
                    r: 4,
                    fill: '#3b82f6',
                    stroke: '#0f172a',
                    strokeWidth: 2,
                  }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border/50 pt-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-blue-500" />
          <span className="font-medium text-foreground">{t('currentSeries')}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-purple-500" />
          <span className="text-muted-foreground">{previousLegendLabel}</span>
        </div>
      </div>
    </section>
  )
}
