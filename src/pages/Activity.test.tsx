import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeedFilters } from '@/data/api'
import type { AccountBalanceRow, CategoryRow, LedgerEntryRow } from '@/data/database.types'
import { Activity } from './Activity'

const account = (id: string, name: string, type: AccountBalanceRow['type'], status: AccountBalanceRow['status'] = 'active'): AccountBalanceRow => ({
  id,
  name,
  type,
  user_id: 'u1',
  currency: 'INR',
  color: 'sky',
  status,
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
  outstanding_minor: type === 'credit_card' ? 0 : null,
  available_credit_minor: null,
})

const category = (id: string, name: string, type: CategoryRow['transaction_type']): CategoryRow => ({
  id,
  name,
  transaction_type: type,
  user_id: 'u1',
  icon: 'tag',
  color: 'orange',
  is_default: true,
  is_archived: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
})

const ACCOUNTS = [account('bank', 'HDFC', 'bank'), account('card', 'Amex', 'credit_card'), account('old', 'Old savings', 'bank', 'archived')]
const CATEGORIES = [category('food', 'Food & dining', 'expense'), category('salary', 'Salary', 'income')]

const settings = {
  todayDate: '2026-10-19',
  timeZone: 'Asia/Kolkata',
  accounts: ACCOUNTS,
  activeAccounts: ACCOUNTS.filter((a) => a.status === 'active'),
  accountsById: new Map(ACCOUNTS.map((a) => [a.id, a])),
  categories: CATEGORIES,
  categoriesById: new Map(CATEGORIES.map((c) => [c.id, c])),
}

let entryCount = 0
const entry = (patch: Partial<LedgerEntryRow>): LedgerEntryRow => ({
  id: `e${++entryCount}`,
  user_id: 'u1',
  kind: 'expense',
  account_id: 'bank',
  counter_account_id: null,
  category_id: 'food',
  amount_minor: 10000,
  currency: 'INR',
  // 13:00 in Kolkata on the 19th.
  occurred_at: '2026-10-19T07:30:00Z',
  note: null,
  merchant: 'Swiggy',
  status: 'posted',
  source_type: 'manual',
  created_via: 'quick_add',
  related_transaction_id: null,
  base_type: 'expense',
  source_confidence: null,
  voided_from: null,
  created_at: '',
  updated_at: '',
  ...patch,
})

let pages: LedgerEntryRow[][] = []
let hasNextPage = false
const feedCalls: FeedFilters[] = []

vi.mock('@/app/settings', () => ({ useSettings: () => settings }))
vi.mock('@/data/hooks', () => ({
  useFeed: (filters: FeedFilters) => {
    feedCalls.push(filters)
    return {
      isPending: false,
      error: null,
      data: { pages },
      isFetching: false,
      hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    }
  },
}))

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.search}</output>
}

