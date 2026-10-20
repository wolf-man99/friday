import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/Toast'
import type { AccountBalanceRow } from '@/data/database.types'
import { AccountEditor, Accounts } from './Accounts'

const account = (
  id: string,
  name: string,
  type: AccountBalanceRow['type'],
  patch: Partial<AccountBalanceRow> = {},
): AccountBalanceRow => ({
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
  outstanding_minor: type === 'credit_card' ? 0 : null,
  available_credit_minor: null,
  ...patch,
})

// Deliberately out of order: the screen groups them.
const ACCOUNTS = [
  account('cash', 'Pocket cash', 'cash', { balance_minor: 30_000 }),
  account('card', 'Millennia', 'credit_card', {
    institution_name: 'HDFC Bank',
    balance_minor: -1_200_000,
    credit_limit_minor: 5_000_000,
  }),
  account('other', 'Savings jar', 'other', { balance_minor: 20_000 }),
  account('bank', 'Salary account', 'bank', { institution_name: 'State Bank of India', balance_minor: 1_000_000 }),
  account('wallet', 'Paytm', 'wallet', { balance_minor: 50_000 }),
  account('old', 'Old bank', 'bank', { status: 'archived', balance_minor: 999_900 }),
]

function makeSettings(accounts: AccountBalanceRow[] = ACCOUNTS) {
  return {
    profile: { id: 'u1', display_name: 'Sai', timezone: 'Asia/Kolkata', base_currency: 'INR', default_account_id: null, created_at: '', updated_at: '' },
    accounts,
    activeAccounts: accounts.filter((a) => a.status === 'active'),
    accountsById: new Map(accounts.map((a) => [a.id, a])),
    categories: [],
    categoriesById: new Map(),
    timeZone: 'Asia/Kolkata',
    todayDate: '2026-10-18',
  }
}

let settings = makeSettings()
const saveAccount = vi.fn()
const updateProfile = vi.fn()

