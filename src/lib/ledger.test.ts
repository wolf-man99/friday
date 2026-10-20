import { describe, expect, it } from 'vitest'
import {
  balanceEffect,
  balanceSummary,
  canChangeStatus,
  restoreTarget,
  cardFigures,
  directionOf,
  groupAccounts,
  incomeEffect,
  isCounted,
  offsetActions,
  remainingToOffset,
  spendingEffect,
} from './ledger'

const entry = (kind: Parameters<typeof directionOf>[0]['kind'], amount: number, base_type: 'income' | 'expense' | null = null) => ({
  kind,
  amount_minor: amount,
  base_type,
})

describe('entry effects', () => {
  it('a purchase lowers the balance and counts as spending once', () => {
    const e = entry('expense', 15000, 'expense')
    expect(balanceEffect(e)).toBe(-15000)
    expect(spendingEffect(e)).toBe(15000)
    expect(incomeEffect(e)).toBe(0)
  })

  it('income raises the balance and income, never spending', () => {
    const e = entry('income', 500000, 'income')
    expect(balanceEffect(e)).toBe(500000)
    expect(incomeEffect(e)).toBe(500000)
    expect(spendingEffect(e)).toBe(0)
  })

  it('a refund returns money and reduces spending, never income', () => {
    const e = entry('refund', 5000, 'expense')
    expect(directionOf(e)).toBe('in')
    expect(balanceEffect(e)).toBe(5000)
    expect(spendingEffect(e)).toBe(-5000)
    expect(incomeEffect(e)).toBe(0)
  })

  it('a reversed purchase nets the purchase to zero', () => {
    const purchase = entry('expense', 15000, 'expense')
    const reversal = entry('reversal', 15000, 'expense')
    expect(balanceEffect(purchase) + balanceEffect(reversal)).toBe(0)
    expect(spendingEffect(purchase) + spendingEffect(reversal)).toBe(0)
  })

  it('reversed income takes money back and reduces income', () => {
    const e = entry('reversal', 20000, 'income')
    expect(directionOf(e)).toBe('out')
    expect(balanceEffect(e)).toBe(-20000)
    expect(incomeEffect(e)).toBe(-20000)
    expect(spendingEffect(e)).toBe(0)
  })

  it('transfers move money without touching income or spending', () => {
    const e = entry('transfer', 15000)
    expect(directionOf(e)).toBe('move')
    expect(spendingEffect(e)).toBe(0)
    expect(incomeEffect(e)).toBe(0)
  })
})

describe('status rules', () => {
  it('only posted and pending entries count', () => {
    expect(isCounted('posted')).toBe(true)
    expect(isCounted('pending')).toBe(true)
    expect(isCounted('needs_review')).toBe(false)
    expect(isCounted('voided')).toBe(false)
  })

  it('mirrors the database transitions', () => {
    expect(canChangeStatus('pending', 'posted')).toBe(true)
    expect(canChangeStatus('pending', 'voided')).toBe(true)
    expect(canChangeStatus('posted', 'voided')).toBe(true)
    expect(canChangeStatus('voided', 'posted')).toBe(true)
    expect(canChangeStatus('needs_review', 'posted')).toBe(true)
    expect(canChangeStatus('posted', 'pending')).toBe(false)
    expect(canChangeStatus('posted', 'needs_review')).toBe(false)
  })

  it('restores a voided entry to the status it had before', () => {
    expect(restoreTarget({ status: 'voided', voided_from: 'pending' })).toBe('pending')
    expect(restoreTarget({ status: 'voided', voided_from: null })).toBe('posted')
    expect(canChangeStatus('voided', 'pending', 'pending')).toBe(true)
    expect(canChangeStatus('voided', 'posted', 'pending')).toBe(false)
    expect(canChangeStatus('voided', 'posted', 'needs_review')).toBe(false)
  })

  it('offers refunds for posted purchases and reversals for posted income', () => {
    expect(offsetActions({ kind: 'expense', status: 'posted' })).toEqual(['refund', 'reversal'])
    expect(offsetActions({ kind: 'income', status: 'posted' })).toEqual(['reversal'])
    expect(offsetActions({ kind: 'expense', status: 'pending' })).toEqual([])
    expect(offsetActions({ kind: 'refund', status: 'posted' })).toEqual([])
    expect(offsetActions({ kind: 'transfer', status: 'posted' })).toEqual([])
  })

  it('caps refunds at what is left, ignoring voided ones', () => {
    expect(
      remainingToOffset({ amount_minor: 15000 }, [
        { amount_minor: 5000, status: 'posted' },
        { amount_minor: 9000, status: 'voided' },
      ]),
    ).toBe(10000)
    expect(remainingToOffset({ amount_minor: 15000 }, [{ amount_minor: 15000, status: 'pending' }])).toBe(0)
  })
})

describe('accounts', () => {
  it('splits a card into what is owed, the limit and what is available', () => {
    expect(cardFigures({ balance_minor: -15000, credit_limit_minor: 5000000 })).toEqual({
      outstandingMinor: 15000,
      inCreditMinor: 0,
      limitMinor: 5000000,
      availableMinor: 4985000,
    })
    expect(cardFigures({ balance_minor: 2000, credit_limit_minor: null })).toEqual({
      outstandingMinor: 0,
      inCreditMinor: 2000,
      limitMinor: null,
      availableMinor: null,
    })
  })

  it('never adds card debt into available money', () => {
    const base = { pending_minor: 0, review_count: 0 }
    const summary = balanceSummary([
      { ...base, type: 'bank', status: 'active', balance_minor: 100000 },
      { ...base, type: 'wallet', status: 'active', balance_minor: 5000 },
      { ...base, type: 'credit_card', status: 'active', balance_minor: -15000 },
      { ...base, type: 'credit_card', status: 'active', balance_minor: 3000 },
      { ...base, type: 'cash', status: 'archived', balance_minor: 999 },
    ])
    expect(summary.availableMinor).toBe(105000)
    expect(summary.cardDuesMinor).toBe(15000)
    expect(summary.netMinor).toBe(90000)
    expect(summary.assetAccounts).toBe(2)
    expect(summary.cardAccounts).toBe(2)
  })

  it('groups accounts by type in a fixed order, skipping empty groups', () => {
    const groups = groupAccounts([{ type: 'cash' }, { type: 'bank' }, { type: 'credit_card' }])
    expect(groups.map((g) => g.title)).toEqual(['Bank accounts', 'Credit cards', 'Cash'])
  })
})
