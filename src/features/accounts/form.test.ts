import { describe, expect, it } from 'vitest'
import { accountFormText, accountValues, type AccountFormInput } from './form'

const input = (patch: Partial<AccountFormInput> = {}): AccountFormInput => ({
  type: 'bank',
  name: 'SBI Savings',
  color: 'sky',
  institution: '',
  openingText: '',
  openingNegative: false,
  openingDate: '2026-10-01',
  creditLimitText: '',
  ...patch,
})

describe('accountValues', () => {
  it('saves blanks as null and a blank opening balance as 0', () => {
    expect(accountValues(input())).toEqual({
      values: {
        name: 'SBI Savings',
        type: 'bank',
        color: 'sky',
        opening_balance_minor: 0,
        opening_date: '2026-10-01',
        institution_name: null,
        credit_limit_minor: null,
      },
    })
    expect(Object.is(accountValues(input({ type: 'credit_card' })).values?.opening_balance_minor, 0)).toBe(true)
  })

  it('stores what a card owed as a negative opening balance', () => {
    expect(accountValues(input({ type: 'credit_card', openingText: '1,500' })).values?.opening_balance_minor).toBe(-150000)
    expect(accountValues(input({ type: 'credit_card', openingText: '200', openingNegative: true })).values?.opening_balance_minor).toBe(20000)
    expect(accountValues(input({ openingText: '200', openingNegative: true })).values?.opening_balance_minor).toBe(-20000)
  })

  it('trims the institution and caps it at 60 characters', () => {
    expect(accountValues(input({ institution: '  HDFC Bank ' })).values?.institution_name).toBe('HDFC Bank')
    expect(accountValues(input({ institution: '   ' })).values?.institution_name).toBeNull()
    expect(accountValues(input({ institution: 'x'.repeat(61) })).errors?.institution).toMatch(/60 characters/)
  })

  it('parses a card’s credit limit and rejects zero, negatives and extra decimals', () => {
    expect(accountValues(input({ type: 'credit_card', creditLimitText: '1,00,000.50' })).values?.credit_limit_minor).toBe(10_000_050)
    expect(accountValues(input({ type: 'credit_card', creditLimitText: '0' })).errors?.creditLimit).toMatch(/more than zero/)
    expect(accountValues(input({ type: 'credit_card', creditLimitText: '-500' })).errors?.creditLimit).toMatch(/negative/)
    expect(accountValues(input({ type: 'credit_card', creditLimitText: '10.505' })).errors?.creditLimit).toMatch(/2 decimal/)
    expect(accountValues(input({ type: 'credit_card', creditLimitText: 'abc' })).errors?.creditLimit).toBeDefined()
  })

  it('never sends a limit for anything but a card', () => {
    expect(accountValues(input({ type: 'wallet', creditLimitText: '5000' })).values?.credit_limit_minor).toBeNull()
  })

  it('reports a missing name and a bad opening balance together', () => {
    expect(accountValues(input({ name: ' ', openingText: '12.345' })).errors).toEqual({
      name: 'Give this account a name',
      opening: 'Use numbers only, with up to 2 decimals',
    })
  })
})

describe('accountFormText', () => {
  it('shows a card’s stored negative opening balance as the amount owed', () => {
    expect(
      accountFormText({ type: 'credit_card', opening_balance_minor: -150000, institution_name: 'HDFC Bank', credit_limit_minor: 10_000_000 }),
    ).toEqual({ openingText: '1,500', openingNegative: false, institution: 'HDFC Bank', creditLimitText: '1,00,000' })
    expect(accountFormText({ type: 'bank', opening_balance_minor: -2500, institution_name: null, credit_limit_minor: null })).toEqual({
      openingText: '25',
      openingNegative: true,
      institution: '',
      creditLimitText: '',
    })
  })
})
