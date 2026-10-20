import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/Toast'
import type { AccountBalanceRow, CategoryRow, LedgerEntryRow, SourceEventRow } from '@/data/database.types'
import { Review } from './Review'

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

const category = (id: string, name: string, type: CategoryRow['transaction_type'], archived = false): CategoryRow => ({
  id,
  name,
  transaction_type: type,
  user_id: 'u1',
  icon: 'tag',
  color: 'orange',
  is_default: true,
  is_archived: archived,
  sort_order: 0,
  created_at: '',
  updated_at: '',
})

const ACCOUNTS = [account('bank', 'HDFC', 'bank'), account('card', 'Amex', 'credit_card'), account('old', 'Old savings', 'bank', 'archived')]
const BASE_CATEGORIES = [category('food', 'Food & dining', 'expense'), category('travel', 'Travel', 'expense'), category('salary', 'Salary', 'income')]

function makeSettings(categories = BASE_CATEGORIES) {
  return {
    profile: { id: 'u1', display_name: 'Sai', timezone: 'Asia/Kolkata', base_currency: 'INR', default_account_id: 'bank', created_at: '', updated_at: '' },
    todayDate: '2026-10-19',
    timeZone: 'Asia/Kolkata',
    accounts: ACCOUNTS,
    activeAccounts: ACCOUNTS.filter((a) => a.status === 'active'),
    accountsById: new Map(ACCOUNTS.map((a) => [a.id, a])),
    categories,
    categoriesById: new Map(categories.map((c) => [c.id, c])),
  }
}

const sourceEvent = (patch: Partial<SourceEventRow> = {}): SourceEventRow => ({
  id: 'ev1',
  user_id: 'u1',
  source_type: 'email',
  source_connection_id: null,
  external_event_id: 'msg-1',
  external_transaction_id: null,
  payload_fingerprint: null,
  received_at: '2026-10-19T04:00:00Z',
  parsed_at: '2026-10-19T04:00:01Z',
  processing_status: 'needs_review',
  confidence: 0.62,
  parsed_kind: 'expense',
  parsed_amount_minor: 25000,
  parsed_currency: 'INR',
  parsed_occurred_at: '2026-10-18T06:30:00Z',
  parsed_merchant: 'Blue Tokai',
  parsed_account_hint: 'HDFC ••1234',
  parsed_entry_status: 'posted',
  review_reason: 'low_confidence',
  suggested_account_id: 'bank',
  suggested_destination_account_id: null,
  suggested_category_id: 'food',
  suggested_match_kind: null,
  suggested_match_id: null,
  resulting_transaction_id: null,
  resulting_transfer_id: null,
  link_type: null,
  linked_at: null,
  error_code: null,
  created_at: '2026-10-19T04:00:00Z',
  updated_at: '2026-10-19T04:00:00Z',
  ...patch,
})

const ledgerEntry = (patch: Partial<LedgerEntryRow> = {}): LedgerEntryRow => ({
  id: 'tx1',
  user_id: 'u1',
  kind: 'expense',
  account_id: 'bank',
  counter_account_id: null,
  category_id: 'food',
  amount_minor: 25000,
  currency: 'INR',
  occurred_at: '2026-10-18T06:30:00Z',
  note: null,
  merchant: 'Blue Tokai',
  status: 'posted',
  source_type: 'manual',
  created_via: 'quick_add',
  related_transaction_id: null,
  base_type: 'expense',
  source_confidence: null,
  voided_from: null,
  created_at: '2026-10-18T06:30:00Z',
  updated_at: 'v1',
  ...patch,
})

const loaded = <T,>(data: T) => ({ data, isPending: false, error: null, fetchStatus: 'idle', refetch: vi.fn() })
const disabled = () => ({ data: undefined, isPending: true, error: null, fetchStatus: 'idle', refetch: vi.fn() })

