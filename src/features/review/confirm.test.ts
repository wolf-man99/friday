import { describe, expect, it } from 'vitest'
import type { CategoryRow, SourceEventRow } from '@/data/database.types'
import {
  confidenceLabel,
  confirmDraftFrom,
  confirmKinds,
  eventAmount,
  eventTitle,
  linkProblem,
  matchQuery,
  originalQuery,
  reasonText,
  refundIncomeCategoryIds,
  UNLINKED,
  validateConfirm,
  withKind,
  type ConfirmDraft,
} from './confirm'

const category = (id: string, name: string, type: CategoryRow['transaction_type'], archived = false): CategoryRow => ({
  id,
  name,
  transaction_type: type,
  user_id: 'u1',
  icon: 'tag',
  color: 'orange',
  is_default: false,
  is_archived: archived,
  sort_order: 0,
  created_at: '',
  updated_at: '',
})

const categoriesById = new Map(
  [
    category('food', 'Food & dining', 'expense'),
    category('old', 'Old stuff', 'expense', true),
    category('salary', 'Salary', 'income'),
  ].map((c) => [c.id, c]),
)
const ctx = { activeAccountIds: new Set(['bank', 'card']), categoriesById }
const zone = { ...ctx, timeZone: 'Asia/Kolkata', todayDate: '2026-10-19' }

const sourceEvent = (patch: Partial<SourceEventRow> = {}): SourceEventRow => ({
  id: 'ev1',
  user_id: 'u1',
  source_type: 'email',
  source_connection_id: null,
  external_event_id: 'msg-1',
  external_transaction_id: null,
  payload_fingerprint: null,
  received_at: '2026-10-18T04:00:00Z',
  parsed_at: '2026-10-18T04:00:01Z',
  processing_status: 'needs_review',
  confidence: 0.62,
  parsed_kind: 'expense',
  parsed_amount_minor: 25000,
  parsed_currency: 'INR',
  parsed_occurred_at: '2026-10-17T20:00:00Z',
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
  created_at: '2026-10-18T04:00:00Z',
  updated_at: '2026-10-18T04:00:00Z',
  ...patch,
})

const draft = (patch: Partial<ConfirmDraft> = {}): ConfirmDraft => ({
  kind: 'expense',
  amountText: '250',
  accountId: 'bank',
  destinationAccountId: '',
  categoryId: 'food',
  originalId: null,
  date: '2026-10-18',
  merchant: 'Blue Tokai',
  note: '',
  status: 'posted',
  ...patch,
})

describe('confirmDraftFrom', () => {
  it('prefills what the import read, in local time', () => {
    expect(confirmDraftFrom(sourceEvent(), zone)).toEqual({
      kind: 'expense',
      amountText: '250',
      accountId: 'bank',
      destinationAccountId: '',
      categoryId: 'food',
      originalId: null,
      // 20:00 UTC is 01:30 the next day in India.
      date: '2026-10-18',
      merchant: 'Blue Tokai',
      note: '',
      status: 'posted',
    })
  })

  it('treats money "received" on a card as a transfer into the card, from an account you pick', () => {
    const value = confirmDraftFrom(
      sourceEvent({ parsed_kind: 'income', review_reason: 'possible_transfer', suggested_account_id: 'card', suggested_category_id: 'salary' }),
      zone,
    )
    expect(value).toMatchObject({ kind: 'transfer', accountId: '', destinationAccountId: 'card', categoryId: '' })
  })

  it('never picks an account it wasn’t told about, or a category from the wrong side', () => {
    const value = confirmDraftFrom(
      sourceEvent({ suggested_account_id: 'gone', suggested_category_id: 'salary', parsed_amount_minor: null, parsed_occurred_at: null, parsed_merchant: null }),
      zone,
    )
    expect(value).toMatchObject({ accountId: '', categoryId: '', amountText: '', date: '2026-10-19', merchant: '' })
  })

  it('never prefills another currency’s figure as rupees', () => {
    expect(confirmDraftFrom(sourceEvent({ parsed_currency: 'USD', review_reason: 'unsupported_currency' }), zone).amountText).toBe('')
  })

  it('keeps pending evidence pending, and preselects the original a refund points at', () => {
    expect(confirmDraftFrom(sourceEvent({ parsed_entry_status: 'pending' }), zone).status).toBe('pending')
    const refund = confirmDraftFrom(
      sourceEvent({ parsed_kind: 'refund', review_reason: 'needs_link', suggested_match_kind: 'transaction', suggested_match_id: 'tx1' }),
      zone,
    )
    expect(refund).toMatchObject({ kind: 'refund', originalId: 'tx1', categoryId: 'food' })
    // A lookalike expense is not an "original".
    const duplicate = confirmDraftFrom(sourceEvent({ suggested_match_kind: 'transaction', suggested_match_id: 'tx1' }), zone)
    expect(duplicate.originalId).toBeNull()
  })
})

