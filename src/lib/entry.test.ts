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
    expect(validateEntry({ ...base, amountText: '1.234' }).ok).toBe(false)
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
