import { describe, expect, it } from 'vitest'
import type { AccountBalanceRow } from '@/data/database.types'
import type { DiscoveredAccount } from '@/data/gmail'
import { parseAmountToMinor } from '@/lib/money'
import { compatibleAccounts, defaultChoice, groupKey, importMonths, instrumentLabel, leftOut, monthsLabel, toDecisions } from './plan'

const account = (id: string, type: AccountBalanceRow['type'], status: AccountBalanceRow['status'] = 'active') =>
  ({ id, type, status, name: id, opening_date: '2026-10-10' }) as AccountBalanceRow

const group = (patch: Partial<DiscoveredAccount> = {}): DiscoveredAccount => ({
  institutionKey: 'hdfc',
  institutionName: 'HDFC Bank',
  instrument: 'bank',
  accountMask: '1234',
  messages: 3,
  firstAt: '2026-08-03T04:30:00Z',
  lastAt: '2026-10-18T04:30:00Z',
  linkedAccountId: null,
  linkedIgnored: false,
  suggestedAccountId: null,
  suggestedName: 'HDFC Bank ••1234',
  suggestedType: 'bank',
  ...patch,
})

describe('months offered', () => {
  it('is this month (to today) and the two before it', () => {
    expect(importMonths('2026-10-20')).toEqual([
      { value: '2026-10', label: 'October 2026 (to today)' },
      { value: '2026-09', label: 'September 2026' },
      { value: '2026-08', label: 'August 2026' },
    ])
    expect(importMonths('2026-01-05').map((m) => m.value)).toEqual(['2026-01', '2025-12', '2025-11'])
  })

  it('moves on with the calendar: in November, November to date, October and September', () => {
    expect(importMonths('2026-11-03').map((m) => m.label)).toEqual(['November 2026 (to today)', 'October 2026', 'September 2026'])
    expect(importMonths('2026-12-31').map((m) => m.label)).toEqual(['December 2026 (to today)', 'November 2026', 'October 2026'])
    expect(importMonths('2027-02-28').map((m) => m.value)).toEqual(['2027-02', '2027-01', '2026-12'])
  })

  it('names chosen months in order', () => {
    expect(monthsLabel(['2026-10', '2026-08'])).toBe('August, October')
  })
})

describe('what Friday suggests for each account', () => {
  const accounts = [account('hdfc-savings', 'bank'), account('amex', 'credit_card'), account('old', 'bank', 'archived')]

  it('links to the account it is linked to or looks like', () => {
    expect(defaultChoice(group({ suggestedAccountId: 'hdfc-savings' }), accounts)).toMatchObject({ kind: 'link', accountId: 'hdfc-savings' })
    expect(defaultChoice(group({ linkedAccountId: 'hdfc-savings' }), accounts)).toMatchObject({ kind: 'link' })
  })

  it('offers a new account otherwise, and review when it can\'t tell what kind', () => {
    expect(defaultChoice(group(), accounts)).toMatchObject({ kind: 'create', name: 'HDFC Bank ••1234', type: 'bank' })
    expect(defaultChoice(group({ instrument: 'unknown', suggestedType: null, institutionName: 'PhonePe' }), accounts)).toMatchObject({ kind: 'review' })
  })

  it('remembers an account ignored before', () => {
    expect(defaultChoice(group({ linkedIgnored: true }), accounts).kind).toBe('ignore')
  })

  it('never suggests an archived account or one of the wrong kind', () => {
    expect(defaultChoice(group({ suggestedAccountId: 'old' }), accounts).kind).toBe('create')
    expect(defaultChoice(group({ suggestedAccountId: 'amex' }), accounts).kind).toBe('create')
    expect(compatibleAccounts(group({ instrument: 'credit_card' }), accounts).map((a) => a.id)).toEqual(['amex'])
    expect(compatibleAccounts(group({ instrument: 'debit_card' }), accounts).map((a) => a.id)).toEqual(['hdfc-savings'])
  })

  it('labels each kind plainly', () => {
    expect(instrumentLabel(group())).toBe('HDFC Bank account ••1234')
    expect(instrumentLabel(group({ instrument: 'credit_card', institutionName: 'ICICI Bank', accountMask: '9001' }))).toBe('ICICI Bank credit card ••9001')
    expect(instrumentLabel(group({ instrument: 'wallet', institutionName: 'Paytm', accountMask: '' }))).toBe('Paytm wallet')
    expect(instrumentLabel(group({ instrument: 'unknown', institutionName: 'PhonePe', accountMask: '' }))).toBe('PhonePe (no account number)')
  })
})

describe('turning choices into decisions', () => {
  const groups = [group(), group({ institutionKey: 'icici', instrument: 'credit_card', accountMask: '9001' })]
  const base = { accountId: '', name: 'X', type: 'bank' as const, openingText: '' }

  it('sends exactly what was chosen; a card\'s amount owed becomes a negative balance', () => {
    const result = toDecisions(
      groups,
      {
        [groupKey(groups[0])]: { ...base, kind: 'link', accountId: 'hdfc-savings' },
        [groupKey(groups[1])]: { ...base, kind: 'create', name: ' ICICI card ', type: 'credit_card', openingText: '1,500' },
      },
      parseAmountToMinor,
    )
    expect(result).toEqual({
      ok: true,
      decisions: [
        { institutionKey: 'hdfc', instrument: 'bank', accountMask: '1234', action: 'link', accountId: 'hdfc-savings' },
        { institutionKey: 'icici', instrument: 'credit_card', accountMask: '9001', action: 'create', name: 'ICICI card', type: 'credit_card', openingBalanceMinor: -150000 },
      ],
    })
  })

  it('points at the first incomplete choice', () => {
    expect(toDecisions(groups, { [groupKey(groups[0])]: { ...base, kind: 'link' } }, parseAmountToMinor)).toMatchObject({
      ok: false,
      key: 'hdfc/bank/1234',
    })
    expect(
      toDecisions(groups, { [groupKey(groups[0])]: { ...base, kind: 'ignore' }, [groupKey(groups[1])]: { ...base, kind: 'create', name: '  ' } }, parseAmountToMinor),
    ).toMatchObject({ ok: false, key: 'icici/credit_card/9001', message: 'Give the new account a name.' })
  })
})

describe('what an import left out', () => {
  it('says why, largest first, including declined payments and ignored accounts', () => {
    expect(leftOut({ skip_reasons: { otp: 2, promotion: 9, no_amount: 1, mystery: 1 }, declined: 1, ignored: 3 })).toEqual([
      { label: 'Offers and promotions', count: 9 },
      { label: 'OTPs', count: 2 },
      { label: 'Other emails with no amount', count: 1 },
      { label: 'Other emails that aren’t transactions', count: 1 },
      { label: 'Declined or failed payments (no money moved)', count: 1 },
      { label: 'From accounts you chose to ignore', count: 3 },
    ])
    expect(leftOut({ skip_reasons: {}, declined: 0, ignored: 0 })).toEqual([])
  })
})
