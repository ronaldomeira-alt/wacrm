"use client"

import Link from 'next/link'
import { UserPlus, BrainCircuit, Megaphone, Calculator } from 'lucide-react'
import type { ComponentType } from 'react'

import { useTranslations } from 'next-intl'

// Quick-action shortcuts. Each navigates to the page that owns the relevant flow.
interface Action {
  labelKey: string
  icon: ComponentType<{ className?: string }>
  tint: string
  href: string
}

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')

  const actions: Action[] = [
    { labelKey: 'newContact', href: '/contacts', icon: UserPlus, tint: 'text-primary' },
    { labelKey: 'aiCenter', href: '/agents', icon: BrainCircuit, tint: 'text-blue-400' },
    { labelKey: 'newBroadcast', href: '/campaigns/new', icon: Megaphone, tint: 'text-amber-400' },
    { labelKey: 'calculadora', href: '/calculadora', icon: Calculator, tint: 'text-primary' },
  ]

  const className =
    'group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-border hover:bg-muted/60'

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {actions.map((a) => {
        const Icon = a.icon
        return (
          <Link key={a.labelKey} href={a.href} className={className}>
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg bg-muted ${a.tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <span className="text-sm font-medium text-foreground">{t(a.labelKey as string)}</span>
          </Link>
        )
      })}
    </div>
  )
}
