import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/Toast'
import type { AccountBalanceRow, CategoryBreakdownRow, LedgerAttentionRow, PeriodSummaryRow } from '@/data/database.types'
import { Home } from './Home'

const account = (id: string, name: string, type: AccountBalanceRow['type'], patch: Partial<AccountBalanceRow> = {}): AccountBalanceRow => ({
  id,
  name,
  type,
  user_id: 'u1',
  currency: 'INR',
  color: 'sky',
  status: 'active',
  sort_order: 0,
  opening_balance_minor: 0,
  opening_date: '2026-10-01',
  income_minor: 0,
  expense_minor: 0,
  transfers_in_minor: 0,
  transfers_out_minor: 0,
  balance_minor: 0,
  institution_name: null,
  credit_limit_minor: null,
  refunds_minor: 0,
  reversed_income_minor: 0,
  pending_minor: 0,
  review_count: 0,
  outstanding_minor: type === 'credit_card' ? Math.max(-(patch.balance_minor ?? 0), 0) : null,
  available_credit_minor: null,
  ...patch,
})

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

let accounts: AccountBalanceRow[] = []
let periodSummary = summary()
let breakdown: CategoryBreakdownRow[] = []
let attention: LedgerAttentionRow = { review_events: 0, review_entries: 0, pending_entries: 0 }

vi.mock('@/app/settings', () => ({
  useSettings: () => ({
    profile: { id: 'u1', display_name: 'Sai Kumar', timezone: 'Asia/Kolkata', base_currency: 'INR', default_account_id: null, created_at: '', updated_at: '' },
    accounts,
    activeAccounts: accounts.filter((a) => a.status === 'active'),
    accountsById: new Map(accounts.map((a) => [a.id, a])),
    categories: [],
    categoriesById: new Map([['shop', { id: 'shop', name: 'Shopping', icon: 'shopping-bag', color: 'pink' }]]),
    timeZone: 'Asia/Kolkata',
    todayDate: '2026-10-18',
  }),
}))
vi.mock('@/data/hooks', () => ({
  useAttention: () => ok(attention),
  usePeriodSummary: () => ok(periodSummary),
  useCategoryBreakdown: () => ok(breakdown),
  useRecentEntries: () => ok([]),
  useDueOccurrences: () => ok([]),
  useRecurringRules: () => ok([]),
  useConfirmOccurrence: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSkipOccurrence: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

function renderHome() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Home />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('Home', () => {
  beforeEach(() => {
    accounts = [
      account('bank', 'Salary account', 'bank', { balance_minor: 1_000_000 }),
      account('wallet', 'Paytm', 'wallet', { balance_minor: 50_000 }),
      account('card', 'Millennia', 'credit_card', { balance_minor: -150_000 }),
      account('old', 'Old cash', 'cash', { status: 'archived', balance_minor: 99_900 }),
    ]
    periodSummary = summary()
    breakdown = []
    attention = { review_events: 0, review_entries: 0, pending_entries: 0 }
  })

  it('keeps card dues out of available money and labels the combined figure', () => {
    renderHome()
    const balances = screen.getByRole('region', { name: 'Balances' })
    expect(within(balances).getByLabelText('Available money ₹10,500')).toBeInTheDocument()
    expect(within(balances).getByText('Card dues').nextElementSibling).toHaveTextContent('₹1,500')
    expect(within(balances).getByText('After card dues').nextElementSibling).toHaveTextContent('₹9,000')
    expect(within(balances).getByText(/cards not included/)).toBeInTheDocument()
    // Archived accounts don't count towards today's money.
    expect(within(balances).queryByText('Old cash')).not.toBeInTheDocument()
  })

  it('shows no attention card when nothing needs a look', () => {
    renderHome()
    expect(screen.queryByRole('region', { name: 'Needs a look' })).not.toBeInTheDocument()
  })

  it('points at the review queue and pending entries when there are some', () => {
    attention = { review_events: 2, review_entries: 1, pending_entries: 4 }
    renderHome()
    const card = screen.getByRole('region', { name: 'Needs a look' })
    expect(within(card).getByRole('link', { name: /3 to review/ })).toHaveAttribute('href', '/review')
    const pending = within(card).getByRole('link', { name: /4 pending/ })
    expect(pending.getAttribute('href')).toContain('status=pending')
  })

  it('shows spending net of refunds and says so', () => {
    periodSummary = summary({ expense_minor: 120_000, refund_minor: 30_000, expense_count: 3, refund_count: 1 })
    renderHome()
    expect(screen.getByText('after ₹300 in refunds')).toBeInTheDocument()
    expect(screen.getByText('3 expenses')).toBeInTheDocument()
  })

  it('never shows negative spending when refunds outweigh it', () => {
    periodSummary = summary({ expense_minor: -20_000, refund_minor: 50_000, expense_count: 1, refund_count: 1 })
    renderHome()
    expect(screen.getByLabelText('₹0')).toBeInTheDocument()
    expect(screen.getByText('₹200 more came back than went out')).toBeInTheDocument()
  })

  it('draws only categories with net spending and links them without a type filter', () => {
    periodSummary = summary({ expense_minor: 40_000, expense_count: 2 })
    breakdown = [
      { category_id: 'shop', total_minor: 40_000, transaction_count: 2, gross_minor: 50_000, refund_minor: 10_000 },
      { category_id: null, total_minor: -5_000, transaction_count: 0, gross_minor: 0, refund_minor: 5_000 },
    ]
    renderHome()
    const tile = screen.getByRole('link', { name: /Shopping: ₹400 after ₹100 in refunds/ })
    expect(tile.getAttribute('href')).not.toContain('kind=')
    expect(tile.getAttribute('href')).toContain('category=shop')
    expect(screen.getByText(/had more refunded than spent/)).toBeInTheDocument()
  })

  it('reaches Profile from the header now that it left the tab bar', () => {
    renderHome()
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/profile')
  })
})
