// Mirrors public.recurrence_date / recurrence_next_after in the database so
// the UI can preview schedules. The database remains the source of truth for
// which dates are due; this is only used to describe and preview them.

import { addDays, addMonths, diffDays, parseISODate, type ISODate } from './dates'

export type Cadence = 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface Schedule {
  startDate: ISODate
  cadence: Cadence
  intervalCount: number
}

/** The n-th due date (n = 0 is the start date). Always computed from the anchor. */
export function recurrenceDate({ startDate, cadence, intervalCount }: Schedule, n: number): ISODate {
  const steps = intervalCount * n
  switch (cadence) {
    case 'daily':
      return addDays(startDate, steps)
    case 'weekly':
      return addDays(startDate, steps * 7)
    case 'monthly':
      return addMonths(startDate, steps)
    case 'yearly':
      return addMonths(startDate, steps * 12)
  }
}

/** First due date strictly after `after` (or the start date if `after` precedes it). */
export function nextAfter(schedule: Schedule, after: ISODate): ISODate {
  const { startDate, cadence, intervalCount } = schedule
  if (diffDays(after, startDate) < 0) return startDate

  const a = parseISODate(after)
  const s = parseISODate(startDate)
  let n: number
  switch (cadence) {
    case 'daily':
      n = Math.floor(diffDays(after, startDate) / intervalCount)
      break
    case 'weekly':
      n = Math.floor(diffDays(after, startDate) / (7 * intervalCount))
      break
    case 'monthly':
      n = Math.floor(((a.year - s.year) * 12 + a.month - s.month) / intervalCount)
      break
    case 'yearly':
      n = Math.floor((a.year - s.year) / intervalCount)
      break
  }
  n = Math.max(n - 1, 0)
  for (;;) {
    const date = recurrenceDate(schedule, n)
    if (diffDays(date, after) > 0) return date
    n += 1
  }
}

/** The next `count` due dates on or after `from`, stopping at `endDate`. */
export function upcomingDates(
  schedule: Schedule,
  from: ISODate,
  count: number,
  endDate?: ISODate | null,
): ISODate[] {
  const dates: ISODate[] = []
  let date = nextAfter(schedule, addDays(from, -1))
  while (dates.length < count && (!endDate || diffDays(date, endDate) <= 0)) {
    dates.push(date)
    date = nextAfter(schedule, date)
  }
  return dates
}

export function describeSchedule({ cadence, intervalCount }: Pick<Schedule, 'cadence' | 'intervalCount'>): string {
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[cadence]
  if (intervalCount === 1) {
    return { daily: 'Every day', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' }[cadence]
  }
  if (cadence === 'weekly' && intervalCount === 2) return 'Every 2 weeks'
  if (cadence === 'monthly' && intervalCount === 3) return 'Every quarter'
  return `Every ${intervalCount} ${unit}s`
}
