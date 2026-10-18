import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/Toast'
import type { AccountBalanceRow, CategoryRow } from '@/data/database.types'
import { EntryEditor } from './EntryEditor'

const account = (id: string, name: string, type: AccountBalanceRow['type']): AccountBalanceRow => ({
  id,
  name,
  type,
  user_id: 'u',
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
})

const category = (id: string, name: string, type: CategoryRow['transaction_type']): CategoryRow => ({
  id,
  name,
  transaction_type: type,
  user_id: 'u',
  icon: 'tag',
  color: 'orange',
  is_default: true,
  is_archived: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
})

// Sorted by name like the API, so a card comes first: the default must skip it.
const accounts = [account('card', 'Amex', 'credit_card'), account('bank', 'HDFC', 'bank'), account('cash', 'Wallet', 'cash')]
const categories = [
  category('food', 'Food & dining', 'expense'),
  category('travel', 'Travel', 'expense'),
  category('salary', 'Salary', 'income'),
]

const createEntry = vi.fn()

vi.mock('@/app/settings', () => ({
  useSettings: () => ({
    activeAccounts: accounts,
    accountsById: new Map(accounts.map((a) => [a.id, a])),
    categories,
    timeZone: 'Asia/Kolkata',
    todayDate: '2026-10-18',
  }),
}))

vi.mock('@/data/hooks', () => ({
  useCreateEntry: () => ({ mutateAsync: createEntry, isPending: false }),
  useUpdateEntry: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetEntryDeleted: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEntry: () => ({ isPending: false, data: undefined, error: null }),
}))

function renderAdd(path = '/add') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path="/add" element={<EntryEditor />} />
          <Route path="/" element={<p>home screen</p>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  createEntry.mockReset()
  createEntry.mockResolvedValue({ kind: 'expense', id: 'new-id' })
  localStorage.clear()
})

describe('Quick add', () => {
  it('opens on the amount with Save disabled until it is valid', async () => {
    renderAdd()
    const amount = screen.getByLabelText(/expense amount in rupees/i)
    expect(amount).toHaveFocus()
    const save = screen.getByRole('button', { name: 'Save expense' })
    expect(save).toBeDisabled()

    await userEvent.type(amount, '0')
    expect(save).toBeDisabled()
    await userEvent.clear(amount)
    await userEvent.type(amount, '1234.5')
    expect(amount).toHaveValue('1,234.5')
    expect(save).toBeEnabled()
  })

  it('saves an expense in paise with the chosen category and a non-card default account', async () => {
    renderAdd()
    await userEvent.type(screen.getByLabelText(/amount in rupees/i), '1234.5')
    const food = screen.getByRole('button', { name: 'Food & dining' })
    await userEvent.click(food)
    expect(food).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('radio', { name: 'HDFC' })).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1))
    expect(createEntry.mock.calls[0][0].entry).toEqual({
      kind: 'expense',
      amountMinor: 123450,
      accountId: 'bank',
      destinationAccountId: null,
      categoryId: 'food',
      date: '2026-10-18',
      note: null,
    })
    expect(await screen.findByText('home screen')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Saved −₹1,234.50 · Food & dining')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('switches type with the arrow keys and offers only matching categories', async () => {
    renderAdd()
    const expense = screen.getByRole('radio', { name: 'Expense' })
    expense.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Income' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Salary' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Food & dining' })).not.toBeInTheDocument()
    // Keyboard users stay in the radio group…
    expect(screen.getByRole('radio', { name: 'Income' })).toHaveFocus()
    // …while a tap carries straight on to the empty amount.
    await userEvent.click(screen.getByRole('radio', { name: 'Expense' }))
    expect(screen.getByLabelText(/expense amount in rupees/i)).toHaveFocus()
  })

  it('records a transfer between two different accounts, without a category', async () => {
    createEntry.mockResolvedValue({ kind: 'transfer', id: 't1' })
    renderAdd('/add?kind=transfer')
    expect(screen.getByText(/Not spending, not income/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/transfer amount in rupees/i), '5000')

    const from = screen.getByRole('radiogroup', { name: 'From' })
    const to = screen.getByRole('radiogroup', { name: 'To' })
    await userEvent.click(within(from, 'HDFC'))
    // The source can't also be the destination.
    expect(within(to, 'HDFC')).toBeDisabled()
    await userEvent.click(within(to, 'Wallet'))

    await userEvent.click(screen.getByRole('button', { name: 'Record transfer' }))
    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1))
    expect(createEntry.mock.calls[0][0].entry).toMatchObject({
      kind: 'transfer',
      amountMinor: 500000,
      accountId: 'bank',
      destinationAccountId: 'cash',
      categoryId: null,
    })
  })

  it('keeps the form and explains the problem when saving fails', async () => {
    createEntry.mockRejectedValue({ code: '22023', message: 'That account is archived' })
    renderAdd()
    await userEvent.type(screen.getByLabelText(/amount in rupees/i), '99')
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That account is archived')
    expect(screen.getByLabelText(/amount in rupees/i)).toHaveValue('99')
  })
})

function within(group: HTMLElement, name: string) {
  const option = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
    (el) => el.textContent?.trim() === name,
  )
  if (!option) throw new Error(`No option ${name}`)
  return option
}
