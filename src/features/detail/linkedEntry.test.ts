import { describe, expect, it } from 'vitest'
import { overLimitMessage, validateLinkedEntry, type LinkedDraft } from './linkedEntry'

const draft = (patch: Partial<LinkedDraft> = {}): LinkedDraft => ({
  amountText: '500',
  accountId: 'bank',
  date: '2026-10-18',
  note: '',
  ...patch,
})

const limits = { kind: 'refund' as const, maxMinor: 150000, usableAccountIds: new Set(['bank', 'card']) }

describe('validateLinkedEntry', () => {
  it('accepts a partial refund up to what is left', () => {
    expect(validateLinkedEntry(draft({ amountText: '1,500', note: '  Returned  ' }), limits)).toEqual({
      ok: true,
      value: { amountMinor: 150000, accountId: 'bank', date: '2026-10-18', note: 'Returned' },
    })
  })

  it('blocks more than what is left on the original', () => {
    const result = validateLinkedEntry(draft({ amountText: '1500.01' }), limits)
    expect(result).toEqual({ ok: false, errors: { amount: 'Only ₹1,500 is left to refund — enter that or less' } })
  })

  it('says so when nothing is left', () => {
    expect(overLimitMessage('reversal', 100, 0)).toBe('Nothing is left to reverse on this entry')
    expect(overLimitMessage('refund', 100, null)).toBeNull()
  })

  it('explains invalid amounts like Quick Add does', () => {
    expect(validateLinkedEntry(draft({ amountText: '' }), limits)).toMatchObject({
      ok: false,
      errors: { amount: 'Enter an amount' },
    })
    expect(validateLinkedEntry(draft({ amountText: '-5' }), limits)).toMatchObject({
      ok: false,
      errors: { amount: expect.stringMatching(/always positive/) },
    })
    expect(validateLinkedEntry(draft({ amountText: '1.234' }), limits)).toMatchObject({
      ok: false,
      errors: { amount: expect.stringMatching(/2 decimal/) },
    })
  })

  it('needs a usable account', () => {
    expect(validateLinkedEntry(draft({ accountId: null }), limits)).toMatchObject({
      ok: false,
      errors: { account: expect.any(String) },
    })
    expect(validateLinkedEntry(draft({ accountId: 'old' }), limits)).toMatchObject({
      ok: false,
      errors: { account: 'That account is archived — choose another' },
    })
    expect(validateLinkedEntry(draft({ accountId: 'old' }), { ...limits, kind: 'reversal' })).toMatchObject({
      ok: false,
      errors: { account: expect.stringMatching(/stays on the original’s account/) },
    })
  })

  it('checks the date and note length', () => {
    expect(validateLinkedEntry(draft({ date: '' }), limits)).toMatchObject({ ok: false, errors: { date: 'Pick a date' } })
    expect(validateLinkedEntry(draft({ note: 'x'.repeat(501) }), limits)).toMatchObject({
      ok: false,
      errors: { note: expect.any(String) },
    })
  })
})
