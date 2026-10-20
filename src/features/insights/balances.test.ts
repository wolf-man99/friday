import { describe, expect, it } from 'vitest'
import type { AccountBalanceRow } from '@/data/database.types'
import { homeBalances, pendingNotes } from './balances'

type Fields = Pick<AccountBalanceRow, 'type' | 'status' | 'balance_minor' | 'pending_minor' | 'review_count'>
const acct = (type: AccountBalanceRow['type'], balance_minor: number, patch: Partial<Fields> = {}): Fields => ({
  type,
  status: 'active',
  balance_minor,
  pending_minor: 0,
  review_count: 0,
  ...patch,
})

describe('homeBalances', () => {
  it('keeps card dues out of available money and labels the net separately', () => {
    const b = homeBalances([
      acct('bank', 1_000_000),
      acct('wallet', 50_000),
      acct('cash', 30_000),
      acct('credit_card', -1_200_000),
      // An overpaid card is not cash.
      acct('credit_card', 20_000),
      acct('bank', 999_900, { status: 'archived' }),
    ])
    expect(b.availableMinor).toBe(1_080_000)
    expect(b.cardDuesMinor).toBe(1_200_000)
    expect(b.netMinor).toBe(-120_000)
    expect(b.assetAccounts).toBe(3)
    expect(b.cardAccounts).toBe(2)
  })

  it('splits pending between available money and card dues', () => {
    const b = homeBalances([
      acct('bank', 100_000, { pending_minor: -5_000 }),
      acct('credit_card', -30_000, { pending_minor: -12_000 }),
      acct('wallet', 1_000, { pending_minor: -1_000, status: 'archived' }),
    ])
    expect(b.availablePendingMinor).toBe(-5_000)
    expect(b.cardPendingMinor).toBe(-12_000)
  })
})

describe('pendingNotes', () => {
  it('says nothing when nothing is pending', () => {
    expect(pendingNotes({ availablePendingMinor: 0, cardPendingMinor: 0 })).toEqual([])
  })

  it('says which figure already includes the pending amount', () => {
    expect(pendingNotes({ availablePendingMinor: -5_000, cardPendingMinor: -12_000 })).toEqual([
      '₹50 going out is still pending — already taken off available money.',
      '₹120 of card spending is still pending — already in card dues.',
    ])
    expect(pendingNotes({ availablePendingMinor: 20_000, cardPendingMinor: 3_000 })).toEqual([
      '₹200 coming in is still pending — already in available money.',
      '₹30 paid or refunded to cards is still pending — already off card dues.',
    ])
  })
})