vi.mock('@/app/settings', () => ({ useSettings: () => settings }))
vi.mock('@/data/hooks', () => ({
  useSaveAccount: () => ({ mutateAsync: saveAccount, isPending: false }),
  useUpdateProfile: () => ({ mutateAsync: updateProfile, isPending: false }),
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/accounts/new" element={<AccountEditor />} />
          <Route path="/accounts/:id" element={<AccountEditor />} />
          <Route path="/review" element={<p>review queue</p>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  settings = makeSettings()
  saveAccount.mockReset()
  saveAccount.mockResolvedValue({ id: 'new-id' })
  updateProfile.mockReset()
})

describe('Accounts list', () => {
  it('groups active accounts by type, in a fixed order, under headings', () => {
    renderAt('/accounts')
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(['Bank accounts', 'Credit cards', 'Wallets', 'Cash', 'Other'])
    const banks = screen.getByRole('region', { name: 'Bank accounts' })
    expect(within(banks).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/accounts/bank'])
    expect(within(screen.getByRole('region', { name: 'Credit cards' })).getByRole('link')).toHaveAttribute('href', '/accounts/card')
  })

  it('keeps card dues out of available money, and archived accounts out of both', () => {
    renderAt('/accounts')
    const summary = screen.getByRole('region', { name: 'Summary' })
    // ₹10,000 bank + ₹500 wallet + ₹300 cash + ₹200 other; the ₹12,000 owed on the card is not subtracted or added.
    expect(within(summary).getByText('Available money').parentElement).toHaveTextContent('₹11,000')
    expect(within(summary).getByText('Card dues').parentElement).toHaveTextContent('₹12,000')
    expect(within(summary).getByText('Owed on 1 card')).toBeInTheDocument()
    expect(summary).not.toHaveTextContent('₹21,999')
  })

  it('shows no card dues when there are no cards', () => {
    settings = makeSettings([account('bank', 'Salary account', 'bank', { balance_minor: -5000 })])
    renderAt('/accounts')
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).queryByText('Card dues')).not.toBeInTheDocument()
    expect(within(summary).getByText('Available money').parentElement).toHaveTextContent('−₹50')
  })

  it('shows a card’s owed amount, limit and an estimate of available credit', () => {
    renderAt('/accounts')
    const card = screen.getByRole('link', { name: /Millennia/ })
    expect(card).toHaveAccessibleName(
      'Millennia, HDFC Bank, Credit card. Owed ₹12,000. Limit ₹50,000. About ₹38,000 available, an estimate.',
    )
    expect(card).toHaveTextContent('Owed')
    expect(card).toHaveTextContent('₹12,000')
    expect(card).toHaveTextContent('₹50,000')
    expect(card).toHaveTextContent('Available · estimate')
    expect(card).toHaveTextContent('~₹38,000')
  })

  it('says when a card is over its limit', () => {
    settings = makeSettings([account('card', 'Millennia', 'credit_card', { balance_minor: -5_200_000, credit_limit_minor: 5_000_000 })])
    renderAt('/accounts')
    const card = screen.getByRole('link', { name: /Millennia/ })
    expect(card).toHaveTextContent('Over limit by')
    expect(card).toHaveAccessibleName(expect.stringContaining('Over the limit by ₹2,000'))
  })

  it('names the institution on bank tiles', () => {
    renderAt('/accounts')
    expect(screen.getByRole('link', { name: /Salary account/ })).toHaveAccessibleName(
      'Salary account, State Bank of India, Bank account. Balance ₹10,000.',
    )
    expect(screen.getByText('State Bank of India')).toBeInTheDocument()
  })

  it('keeps archived accounts, with their balance, behind the toggle', async () => {
    renderAt('/accounts')
    expect(screen.queryByRole('link', { name: /Old bank/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show archived (1)' }))
    expect(screen.getByRole('link', { name: /Old bank/ })).toHaveAccessibleName('Old bank, Bank account, archived. Balance ₹9,999.')
  })

  it('is honest when there are no active accounts', () => {
    settings = makeSettings([])
    renderAt('/accounts')
    expect(screen.getByText('No active accounts')).toBeInTheDocument()
    expect(screen.queryByText('Available money')).not.toBeInTheDocument()
  })

  it('points to the review queue when entries are waiting', () => {
    settings = makeSettings([account('bank', 'Salary account', 'bank', { review_count: 2 })])
    renderAt('/accounts')
    expect(screen.getByRole('link', { name: /2 entries waiting for review aren’t included/ })).toHaveAttribute('href', '/review')
  })
})

describe('Account form', () => {
  it('only asks for a credit limit on cards, and drops it when switching away', async () => {
    renderAt('/accounts/new')
    expect(screen.getAllByRole('radio', { name: /^(Bank|Card|Wallet|Cash|Other)$/ })).toHaveLength(5)
    expect(screen.queryByLabelText(/credit limit/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('radio', { name: 'Card' }))
    await userEvent.type(screen.getByLabelText(/credit limit/i), '50000')
    await userEvent.click(screen.getByRole('radio', { name: 'Bank' }))
    expect(screen.queryByLabelText(/credit limit/i)).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Name'), 'Salary account')
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }))
    await waitFor(() => expect(saveAccount).toHaveBeenCalledTimes(1))
    expect(saveAccount.mock.calls[0][0]).toEqual({
      id: undefined,
      values: {
        name: 'Salary account',
        type: 'bank',
        color: 'sky',
        opening_balance_minor: 0,
        opening_date: '2026-10-18',
        institution_name: null,
        credit_limit_minor: null,
      },
    })
  })

  it('saves a card’s institution, limit and amount owed', async () => {
    renderAt('/accounts/new')
    await userEvent.click(screen.getByRole('radio', { name: 'Card' }))
    await userEvent.type(screen.getByLabelText('Name'), 'Millennia')
    await userEvent.type(screen.getByLabelText(/bank or provider/i), 'HDFC Bank')
    await userEvent.type(screen.getByLabelText(/credit limit/i), '1,00,000')
    await userEvent.type(screen.getByLabelText(/amount owed/i), '1500')
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }))
    await waitFor(() => expect(saveAccount).toHaveBeenCalledTimes(1))
    expect(saveAccount.mock.calls[0][0].values).toEqual({
      name: 'Millennia',
      type: 'credit_card',
      color: 'purple',
      opening_balance_minor: -150_000,
      opening_date: '2026-10-18',
      institution_name: 'HDFC Bank',
      credit_limit_minor: 10_000_000,
    })
  })

  it('defaults a wallet to its own colour and explains the opening balance', async () => {
    renderAt('/accounts/new')
    await userEvent.click(screen.getByRole('radio', { name: 'Wallet' }))
    expect(screen.getByRole('radio', { name: 'Mint' })).toBeChecked()
    expect(screen.getByText(/Every entry moves it from there — even ones dated before this day/)).toBeInTheDocument()
  })

  it('refuses a zero credit limit without saving', async () => {
    renderAt('/accounts/new')
    await userEvent.click(screen.getByRole('radio', { name: 'Card' }))
    await userEvent.type(screen.getByLabelText('Name'), 'Millennia')
    await userEvent.type(screen.getByLabelText(/credit limit/i), '0')
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/more than zero/)
    expect(saveAccount).not.toHaveBeenCalled()
  })

  it('loads an existing card’s limit and owed amount for editing', () => {
    renderAt('/accounts/card')
    expect(screen.getByLabelText(/credit limit/i)).toHaveValue('50,000')
    expect(screen.getByLabelText(/bank or provider/i)).toHaveValue('HDFC Bank')
  })
})

