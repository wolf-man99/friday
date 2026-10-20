import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/Toast'
import type { AccountBalanceRow, CategoryRow } from '@/data/database.types'
import type { HistoryItem } from '@/features/capture/suggest'
import { addAnalyticsSink, type TrackedEvent } from '@/lib/analytics'
import { EntryEditor } from './EntryEditor'

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

const ACCOUNTS = [account('card', 'Amex', 'credit_card'), account('bank', 'HDFC', 'bank'), account('cash', 'Wallet', 'cash')]
const CATEGORIES = [category('food', 'Food & dining', 'expense'), category('travel', 'Travel', 'expense'), category('salary', 'Salary', 'income')]

function makeSettings(overrides: { defaultAccountId?: string | null; accounts?: AccountBalanceRow[] } = {}) {
  const accounts = overrides.accounts ?? ACCOUNTS
  return {
    profile: { id: 'u1', display_name: 'Sai', timezone: 'Asia/Kolkata', base_currency: 'INR', default_account_id: overrides.defaultAccountId ?? null, created_at: '', updated_at: '' },
    activeAccounts: accounts.filter((a) => a.status === 'active'),
    accountsById: new Map(accounts.map((a) => [a.id, a])),
    categories: CATEGORIES,
    timeZone: 'Asia/Kolkata',
    todayDate: '2026-10-18',
  }
}

let settings = makeSettings()
let history: HistoryItem[] = []
const createEntry = vi.fn()
const updateEntry = vi.fn()
const setDeleted = vi.fn()
let entryResult: { isPending: boolean; data: unknown; error: unknown; refetch?: () => Promise<unknown> } = {
  isPending: false,
  data: undefined,
  error: null,
}

vi.mock('@/app/settings', () => ({ useSettings: () => settings }))
vi.mock('@/data/hooks', () => ({
  useCreateEntry: () => ({ mutateAsync: createEntry, isPending: false }),
  useUpdateEntry: () => ({ mutateAsync: updateEntry, isPending: false }),
  useSetEntryDeleted: () => ({ mutateAsync: setDeleted, isPending: false }),
  useEntry: () => entryResult,
  useCaptureHistory: () => ({ data: history, isPending: false }),
}))

const saved = (patch = {}) => ({ kind: 'expense', id: 'new-id', created: true, matches: true, voided: false, updated_at: 'v1', ...patch })

function renderAdd(path = '/add') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path="/add" element={<EntryEditor />} />
          <Route path="/" element={<p>home screen</p>} />
          <Route path="/entry/:kind/:id" element={<p>details screen</p>} />
          <Route path="/entry/:kind/:id/edit" element={<p>edit screen</p>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  )
}

function DetailsStub() {
  const location = useLocation()
  return <p>details screen {location.pathname}</p>
}

function renderEdit(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path="/entry/:kind/:id/edit" element={<EntryEditor />} />
          <Route path="/entry/:kind/:id" element={<DetailsStub />} />
          <Route path="/activity" element={<p>activity screen</p>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  )
}

const expenseRow = (patch = {}) => ({
  kind: 'expense',
  id: 'e1',
  user_id: 'u1',
  account_id: 'bank',
  type: 'expense',
  amount_minor: 25000,
  currency: 'INR',
  category_id: 'food',
  occurred_at: '2026-10-17T06:30:00.000Z',
  note: null,
  merchant: 'Blue Tokai',
  idempotency_key: 'k',
  created_via: 'quick_add',
  deleted_at: null,
  status: 'posted',
  voided_from: null,
  related_transaction_id: null,
  reversal_of_type: null,
  base_type: 'expense',
  source_type: 'manual',
  source_confidence: null,
  created_at: '2026-10-17T06:30:00.000Z',
  updated_at: '2026-10-17T06:31:00.123456+00:00',
  ...patch,
})

const amountField = () => screen.getByLabelText(/amount in rupees/i)
const storedDraft = () => JSON.parse(localStorage.getItem('friday:quick-add-draft:u1') ?? 'null')?.draft ?? null

