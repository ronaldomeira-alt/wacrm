'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Building2, ChevronRight, Layers, RefreshCw } from 'lucide-react'
import type { DashboardMatchSummary } from '@/lib/dashboard/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from './skeleton'

function PropertyThumb({
  src,
  alt,
}: {
  src: string | null
  alt: string
}) {
  const [failed, setFailed] = useState(false)

  if (!src || failed) {
    return (
      <div className="flex h-11 w-14 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted text-muted-foreground sm:h-12 sm:w-16">
        <Building2 className="h-4 w-4" />
      </div>
    )
  }

  return (
    <div className="h-11 w-14 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted sm:h-12 sm:w-16">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
    </div>
  )
}

function formatPropertyHeading(title: string, neighborhood: string): string {
  if (!neighborhood) return title
  const normTitle = title.toLowerCase()
  const normNeigh = neighborhood.toLowerCase()
  if (normTitle.includes(normNeigh)) return title
  return `${title} – ${neighborhood}`
}

export function MatchSummaryCard() {
  const t = useTranslations('Dashboard.matchSummary')
  const [summary, setSummary] = useState<DashboardMatchSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let active = true
    void fetch('/api/dashboard/match-summary', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as DashboardMatchSummary
      })
      .then((json) => {
        if (!active) return
        setSummary(json)
        setError(false)
      })
      .catch((err) => {
        console.error('[dashboard] match summary failed:', err)
        if (active) setError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [reloadTick])

  const handleRetry = () => {
    setLoading(true)
    setError(false)
    setReloadTick((n) => n + 1)
  }

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card p-4 sm:p-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-400">
            <Layers className="h-4 w-4" />
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

        <Link
          href="/match"
          aria-label={t('viewAllAria')}
          className="inline-flex shrink-0 items-center gap-1 rounded-full transition-opacity hover:opacity-85"
        >
          <span className="inline-flex h-6 min-w-7 items-center justify-center rounded-full bg-purple-600 px-2.5 text-xs font-bold tabular-nums text-white">
            {loading ? '—' : (summary?.totalPendingLeads ?? 0)}
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      </div>

      {/* Body */}
      <div className="mt-4 flex flex-1 flex-col justify-center">
        {loading ? (
          <div className="space-y-2.5">
            {[0, 1, 2].map((idx) => (
              <div
                key={idx}
                className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 p-2.5"
              >
                <Skeleton className="h-11 w-14 shrink-0 rounded-lg sm:h-12 sm:w-16" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex min-h-[190px] flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-border/70 px-4 text-center">
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
        ) : !summary || summary.items.length === 0 ? (
          <div className="flex min-h-[190px] flex-col items-center justify-center rounded-lg border border-dashed border-border/70 px-4 text-center">
            <p className="text-sm font-medium text-foreground">{t('emptyTitle')}</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              {t('emptyDescription')}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {summary.items.map((item) => {
              const heading = formatPropertyHeading(item.title, item.neighborhood)
              const isStrong = item.maxMatchScore >= 95
              return (
                <Link
                  key={item.propertyId}
                  href={`/match?lead=${encodeURIComponent(item.topLeadId)}&property=${encodeURIComponent(item.propertyId)}`}
                  className="group flex min-h-[60px] items-center gap-3 rounded-xl border border-border/70 bg-background/40 p-2.5 transition-colors hover:border-border hover:bg-muted/50 active:bg-muted/70"
                >
                  <PropertyThumb src={item.coverUrl} alt={heading} />

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {heading}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {t('leadsMatched', { count: item.leadsCount })}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums ${
                        isStrong
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-blue-500/15 text-blue-400'
                      }`}
                    >
                      {item.maxMatchScore}%
                    </span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
