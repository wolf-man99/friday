import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountActivityRow, CategoryBreakdownRow, PeriodSummaryRow } from '@/data/database.types'
import { Insights } from './Insights'

const summary = (patch: Partial<PeriodSummaryRow> = {}): PeriodSummaryRow => ({
  income_minor: 0,
  expense_minor: 0,
  net_minor: 0,
  income_count: 0,
  expense_count: 0,
  transfer_count: 0,
  refund_minor: 0,
  refund_count: 0,
  pending_count: 0,
  ...patch,
})

const ok = <T,>(data: T) => ({ data, error: null, isPending: false, refetch: vi.fn() })

let periodSummary = summary()
let breakdown: CategoryBreakdownRow[] = []
let activity: AccountActivityRow[] = []

const CATEGORIES = new Map([
  ['food', { id: 'food', name: 'Food & dining', icon: 'utensils', color: 'orange' }],
  ['shop', { id: 'shop', name: 'Shopping', icon: 'shopping-bag', color: 'pink' }],
])
const ACCOUNTS = new Map([
  ['bank', { id: 'bank', name: 'Salary account', type: 'bank', color: 'sky', status: 'active' }],
  ['old', { id: 'old', name: 'Old card', type: 'credit_card', color: 'purple', status: 'archived' }],
])

vi.mock('@/app/settings', () => ({
  useSettings: () => ({
    accountsById: ACCOUNTS,
    categoriesById: CATEGORIES,
    timeZone: 'Asia/Kolkata',
    todayDate: '2026-10-18',
  }),
}))
vi.mock('@/data/hooks', () => ({
  usePeriodSummary: () => ok(periodSummary),
  useCategoryBreakdown: () => ok(breakdown),
  useCashflowTrend: () => ok([]),
  useAccountActivity: () => ok(activity),
}))

function renderInsights() {
  return render(
    <MemoryRouter>
      <Insights />
    </MemoryRouter>,
  )
}

describe('Insights', () => {
  beforeEach(() => {
    periodSummary = summary({ expense_minor: 50_000, refund_minor: 30_000, expense_count: 2, refund_count: 1 })
    breakdown = [
      { category_id: 'food', total_minor: 80_000, transaction_count: 2, gross_minor: 80_000, refund_minor: 0 },
      { category_id: 'shop', total_minor: -30_000, transaction_count: 0, gross_minor: 0, refund_minor: 30_000 },
    ]
    activity = []
  })

  it('shows spending net of refunds', () => {
    renderInsights()
    expect(screen.getByLabelText('Spent ₹500')).toBeInTheDocument()
    expect(screen.getByText(/Net of refunds ₹300/)).toBeInTheDocument()
  })

  it('leaves categories where refunds outweighed spending out of the chart and says so in words', () => {
    renderInsights()
    // Only Food is drawn, at 100% of what's drawn; Shopping is described instead.
    expect(screen.getByRole('link', { name: /Food & dining: ₹800, 100% of total/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Shopping: .*% of total/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Shopping: ₹300 more refunded than spent/ })).toBeInTheDocument()
  })

  it('drills into a category without a type filter, so its refunds show too', () => {
    renderInsights()
    const link = screen.getByRole('link', { name: /Food & dining: ₹800/ })
    expect(link.getAttribute('href')).toContain('category=food')
    expect(link.getAttribute('href')).not.toContain('kind=')
  })

  it('lists money in and out per account, archived ones included', () => {
    activity = [
      { account_id: 'bank', money_in_minor: 500_000, money_out_minor: 120_000, transfers_in_minor: 0, transfers_out_minor: 150_000, entry_count: 6 },
      { account_id: 'old', money_in_minor: 0, money_out_minor: 9_900, transfers_in_minor: 0, transfers_out_minor: 0, entry_count: 1 },
    ]
    renderInsights()
    const section = screen.getByRole('heading', { name: 'By account' }).closest('section')!
    const bank = within(section).getByRole('link', { name: /Salary account, .*money in ₹5,000, money out ₹1,200, transfers out ₹1,500/ })
    expect(bank.getAttribute('href')).toContain('account=bank')
    expect(within(section).getByText('Old card (archived)')).toBeInTheDocument()
  })

  it('says when no account had activity', () => {
    renderInsights()
    expect(screen.getByText(/No account activity in/)).toBeInTheDocument()
  })
})
