'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { formatDistanceToNow } from 'date-fns'
import { CalendarCheck2, ChevronRight, Clock, RefreshCw } from 'lucide-react'
import { getDateFnsLocale } from '@/lib/date-fns-locale'
import type { AiSuggestion } from '@/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from './skeleton'

interface FollowupPayload {
  score?: number
  hours_since_contact?: number
  reason?: string
  approach_summary?: string
  stage_name?: string | null
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

function formatSuggestionSummary(item: AiSuggestion): string {
  const title = (item.title || '').trim()
  const desc = (item.description || '').trim()
  if (title && desc && desc.toLowerCase() !== title.toLowerCase()) {
    return `${title}. ${desc}`
  }
  return title || desc
}

function getAgeToneClass(hoursSince: number | null): string {
  if (hoursSince === null) return 'text-muted-foreground'
  if (hoursSince >= 72) return 'text-amber-400'
  if (hoursSince >= 24) return 'text-emerald-400'
  return 'text-purple-400'
}

export function FollowupRecommendationsCard() {
  const t = useTranslations('Dashboard.followupRecommendations')
  const appLocale = useLocale()
  const dateFnsLocale = getDateFnsLocale(appLocale)

  const [items, setItems] = useState<AiSuggestion[]>([])
  const [totalPending, setTotalPending] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let active = true
    void fetch('/api/ai/suggestions?status=pending&category=followup&limit=50', {
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as { suggestions?: AiSuggestion[] }
      })
      .then((json) => {
        if (!active) return
        const all = Array.isArray(json.suggestions) ? json.suggestions : []

        // Rank by persisted Clara score descending, then newest creation timestamp
        const sorted = [...all].sort((a, b) => {
          const scoreA = Number((a.payload as FollowupPayload | undefined)?.score ?? 0)
          const scoreB = Number((b.payload as FollowupPayload | undefined)?.score ?? 0)
          if (scoreB !== scoreA) return scoreB - scoreA
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        })

        setTotalPending(all.length)
        setItems(sorted.slice(0, 3))
        setError(false)
      })
      .catch((err) => {
        console.error('[dashboard] followup recommendations failed:', err)
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
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <CalendarCheck2 className="h-4 w-4" />
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
          href="/followup"
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border bg-muted/40 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <span>
            {totalPending > 0
              ? t('viewAllWithCount', { count: totalPending })
              : t('viewAll')}
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </Link>
      </div>

      {/* Content */}
      <div className="mt-4">
        {loading ? (
          <div className="space-y-2.5">
            {[0, 1, 2].map((idx) => (
              <div
                key={idx}
                className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-3 py-3"
              >
                <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                <Skeleton className="h-4 w-28 shrink-0" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-16 shrink-0" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-border/70 px-4 py-8 text-center">
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
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/70 px-4 py-8 text-center">
            <p className="text-sm font-medium text-foreground">{t('emptyTitle')}</p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              {t('emptyDescription')}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const contactName = item.contact?.name?.trim() || t('unnamedLead')
              const avatarUrl = item.contact?.avatar_url
              const summaryText = formatSuggestionSummary(item)
              const payload = (item.payload as FollowupPayload | undefined) ?? {}
              const hoursSince =
                typeof payload.hours_since_contact === 'number'
                  ? payload.hours_since_contact
                  : null
              const timeLabel = formatDistanceToNow(new Date(item.created_at), {
                addSuffix: true,
                locale: dateFnsLocale,
              })
              const href = item.conversation_id
                ? `/inbox?c=${encodeURIComponent(item.conversation_id)}`
                : `/followup${
                    item.contact_id
                      ? `?contact=${encodeURIComponent(item.contact_id)}`
                      : ''
                  }`

              return (
                <Link
                  key={item.id}
                  href={href}
                  className="group flex min-h-[56px] flex-col gap-2 rounded-xl border border-border/70 bg-background/40 px-3.5 py-3 transition-colors hover:border-border hover:bg-muted/50 active:bg-muted/70 md:flex-row md:items-center md:gap-3"
                >
                  {/* Lead Avatar + Name + Mobile Meta */}
                  <div className="flex items-center justify-between gap-2 md:w-48 md:shrink-0 md:justify-start">
                    <div className="flex min-w-0 items-center gap-2.5">
                      {avatarUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={avatarUrl}
                          alt={contactName}
                          className="h-8 w-8 shrink-0 rounded-full border border-border/60 object-cover"
                        />
                      ) : (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted text-xs font-semibold text-foreground">
                          {getInitials(contactName)}
                        </div>
                      )}
                      <span className="truncate text-sm font-semibold text-foreground">
                        {contactName}
                      </span>
                    </div>

                    {/* Mobile timing badge */}
                    <span
                      className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium md:hidden ${getAgeToneClass(hoursSince)}`}
                    >
                      <Clock className="h-3.5 w-3.5" />
                      <span>{timeLabel}</span>
                    </span>
                  </div>

                  <span
                    aria-hidden
                    className="hidden h-4 w-px shrink-0 bg-border md:block"
                  />

                  {/* Reason & Suggested Action */}
                  <p className="line-clamp-2 min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground md:line-clamp-1 md:text-sm">
                    {summaryText}
                  </p>

                  {/* Desktop timing + chevron */}
                  <div className="hidden shrink-0 items-center gap-2 md:flex">
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs font-medium ${getAgeToneClass(hoursSince)}`}
                    >
                      <Clock className="h-3.5 w-3.5" />
                      <span>{timeLabel}</span>
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
