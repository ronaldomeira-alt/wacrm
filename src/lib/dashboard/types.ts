// Shared result shapes the dashboard consumes.

export interface LeadsTodayMetric {
  current: number
  previous: number
}

export interface FirstResponseMetric {
  /** Average minutes from a customer's first message in a conversation
   *  to the first subsequent agent/bot reply, over the trailing
   *  7-day window. Null when there are no paired samples yet. */
  avgMinutes: number | null
  sampleCount: number
}

export type LeadsMovementPeriod = 7 | 14 | 30

export interface LeadsMovementPoint {
  index: number
  dayLabel: string
  currentKey: string
  previousKey: string
  current: number
  previous: number
}

export interface LeadsMovementData {
  period: LeadsMovementPeriod
  points: LeadsMovementPoint[]
  totalCurrent: number
  totalPrevious: number
}

export interface DashboardMatchPropertySummary {
  propertyId: string
  title: string
  neighborhood: string
  coverUrl: string | null
  leadsCount: number
  maxMatchScore: number
  maxCommercialPriority: number
  topLeadId: string
}

export interface DashboardMatchSummary {
  totalPendingLeads: number
  totalPendingMatches: number
  activeWindowDays: number
  items: DashboardMatchPropertySummary[]
}
