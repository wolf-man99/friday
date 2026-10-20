// The dashboard's balance summary: available money and card dues side by
// side, never silently netted, plus where pending entries sit. The sums come
// from balanceSummary() in src/lib/ledger.ts; this module adds the pending
// split and the words. See docs/ledger-model.md "Credit cards".

import type { AccountBalanceRow } from '@/data/database.types'
import { balanceSummary, isLiability, type BalanceSummary } from '@/lib/ledger'
import { formatMoney } from '@/lib/money'

type BalanceFields = Pick<AccountBalanceRow, 'type' | 'status' | 'balance_minor' | 'pending_minor' | 'review_count'>

export interface HomeBalances extends BalanceSummary {
  /** Pending part of available money: negative while payments out are still settling. */
  availablePendingMinor: number
  /** Pending part of card balances: negative while card spending is still settling. */
  cardPendingMinor: number
}

export function homeBalances(accounts: BalanceFields[]): HomeBalances {
  const summary = balanceSummary(accounts)
  return {
    ...summary,
    availablePendingMinor: balanceSummary(accounts.filter((a) => !isLiability(a.type))).pendingMinor,
    cardPendingMinor: balanceSummary(accounts.filter((a) => isLiability(a.type))).pendingMinor,
  }
}

/** One line per side that has pending entries, saying they're already counted. */
export function pendingNotes(balances: Pick<HomeBalances, 'availablePendingMinor' | 'cardPendingMinor'>): string[] {
  const notes: string[] = []
  const { availablePendingMinor: cash, cardPendingMinor: card } = balances
  if (cash < 0) notes.push(`${formatMoney(-cash)} going out is still pending — already taken off available money.`)
  if (cash > 0) notes.push(`${formatMoney(cash)} coming in is still pending — already in available money.`)
  if (card < 0) notes.push(`${formatMoney(-card)} of card spending is still pending — already in card dues.`)
  if (card > 0) notes.push(`${formatMoney(card)} paid or refunded to cards is still pending — already off card dues.`)
  return notes
}