describe('confirmKinds and withKind', () => {
  it('offers reversal only when the evidence says so', () => {
    expect(confirmKinds({ parsed_kind: 'expense' })).toEqual(['expense', 'income', 'transfer', 'refund'])
    expect(confirmKinds({ parsed_kind: 'reversal' })).toContain('reversal')
  })

  it('keeps what was typed but drops a category from the other side', () => {
    expect(withKind(draft(), 'income', categoriesById)).toMatchObject({ kind: 'income', amountText: '250', categoryId: '' })
    expect(withKind(draft(), 'refund', categoriesById).categoryId).toBe('food')
    expect(withKind(draft({ kind: 'refund', originalId: UNLINKED }), 'reversal', categoriesById).originalId).toBeNull()
  })
})

describe('validateConfirm', () => {
  it('turns a prefilled expense into exactly what confirm_source_event takes', () => {
    expect(validateConfirm(draft({ note: '  oat latte ' }), ctx)).toEqual({
      ok: true,
      value: {
        kind: 'expense',
        amountMinor: 25000,
        accountId: 'bank',
        destinationAccountId: null,
        categoryId: 'food',
        relatedTransactionId: null,
        merchant: 'Blue Tokai',
        note: 'oat latte',
        status: 'posted',
        date: '2026-10-18',
      },
    })
  })

  it('needs an amount, an active account and two different accounts for a transfer', () => {
    const result = validateConfirm(draft({ amountText: '', accountId: '' }), ctx)
    expect(result).toEqual({ ok: false, errors: { amount: 'Enter an amount', account: 'Choose the account it was paid from' } })
    expect(validateConfirm(draft({ accountId: 'archived' }), ctx)).toMatchObject({ ok: false, errors: { account: expect.stringMatching(/archived/) } })
    expect(validateConfirm(draft({ kind: 'transfer', destinationAccountId: 'bank' }), ctx)).toMatchObject({
      ok: false,
      errors: { destination: 'Pick two different accounts' },
    })
  })

  it('sends transfers without a category or merchant', () => {
    const result = validateConfirm(draft({ kind: 'transfer', destinationAccountId: 'card' }), ctx)
    expect(result).toMatchObject({ ok: true, value: { kind: 'transfer', destinationAccountId: 'card', categoryId: null, merchant: null } })
  })

  it('links a refund to its purchase (taking its category), or records it unlinked in an expense category', () => {
    expect(validateConfirm(draft({ kind: 'refund' }), ctx)).toMatchObject({ ok: false, errors: { original: expect.any(String) } })
    expect(validateConfirm(draft({ kind: 'refund', originalId: 'tx1' }), ctx)).toMatchObject({
      ok: true,
      value: { kind: 'refund', relatedTransactionId: 'tx1', categoryId: null },
    })
    expect(validateConfirm(draft({ kind: 'refund', originalId: UNLINKED }), ctx)).toMatchObject({
      ok: true,
      value: { kind: 'refund', relatedTransactionId: null, categoryId: 'food' },
    })
    expect(validateConfirm(draft({ kind: 'reversal', originalId: UNLINKED, categoryId: '' }), ctx)).toMatchObject({
      ok: false,
      errors: { original: 'Pick the entry this reverses' },
    })
  })

  it('refuses a category from the wrong side and overlong text', () => {
    const result = validateConfirm(draft({ categoryId: 'salary', merchant: 'x'.repeat(121), note: 'y'.repeat(501) }), ctx)
    expect(result).toMatchObject({ ok: false, errors: { category: expect.any(String), merchant: expect.any(String), note: expect.any(String) } })
  })
})