let settings = makeSettings()
let events: SourceEventRow[] = []
let reviewEntries: LedgerEntryRow[] = []
let stalePending: LedgerEntryRow[] = []
let incomeInRefunds: LedgerEntryRow[] = []
let matches: LedgerEntryRow[] = []
let offsets: LedgerEntryRow[] = []
let byId: Record<string, LedgerEntryRow | null> = {}
const incomeQueries: string[][] = []
const matchQueries: unknown[] = []
const confirmEvent = vi.fn()
const linkEvent = vi.fn()
const ignoreEvent = vi.fn()
const setStatus = vi.fn()
const makeRefund = vi.fn()

vi.mock('@/app/settings', () => ({ useSettings: () => settings }))
vi.mock('@/data/hooks', () => ({
  useReviewEvents: () => loaded(events),
  useReviewEntries: () => loaded(reviewEntries),
  useStalePending: () => loaded(stalePending),
  useIncomeInCategories: (ids: string[]) => {
    incomeQueries.push(ids)
    return ids.length ? loaded(incomeInRefunds) : disabled()
  },
  useMatchCandidates: (input: unknown) => {
    matchQueries.push(input)
    return input ? loaded(matches) : disabled()
  },
  useOffsetCandidates: (input: unknown) => (input ? loaded(offsets) : disabled()),
  useLedgerEntry: (id: string | null) => (id ? loaded(byId[id] ?? null) : disabled()),
  useConfirmSourceEvent: () => ({ mutateAsync: confirmEvent, isPending: false }),
  useLinkSourceEvent: () => ({ mutateAsync: linkEvent, isPending: false }),
  useIgnoreSourceEvent: () => ({ mutateAsync: ignoreEvent, isPending: false }),
  useSetEntryStatus: () => ({ mutateAsync: setStatus, isPending: false }),
  useMakeRefund: () => ({ mutateAsync: makeRefund, isPending: false }),
}))

