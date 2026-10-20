import { describe, expect, it } from 'vitest'
import type { AccountBalanceRow, LedgerEntryRow } from '@/data/database.types'
import { accountsCsv, transactionsCsv } from './exports'

const entry = (patch: Partial<LedgerEntryRow>): LedgerEntryRow => ({
  id: 'e1',
  user_id: 'u1',
  kind: 'expense',
  account_id: 'bank',
  counter_account_id: null,
  category_id: 'food',
  amount_minor: 125_050,
  currency: 'INR',
  occurred_at: '2026-10-17T06:30:00.000Z',
  note: 'Dinner',
  merchant: null,
  status: 'posted',
  source_type: 'manual',
  created_via: 'quick_add',
  related_transaction_id: null,
  base_type: 'expense',
  source_confidence: null,
  voided_from: null,
  created_at: '',
  updated_at: '',
  ...patch,
})

const lookups = {
  accountsById: new Map([
    ['bank', { name: 'Savings' }],
    ['card', { name: 'Amex' }],
  ]),
  categoriesById: new Map([['food', { name: 'Food & dining' }]]),
  timeZone: 'Asia/Kolkata',
}

describe('transactionsCsv', () => {
  it('keeps the original columns in order and appends status, source and refund_of', () => {
    const { headers } = transactionsCsv([], lookups)
    expect(headers.join(',')).toBe(
      'date,time,type,amount,currency,account,category,transfer_from,transfer_to,merchant,note,id,status,source,refund_of',
    )
  })

  it('writes the existing columns as before and the new ones after id', () => {
    const { rows } = transactionsCsv(
      [
        entry({}),
        entry({ id: 'r1', kind: 'refund', amount_minor: 20_000, note: null, merchant: 'Myntra', related_transaction_id: 'e1', source_type: 'email', status: 'pending' }),
        entry({ id: 't1', kind: 'transfer', account_id: 'bank', counter_account_id: 'card', category_id: null, note: null, base_type: null, status: 'voided' }),
      ],
      lookups,
    )
    expect(rows[0]).toEqual(['2026-10-17', '12:00', 'expense', '1250.50', 'INR', 'Savings', 'Food & dining', '', '', '', 'Dinner', 'e1', 'posted', 'manual', ''])
    expect(rows[1].slice(2, 4)).toEqual(['refund', '200.00'])
    expect(rows[1].slice(-4)).toEqual(['r1', 'pending', 'email', 'e1'])
    expect(rows[2].slice(5, 9)).toEqual(['', '', 'Savings', 'Amex'])
    expect(rows[2].slice(-3)).toEqual(['voided', 'manual', ''])
  })
})

describe('accountsCsv', () => {
  const account: AccountBalanceRow = {
    id: 'card',
    user_id: 'u1',
    name: 'Amex',
    type: 'credit_card',
    currency: 'INR',
    color: 'purple',
    status: 'active',
    sort_order: 0,
    opening_balance_minor: -500_00,
    opening_date: '2026-10-01',
    income_minor: 0,
    expense_minor: 1_500_00,
    transfers_in_minor: 1_000_00,
    transfers_out_minor: 0,
    balance_minor: -900_00,
    institution_name: 'American Express',
    credit_limit_minor: 50_000_00,
    refunds_minor: 100_00,
    reversed_income_minor: 0,
    pending_minor: -250_00,
    review_count: 0,
    outstanding_minor: 900_00,
    available_credit_minor: 49_100_00,
  }

  it('keeps the original columns in order and appends the Phase 1 ones after id', () => {
    const { headers, rows } = accountsCsv([account, { ...account, id: 'cash', type: 'cash', institution_name: null, credit_limit_minor: null }])
    expect(headers.join(',')).toBe(
      'name,type,status,currency,opening_balance,opening_date,income,expenses,transfers_in,transfers_out,balance,id,institution,credit_limit,refunds,reversed_income,pending',
    )
    expect(rows[0]).toEqual([
      'Amex',
      'credit_card',
      'active',
      'INR',
      '-500.00',
      '2026-10-01',
      '0.00',
      '1500.00',
      '1000.00',
      '0.00',
      '-900.00',
      'card',
      'American Express',
      '50000.00',
      '100.00',
      '0.00',
      '-250.00',
    ])
    expect(rows[1].slice(12, 14)).toEqual(['', ''])
  })
})
