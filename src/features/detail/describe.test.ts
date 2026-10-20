import { describe, expect, it } from 'vitest'
import type { LedgerAuditRow } from '@/data/database.types'
import { confidenceText, describeAudit, entryTypeLabel, formatDateTime, kindExplainer, remainingText } from './describe'

const TZ = 'Asia/Kolkata'

const row = (patch: Partial<LedgerAuditRow>): LedgerAuditRow => ({
  id: 1,
  user_id: 'u1',
  entity: 'transaction',
  entity_id: 't1',
  action: 'update',
  changed_fields: [],
  snapshot: {},
  previous: null,
  reason: null,
  created_at: '2026-10-18T08:35:00Z',
  ...patch,
})

const context = {
  timeZone: TZ,
  accountName: (id: string) => ({ bank: 'HDFC', card: 'Amex' })[id],
  categoryName: (id: string) => ({ food: 'Food & dining', travel: 'Travel' })[id],
}

describe('labels', () => {
  it('calls a transfer to a card a card payment', () => {
    expect(entryTypeLabel('transfer', 'credit_card')).toBe('Card payment')
    expect(entryTypeLabel('transfer', 'bank')).toBe('Transfer')
    expect(entryTypeLabel('refund')).toBe('Refund')
  })

  it('formats instants in the user’s timezone', () => {
    expect(formatDateTime('2026-10-18T20:00:00Z', TZ)).toBe('19 Oct 2026, 01:30')
  })

  it('says how much is left to give back, in words', () => {
    expect(remainingText('expense', 150000)).toBe('₹1,500 left that can be refunded or reversed')
    expect(remainingText('income', 5000)).toBe('₹50 left that can be reversed')
    expect(remainingText('expense', 0)).toBe('Fully refunded or reversed')
  })

  it('rounds confidence to a percentage', () => {
    expect(confidenceText(0.924)).toBe('92% confidence')
    expect(confidenceText(null)).toBeNull()
  })

  it('explains entries whose effect isn’t obvious', () => {
    expect(kindExplainer('refund')).toMatch(/never counted as income/)
    expect(kindExplainer('reversal', 'income')).toMatch(/out of your income/)
    expect(kindExplainer('reversal', 'expense')).toMatch(/spending/)
    expect(kindExplainer('transfer', null, 'credit_card')).toMatch(/Not spending — the purchases already counted/)
    expect(kindExplainer('expense')).toBeNull()
  })
})

describe('describeAudit', () => {
  it('words an edit field by field', () => {
    const line = describeAudit(
      row({
        changed_fields: ['amount_minor', 'category_id', 'account_id', 'note', 'occurred_at'],
        previous: { amount_minor: 25000, category_id: 'food', account_id: 'bank', occurred_at: '2026-10-17T06:30:00Z' },
        snapshot: { amount_minor: 30000, category_id: null, account_id: 'card', occurred_at: '2026-10-15T06:30:00Z' },
        reason: '  Tip added ',
      }),
      context,
    )
    expect(line.title).toBe('Edited')
    expect(line.changes).toEqual([
      'Amount ₹250 → ₹300',
      'Category Food & dining → Uncategorised',
      'Account HDFC → Amex',
      'Note changed',
      'Date 17 Oct 2026 → 15 Oct 2026',
    ])
    expect(line.reason).toBe('Tip added')
  })

  it('names status changes, including confirm and restore', () => {
    const status = (from: string, to: string) =>
      describeAudit(
        row({ action: 'status', changed_fields: ['status'], previous: { status: from }, snapshot: { status: to } }),
        context,
      ).title
    expect(status('posted', 'voided')).toBe('Voided')
    expect(status('pending', 'posted')).toBe('Marked as posted')
    expect(status('needs_review', 'posted')).toBe('Confirmed')
    expect(status('voided', 'needs_review')).toBe('Restored as needs review')
  })

  it('reads the legacy void action as a deletion', () => {
    expect(describeAudit(row({ action: 'void' }), context).title).toBe('Deleted')
    expect(describeAudit(row({ action: 'delete' }), context).title).toBe('Deleted')
    expect(describeAudit(row({ action: 'restore' }), context).title).toBe('Restored after deleting')
  })

  it('says when income became a refund, or a refund was linked', () => {
    const converted = describeAudit(
      row({
        changed_fields: ['type', 'related_transaction_id', 'category_id'],
        previous: { type: 'income', category_id: 'travel' },
        snapshot: { type: 'refund', related_transaction_id: 'p1', category_id: 'food' },
      }),
      context,
    )
    expect(converted.title).toBe('Turned into a refund')
    expect(converted.changes).toEqual(['Linked to the original', 'Category Travel → Food & dining'])
    const linked = describeAudit(
      row({
        changed_fields: ['related_transaction_id'],
        previous: { type: 'refund' },
        snapshot: { type: 'refund', related_transaction_id: 'p1' },
      }),
      context,
    )
    expect(linked.title).toBe('Linked to its purchase')
  })

  it('marks entries added as pending', () => {
    expect(describeAudit(row({ action: 'create', snapshot: { status: 'pending' } }), context).title).toBe('Added as pending')
    expect(describeAudit(row({ action: 'create', snapshot: { status: 'posted' } }), context).title).toBe('Added')
  })
})