function renderReview() {
  return render(
    <MemoryRouter initialEntries={['/review']}>
      <ToastProvider>
        <Routes>
          <Route path="/review" element={<Review />} />
          <Route path="/entry/:kind/:id" element={<p>entry screen</p>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  )
}

const sheet = (name: string) => screen.getByRole('dialog', { name })

beforeEach(() => {
  settings = makeSettings()
  events = []
  reviewEntries = []
  stalePending = []
  incomeInRefunds = []
  matches = []
  offsets = []
  byId = {}
  incomeQueries.length = 0
  matchQueries.length = 0
  for (const fn of [confirmEvent, linkEvent, ignoreEvent, setStatus, makeRefund]) fn.mockReset()
  confirmEvent.mockResolvedValue({ kind: 'expense', id: 'new-tx' })
  linkEvent.mockResolvedValue(undefined)
  ignoreEvent.mockResolvedValue(undefined)
  setStatus.mockResolvedValue('v2')
  makeRefund.mockResolvedValue('v2')
})

describe('Review queue', () => {
  it('says honestly that nothing needs a look, and that imports aren’t connected yet', () => {
    renderReview()
    expect(screen.getByRole('heading', { level: 1, name: 'Review' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Nothing needs a look right now' })).toBeInTheDocument()
    expect(screen.getByText(/doesn’t read your email or bank yet/)).toBeInTheDocument()
    expect(screen.getByText(/waits here instead of touching your balances/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'From imports' })).not.toBeInTheDocument()
    // No "Refunds" income category: nothing to look up.
    expect(incomeQueries.every((ids) => ids.length === 0)).toBe(true)
  })

  it('shows an import with its source, signed amount, reason, suggestions and actions', () => {
    events = [sourceEvent()]
    renderReview()
    const card = screen.getByRole('article', { name: 'Blue Tokai' })
    expect(within(card).getByText('Email')).toBeInTheDocument()
    expect(within(card).getByText('−₹250')).toBeInTheDocument()
    expect(within(card).getByText('₹250 spent')).toBeInTheDocument()
    expect(within(card).getByText(/wasn’t sure enough to record it on its own/)).toBeInTheDocument()
    expect(within(card).getByText('62% sure')).toBeInTheDocument()
    expect(within(card).getByText('HDFC ••1234')).toBeInTheDocument()
    expect(within(card).getByText('HDFC')).toBeInTheDocument()
    expect(within(card).getByText('Food & dining')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: /^Confirm Blue Tokai/ })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: /^Ignore Blue Tokai/ })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: /^Same as an existing entry/ })).toBeInTheDocument()
    expect(screen.queryByText('Nothing needs a look right now')).not.toBeInTheDocument()
  })

  it('says when the amount couldn’t be read, and signs money in with a plus', () => {
    events = [sourceEvent({ id: 'a', parsed_amount_minor: null, parsed_merchant: 'Mystery' }), sourceEvent({ id: 'b', parsed_kind: 'income', parsed_merchant: 'Acme Payroll' })]
    renderReview()
    expect(within(screen.getByRole('article', { name: 'Mystery' })).getByText('Amount unknown')).toBeInTheDocument()
    expect(within(screen.getByRole('article', { name: 'Acme Payroll' })).getByText('+₹250')).toBeInTheDocument()
  })

  it('confirms with the values the import read', async () => {
    events = [sourceEvent()]
    renderReview()
    await userEvent.click(screen.getByRole('button', { name: /^Confirm Blue Tokai/ }))
    const dialog = sheet('Confirm it')
    expect(within(dialog).getByRole('radio', { name: 'Expense' })).toBeChecked()
    expect(within(dialog).getByLabelText('Amount')).toHaveValue('250')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record expense' }))
    await waitFor(() => expect(confirmEvent).toHaveBeenCalledTimes(1))
    expect(confirmEvent).toHaveBeenCalledWith({
      eventId: 'ev1',
      input: {
        kind: 'expense',
        amountMinor: 25000,
        accountId: 'bank',
        destinationAccountId: null,
        categoryId: 'food',
        relatedTransactionId: null,
        merchant: 'Blue Tokai',
        note: null,
        status: 'posted',
        // The day wasn't changed, so the exact instant from the import is kept.
        occurredAt: '2026-10-18T06:30:00Z',
      },
    })
    expect(await screen.findByText('Expense recorded · ₹250')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Confirm it' })).not.toBeInTheDocument()
  })

  it('steers a cancelled or declined payment to Ignore rather than recording it', async () => {
    events = [sourceEvent({ parsed_entry_status: 'declined' })]
    renderReview()
    await userEvent.click(screen.getByRole('button', { name: /^Confirm Blue Tokai/ }))
    const note = within(sheet('Confirm it')).getByRole('note')
    expect(note).toHaveTextContent('this payment was declined, so no money moved')
    expect(note).toHaveTextContent('choose Ignore')
  })

  it('confirms with what the person corrected', async () => {
    events = [sourceEvent({ parsed_entry_status: 'pending' })]
    renderReview()
    await userEvent.click(screen.getByRole('button', { name: /^Confirm Blue Tokai/ }))
    const dialog = sheet('Confirm it')
    const amount = within(dialog).getByLabelText('Amount')
    await userEvent.clear(amount)
    await userEvent.type(amount, '1300')
    await userEvent.selectOptions(within(dialog).getByLabelText('Category'), 'travel')
    // Pending evidence can be confirmed as still pending, or as settled.
    expect(within(dialog).getByRole('radio', { name: 'Pending' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Posted' }))
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-10-15' } })
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'Team coffee')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record expense' }))
    await waitFor(() => expect(confirmEvent).toHaveBeenCalledTimes(1))
    expect(confirmEvent.mock.calls[0][0].input).toMatchObject({
      amountMinor: 130000,
      categoryId: 'travel',
      status: 'posted',
      note: 'Team coffee',
      // Midday local time on the chosen day.
      occurredAt: '2026-10-15T06:30:00.000Z',
    })
  })

  it('suggests a transfer for money “received” on a card, and needs the account it came from', async () => {
    events = [sourceEvent({ parsed_kind: 'income', review_reason: 'possible_transfer', suggested_account_id: 'card', suggested_category_id: null, parsed_merchant: 'Card payment' })]
    renderReview()
    await userEvent.click(screen.getByRole('button', { name: /^Confirm Card payment/ }))
    const dialog = sheet('Confirm it')
    expect(within(dialog).getByRole('radio', { name: 'Transfer' })).toBeChecked()
    expect(within(dialog).getByLabelText('To')).toHaveValue('card')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record transfer' }))
    expect(await within(dialog).findByText('Choose the account the money left')).toBeInTheDocument()
    expect(confirmEvent).not.toHaveBeenCalled()
    await userEvent.selectOptions(within(dialog).getByLabelText('From'), 'bank')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record transfer' }))
    await waitFor(() => expect(confirmEvent).toHaveBeenCalledTimes(1))
    expect(confirmEvent.mock.calls[0][0].input).toMatchObject({
      kind: 'transfer',
      accountId: 'bank',
      destinationAccountId: 'card',
      categoryId: null,
      merchant: null,
    })
  })

  it('confirms a refund against the purchase the import pointed at', async () => {
    const purchase = ledgerEntry({ id: 'purchase', merchant: 'Myntra', amount_minor: 99900 })
    byId = { purchase }
    offsets = [ledgerEntry({ id: 'other', merchant: 'Ajio', amount_minor: 120000 })]
    events = [
      sourceEvent({ parsed_kind: 'refund', parsed_merchant: 'Myntra', review_reason: 'needs_link', suggested_match_kind: 'transaction', suggested_match_id: 'purchase' }),
    ]
    renderReview()
    expect(screen.getByText('+₹250')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Confirm Myntra/ }))
    const dialog = sheet('Confirm it')
    expect(within(dialog).getByRole('radio', { name: 'Refund' })).toBeChecked()
    expect(within(dialog).getByRole('radio', { name: /Myntra.*Suggested/ })).toBeChecked()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record refund' }))
    await waitFor(() => expect(confirmEvent).toHaveBeenCalledTimes(1))
    expect(confirmEvent.mock.calls[0][0].input).toMatchObject({ kind: 'refund', relatedTransactionId: 'purchase', categoryId: null })
  })

  it('keeps everything typed when confirming fails', async () => {
    confirmEvent.mockRejectedValue({ code: 'P0001', message: 'That account is archived — choose another' })
    events = [sourceEvent()]
    renderReview()
    await userEvent.click(screen.getByRole('button', { name: /^Confirm Blue Tokai/ }))
    const dialog = sheet('Confirm it')
    const amount = within(dialog).getByLabelText('Amount')
    await userEvent.clear(amount)
    await userEvent.type(amount, '300')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record expense' }))
    expect(await within(dialog).findByText('That account is archived — choose another')).toBeInTheDocument()
    expect(within(sheet('Confirm it')).getByLabelText('Amount')).toHaveValue('300')
  })

  it('links an import to the entry it suggested, without recording a new one', async () => {
    byId = { tx2: ledgerEntry({ id: 'tx2', status: 'pending' }) }
    matches = [ledgerEntry({ id: 'tx2', status: 'pending' }), ledgerEntry({ id: 'tx3', merchant: 'Third Wave', occurred_at: '2026-10-16T06:30:00Z' })]
    events = [sourceEvent({ review_reason: 'possible_duplicate', suggested_match_kind: 'transaction', suggested_match_id: 'tx2' })]
    renderReview()
    await userEvent.click(screen.getByRole('button', { name: /^Same as an existing entry/ }))
    const dialog = sheet('Same as an existing entry')
    expect(within(dialog).getByText(/Friday keeps one entry and records this as more evidence\./)).toBeInTheDocument()
    expect(matchQueries).toContainEqual({ amountMinor: 25000, around: '2026-10-18T06:30:00Z', kinds: ['expense'] })
    const options = within(dialog).getAllByRole('radio')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveAccessibleName(/Blue Tokai.*Suggested/)
    expect(options[0]).toBeChecked()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link it' }))
    await waitFor(() => expect(linkEvent).toHaveBeenCalledWith({ eventId: 'ev1', entryKind: 'expense', entryId: 'tx2' }))
    expect(confirmEvent).not.toHaveBeenCalled()
  })

  it('asks before ignoring an import', async () => {
    events = [sourceEvent()]
    renderReview()
    await userEvent.click(screen.getByRole('button', { name: /^Ignore Blue Tokai/ }))
    const dialog = sheet('Ignore this?')
    expect(within(dialog).getByText(/nothing is recorded/)).toBeInTheDocument()
    expect(ignoreEvent).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ignore' }))
    await waitFor(() => expect(ignoreEvent).toHaveBeenCalledWith('ev1'))
    expect(await screen.findByText('Ignored Blue Tokai — nothing was recorded')).toBeInTheDocument()
  })

  it('confirms or voids entries waiting for review', async () => {
    reviewEntries = [ledgerEntry({ id: 'nr1', status: 'needs_review', merchant: 'Swiggy' })]
    renderReview()
    expect(screen.getByRole('heading', { name: 'Waiting for your OK' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Confirm Swiggy/ }))
    await waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith({ kind: 'expense', id: 'nr1', status: 'posted', reason: null, expectedUpdatedAt: 'v1' }),
    )
    await userEvent.click(screen.getByRole('button', { name: /^Void Swiggy/ }))
    await waitFor(() => expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'nr1', status: 'voided' })))
  })

  it('asks whether stale pending entries went through or were cancelled', async () => {
    stalePending = [ledgerEntry({ id: 'p1', status: 'pending', merchant: 'Uber', occurred_at: '2026-10-10T06:30:00Z' })]
    renderReview()
    expect(screen.getByRole('heading', { name: 'Still pending?' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^It went through/ }))
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'expense', id: 'p1', status: 'posted' })))
    await userEvent.click(screen.getByRole('button', { name: /^It was cancelled/ }))
    await waitFor(() =>
      expect(setStatus).toHaveBeenLastCalledWith({ kind: 'expense', id: 'p1', status: 'voided', reason: 'Cancelled', expectedUpdatedAt: 'v1' }),
    )
    // Undo restores it to pending, the way it was.
    const toast = await screen.findByRole('status')
    await userEvent.click(within(toast).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(setStatus).toHaveBeenLastCalledWith({ kind: 'expense', id: 'p1', status: 'pending' }))
  })

  it('shows refunds recorded as income only when there are some', async () => {
    settings = makeSettings([...BASE_CATEGORIES, category('refunds', 'Refunds', 'income', true)])
    renderReview()
    expect(incomeQueries).toContainEqual(['refunds'])
    expect(screen.queryByRole('heading', { name: 'Refunds recorded as income' })).not.toBeInTheDocument()
  })

  it('turns income in a Refunds category into a refund', async () => {
    settings = makeSettings([...BASE_CATEGORIES, category('refunds', 'Refunds', 'income', true)])
    incomeInRefunds = [ledgerEntry({ id: 'inc1', kind: 'income', base_type: 'income', category_id: 'refunds', merchant: 'Amazon refund', amount_minor: 49900 })]
    offsets = [ledgerEntry({ id: 'buy1', merchant: 'Amazon', amount_minor: 49900, occurred_at: '2026-10-01T06:30:00Z' })]
    renderReview()
    expect(screen.getByRole('heading', { name: 'Refunds recorded as income' })).toBeInTheDocument()
    expect(screen.getByText(/lowers your spending — it isn’t income/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Make it a refund/ }))
    const dialog = sheet('This was a refund')
    await userEvent.click(within(dialog).getByRole('radio', { name: /Amazon/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make it a refund' }))
    await waitFor(() => expect(makeRefund).toHaveBeenCalledWith(expect.objectContaining({ id: 'inc1', originalId: 'buy1' })))
  })
})
