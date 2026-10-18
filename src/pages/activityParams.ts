// The Activity screen keeps its filters in the URL so every chart, card and
// metric can deep-link into the exact supporting transactions.

import type { EntryKind } from '@/data/database.types'
import { addMonths, monthRange, type DateRange } from '@/lib/dates'

export type PeriodMode = 'month' | 'week' | 'all' | 'custom'

export interface ActivityFilters {
  period: PeriodMode
  range: DateRange | null
  kind: EntryKind | null
  account: string | null
  /** A category id, or 'none' for uncategorised. */
  category: string | null
  q: string
}

export function readActivityParams(params: URLSearchParams, todayDate: string): ActivityFilters {
  const from = params.get('from')
  const to = params.get('to')
  const valid = (d: string | null) => d !== null && /^\d{4}-\d{2}-\d{2}$/.test(d)
  let period = (params.get('period') as PeriodMode | null) ?? null
  let range: DateRange | null = null

  if (valid(from) && valid(to) && from! <= to!) {
    range = { from: from!, to: to! }
    if (!period) {
      const month = monthRange(from!)
      period = month.from === from && month.to === to ? 'month' : 'custom'
    }
  }
  if (period === 'all') range = null
  else if (!range) {
    period = 'month'
    range = monthRange(todayDate)
  }

  const kind = params.get('kind')
  return {
    period: period ?? 'month',
    range,
    kind: kind === 'income' || kind === 'expense' || kind === 'transfer' ? kind : null,
    account: params.get('account'),
    category: params.get('category'),
    q: params.get('q') ?? '',
  }
}

interface HrefInput {
  range?: DateRange | null
  period?: PeriodMode
  kind?: EntryKind | null
  account?: string | null
  category?: string | null
  q?: string
}

export function activityHref(input: HrefInput): string {
  return `/activity?${activitySearch(input).toString()}`
}

export function activitySearch({ range, period, kind, account, category, q }: HrefInput): URLSearchParams {
  const params = new URLSearchParams()
  if (period === 'all') params.set('period', 'all')
  else if (range) {
    params.set('from', range.from)
    params.set('to', range.to)
    if (period && period !== 'month' && period !== 'custom') params.set('period', period)
  }
  if (kind) params.set('kind', kind)
  if (account) params.set('account', account)
  if (category) params.set('category', category)
  if (q) params.set('q', q)
  return params
}

export function shiftMonth(range: DateRange, months: number): DateRange {
  return monthRange(addMonths(range.from, months))
}
