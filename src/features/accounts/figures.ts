// How an account's numbers read on screen and aloud. The sums themselves come
// from the account_balances view and src/lib/ledger.ts (cardFigures); this
// module only words them, so a card is never shown as ordinary cash and an
// estimate is always labelled as one. See docs/ledger-model.md "Balances".

import type { AccountBalanceRow } from '@/data/database.types'
import { cardFigures, isLiability } from '@/lib/ledger'
import { formatMoney } from '@/lib/money'

export interface BalanceWording {
  /** "Owed", "In credit", "Nothing owed", "Overdrawn" or "Balance". */
  label: string
  /** What to show; overdrafts keep their minus sign. */
  amount: string
  /** A full phrase for aria-labels, e.g. "Overdrawn by ₹500". */
  spoken: string
}

/** How to read an account's balance; credit cards show what is owed. */
export function describeBalance(account: Pick<AccountBalanceRow, 'type' | 'balance_minor'>): BalanceWording {
  const { type, balance_minor: balance } = account
  if (isLiability(type)) {
    const { outstandingMinor, inCreditMinor } = cardFigures({ balance_minor: balance, credit_limit_minor: null })
    if (outstandingMinor > 0) return { label: 'Owed', amount: formatMoney(outstandingMinor), spoken: `Owed ${formatMoney(outstandingMinor)}` }
    if (inCreditMinor > 0) return { label: 'In credit', amount: formatMoney(inCreditMinor), spoken: `In credit by ${formatMoney(inCreditMinor)}` }
    return { label: 'Nothing owed', amount: formatMoney(0), spoken: 'Nothing owed' }
  }
  if (balance < 0) return { label: 'Overdrawn', amount: formatMoney(balance), spoken: `Overdrawn by ${formatMoney(-balance)}` }
  return { label: 'Balance', amount: formatMoney(balance), spoken: `Balance ${formatMoney(balance)}` }
}

export interface CreditWording {
  limit: string
  /** Available credit, or how far over the limit the card is. */
  remaining: { label: 'Available' | 'Over limit by'; amount: string; overLimit: boolean }
  spoken: string
}

/**
 * A card's limit and what's left of it, or null when it isn't a card or has
 * no limit. Available is an estimate: limit minus what Friday knows is owed —
 * the bank's figure can differ (holds, fees, interest it hasn't seen).
 */
export function describeCredit(
  account: Pick<AccountBalanceRow, 'type' | 'balance_minor' | 'credit_limit_minor'>,
): CreditWording | null {
  if (!isLiability(account.type)) return null
  const { limitMinor, availableMinor } = cardFigures(account)
  if (limitMinor === null || availableMinor === null) return null
  const limit = formatMoney(limitMinor)
  if (availableMinor < 0) {
    const over = formatMoney(-availableMinor)
    return {
      limit,
      remaining: { label: 'Over limit by', amount: over, overLimit: true },
      spoken: `Limit ${limit}. Over the limit by ${over}`,
    }
  }
  const available = formatMoney(availableMinor)
  return {
    limit,
    remaining: { label: 'Available', amount: `~${available}`, overLimit: false },
    spoken: `Limit ${limit}. About ${available} available, an estimate`,
  }
}

export interface BreakdownRow {
  key: 'opening' | 'income' | 'expenses' | 'refunds' | 'reversed_income' | 'transfers_in' | 'transfers_out'
  label: string
  /** '' for the opening balance, which keeps its own sign. */
  sign: '' | '+' | '−'
  minor: number
}

/**
 * The lines that add up to an account's balance, in the order of the ledger
 * formula. Refunds and reversed income only appear when there are any.
 */
export function breakdownRows(
  account: Pick<
    AccountBalanceRow,
    | 'opening_balance_minor'
    | 'income_minor'
    | 'expense_minor'
    | 'refunds_minor'
    | 'reversed_income_minor'
    | 'transfers_in_minor'
    | 'transfers_out_minor'
  >,
  openingLabel = 'Opening',
): BreakdownRow[] {
  const rows: BreakdownRow[] = [
    { key: 'opening', label: openingLabel, sign: '', minor: account.opening_balance_minor },
    { key: 'income', label: 'Income', sign: '+', minor: account.income_minor },
    { key: 'expenses', label: 'Expenses', sign: '−', minor: account.expense_minor },
  ]
  if (account.refunds_minor) rows.push({ key: 'refunds', label: 'Refunds & reversed purchases', sign: '+', minor: account.refunds_minor })
  if (account.reversed_income_minor) {
    rows.push({ key: 'reversed_income', label: 'Reversed income', sign: '−', minor: account.reversed_income_minor })
  }
  rows.push(
    { key: 'transfers_in', label: 'Transfers in', sign: '+', minor: account.transfers_in_minor },
    { key: 'transfers_out', label: 'Transfers out', sign: '−', minor: account.transfers_out_minor },
  )
  return rows
}