function renderActivity(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/activity${search}`]}>
      <Routes>
        <Route
          path="/activity"
          element={
            <>
              <Activity />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

const lastFeed = () => feedCalls[feedCalls.length - 1]
const daySection = (name: string) => screen.getByRole('region', { name })

beforeEach(() => {
  pages = []
  hasNextPage = false
  feedCalls.length = 0
  entryCount = 0
})

describe('Activity — day totals', () => {
  it('counts only posted and pending entries, nets refunds and reversed income, and skips transfers', () => {
    pages = [
      [
        entry({ amount_minor: 45000 }),
        entry({ amount_minor: 30000, status: 'voided', voided_from: 'pending' }),
        entry({ amount_minor: 99900, status: 'needs_review', source_type: 'email' }),
        entry({ kind: 'refund', amount_minor: 20000, related_transaction_id: 'e1' }),
        entry({ kind: 'reversal', amount_minor: 5000, related_transaction_id: 'e1' }),
        entry({ kind: 'transfer', amount_minor: 500000, counter_account_id: 'card', category_id: null, merchant: null, base_type: null }),
        entry({ kind: 'income', amount_minor: 100000, status: 'pending', category_id: 'salary', merchant: 'Acme', base_type: 'income' }),
        entry({ kind: 'reversal', amount_minor: 10000, category_id: 'salary', merchant: 'Acme', base_type: 'income' }),
        entry({ kind: 'income', amount_minor: 70000, status: 'voided', category_id: 'salary', base_type: 'income' }),
      ],
    ]
    renderActivity()

    const today = daySection('Today')
    // 450 − 200 refund − 50 reversed purchase; the voided 300 and the 999 in review don't count.
    expect(within(today).getByText('Out ₹200')).toBeInTheDocument()
    // 1,000 pending income − 100 reversed; the voided 700 doesn't count.
    expect(within(today).getByText('In ₹900')).toBeInTheDocument()
    expect(within(today).getAllByRole('link')).toHaveLength(9)
  })

  it('says money back when a day only has a refund', () => {
    pages = [
      [
        entry({ kind: 'refund', amount_minor: 20000, occurred_at: '2026-10-19T07:30:00Z' }),
        entry({ amount_minor: 30000, status: 'voided', occurred_at: '2026-10-18T07:30:00Z' }),
      ],
    ]
    renderActivity()
    expect(within(daySection('Today')).getByText('Money back ₹200')).toBeInTheDocument()
    // A day with only voided entries has no totals at all.
    expect(within(daySection('Yesterday')).queryByText(/Out|In|Money back/)).not.toBeInTheDocument()
  })

  it('explains what the day totals count', () => {
    pages = [[entry({})]]
    hasNextPage = true
    renderActivity()
    expect(screen.getByText(/Day totals cover the entries loaded so far/)).toBeInTheDocument()
    expect(screen.getByText(/Pending entries count in day totals; voided ones and ones waiting for review don’t/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument()
  })
})

describe('Activity — filters', () => {
  it('filters to refunds (which include reversals) and limits categories to expense ones', async () => {
    const user = userEvent.setup()
    pages = [[entry({})]]
    renderActivity()

    await user.click(screen.getByRole('button', { name: 'Refunds' }))
    expect(screen.getByTestId('location')).toHaveTextContent('kind=refund')
    expect(lastFeed().kind).toBe('refund')
    expect(screen.getByRole('button', { name: 'Refunds' })).toHaveAttribute('aria-pressed', 'true')

    const categorySelect = screen.getByRole('combobox', { name: 'Category' })
    const options = within(categorySelect).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Any category', 'Uncategorised', 'Food & dining'])
  })

  it('shows every category when no type is selected', () => {
    renderActivity()
    const options = within(screen.getByRole('combobox', { name: 'Category' }))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toEqual(['Any category', 'Uncategorised', 'Food & dining', 'Salary'])
  })

  it('drops an income category when switching to money out', async () => {
    const user = userEvent.setup()
    renderActivity('?kind=income&category=salary')
    await user.click(screen.getByRole('button', { name: 'Money out' }))
    expect(screen.getByTestId('location')).toHaveTextContent('kind=expense')
    expect(screen.getByTestId('location')).not.toHaveTextContent('category=')
  })

  it('filters by status and writes it to the URL', async () => {
    const user = userEvent.setup()
    renderActivity()
    const status = screen.getByRole('combobox', { name: 'Status' })
    expect(within(status).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Any status',
      'Needs attention (pending + review)',
      'Pending',
      'Needs review',
      'Voided',
    ])
    await user.selectOptions(status, 'attention')
    expect(screen.getByTestId('location')).toHaveTextContent('status=attention')
    expect(lastFeed().status).toBe('attention')
  })

  it('reads the status from the URL and clears it with the other filters', async () => {
    const user = userEvent.setup()
    renderActivity('?status=voided&kind=refund')
    expect(lastFeed()).toMatchObject({ status: 'voided', kind: 'refund' })
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('voided')

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByTestId('location')).not.toHaveTextContent('status=')
    expect(lastFeed()).toMatchObject({ status: null, kind: null })
  })

  it('lists archived accounts so their history stays reachable', () => {
    renderActivity()
    const options = within(screen.getByRole('combobox', { name: 'Account' }))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(options).toContain('Old savings (archived)')
  })

  it('searches merchants, notes and categories', () => {
    renderActivity()
    expect(screen.getByRole('searchbox', { name: 'Search merchants, notes and categories' })).toHaveAttribute(
      'placeholder',
      'Search merchants, notes or categories',
    )
  })
})
