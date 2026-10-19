import { describe, expect, it } from 'vitest'
import { validateEntry, type EntryDraft } from './entry'

const base: EntryDraft = {
  kind: 'expense',
  amountText: '250',
  accountId: 'acc-1',
  destinationAccountId: null,
  categoryId: 'cat-food',
  date: '2026-10-18',
  note: '',
}

describe('validateEntry', () => {
  it('accepts a minimal expense', () => {
    const result = validateEntry(base)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toMatchObject({ amountMinor: 25000, note: null })
  })

  it('needs a positive amount', () => {
    expect(validateEntry({ ...base, amountText: '' })).toMatchObject({ ok: false, errors: { amount: 'Enter an amount' } })
    expect(validateEntry({ ...base, amountText: '0' })).toMatchObject({
      ok: false,
      errors: { amount: 'Amount must be more than zero' },
    })
    expect(validateEntry({ ...base, amountText: '1.234' })).toMatchObject({ errors: { amount: 'Use at most 2 decimal places (paise)' } })
    expect(validateEntry({ ...base, amountText: '-5' }).ok).toBe(false)
  })

  it('reports an account that is no longer available instead of swapping it', () => {
    const context = { availableAccountIds: new Set(['acc-2']) }
    expect(validateEntry(base, context)).toMatchObject({ errors: { account: 'That account is no longer available — choose another' } })
    expect(validateEntry({ ...base, accountId: 'acc-2' }, context).ok).toBe(true)
  })

  it('trims an optional merchant and limits its length', () => {
    const ok = validateEntry({ ...base, merchant: '  Blue Tokai ' })
    expect(ok.ok && ok.value.merchant).toBe('Blue Tokai')
    expect(validateEntry({ ...base, merchant: 'm'.repeat(121) }).ok).toBe(false)
    const transfer = validateEntry({ ...base, kind: 'transfer', destinationAccountId: 'acc-2', merchant: 'ignored' })
    expect(transfer.ok && transfer.value.merchant).toBeNull()
  })

  it('needs an account', () => {
    expect(validateEntry({ ...base, accountId: null })).toMatchObject({ errors: { account: 'Choose an account' } })
  })

  it('needs two different accounts for a transfer', () => {
    const transfer = { ...base, kind: 'transfer' as const }
    expect(validateEntry(transfer)).toMatchObject({ errors: { destination: 'Choose a destination account' } })
    expect(validateEntry({ ...transfer, destinationAccountId: 'acc-1' })).toMatchObject({
      errors: { destination: 'Pick two different accounts' },
    })
    const ok = validateEntry({ ...transfer, destinationAccountId: 'acc-2' })
    expect(ok.ok).toBe(true)
    // Transfers never carry a category.
    if (ok.ok) expect(ok.value.categoryId).toBeNull()
  })

  it('allows an uncategorised entry', () => {
    expect(validateEntry({ ...base, categoryId: null }).ok).toBe(true)
  })
})
