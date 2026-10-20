import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/Toast'
import type { AccountBalanceRow, CategoryRow, LedgerAuditRow, LedgerEntryRow, SourceEventRow } from '@/data/database.types'
import { EntryDetail } from './EntryDetail'

const account = (
  id: string,
  name: string,
  type: AccountBalanceRow['type'],
  status: AccountBalanceRow['status'] = 'active',
): AccountBalanceRow => ({
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

const ACCOUNTS = [
  account('bank', 'HDFC', 'bank'),
  account('card', 'Amex', 'credit_card'),
  account('old', 'Old savings', 'bank', 'archived'),
]
const CATEGORIES = [
  category('food', 'Food & dining', 'expense'),
  category('shopping', 'Shopping', 'expense'),
  category('salary', 'Salary', 'income'),
]

const settings = {
  profile: {
    id: 'u1',
    display_name: 'Sai',
    timezone: 'Asia/Kolkata',
    base_currency: 'INR',
    default_account_id: null,
    created_at: '',
    updated_at: '',
  },
  accounts: ACCOUNTS,
  activeAccounts: ACCOUNTS.filter((a) => a.status === 'active'),
  accountsById: new Map(ACCOUNTS.map((a) => [a.id, a])),
  categories: CATEGORIES,
  categoriesById: new Map(CATEGORIES.map((c) => [c.id, c])),
  timeZone: 'Asia/Kolkata',
  todayDate: '2026-10-18',
}

/** A row from the transactions table, as useEntry returns it. */
const tx = (patch: Record<string, unknown> = {}) => {
  const type = (patch.type as string) ?? 'expense'
  return {
    kind: type,
    type,
    id: 'e1',
    user_id: 'u1',
    account_id: 'bank',
    amount_minor: 200000,
    currency: 'INR',
    category_id: 'food',
    occurred_at: '2026-10-17T06:30:00Z',
    note: null,
    merchant: 'Amazon',
    idempotency_key: 'k1',
    created_via: 'quick_add',
    deleted_at: null,
    status: 'posted',
    voided_from: null,
    related_transaction_id: null,
    reversal_of_type: null,
    base_type: type === 'income' ? 'income' : 'expense',
    source_type: 'manual',
    source_confidence: null,
    created_at: '2026-10-17T06:30:00Z',
    updated_at: '2026-10-17T06:31:00.123456+00:00',
    ...patch,
  }
}

/** A ledger_entries row (refunds, originals, candidates). */
const feedRow = (patch: Partial<LedgerEntryRow> = {}): LedgerEntryRow => ({
  id: 'x',
  user_id: 'u1',
  kind: 'expense',
  account_id: 'bank',
  counter_account_id: null,
  category_id: 'food',
  amount_minor: 200000,
  currency: 'INR',
  occurred_at: '2026-10-10T06:30:00Z',
  note: null,
  merchant: 'Amazon',
  status: 'posted',
  source_type: 'manual',
  created_via: 'quick_add',
  related_transaction_id: null,
  base_type: 'expense',
  source_confidence: null,
  voided_from: null,
  created_at: '2026-10-10T06:30:00Z',
  updated_at: '2026-10-10T06:30:00Z',
  ...patch,
})

let entryData: unknown
let entryError: unknown = null
const refetch = vi.fn()
let linked: Record<string, LedgerEntryRow[]> = {}
let ledger: Record<string, LedgerEntryRow | null> = {}
let audit: LedgerAuditRow[] = []
let sources: SourceEventRow[] = []
let candidates: LedgerEntryRow[] = []
const recordLinked = vi.fn()
const updateLinked = vi.fn()
const setStatus = vi.fn()
const setDeleted = vi.fn()
const makeRefund = vi.fn()

const disabled = { isPending: true, isSuccess: false, data: undefined, error: null, refetch: vi.fn() }
const loaded = <T,>(data: T) => ({ isPending: false, isSuccess: true, data, error: null, refetch: vi.fn() })

vi.mock('@/app/settings', () => ({ useSettings: () => settings }))
vi.mock('@/data/hooks', () => ({
  useEntry: () => ({ isPending: false, data: entryData, error: entryError, refetch }),
  useLinkedEntries: (id: string | null) => (id ? loaded(linked[id] ?? []) : disabled),
  useLedgerEntry: (id: string | null) => (id ? loaded(ledger[id] ?? null) : disabled),
  useEntryAudit: () => loaded(audit),
  useEntrySources: () => loaded(sources),
  useOffsetCandidates: () => loaded(candidates),
  useRecordLinkedEntry: () => ({ mutateAsync: recordLinked, isPending: false }),
  useUpdateLinkedEntry: () => ({ mutateAsync: updateLinked, isPending: false }),
  useSetEntryStatus: () => ({ mutateAsync: setStatus, isPending: false }),
  useSetEntryDeleted: () => ({ mutateAsync: setDeleted, isPending: false }),
  useMakeRefund: () => ({ mutateAsync: makeRefund, isPending: false }),
}))

function Where() {
  return <p>at {useLocation().pathname}</p>
}

function renderDetail(path = '/entry/expense/e1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route path="/entry/:kind/:id" element={<EntryDetail />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  )
}

/** The value next to a fact's label in the details list. */
function fact(label: string) {
  const term = screen.getAllByText(label).find((el) => el.tagName === 'DT')
  if (!term) throw new Error(`No fact labelled ${label}`)
  return term.nextElementSibling as HTMLElement
}

const button = (name: string | RegExp) => screen.queryByRole('button', { name })

beforeEach(() => {
  entryData = tx()
  entryError = null
  linked = {}
  ledger = {}
  audit = []
  sources = []
  candidates = []
  refetch.mockReset()
  for (const fn of [recordLinked, updateLinked, setStatus, setDeleted, makeRefund]) fn.mockReset()
  recordLinked.mockResolvedValue({ kind: 'refund', id: 'r-new', created: true, matches: true, voided: false, updated_at: 'v' })
  updateLinked.mockResolvedValue('v2')
  setStatus.mockResolvedValue('v2')
  setDeleted.mockResolvedValue(undefined)
  makeRefund.mockResolvedValue('v2')
})

describe('Entry details — facts', () => {
  it('shows what the entry is, where it came from and how it counts', () => {
    entryData = tx({
      status: 'pending',
      account_id: 'old',
      note: 'Birthday gift',
      source_type: 'email',
      source_confidence: 0.92,
      created_via: 'import',
    })
    sources = [
      {
        id: 'ev1',
        source_type: 'email',
        received_at: '2026-10-17T06:40:00Z',
        link_type: 'created',
        confidence: 0.92,
        parsed_amount_minor: 200000,
        parsed_merchant: 'AMAZON',
        parsed_account_hint: '••1234',
        parsed_entry_status: 'pending',
      } as SourceEventRow,
    ]
    renderDetail()

    expect(screen.getByRole('heading', { level: 1, name: 'Expense' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Amazon' })).toBeInTheDocument()
    expect(screen.getByLabelText('₹2,000 spent')).toHaveTextContent('−₹2,000')
    // Badges: state in words, never colour alone.
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0)
    expect(screen.getByText('Email')).toBeInTheDocument()

    expect(fact('Type')).toHaveTextContent('Expense')
    expect(fact('Date')).toHaveTextContent('Yesterday · 17 Oct 2026')
    expect(fact('Account')).toHaveTextContent('Old savings')
    expect(within(fact('Account')).getByText('Archived')).toBeInTheDocument()
    expect(fact('Category')).toHaveTextContent('Food & dining')
    expect(fact('Merchant')).toHaveTextContent('Amazon')
    expect(fact('Note')).toHaveTextContent('Birthday gift')
    expect(fact('Status')).toHaveTextContent('Pending')
    expect(fact('Status')).toHaveTextContent('Already counted in balances and insights')
    expect(fact('Source')).toHaveTextContent('From an email')
    expect(fact('Source')).toHaveTextContent('92% confidence')
    expect(fact('Created via')).toHaveTextContent('Import')
    expect(fact('Added')).toHaveTextContent('17 Oct 2026, 12:00')
    expect(fact('Last changed')).toHaveTextContent('17 Oct 2026, 12:01')

    expect(screen.getByRole('heading', { name: 'Import evidence' })).toBeInTheDocument()
    expect(screen.getByText(/From an email · Created this entry/)).toBeInTheDocument()
    expect(screen.getByText('Read as ₹2,000 · AMAZON · ••1234 · pending')).toBeInTheDocument()
  })

  it('calls a transfer to a card a card payment that isn’t spending', () => {
    entryData = {
      kind: 'transfer',
      id: 't1',
      user_id: 'u1',
      source_account_id: 'bank',
      destination_account_id: 'card',
      amount_minor: 1500000,
      currency: 'INR',
      occurred_at: '2026-10-17T06:30:00Z',
      note: null,
      idempotency_key: null,
      created_via: 'quick_add',
      deleted_at: null,
      status: 'posted',
      voided_from: null,
      source_type: 'manual',
      source_confidence: null,
      created_at: '2026-10-17T06:30:00Z',
      updated_at: '2026-10-17T06:30:00Z',
    }
    renderDetail('/entry/transfer/t1')
    expect(screen.getByRole('heading', { level: 1, name: 'Card payment' })).toBeInTheDocument()
    expect(fact('Type')).toHaveTextContent(/Card payment.*Not spending/)
    expect(fact('From')).toHaveTextContent('HDFC')
    expect(fact('To')).toHaveTextContent('Amex')
    expect(screen.getByLabelText('₹15,000 moved')).toHaveTextContent('₹15,000')
    expect(button('Record refund')).toBeNull()
    expect(button('Reverse')).toBeNull()
  })

  it('opens the history on request, in words, newest first', async () => {
    audit = [
      {
        id: 1,
        user_id: 'u1',
        entity: 'transaction',
        entity_id: 'e1',
        action: 'create',
        changed_fields: [],
        snapshot: { status: 'posted' },
        previous: null,
        reason: null,
        created_at: '2026-10-17T06:30:00Z',
      },
      {
        id: 2,
        user_id: 'u1',
        entity: 'transaction',
        entity_id: 'e1',
        action: 'update',
        changed_fields: ['amount_minor'],
        snapshot: { amount_minor: 200000 },
        previous: { amount_minor: 180000 },
        reason: 'Added the tip',
        created_at: '2026-10-17T07:00:00Z',
      },
    ]
    renderDetail()
    const toggle = screen.getByRole('button', { name: /History/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Amount ₹1,800 → ₹2,000')).not.toBeInTheDocument()
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const items = within(document.getElementById('entry-history')!).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Edited')
    expect(items[0]).toHaveTextContent('Amount ₹1,800 → ₹2,000')
    expect(items[0]).toHaveTextContent('“Added the tip”')
    expect(items[1]).toHaveTextContent('Added')
  })
})

describe('Entry details — actions by state', () => {
  it('offers refund and reverse only on a posted expense', () => {
    renderDetail()
    expect(button('Record refund')).toBeInTheDocument()
    expect(button('Reverse')).toBeInTheDocument()
    expect(button('This was a refund')).toBeNull()
    expect(screen.getByText('₹2,000 left that can be refunded or reversed')).toBeInTheDocument()
  })

  it('offers reverse (not refund) on posted income, and can correct it into a refund', () => {
    entryData = tx({ type: 'income', category_id: 'salary', merchant: 'Acme' })
    renderDetail('/entry/income/e1')
    expect(button('Reverse')).toBeInTheDocument()
    expect(button('Record refund')).toBeNull()
    expect(button('This was a refund')).toBeInTheDocument()
    expect(fact('Payer')).toHaveTextContent('Acme')
  })

  it('offers no money-back actions on pending or review entries, but lets you settle them', async () => {
    entryData = tx({ status: 'pending' })
    const { unmount } = renderDetail()
    expect(button('Record refund')).toBeNull()
    expect(button('Reverse')).toBeNull()
    await userEvent.click(button('Mark as posted')!)
    expect(setStatus).toHaveBeenCalledWith({
      kind: 'expense',
      id: 'e1',
      status: 'posted',
      reason: null,
      expectedUpdatedAt: '2026-10-17T06:31:00.123456+00:00',
    })
    unmount()

    entryData = tx({ status: 'needs_review' })
    renderDetail()
    expect(button('Record refund')).toBeNull()
    await userEvent.click(button('Confirm')!)
    expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'posted' }))
  })

  it('opens the full editor for income, expenses and transfers', async () => {
    renderDetail()
    await userEvent.click(button('Edit')!)
    expect(await screen.findByText('at /entry/expense/e1/edit')).toBeInTheDocument()
  })

  it('voids with a reason after explaining void vs delete vs refund', async () => {
    renderDetail()
    await userEvent.click(button('Void')!)
    const dialog = screen.getByRole('dialog', { name: 'Void this expense?' })
    expect(dialog).toHaveTextContent(/never really happened/)
    expect(dialog).toHaveTextContent(/Delete is for something added by mistake/)
    expect(dialog).toHaveTextContent(/use Record refund instead/)
    await userEvent.type(within(dialog).getByLabelText('Reason (optional)'), 'Card hold cancelled')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void' }))
    expect(setStatus).toHaveBeenCalledWith({
      kind: 'expense',
      id: 'e1',
      status: 'voided',
      reason: 'Card hold cancelled',
      expectedUpdatedAt: '2026-10-17T06:31:00.123456+00:00',
    })
    expect(await screen.findByText('Voided — it no longer counts anywhere')).toBeInTheDocument()
  })

  it('restores a voided entry to the status it had before', async () => {
    entryData = tx({ status: 'voided', voided_from: 'needs_review' })
    renderDetail()
    expect(button('Edit')).toBeNull()
    expect(button('Void')).toBeNull()
    expect(button('Record refund')).toBeNull()
    expect(screen.getByText(/Restore brings it back as needs review/)).toBeInTheDocument()
    await userEvent.click(button('Restore')!)
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'needs_review', expectedUpdatedAt: '2026-10-17T06:31:00.123456+00:00' }),
    )
  })

  it('won’t offer void or delete while counted money back depends on it', () => {
    linked = { e1: [feedRow({ id: 'r1', kind: 'refund', amount_minor: 50000, related_transaction_id: 'e1' })] }
    renderDetail()
    expect(button('Void')).toBeNull()
    expect(button('Delete')).toBeNull()
    expect(screen.getByText(/can’t be voided or deleted/)).toBeInTheDocument()
  })

  it('offers to reload after a change made elsewhere', async () => {
    setStatus.mockRejectedValueOnce({
      code: 'PT409',
      message: 'This entry was changed somewhere else. Reload to see the latest version.',
    })
    entryData = tx({ status: 'pending' })
    renderDetail()
    await userEvent.click(button('Mark as posted')!)
    expect(await screen.findByRole('alert')).toHaveTextContent('changed somewhere else')
    await userEvent.click(button('Load the latest version')!)
    expect(refetch).toHaveBeenCalled()
  })
})

