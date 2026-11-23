// Centralised date helpers for the dashboard so every chart / card
// agrees on what "today", "day boundary", and "day of week" mean.
// All boundaries are computed in the user's LOCAL timezone — which is
// what a business user intuitively expects when they say "today".

export function startOfLocalDay(d: Date = new Date()): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

export function daysAgoStart(days: number): Date {
  const out = startOfLocalDay()
  out.setDate(out.getDate() - days)
  return out
}

/** Date-only key (YYYY-MM-DD) for bucketing rows by local calendar day. */
export function localDayKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Inclusive list of local-day keys spanning the last `n` days, in
 * chronological order. Useful for seeding chart buckets so days with
 * zero activity still render a 0-point in the line.
 */
export function lastNDayKeys(n: number): string[] {
  const keys: string[] = []
  const start = daysAgoStart(n - 1)
  for (let i = 0; i < n; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    keys.push(localDayKey(d))
  }
  return keys
}

/**
 * Which days the weekly agenda shows, as an offset from Monday
 * (0 = Monday … 6 = Sunday). Sunday (6) is deliberately excluded for
 * now — add it here to turn the column on later; getWeekDates below
 * (and every caller that maps over its result) needs no other change.
 */
export const WEEK_DAY_OFFSETS = [0, 1, 2, 3, 4, 5] as const

/**
 * Local-day keys (YYYY-MM-DD) for WEEK_DAY_OFFSETS within the
 * Monday-start calendar week containing `d`.
 */
export function getWeekDates(d: Date = new Date()): string[] {
  const jsDow = d.getDay() // 0 = Sunday … 6 = Saturday
  const mondayOffset = (jsDow + 6) % 7 // 0 = Monday … 6 = Sunday
  const monday = startOfLocalDay(d)
  monday.setDate(monday.getDate() - mondayOffset)
  return WEEK_DAY_OFFSETS.map((offset) => {
    const day = new Date(monday)
    day.setDate(day.getDate() + offset)
    return localDayKey(day)
  })
}

// ------------------------------------------------------------
// America/Sao_Paulo helpers (used by Leads Movement chart)
// ------------------------------------------------------------

export const DASHBOARD_TIMEZONE = 'America/Sao_Paulo'

const spDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DASHBOARD_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const spOffsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DASHBOARD_TIMEZONE,
  timeZoneName: 'shortOffset',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** Date-only key (YYYY-MM-DD) in America/Sao_Paulo timezone. */
export function saoPauloDayKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  return spDateFormatter.format(date)
}

/**
 * Inclusive list of America/Sao_Paulo day keys (YYYY-MM-DD) spanning the
 * last `n` days ending on the current calendar day in America/Sao_Paulo.
 */
export function lastNSaoPauloDayKeys(n: number, now: Date = new Date()): string[] {
  if (n <= 0) return []
  const todayKey = saoPauloDayKey(now)
  const [y, m, day] = todayKey.split('-').map(Number)
  const baseUtcMs = Date.UTC(y, m - 1, day)
  const keys: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(baseUtcMs - i * 86_400_000)
    const yy = dt.getUTCFullYear()
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(dt.getUTCDate()).padStart(2, '0')
    keys.push(`${yy}-${mm}-${dd}`)
  }
  return keys
}

/**
 * Returns the ISO UTC timestamp representing 00:00:00.000 of `dayKey`
 * (YYYY-MM-DD) in America/Sao_Paulo, computing the offset dynamically.
 */
export function saoPauloDayStartIso(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  // Probe around midday UTC (same calendar day in SP) to resolve active offset (-03 or -02)
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  const parts = spOffsetFormatter.formatToParts(probe)
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-3'
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
  let offsetMinutes = -180
  if (match) {
    const sign = match[1] === '-' ? -1 : 1
    const hours = Number(match[2])
    const mins = Number(match[3] ?? '0')
    offsetMinutes = sign * (hours * 60 + mins)
  }
  const utcMidnightMs = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60_000
  return new Date(utcMidnightMs).toISOString()
}

const WEEKDAY_LABELS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const
const WEEKDAY_LABELS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const WEEKDAY_LABELS_KO = ['일', '월', '화', '수', '목', '금', '토'] as const

/** Short weekday label for a YYYY-MM-DD key (calendar-pure, timezone-safe). */
export function formatShortWeekday(dayKey: string, locale: string = 'pt-BR'): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  if (locale.startsWith('ko')) return WEEKDAY_LABELS_KO[dow]
  if (locale.startsWith('en')) return WEEKDAY_LABELS_EN[dow]
  return WEEKDAY_LABELS_PT[dow]
}

/** Formats YYYY-MM-DD as DD/MM. */
export function formatDayMonth(dayKey: string): string {
  const [, m, d] = dayKey.split('-')
  return `${d}/${m}`
}