let events: TrackedEvent[] = []
let stopSink: () => void

beforeEach(() => {
  settings = makeSettings()
  history = []
  createEntry.mockReset()
  createEntry.mockResolvedValue(saved())
  updateEntry.mockReset()
  updateEntry.mockResolvedValue('v2')
  entryResult = { isPending: false, data: undefined, error: null }
  setDeleted.mockReset()
  setDeleted.mockResolvedValue(undefined)
  localStorage.clear()
  events = []
  stopSink = addAnalyticsSink((e) => events.push(e))
})

afterEach(() => {
  stopSink()
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
})

describe('Quick Add — capture', () => {
  it('opens on the amount, with Save disabled until it is valid', async () => {
    renderAdd()
    expect(amountField()).toHaveFocus()
    const save = screen.getByRole('button', { name: 'Save expense' })
    expect(save).toBeDisabled()
    await userEvent.type(amountField(), '1234.5')
    expect(amountField()).toHaveValue('1,234.5')
    expect(save).toBeEnabled()
  })

  it('saves a routine expense with nothing optional filled in, with a request key', async () => {
    renderAdd()
    await userEvent.type(amountField(), '250')
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1))
    const { entry, idempotencyKey } = createEntry.mock.calls[0][0]
    expect(entry).toEqual({
      kind: 'expense',
      amountMinor: 25000,
      accountId: 'bank',
      destinationAccountId: null,
      categoryId: null,
      date: '2026-10-18',
      note: null,
      merchant: null,
    })
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(await screen.findByText('home screen')).toBeInTheDocument()
    expect(storedDraft()).toBeNull()
  })

  it('confirms with Edit and Undo, and Undo voids the saved entry', async () => {
    renderAdd()
    await userEvent.type(amountField(), '250')
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    const toast = await screen.findByRole('status')
    expect(toast).toHaveTextContent('Saved −₹250')
    expect(within(toast).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    await userEvent.click(within(toast).getByRole('button', { name: 'Undo' }))
    expect(setDeleted).toHaveBeenCalledWith({ kind: 'expense', id: 'new-id', deleted: true })
    expect(events.some((e) => e.name === 'transaction_undo_used')).toBe(true)
  })

  it('opens the saved entry’s edit screen from the toast', async () => {
    renderAdd()
    await userEvent.type(amountField(), '250')
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    const toast = await screen.findByRole('status')
    await userEvent.click(within(toast).getByRole('button', { name: 'Edit' }))
    expect(await screen.findByText('edit screen')).toBeInTheDocument()
  })

  it('calls a transfer to a credit card a card payment, not spending', async () => {
    renderAdd('/add?kind=transfer')
    expect(screen.getByText('Not spending, not income.')).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'From' })).getByRole('radio', { name: /HDFC/ }))
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'To' })).getByRole('radio', { name: /Amex/ }))
    expect(screen.getByText('Card payment — not spending.')).toBeInTheDocument()
    expect(screen.getByText(/reduces what you owe on Amex/)).toBeInTheDocument()
    expect(screen.queryByText('Not spending, not income.')).not.toBeInTheDocument()
  })

  it('keeps the amount and drops the category when switching type', async () => {
    renderAdd()
    await userEvent.type(amountField(), '500')
    await userEvent.click(screen.getByRole('button', { name: 'Food & dining' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Income' }))
    expect(screen.getByLabelText(/income amount in rupees/i)).toHaveValue('500')
    expect(screen.queryByRole('button', { name: 'Food & dining' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Salary' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('moves between types with the arrow keys', async () => {
    renderAdd()
    screen.getByRole('radio', { name: 'Expense' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Income' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Income' })).toHaveFocus()
  })

  it('records a transfer between two different accounts, without a category', async () => {
    createEntry.mockResolvedValue(saved({ kind: 'transfer' }))
    renderAdd('/add?kind=transfer')
    await userEvent.type(amountField(), '5000')
    const from = screen.getByRole('radiogroup', { name: 'From' })
    const to = screen.getByRole('radiogroup', { name: 'To' })
    await userEvent.click(within(from).getByRole('radio', { name: /HDFC/ }))
    expect(within(to).getByRole('radio', { name: /HDFC/ })).toBeDisabled()
    await userEvent.click(within(to).getByRole('radio', { name: /Wallet/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Record transfer' }))
    await waitFor(() => expect(createEntry).toHaveBeenCalled())
    expect(createEntry.mock.calls[0][0].entry).toMatchObject({ kind: 'transfer', amountMinor: 500000, accountId: 'bank', destinationAccountId: 'cash', categoryId: null })
  })

  it('explains invalid amounts instead of silently changing them', async () => {
    renderAdd()
    await userEvent.type(amountField(), '-50')
    expect(screen.getAllByText(/Amounts are always positive/)[0]).toBeInTheDocument()
    await userEvent.clear(amountField())
    await userEvent.type(amountField(), '12.345')
    expect(amountField()).toHaveValue('12.345')
    expect(screen.getAllByText('Use at most 2 decimal places (paise)')[0]).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save expense' })).toBeDisabled()
  })
})

describe('Quick Add — smart defaults', () => {
  it('preselects the configured default account and labels it', () => {
    settings = makeSettings({ defaultAccountId: 'cash' })
    renderAdd()
    const wallet = screen.getByRole('radio', { name: /Wallet/ })
    expect(wallet).toHaveAttribute('aria-checked', 'true')
    expect(wallet).toHaveTextContent('Default')
  })

  it('preselects the account the screen asked for', () => {
    renderAdd('/add?account=card')
    expect(screen.getByRole('radio', { name: /Amex/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('marks a history-based category as a suggestion that can be rejected', async () => {
    history = Array.from({ length: 6 }, () => ({ kind: 'expense' as const, categoryId: 'food', merchant: null, accountId: 'bank', amountMinor: 100 }))
    renderAdd()
    const tile = await screen.findByRole('button', { name: 'Food & dining, suggested — tap to confirm' })
    expect(tile).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/Suggested from your history/)).toBeInTheDocument()
    expect(events.find((e) => e.name === 'suggestion_shown')?.props).toMatchObject({ reason: 'frequent', basis: 6 })

    await userEvent.click(screen.getByRole('button', { name: 'Not this' }))
    expect(screen.getByRole('button', { name: 'Food & dining' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('No category — it’ll be saved as Uncategorised.')).toBeInTheDocument()

    await userEvent.type(amountField(), '90')
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    await waitFor(() => expect(createEntry).toHaveBeenCalled())
    expect(createEntry.mock.calls[0][0].entry.categoryId).toBeNull()
  })

  it('suggests nothing without enough history', () => {
    history = [{ kind: 'expense', categoryId: 'food', merchant: null, accountId: 'bank', amountMinor: 100 }]
    renderAdd()
    expect(screen.queryByText(/Suggested from your history/)).not.toBeInTheDocument()
    expect(screen.getByText('No category — it’ll be saved as Uncategorised.')).toBeInTheDocument()
  })

  it('offers recent entries as one-tap prefills, still saved by the user', async () => {
    history = [{ kind: 'expense', categoryId: 'food', merchant: 'Blue Tokai', accountId: 'cash', amountMinor: 25000 }]
    renderAdd()
    await userEvent.click(screen.getByRole('button', { name: /Fill in Blue Tokai/ }))
    expect(amountField()).toHaveValue('250')
    expect(screen.getByRole('radio', { name: /Wallet/ })).toHaveAttribute('aria-checked', 'true')
    expect(createEntry).not.toHaveBeenCalled()
  })
})

describe('Quick Add — failures and drafts', () => {
  it('keeps the draft through a network failure and retries with the same key', async () => {
    createEntry.mockRejectedValueOnce({ message: 'TypeError: Failed to fetch', code: '' })
    createEntry.mockResolvedValueOnce(saved({ created: false, matches: true }))
    renderAdd()
    await userEvent.type(amountField(), '777')
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    expect(await screen.findByText(/Couldn’t confirm the save/)).toBeInTheDocument()
    expect(screen.queryByText('home screen')).not.toBeInTheDocument()
    expect(storedDraft()?.amountText).toBe('777')

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('home screen')).toBeInTheDocument()
    expect(createEntry).toHaveBeenCalledTimes(2)
    expect(createEntry.mock.calls[1][0].idempotencyKey).toBe(createEntry.mock.calls[0][0].idempotencyKey)
    expect(events.find((e) => e.name === 'transaction_save_succeeded')?.props).toMatchObject({ replayed: true, attempt: 2 })
  })

  it('never claims a save when an earlier attempt committed different details', async () => {
    createEntry.mockResolvedValueOnce(saved({ created: false, matches: false }))
    createEntry.mockResolvedValueOnce(saved())
    renderAdd()
    await userEvent.type(amountField(), '300')
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    expect(await screen.findByText('Already saved earlier')).toBeInTheDocument()
    expect(screen.queryByText('home screen')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Save this as a separate entry' }))
    expect(await screen.findByText('home screen')).toBeInTheDocument()
    expect(createEntry.mock.calls[1][0].idempotencyKey).not.toBe(createEntry.mock.calls[0][0].idempotencyKey)
  })

  it('opens the entry an earlier attempt saved on its details page', async () => {
    createEntry.mockResolvedValueOnce(saved({ created: false, matches: false, id: 'earlier' }))
    renderAdd()
    await userEvent.type(amountField(), '300')
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Open the saved entry' }))
    expect(await screen.findByText('details screen')).toBeInTheDocument()
  })

  it('does not send anything while offline, and keeps the draft', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    renderAdd()
    await userEvent.type(amountField(), '120')
    await act(async () => window.dispatchEvent(new Event('offline')))
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    expect(await screen.findByText(/You’re offline. Nothing was sent/)).toBeInTheDocument()
    expect(createEntry).not.toHaveBeenCalled()
    expect(storedDraft()?.amountText).toBe('120')
    expect(events.find((e) => e.name === 'transaction_save_failed')?.props).toMatchObject({ error_class: 'offline' })
  })

  it('recovers an unsaved draft and can start fresh', async () => {
    localStorage.setItem(
      'friday:quick-add-draft:u1',
      JSON.stringify({
        version: 1,
        draft: { kind: 'expense', amountText: '640', accountId: 'cash', destinationAccountId: null, categoryId: 'food', categorySource: 'user', date: '2026-10-18', note: 'Veg', merchant: '', idempotencyKey: 'k-1', updatedAt: Date.now() },
      }),
    )
    renderAdd()
    expect(screen.getByText(/Picked up your unsaved expense/)).toBeInTheDocument()
    expect(amountField()).toHaveValue('640')
    expect(events.some((e) => e.name === 'draft_recovered')).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Start fresh' }))
    expect(amountField()).toHaveValue('')
    expect(storedDraft()).toBeNull()
  })

  it('reports an archived account in a recovered draft instead of swapping it', () => {
    settings = makeSettings({ accounts: [...ACCOUNTS.slice(0, 2), account('cash', 'Wallet', 'cash', 'archived')] })
    localStorage.setItem(
      'friday:quick-add-draft:u1',
      JSON.stringify({
        version: 1,
        draft: { kind: 'expense', amountText: '640', accountId: 'cash', destinationAccountId: null, categoryId: null, categorySource: null, date: '2026-10-18', note: '', merchant: '', idempotencyKey: 'k-1', updatedAt: Date.now() },
      }),
    )
    renderAdd()
    expect(screen.getAllByText('That account is no longer available — choose another')[0]).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save expense' })).toBeDisabled()
  })

  it('asks before discarding something typed', async () => {
    renderAdd()
    await userEvent.type(amountField(), '99')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('heading', { name: 'Discard this entry?' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(amountField()).toHaveValue('99')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(await screen.findByText('home screen')).toBeInTheDocument()
    expect(storedDraft()).toBeNull()
  })

  it('leaves straight away when nothing was typed', async () => {
    renderAdd()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('home screen')).toBeInTheDocument()
  })

  it('asks for an account when none can take entries', () => {
    settings = makeSettings({ accounts: [account('old', 'Old', 'bank', 'archived')] })
    renderAdd()
    expect(screen.getByText('Add an account first')).toBeInTheDocument()
  })
})

describe('Quick Add — analytics privacy', () => {
  it('never sends amounts, notes or merchants', async () => {
    renderAdd()
    await userEvent.type(amountField(), '4321')
    await userEvent.click(screen.getByRole('button', { name: /Add details/ }))
    await userEvent.type(screen.getByLabelText('Merchant or payee'), 'Secret Shop')
    await userEvent.type(screen.getByLabelText('Note'), 'very private')
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    await screen.findByText('home screen')
    const names = events.map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['quick_add_opened', 'transaction_save_attempted', 'transaction_save_succeeded']))
    const dump = JSON.stringify(events)
    expect(dump).not.toMatch(/4321|43,21|Secret Shop|very private/)
    expect(events.find((e) => e.name === 'transaction_save_attempted')?.props).toMatchObject({ has_note: true, has_merchant: true })
  })
})

describe('Editing an entry', () => {
  it('saves against the loaded version and returns to the details page', async () => {
    entryResult = { isPending: false, data: expenseRow(), error: null }
    renderEdit('/entry/expense/e1/edit')
    expect(screen.getByRole('heading', { name: 'Edit expense' })).toBeInTheDocument()
    expect(amountField()).toHaveValue('250')
    await userEvent.clear(amountField())
    await userEvent.type(amountField(), '300')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateEntry).toHaveBeenCalledTimes(1))
    expect(updateEntry.mock.calls[0][0]).toMatchObject({
      previousKind: 'expense',
      id: 'e1',
      expectedUpdatedAt: '2026-10-17T06:31:00.123456+00:00',
      entry: { kind: 'expense', amountMinor: 30000, accountId: 'bank', categoryId: 'food' },
      // The day didn't change, so the original instant is kept.
      occurredAt: '2026-10-17T06:30:00.000Z',
    })
    expect(await screen.findByText('details screen /entry/expense/e1')).toBeInTheDocument()
  })

  it('closes back to the details page when nothing changed', async () => {
    entryResult = { isPending: false, data: expenseRow(), error: null }
    renderEdit('/entry/expense/e1/edit')
    await userEvent.click(screen.getByRole('button', { name: 'Close without saving' }))
    expect(await screen.findByText('details screen /entry/expense/e1')).toBeInTheDocument()
    expect(updateEntry).not.toHaveBeenCalled()
  })

  it('sends refunds and reversals to their details page, which has their own form', async () => {
    renderEdit('/entry/refund/r1/edit')
    expect(await screen.findByText('details screen /entry/refund/r1')).toBeInTheDocument()
  })

  it('follows an entry whose kind differs from its address to its details', async () => {
    entryResult = { isPending: false, data: expenseRow({ kind: 'refund', type: 'refund', id: 'e1' }), error: null }
    renderEdit('/entry/expense/e1/edit')
    expect(await screen.findByText('details screen /entry/refund/e1')).toBeInTheDocument()
  })

  it('won’t edit a voided entry', () => {
    entryResult = { isPending: false, data: expenseRow({ status: 'voided', voided_from: 'posted' }), error: null }
    renderEdit('/entry/expense/e1/edit')
    expect(screen.getByText(/Voided entries can’t be edited/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })
})
