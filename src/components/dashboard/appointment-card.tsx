'use client'

import { memo } from 'react'
import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import type { Appointment, AppointmentType } from '@/types'

// Left-border accent per appointment type — a quiet extra signal on
// the card, independent of the two text lines (title/time) it shows.
const TYPE_BORDER_CLASSES: Record<AppointmentType, string> = {
  call: 'border-l-blue-500',
  visit: 'border-l-violet-500',
  meeting: 'border-l-emerald-500',
  proposal: 'border-l-amber-500',
  follow_up: 'border-l-orange-500',
  other: 'border-l-slate-400',
}

interface AppointmentCardProps {
  appointment: Appointment
  /** Called with the card's own bounding box (captured synchronously at
   *  click time) so the detail popup can grow out of this exact card —
   *  see useFlipTransition. */
  onSelect: (appointment: Appointment, originRect: DOMRect) => void
  onToggleComplete: (appointment: Appointment) => void
}

/** Memoized — same reasoning as PipelineBoard's DealCard: opening the
 *  detail popup only ever changes AgendaWeek's `detailAppointment`/
 *  `detailOriginRect` state, unrelated to any card's own `appointment`
 *  prop, so re-rendering every sibling card (up to 6 columns' worth)
 *  on that update is pure waste competing with the popup's own opening
 *  animation for the first frame. */
export const AppointmentCard = memo(function AppointmentCard({
  appointment: a,
  onSelect,
  onToggleComplete,
}: AppointmentCardProps) {
  const t = useTranslations('Dashboard.agenda')
  const isCompleted = a.status === 'completed'

  function handleActivate(originRect: DOMRect) {
    onSelect(a, originRect)
  }

  return (
    // A `<div role="button">`, not a native `<button>`: the checkbox
    // below is itself a real `<button>`, and nesting button-in-button
    // is invalid HTML — the browser closes the outer one the instant
    // it hits the inner one, breaking the card's layout. onKeyDown
    // mirrors the Enter/Space activation a real button gets for free.
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => handleActivate(e.currentTarget.getBoundingClientRect())}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleActivate(e.currentTarget.getBoundingClientRect())
        }
      }}
      className={`relative w-full cursor-pointer rounded-md border border-l-2 border-border bg-card p-2.5 pr-7 text-left transition-colors hover:border-primary/40 ${
        isCompleted ? 'border-l-[#00E5FF] opacity-[0.45]' : TYPE_BORDER_CLASSES[a.type]
      }`}
    >
      <button
        type="button"
        onClick={(e) => {
          // Keep the card's own onClick (open detail sheet) from also
          // firing on a checkbox click — see the card's role="button"
          // comment above for why this can't be a native nested
          // <button>-in-<button> either way; this is the checkbox
          // itself, not nested inside another button.
          e.stopPropagation()
          onToggleComplete(a)
        }}
        aria-label={t('toggleCompleteLabel')}
        aria-pressed={isCompleted}
        className={`absolute right-3 top-3 flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-[1.5px] transition-colors ${
          isCompleted
            ? 'border-[#00E5FF] bg-[#00E5FF]'
            : 'border-[#334155] bg-transparent hover:border-[#64748B]'
        }`}
      >
        {isCompleted && <Check className="h-3 w-3 text-black" strokeWidth={2} />}
      </button>
      {/* Title is the card's primary line now (iPhone-calendar-style
          layout) — up to two lines, wrapping naturally rather than
          truncating with an ellipsis, so the card grows to fit instead
          of ever cutting the title off. */}
      <p className={`text-sm font-semibold text-foreground ${isCompleted ? 'line-through' : ''}`}>
        {a.title}
      </p>
      <p className="mt-0.5 text-xs tabular-nums text-foreground/80">
        {a.scheduled_time ? a.scheduled_time.slice(0, 5) : t('allDay')}
      </p>
    </div>
  )
})