describe('Entry details — refunds and reversals', () => {
  it('defaults a refund to what is left, blocks over-refunding and retries with the same key', async () => {
    linked = {
      e1: [feedRow({ id: 'r1', kind: 'refund', amount_minor: 50000, related_transaction_id: 'e1', merchant: 'Amazon' })],
    }
    recordLinked.mockRejectedValueOnce({ message: 'TypeError: Failed to fetch', code: '' })
    renderDetail()
    expect(screen.getByRole('heading', { name: 'Money back' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Amazon, refunded ₹500/ })).toHaveAttribute('href', '/entry/refund/r1')
    expect(screen.getByText('₹1,500 left that can be refunded or reversed')).toBeInTheDocument()

    await userEvent.click(button('Record refund')!)
    const dialog = screen.getByRole('dialog', { name: 'Record a refund' })
    const amount = within(dialog).getByLabelText('Amount')
    expect(amount).toHaveValue('1,500')
    expect(within(dialog).getByLabelText('Money came back to')).toHaveValue('bank')

    await userEvent.clear(amount)
    await userEvent.type(amount, '1600')
    expect(within(dialog).getAllByText('Only ₹1,500 is left to refund — enter that or less')[0]).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record refund' }))
    expect(recordLinked).not.toHaveBeenCalled()

    await userEvent.clear(amount)
    await userEvent.type(amount, '1000')
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'Returned one')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record refund' }))
    expect(await within(dialog).findByText(/Trying again is safe/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record refund' }))

    await waitFor(() => expect(recordLinked).toHaveBeenCalledTimes(2))
    const [first, second] = recordLinked.mock.calls.map((call) => call[0])
    expect(second.input).toMatchObject({
      kind: 'refund',
      originalId: 'e1',
      amountMinor: 100000,
      accountId: 'bank',
      note: 'Returned one',
      merchant: 'Amazon',
    })
    expect(second.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(await screen.findByText('Refund recorded · ₹500 left')).toBeInTheDocument()
  })

  it('keeps a reversal on the original’s account', async () => {
    entryData = tx({ type: 'income', category_id: 'salary', merchant: 'Acme' })
    renderDetail('/entry/income/e1')
    await userEvent.click(button('Reverse')!)
    const dialog = screen.getByRole('dialog', { name: 'Reverse it' })
    expect(within(dialog).queryByLabelText('Money came back to')).toBeNull()
    expect(dialog).toHaveTextContent('A reversal always stays on the original’s account.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record reversal' }))
    await waitFor(() => expect(recordLinked).toHaveBeenCalled())
    expect(recordLinked.mock.calls[0][0].input).toMatchObject({
      kind: 'reversal',
      originalId: 'e1',
      amountMinor: 200000,
      accountId: 'bank',
    })
  })

  it('shows a refund’s original and edits the refund within what is left', async () => {
    entryData = tx({ id: 'r1', type: 'refund', amount_minor: 50000, related_transaction_id: 'e1', note: 'Returned' })
    ledger = { e1: feedRow({ id: 'e1', amount_minor: 200000 }) }
    linked = {
      e1: [
        feedRow({ id: 'r1', kind: 'refund', amount_minor: 50000, related_transaction_id: 'e1' }),
        feedRow({ id: 'r2', kind: 'refund', amount_minor: 100000, related_transaction_id: 'e1' }),
      ],
    }
    renderDetail('/entry/refund/r1')
    expect(screen.getByRole('heading', { level: 1, name: 'Refund' })).toBeInTheDocument()
    expect(screen.getByLabelText('₹500 refunded')).toHaveTextContent('+₹500')
    expect(screen.getByText('Refund', { selector: 'span' })).toBeInTheDocument()
    expect(fact('Category')).toHaveTextContent('Food & dining · from the original')
    expect(screen.getByRole('heading', { name: 'Refund of' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Amazon, spent ₹2,000/ })).toHaveAttribute('href', '/entry/expense/e1')
    expect(button('Record refund')).toBeNull()

    await userEvent.click(button('Edit')!)
    const dialog = screen.getByRole('dialog', { name: 'Edit refund' })
    const amount = within(dialog).getByLabelText('Amount')
    expect(amount).toHaveValue('500')
    // ₹2,000 − the other ₹1,000 refund = ₹1,000 at most.
    await userEvent.clear(amount)
    await userEvent.type(amount, '1200')
    expect(within(dialog).getAllByText('Only ₹1,000 is left to refund — enter that or less')[0]).toBeInTheDocument()
    await userEvent.clear(amount)
    await userEvent.type(amount, '800')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateLinked).toHaveBeenCalled())
    expect(updateLinked.mock.calls[0][0]).toMatchObject({
      kind: 'refund',
      id: 'r1',
      expectedUpdatedAt: '2026-10-17T06:31:00.123456+00:00',
      values: { amountMinor: 80000, accountId: 'bank', occurredAt: '2026-10-17T06:30:00Z', note: 'Returned', merchant: 'Amazon' },
    })
  })

  it('turns income that was really a refund into a refund of a chosen purchase', async () => {
    entryData = tx({ id: 'i1', type: 'income', category_id: 'salary', merchant: null, amount_minor: 50000 })
    candidates = [feedRow({ id: 'p1', merchant: 'Myntra', category_id: 'shopping', amount_minor: 300000 })]
    renderDetail('/entry/income/i1')
    await userEvent.click(button('This was a refund')!)
    const dialog = screen.getByRole('dialog', { name: 'This was a refund' })
    const confirm = within(dialog).getByRole('button', { name: 'Make it a refund' })
    expect(confirm).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('radio', { name: /Myntra/ }))
    await userEvent.click(confirm)
    await waitFor(() =>
      expect(makeRefund).toHaveBeenCalledWith({
        id: 'i1',
        originalId: 'p1',
        categoryId: null,
        expectedUpdatedAt: '2026-10-17T06:31:00.123456+00:00',
      }),
    )
    expect(await screen.findByText('Now a refund of Myntra — it lowers your spending')).toBeInTheDocument()
  })

  it('can keep converted income as an unlinked refund in an expense category', async () => {
    entryData = tx({ id: 'i1', type: 'income', category_id: 'salary', amount_minor: 50000 })
    renderDetail('/entry/income/i1')
    await userEvent.click(button('This was a refund')!)
    const dialog = screen.getByRole('dialog', { name: 'This was a refund' })
    expect(dialog).toHaveTextContent('No purchases like that yet.')
    await userEvent.click(within(dialog).getByRole('radio', { name: /No purchase in Friday/ }))
    await userEvent.selectOptions(within(dialog).getByLabelText('Expense category'), 'shopping')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make it a refund' }))
    await waitFor(() =>
      expect(makeRefund).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1', originalId: null, categoryId: 'shopping' })),
    )
  })

  it('links a refund recorded without its purchase', async () => {
    entryData = tx({ id: 'r9', type: 'refund', related_transaction_id: null, amount_minor: 50000, category_id: null })
    candidates = [feedRow({ id: 'p1', merchant: 'Myntra' })]
    renderDetail('/entry/refund/r9')
    expect(screen.getByText(/Not linked to a purchase yet/)).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'Link to purchase' })[0])
    const dialog = screen.getByRole('dialog', { name: 'Link to purchase' })
    expect(within(dialog).queryByRole('radio', { name: /No purchase in Friday/ })).toBeNull()
    await userEvent.click(within(dialog).getByRole('radio', { name: /Myntra/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link purchase' }))
    await waitFor(() => expect(makeRefund).toHaveBeenCalledWith(expect.objectContaining({ id: 'r9', originalId: 'p1' })))
  })
})

