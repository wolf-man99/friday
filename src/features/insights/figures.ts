// How Home and Insights read period totals. The sums come from the database
// (period_summary, category_breakdown, cashflow_trend, account_activity): they
// are already net of refunds and reversals, count only posted and pending
// entries, and leave transfers out. This module only decides what is safe to
// draw and how to say it, so a period or category where more came back than
// went out never shows as negative "spending" or a negative chart slice.
// See docs/ledger-model.md "Refunds".

import type { AccountActivityRow, CategoryBreakdownRow, LedgerAttentionRow, PeriodSummaryRow, TransactionType } from '@/data/database.types'
import { formatMoney } from '@/lib/money'

export interface SpendingHeadline {
  /** Net spending, never below zero: what "Spent" shows. */
  spentMinor: number
  /** Refunds and reversed purchases already taken off (≥ 0). */
  refundsMinor: number
  /** When refunds outweighed spending, how much more came back (≥ 0). */
  cameBackMinor: number
}

/** "Spent" for a period: net of refunds, with the refunds and any surplus said in words. */
export function spendingHeadline(summary: Pick<PeriodSummaryRow, 'expense_minor' | 'refund_minor'> | undefined): SpendingHeadline {
  const net = summary?.expense_minor ?? 0
  return {
    spentMinor: Math.max(net, 0),
    refundsMinor: Math.max(summary?.refund_minor ?? 0, 0),
    cameBackMinor: Math.max(-net, 0),
  }
}

export interface BreakdownSplit {
  /** Categories with a net total above zero: the only ones a chart can draw. */
  drawn: CategoryBreakdownRow[]
  /** Sum of the drawn totals, the base for their percentages. */
  drawnTotalMinor: number
  /** Categories whose refunds (or reversals) matched or outweighed the period's amount. */
  offset: CategoryBreakdownRow[]
}

/** Splits a net category breakdown into what can be charted and what must be said in words. */
export function splitBreakdown(rows: CategoryBreakdownRow[]): BreakdownSplit {
  const drawn = rows.filter((row) => row.total_minor > 0).sort((a, b) => b.total_minor - a.total_minor)
  return {
    drawn,
    drawnTotalMinor: drawn.reduce((sum, row) => sum + row.total_minor, 0),
    offset: rows.filter((row) => row.total_minor <= 0 && row.refund_minor > 0).sort((a, b) => a.total_minor - b.total_minor),
  }
}

/** "Shopping: ₹300 more refunded than spent" — for a category the chart leaves out. */
export function offsetSentence(name: string, row: Pick<CategoryBreakdownRow, 'total_minor'>, type: TransactionType): string {
  const surplus = formatMoney(-row.total_minor)
  if (type === 'income') {
    return row.total_minor < 0 ? `${name}: ${surplus} more reversed than received` : `${name}: all of it was reversed`
  }
  return row.total_minor < 0 ? `${name}: ${surplus} more refunded than spent` : `${name}: refunds cancelled out the spending`
}

export type Comparison =
  /** Still loading. */
  | { kind: 'unknown' }
  /** Nothing (or nothing net) last time, so a change or percentage would mean nothing. */
  | { kind: 'no-base' }
  | { kind: 'same' }
  | { kind: 'change'; diffMinor: number; percent: number; up: boolean }

/**
 * Compares two period totals. Net figures can dip to zero or below when
 * refunds outweigh spending; both sides are read as at least zero, and a
 * previous total of zero is never used as a percentage base.
 */
export function compareTotals(current: number | undefined, previous: number | undefined): Comparison {
  if (current === undefined || previous === undefined) return { kind: 'unknown' }
  const now = Math.max(current, 0)
  const before = Math.max(previous, 0)
  if (before === 0) return { kind: 'no-base' }
  if (now === before) return { kind: 'same' }
  const diff = now - before
  return { kind: 'change', diffMinor: Math.abs(diff), percent: Math.round((Math.abs(diff) / before) * 100), up: diff > 0 }
}

/** Review queue and pending counts for the dashboard. */
export function attentionCounts(row: LedgerAttentionRow | undefined): { toReview: number; pending: number } {
  return {
    toReview: (row?.review_events ?? 0) + (row?.review_entries ?? 0),
    pending: row?.pending_entries ?? 0,
  }
}

/** The sentence a screen reader hears for one account's activity in a period. */
export function describeAccountActivity(name: string, row: AccountActivityRow, periodLabel: string): string {
  const parts = [`money in ${formatMoney(row.money_in_minor)}`, `money out ${formatMoney(row.money_out_minor)}`]
  if (row.transfers_in_minor > 0) parts.push(`transfers in ${formatMoney(row.transfers_in_minor)}`)
  if (row.transfers_out_minor > 0) parts.push(`transfers out ${formatMoney(row.transfers_out_minor)}`)
  return `${name}, ${periodLabel}: ${parts.join(', ')}. Show transactions`
}