describe('Account editor', () => {
  it('shows the refunds row only when there are refunds', () => {
    settings = makeSettings([account('bank', 'Salary account', 'bank', { income_minor: 100_000, balance_minor: 100_000 })])
    const { unmount } = renderAt('/accounts/bank')
    expect(screen.queryByText('Refunds & reversed purchases')).not.toBeInTheDocument()
    expect(screen.queryByText('Reversed income')).not.toBeInTheDocument()
    unmount()

    settings = makeSettings([
      account('bank', 'Salary account', 'bank', {
        income_minor: 100_000,
        expense_minor: 40_000,
        refunds_minor: 5_000,
        reversed_income_minor: 10_000,
        balance_minor: 55_000,
      }),
    ])
    renderAt('/accounts/bank')
    const rows = screen.getAllByRole('term').map((dt) => dt.textContent)
    expect(rows).toEqual([
      'Opening (1 Oct 2026)',
      '+Income',
      '−Expenses',
      '+Refunds & reversed purchases',
      '−Reversed income',
      '+Transfers in',
      '−Transfers out',
      '=Balance',
    ])
    expect(screen.getByText('Refunds & reversed purchases').closest('div')).toHaveTextContent('₹50')
  })

  it('shows pending and review notes from the balance view', () => {
    settings = makeSettings([account('bank', 'Salary account', 'bank', { pending_minor: -20_000, review_count: 1 })])
    renderAt('/accounts/bank')
    expect(screen.getByText(/still pending/)).toHaveTextContent('Includes −₹200 still pending.')
    expect(screen.getByRole('link', { name: /1 entry on this account waiting for review isn’t included in this balance/ })).toHaveAttribute(
      'href',
      '/review',
    )
  })

  it('shows a card’s owed amount, limit and available estimate, or asks for a limit', () => {
    renderAt('/accounts/card')
    expect(screen.getByText('Credit card · Owed')).toBeInTheDocument()
    expect(screen.getByText('Limit')).toBeInTheDocument()
    expect(screen.getByText('Available · estimate').nextSibling).toHaveTextContent('~₹38,000')
    expect(screen.getByText(/based on what Friday knows/)).toBeInTheDocument()
  })

  it('asks for a limit when a card has none', () => {
    settings = makeSettings([account('card', 'Millennia', 'credit_card', { balance_minor: -1000 })])
    renderAt('/accounts/card')
    expect(screen.getByText(/No credit limit set/)).toBeInTheDocument()
  })

  it('archives instead of deleting', async () => {
    saveAccount.mockResolvedValue({ id: 'bank' })
    renderAt('/accounts/bank')
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Archive account' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(saveAccount).toHaveBeenCalledWith({ id: 'bank', values: { status: 'archived' } }))
  })
})