describe('candidate queries', () => {
  it('looks for purchases on the refund’s account, or anywhere', () => {
    expect(originalQuery('refund', 'bank', 25000)).toEqual({ kinds: ['expense'], accountId: 'bank', minAmountMinor: 25000 })
    expect(originalQuery('refund', 'bank', null, { onlyThisAccount: false })).toEqual({
      kinds: ['expense'],
      accountId: undefined,
      minAmountMinor: undefined,
    })
    expect(originalQuery('reversal', '', 25000)).toBeNull()
    expect(originalQuery('reversal', 'bank', 25000)).toEqual({ kinds: ['expense', 'income'], accountId: 'bank', minAmountMinor: 25000 })
    expect(originalQuery('expense', 'bank', 25000)).toBeNull()
  })

  it('matches on amount around the evidence’s date and kind', () => {
    expect(matchQuery(sourceEvent())).toEqual({ amountMinor: 25000, around: '2026-10-17T20:00:00Z', kinds: ['expense'] })
    expect(matchQuery(sourceEvent({ parsed_occurred_at: null, parsed_kind: null }))).toEqual({
      amountMinor: 25000,
      around: '2026-10-18T04:00:00Z',
      kinds: undefined,
    })
    expect(matchQuery(sourceEvent({ parsed_amount_minor: null }))).toBeNull()
  })

  it('explains entries an event can’t be linked to', () => {
    expect(linkProblem({ parsed_kind: 'expense' }, { kind: 'expense', status: 'pending' })).toBeNull()
    expect(linkProblem({ parsed_kind: 'expense' }, { kind: 'expense', status: 'voided' })).toMatch(/restore it first/)
    expect(linkProblem({ parsed_kind: 'refund' }, { kind: 'expense', status: 'posted' })).toMatch(/money back/)
    expect(linkProblem({ parsed_kind: 'expense' }, { kind: 'income', status: 'posted' })).toBe('That’s income, but this looks like an expense.')
    expect(linkProblem({ parsed_kind: null }, { kind: 'transfer', status: 'posted' })).toBeNull()
  })
})

describe('display helpers', () => {
  it('signs the parsed amount by kind, and never shows another currency as rupees', () => {
    expect(eventAmount(sourceEvent())).toEqual({ text: '−₹250', spoken: '₹250 spent', direction: 'out' })
    expect(eventAmount(sourceEvent({ parsed_kind: 'refund' }))).toEqual({ text: '+₹250', spoken: '₹250 refunded', direction: 'in' })
    expect(eventAmount(sourceEvent({ parsed_kind: 'transfer' }))).toMatchObject({ text: '₹250', direction: 'move' })
    expect(eventAmount(sourceEvent({ parsed_kind: 'reversal' }))).toMatchObject({ text: '₹250', direction: null })
    expect(eventAmount(sourceEvent({ parsed_currency: 'USD', parsed_amount_minor: 1250 }))).toMatchObject({ text: '−USD 12.50' })
    expect(eventAmount(sourceEvent({ parsed_amount_minor: null }))).toBeNull()
  })

  it('names, explains and rates evidence in words', () => {
    expect(eventTitle(sourceEvent())).toBe('Blue Tokai')
    expect(eventTitle(sourceEvent({ parsed_merchant: null, parsed_kind: 'transfer' }))).toBe('Transfer')
    expect(eventTitle(sourceEvent({ parsed_merchant: null, parsed_kind: null }))).toBe('Unknown item')
    expect(reasonText(sourceEvent())).toMatch(/wasn’t sure enough/)
    expect(reasonText(sourceEvent({ review_reason: null }))).toMatch(/check this one/)
    expect(confidenceLabel(0.62)).toBe('62% sure')
    expect(confidenceLabel(null)).toBeNull()
  })

  it('finds income categories named Refunds, archived or not', () => {
    expect(
      refundIncomeCategoryIds([
        category('r1', 'Refunds', 'income', true),
        category('r2', ' refunds ', 'income'),
        category('r3', 'Refunds', 'expense'),
        category('s', 'Salary', 'income'),
      ]),
    ).toEqual(['r1', 'r2'])
  })
})