describe('Entry details — deleting', () => {
  it('deletes with an Undo toast', async () => {
    renderDetail()
    await userEvent.click(button('Delete')!)
    const dialog = screen.getByRole('dialog', { name: 'Delete this expense?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(setDeleted).toHaveBeenCalledWith({ kind: 'expense', id: 'e1', deleted: true })
    const toast = await screen.findByText('Deleted expense · ₹2,000')
    await userEvent.click(within(toast.parentElement!.parentElement!).getByRole('button', { name: 'Undo' }))
    expect(setDeleted).toHaveBeenLastCalledWith({ kind: 'expense', id: 'e1', deleted: false })
  })

  it('shows a deleted entry clearly and offers to restore it', async () => {
    entryData = tx({ deleted_at: '2026-10-18T05:00:00Z' })
    renderDetail()
    expect(screen.getByText(/This entry was deleted/)).toBeInTheDocument()
    expect(button('Edit')).toBeNull()
    expect(button('Void')).toBeNull()
    expect(button('Record refund')).toBeNull()
    await userEvent.click(button('Restore')!)
    expect(setDeleted).toHaveBeenCalledWith({ kind: 'expense', id: 'e1', deleted: false })
  })
})

describe('Entry details — missing entries', () => {
  it('says so for an unknown kind in the address', () => {
    renderDetail('/entry/bogus/e1')
    expect(screen.getByText('Entry not found')).toBeInTheDocument()
  })

  it('says so when the entry doesn’t exist', () => {
    entryData = undefined
    entryError = { code: 'PGRST116', message: 'no rows' }
    renderDetail()
    expect(screen.getByText('Entry not found')).toBeInTheDocument()
  })

  it('keeps showing the entry when a background refresh fails', () => {
    entryError = new TypeError('Failed to fetch')
    renderDetail()
    expect(screen.getByRole('heading', { level: 1, name: 'Expense' })).toBeInTheDocument()
    expect(button('Edit')).not.toBeNull()
  })

  it('offers a retry when the first load fails', async () => {
    entryData = undefined
    entryError = new TypeError('Failed to fetch')
    renderDetail()
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(refetch).toHaveBeenCalled()
  })
})
