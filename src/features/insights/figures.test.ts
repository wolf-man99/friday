import { describe, expect, it } from 'vitest'
import type { AccountActivityRow, CategoryBreakdownRow } from '@/data/database.types'
import {
  attentionCounts,
  compareTotals,
  describeAccountActivity,
  offsetSentence,
  spendingHeadline,
  splitBreakdown,
} from './figures'

const row = (category_id: string | null, total_minor: number, refund_minor = 0): CategoryBreakdownRow => ({
  category_id,
  total_minor,
  gross_minor: total_minor + refund_minor,
  refund_minor,
  transaction_count: 1,
})

describe('spendingHeadline', () => {
  it('shows net spending and the refunds already taken off', () => {
    expect(spendingHeadline({ expense_minor: 80_000, refund_minor: 20_000 })).toEqual({
      spentMinor: 80_000,
      refundsMinor: 20_000,
      cameBackMinor: 0,
    })
  })

  it('never shows negative spending: zero spent and the surplus in words', () => {
    expect(spendingHeadline({ expense_minor: -15_000, refund_minor: 40_000 })).toEqual({
      spentMinor: 0,
      refundsMinor: 40_000,
      cameBackMinor: 15_000,
    })
  })

  it('reads a missing summary as nothing', () => {
    expect(spendingHeadline(undefined)).toEqual({ spentMinor: 0, refundsMinor: 0, cameBackMinor: 0 })
  })
})

describe('splitBreakdown', () => {
  it('draws only categories above zero, with percentages of their sum', () => {
    const split = splitBreakdown([row('food', 60_000), row('shop', -30_000, 50_000), row('bills', 40_000, 1_000), row('gift', 0, 5_000)])
    expect(split.drawn.map((r) => r.category_id)).toEqual(['food', 'bills'])
    expect(split.drawnTotalMinor).toBe(100_000)
    // Most-refunded first; a category refunded to exactly zero is still mentioned.
    expect(split.offset.map((r) => r.category_id)).toEqual(['shop', 'gift'])
  })

  it('handles an empty breakdown', () => {
    expect(splitBreakdown([])).toEqual({ drawn: [], drawnTotalMinor: 0, offset: [] })
  })
})

describe('offsetSentence', () => {
  it('words refunds that outweighed spending', () => {
    expect(offsetSentence('Shopping', { total_minor: -30_000 }, 'expense')).toBe('Shopping: ₹300 more refunded than spent')
    expect(offsetSentence('Shopping', { total_minor: 0 }, 'expense')).toBe('Shopping: refunds cancelled out the spending')
  })

  it('words reversed income', () => {
    expect(offsetSentence('Salary', { total_minor: 0 }, 'income')).toBe('Salary: all of it was reversed')
    expect(offsetSentence('Salary', { total_minor: -500 }, 'income')).toBe('Salary: ₹5 more reversed than received')
  })
})

describe('compareTotals', () => {
  it('waits for both sides', () => {
    expect(compareTotals(undefined, 100)).toEqual({ kind: 'unknown' })
    expect(compareTotals(100, undefined)).toEqual({ kind: 'unknown' })
  })

  it('never uses zero or a net-negative previous total as a base', () => {
    expect(compareTotals(50_000, 0)).toEqual({ kind: 'no-base' })
    expect(compareTotals(50_000, -20_000)).toEqual({ kind: 'no-base' })
  })

  it('reads a net-negative current total as zero', () => {
    expect(compareTotals(-10_000, 40_000)).toEqual({ kind: 'change', diffMinor: 40_000, percent: 100, up: false })
  })

  it('reports the change and percentage', () => {
    expect(compareTotals(150_00, 100_00)).toEqual({ kind: 'change', diffMinor: 50_00, percent: 50, up: true })
    expect(compareTotals(100_00, 100_00)).toEqual({ kind: 'same' })
  })
})

describe('attentionCounts', () => {
  it('adds review events and entries; pending stays separate', () => {
    expect(attentionCounts({ review_events: 2, review_entries: 1, pending_entries: 4 })).toEqual({ toReview: 3, pending: 4 })
    expect(attentionCounts(undefined)).toEqual({ toReview: 0, pending: 0 })
  })
})

describe('describeAccountActivity', () => {
  const activity = (patch: Partial<AccountActivityRow> = {}): AccountActivityRow => ({
    account_id: 'bank',
    money_in_minor: 100_000,
    money_out_minor: 25_050,
    transfers_in_minor: 0,
    transfers_out_minor: 0,
    entry_count: 3,
    ...patch,
  })

  it('names the figures, and transfers only when there are any', () => {
    expect(describeAccountActivity('HDFC', activity(), 'October 2026')).toBe(
      'HDFC, October 2026: money in ₹1,000, money out ₹250.50. Show transactions',
    )
    expect(describeAccountActivity('HDFC', activity({ transfers_out_minor: 500_00 }), 'October 2026')).toBe(
      'HDFC, October 2026: money in ₹1,000, money out ₹250.50, transfers out ₹500. Show transactions',
    )
  })
})
