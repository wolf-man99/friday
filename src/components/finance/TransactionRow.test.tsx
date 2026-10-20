import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { AccountBalanceRow, CategoryRow, LedgerEntryRow } from '@/data/database.types'
import { DayGroupHeader, TransactionRow } from './TransactionRow'

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

const FOOD: CategoryRow = {
  id: 'food',
  name: 'Food & dining',
  transaction_type: 'expense',
  user_id: 'u1',
  icon: 'utensils',
  color: 'orange',
  is_default: true,
  is_archived: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
}

const HDFC = account('bank', 'HDFC', 'bank')
const AMEX = account('card', 'Amex', 'credit_card')
const PAYTM = account('wallet', 'Paytm', 'wallet')

const entry = (patch: Partial<LedgerEntryRow> = {}): LedgerEntryRow => ({
  id: 'e1',
  user_id: 'u1',
  kind: 'expense',
  account_id: 'bank',
  counter_account_id: null,
  category_id: 'food',
  amount_minor: 45000,
  currency: 'INR',
  occurred_at: '2026-10-18T07:30:00Z',
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

function renderRow(props: Parameters<typeof TransactionRow>[0]) {
  render(
    <MemoryRouter>
      <ul>
        <li>
          <TransactionRow {...props} />
        </li>
      </ul>
    </MemoryRouter>,
  )
  return screen.getByRole('link')
}

describe('TransactionRow', () => {
  it('shows a plain posted expense with a minus sign and links to its details', () => {
    const row = renderRow({ entry: entry(), category: FOOD, account: HDFC })
    expect(row).toHaveAttribute('href', '/entry/expense/e1')
    expect(row).toHaveAccessibleName('Swiggy, spent ₹450, Food & dining, HDFC')
    expect(row).toHaveTextContent('−₹450')
    expect(row).toHaveTextContent('Food & dining · HDFC')
    expect(screen.queryByText('Pending')).not.toBeInTheDocument()
  })

  it('marks a refund with a badge, a plus sign and green money-back colour', () => {
    const row = renderRow({
      entry: entry({ id: 'r1', kind: 'refund', amount_minor: 20000, related_transaction_id: 'e1' }),
      category: FOOD,
      account: HDFC,
    })
    expect(row).toHaveAttribute('href', '/entry/refund/r1')
    expect(screen.getByText('Refund')).toBeInTheDocument()
    const amount = screen.getByText('+₹200')
    expect(amount).toHaveClass('text-positive')
    // Refund · Category · Account: the badge leads the detail line.
    expect(row).toHaveTextContent('RefundFood & dining · HDFC')
    expect(row).toHaveAccessibleName('Swiggy, refunded ₹200, Food & dining, HDFC, refund')
  })

  it('signs a reversal by what it reverses', () => {
    renderRow({ entry: entry({ kind: 'reversal', base_type: 'income', merchant: 'Salary', amount_minor: 100000 }), account: HDFC })
    expect(screen.getByText('Reversal')).toBeInTheDocument()
    expect(screen.getByText('−₹1,000')).not.toHaveClass('text-positive')
  })

  it('strikes through a voided entry and says so', () => {
    const row = renderRow({ entry: entry({ status: 'voided', voided_from: 'pending' }), category: FOOD, account: HDFC })
    expect(row).toHaveClass('opacity-70')
    expect(screen.getByText('Voided')).toBeInTheDocument()
    expect(screen.getByText('−₹450')).toHaveClass('line-through')
    expect(row).toHaveAccessibleName(/, voided$/)
  })

  it('shows pending, needs-review and import badges and reads them out', () => {
    renderRow({ entry: entry({ status: 'pending', source_type: 'email' }), category: FOOD, account: HDFC })
    expect(screen.getByText('Pending')).toBeInTheDocument()
    expect(screen.getByText('Email')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAccessibleName('Swiggy, spent ₹450, Food & dining, HDFC, pending, imported from email')
  })

  it('reads needs review out loud', () => {
    const row = renderRow({ entry: entry({ status: 'needs_review', source_type: 'bank_import' }), category: FOOD, account: HDFC })
    expect(screen.getByText('Needs review')).toBeInTheDocument()
    expect(screen.getByText('Bank')).toBeInTheDocument()
    expect(row).toHaveAccessibleName(/needs review, imported from bank$/)
  })

  it('calls a transfer to a credit card a card payment', () => {
    const row = renderRow({
      entry: entry({ id: 't1', kind: 'transfer', counter_account_id: 'card', category_id: null, merchant: null, base_type: null, amount_minor: 500000 }),
      account: HDFC,
      counterAccount: AMEX,
    })
    expect(row).toHaveAttribute('href', '/entry/transfer/t1')
    expect(screen.getByText('Card payment')).toBeInTheDocument()
    expect(screen.getByText('HDFC → Amex')).toBeInTheDocument()
    expect(screen.getByText('₹5,000')).toBeInTheDocument()
    expect(row).toHaveAccessibleName('Card payment, moved ₹5,000, from HDFC to Amex')
  })

  it('keeps a transfer note as the title and still names the card payment', () => {
    renderRow({
      entry: entry({ kind: 'transfer', counter_account_id: 'card', category_id: null, merchant: null, note: 'October bill', base_type: null }),
      account: HDFC,
      counterAccount: AMEX,
    })
    expect(screen.getByText('October bill')).toBeInTheDocument()
    expect(screen.getByText('Card payment · HDFC → Amex')).toBeInTheDocument()
  })

  it('calls other transfers a transfer and keeps archived account names', () => {
    renderRow({
      entry: entry({ kind: 'transfer', counter_account_id: 'wallet', category_id: null, merchant: null, base_type: null }),
      account: account('old', 'Old savings', 'bank', 'archived'),
      counterAccount: PAYTM,
    })
    expect(screen.getByText('Transfer')).toBeInTheDocument()
    expect(screen.getByText('Old savings → Paytm')).toBeInTheDocument()
  })
})

describe('DayGroupHeader', () => {
  it('shows net out and in', () => {
    render(<DayGroupHeader label="Today" expenseMinor={45000} incomeMinor={100000} />)
    expect(screen.getByText('Out ₹450')).toBeInTheDocument()
    expect(screen.getByText('In ₹1,000')).toHaveClass('text-positive')
  })

  it('says money back in words when refunds outweigh spending', () => {
    render(<DayGroupHeader label="Today" expenseMinor={-20000} incomeMinor={0} />)
    expect(screen.getByText('Money back ₹200')).toBeInTheDocument()
    expect(screen.queryByText(/^Out/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^In/)).not.toBeInTheDocument()
  })
})
