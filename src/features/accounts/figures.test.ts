import { describe, expect, it } from 'vitest'
import { breakdownRows, describeBalance, describeCredit } from './figures'

const base = {
  opening_balance_minor: 0,
  income_minor: 0,
  expense_minor: 0,
  refunds_minor: 0,
  reversed_income_minor: 0,
  transfers_in_minor: 0,
  transfers_out_minor: 0,
}

describe('describeBalance', () => {
  it('reads a card as what is owed, never as cash', () => {
    expect(describeBalance({ type: 'credit_card', balance_minor: -15000 })).toEqual({ label: 'Owed', amount: '₹150', spoken: 'Owed ₹150' })
    expect(describeBalance({ type: 'credit_card', balance_minor: 2500 })).toEqual({
      label: 'In credit',
      amount: '₹25',
      spoken: 'In credit by ₹25',
    })
    expect(describeBalance({ type: 'credit_card', balance_minor: 0 }).label).toBe('Nothing owed')
  })

  it('keeps an overdraft’s minus sign on screen and says it in words', () => {
    expect(describeBalance({ type: 'bank', balance_minor: -50000 })).toEqual({
      label: 'Overdrawn',
      amount: '−₹500',
      spoken: 'Overdrawn by ₹500',
    })
    expect(describeBalance({ type: 'wallet', balance_minor: 12345 })).toEqual({ label: 'Balance', amount: '₹123.45', spoken: 'Balance ₹123.45' })
  })
})

describe('describeCredit', () => {
  it('estimates available credit only for cards with a limit', () => {
    expect(describeCredit({ type: 'credit_card', balance_minor: -1_200_000, credit_limit_minor: 5_000_000 })).toEqual({
      limit: '₹50,000',
      remaining: { label: 'Available', amount: '~₹38,000', overLimit: false },
      spoken: 'Limit ₹50,000. About ₹38,000 available, an estimate',
    })
    expect(describeCredit({ type: 'credit_card', balance_minor: -1_200_000, credit_limit_minor: null })).toBeNull()
    expect(describeCredit({ type: 'bank', balance_minor: 100, credit_limit_minor: null })).toBeNull()
  })

  it('says when a card is over its limit, in words', () => {
    const credit = describeCredit({ type: 'credit_card', balance_minor: -5_200_000, credit_limit_minor: 5_000_000 })
    expect(credit?.remaining).toEqual({ label: 'Over limit by', amount: '₹2,000', overLimit: true })
    expect(credit?.spoken).toBe('Limit ₹50,000. Over the limit by ₹2,000')
  })

  it('a card in credit has its whole limit available', () => {
    expect(describeCredit({ type: 'credit_card', balance_minor: 1000, credit_limit_minor: 100_000 })?.remaining.amount).toBe('~₹1,000')
  })
})

describe('breakdownRows', () => {
  it('lists the ledger formula in order, adding refunds and reversed income only when present', () => {
    expect(breakdownRows(base).map((r) => r.key)).toEqual(['opening', 'income', 'expenses', 'transfers_in', 'transfers_out'])
    const rows = breakdownRows({ ...base, refunds_minor: 500, reversed_income_minor: 200 })
    expect(rows.map((r) => [r.sign, r.label])).toEqual([
      ['', 'Opening'],
      ['+', 'Income'],
      ['−', 'Expenses'],
      ['+', 'Refunds & reversed purchases'],
      ['−', 'Reversed income'],
      ['+', 'Transfers in'],
      ['−', 'Transfers out'],
    ])
  })

  it('adds up to the balance the view derives', () => {
    // A card: owed ₹1,000 at the start, ₹500 spent, ₹100 refunded, ₹800 paid from the bank.
    const card = { ...base, opening_balance_minor: -100_000, expense_minor: 50_000, refunds_minor: 10_000, transfers_in_minor: 80_000 }
    const total = breakdownRows(card).reduce((sum, row) => sum + (row.sign === '−' ? -row.minor : row.minor), 0)
    expect(total).toBe(-60_000)
  })
})
