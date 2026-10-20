// The Activity screen keeps its filters in the URL so every chart, card and
// metric can deep-link into the exact supporting transactions.

import type { EntryKind, EntryStatus } from '@/data/database.types'
import { addMonths, monthRange, type DateRange } from '@/lib/dates'

export type PeriodMode = 'month' | 'week' | 'all' | 'custom'

/** The type chips. 'refund' also finds reversals (the feed widens it). */
export type ActivityKind = Exclude<EntryKind, 'reversal'>

/** The status filter. 'attention' finds pending and needs-review entries. */
export type ActivityStatus = Exclude<EntryStatus, 'posted'> | 'attention'

export interface ActivityFilters {
  period: PeriodMode
  range: DateRange | null
  kind: ActivityKind | null
  status: ActivityStatus | null
  account: string | null
  /** A category id, or 'none' for uncategorised. */
  category: string | null
  q: string
}

const PERIODS: readonly string[] = ['month', 'week', 'all', 'custom'] satisfies PeriodMode[]
const KINDS: readonly string[] = ['expense', 'income', 'refund', 'transfer'] satisfies ActivityKind[]
const STATUSES: readonly string[] = ['pending', 'needs_review', 'voided', 'attention'] satisfies ActivityStatus[]

/** Ids go into feed filters, so anything that isn't plainly an id is dropped. */
const SAFE_ID = /^[\w-]{1,64}$/

function pick<T extends string>(value: string | null, allowed: readonly string[]): T | null {
  return value !== null && allowed.includes(value) ? (value as T) : null
}

export function readActivityParams(params: URLSearchParams, todayDate: string): ActivityFilters {
  const from = params.get('from')
  const to = params.get('to')
  const valid = (d: string | null) => d !== null && /^\d{4}-\d{2}-\d{2}$/.test(d)
  let period = pick<PeriodMode>(params.get('period'), PERIODS)
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

  const kind = pick<ActivityKind>(params.get('kind'), KINDS)
  const account = params.get('account')
  const category = params.get('category')
  return {
    period: period ?? 'month',
    range,
    kind,
    status: pick<ActivityStatus>(params.get('status'), STATUSES),
    account: account && SAFE_ID.test(account) ? account : null,
    // Transfers have no category.
    category: kind !== 'transfer' && category && SAFE_ID.test(category) ? category : null,
    q: params.get('q') ?? '',
  }
}

interface HrefInput {
  range?: DateRange | null
  period?: PeriodMode
  kind?: EntryKind | null
  status?: ActivityStatus | null
  account?: string | null
  category?: string | null
  q?: string
}

export function activityHref(input: HrefInput): string {
  return `/activity?${activitySearch(input).toString()}`
}

export function activitySearch({ range, period, kind, status, account, category, q }: HrefInput): URLSearchParams {
  const params = new URLSearchParams()
  if (period === 'all') params.set('period', 'all')
  else if (range) {
    params.set('from', range.from)
    params.set('to', range.to)
    if (period && period !== 'month' && period !== 'custom') params.set('period', period)
  }
  // Reversals are listed under Refunds: both give money back against an original.
  if (kind) params.set('kind', kind === 'reversal' ? 'refund' : kind)
  if (status) params.set('status', status)
  if (account) params.set('account', account)
  if (category) params.set('category', category)
  if (q) params.set('q', q)
  return params
}

export function shiftMonth(range: DateRange, months: number): DateRange {
  return monthRange(addMonths(range.from, months))
}
