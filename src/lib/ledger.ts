// The ledger's accounting rules, client side. The database enforces them
// (supabase/migrations/20261020000000_ledger_model.sql); this module only
// mirrors them for display so screens never re-derive signs or totals ad hoc.
// See docs/ledger-model.md.

import type {
  AccountBalanceRow,
  AccountType,
  EntryKind,
  EntryStatus,
  ImportSourceType,
  ReviewReason,
  SourceType,
  TransactionType,
} from '@/data/database.types'

/** Statuses that move balances and insights. */
export const COUNTED_STATUSES: readonly EntryStatus[] = ['posted', 'pending']

export function isCounted(status: EntryStatus): boolean {
  return status === 'posted' || status === 'pending'
}

export const KIND_LABEL: Record<EntryKind, string> = {
  expense: 'Expense',
  income: 'Income',
  refund: 'Refund',
  reversal: 'Reversal',
  transfer: 'Transfer',
}

export const STATUS_LABEL: Record<EntryStatus, string> = {
  posted: 'Posted',
  pending: 'Pending',
  needs_review: 'Needs review',
  voided: 'Voided',
}

/** One line on what a status means for the numbers. */
export const STATUS_EXPLAINER: Record<EntryStatus, string> = {
  posted: 'Settled. Counted in balances and insights.',
  pending: 'Not settled yet. Already counted in balances and insights, and marked pending.',
  needs_review: 'Not counted in balances or insights until you confirm it.',
  voided: 'Cancelled. Kept for the record, not counted anywhere.',
}

export const SOURCE_LABEL: Record<SourceType, string> = {
  manual: 'Entered by you',
  email: 'From an email',
  bank_import: 'Bank import',
  wallet_import: 'Wallet import',
  other_import: 'Import',
}

export const IMPORT_SOURCE_SHORT: Record<ImportSourceType, string> = {
  email: 'Email',
  bank_import: 'Bank',
  wallet_import: 'Wallet',
  other_import: 'Import',
}

export const REVIEW_REASON_TEXT: Record<ReviewReason, string> = {
  missing_details: 'Some details couldn’t be read — check the amount, type and date.',
  unsupported_currency: 'It isn’t in rupees. Friday only tracks INR for now.',
  unknown_account: 'Friday couldn’t tell which account this was.',
  needs_link: 'Refunds and reversals need the original purchase picked first.',
  low_confidence: 'Friday wasn’t sure enough to record it on its own.',
  possible_duplicate: 'It looks a lot like an entry you already have — maybe the same purchase.',
  linked_entry_removed: 'It’s about an entry that was deleted or voided.',
  possible_transfer: 'Money arriving on a card is usually a bill payment — record it as a transfer.',
  settlement_differs: 'It settled for a different amount than the pending entry.',
  before_tracking_start: 'It’s dated before you started tracking this account, so it’s probably already in the opening balance.',
}

/**
 * Allowed status changes; mirrors ledger_status_change_allowed() in SQL.
 * A voided entry can only be restored to the status it had before
 * (restoreTarget) — the database enforces that too.
 */
const STATUS_CHANGES: Record<EntryStatus, readonly EntryStatus[]> = {
  pending: ['posted', 'voided'],
  posted: ['voided'],
  needs_review: ['posted', 'pending', 'voided'],
  voided: ['posted', 'pending', 'needs_review'],
}

export function canChangeStatus(
  from: EntryStatus,
  to: EntryStatus,
  voidedFrom: EntryStatus | null = null,
): boolean {
  if (from === to) return true
  if (from === 'voided') return to === restoreTarget({ status: from, voided_from: voidedFrom })
  return STATUS_CHANGES[from].includes(to)
}

/** Where Restore takes a voided entry. */
export function restoreTarget(entry: { status: EntryStatus; voided_from?: EntryStatus | null }): EntryStatus {
  return entry.voided_from ?? 'posted'
}

export interface EntryShape {
  kind: EntryKind
  /** The side a refund/reversal nets against; null for transfers. */
  base_type?: TransactionType | null
  amount_minor: number
}

export type Direction = 'in' | 'out' | 'move'

/** Which way money moves for the entry's own account. */
export function directionOf(entry: Pick<EntryShape, 'kind' | 'base_type'>): Direction {
  switch (entry.kind) {
    case 'income':
    case 'refund':
      return 'in'
    case 'expense':
      return 'out'
    case 'reversal':
      // A reversed purchase gives money back; reversed income takes it away.
      return entry.base_type === 'income' ? 'out' : 'in'
    case 'transfer':
      return 'move'
  }
}

/** Effect on the entry's account balance, in minor units (transfers: the source side). */
export function balanceEffect(entry: EntryShape): number {
  const direction = directionOf(entry)
  if (direction === 'in') return entry.amount_minor
  return -entry.amount_minor
}

/** Contribution to net spending (expenses minus refunds/reversed purchases). */
export function spendingEffect(entry: EntryShape): number {
  if (entry.kind === 'expense') return entry.amount_minor
  if (entry.kind === 'refund') return -entry.amount_minor
  if (entry.kind === 'reversal' && entry.base_type === 'expense') return -entry.amount_minor
  return 0
}

/** Contribution to net income (income minus reversed income). Refunds are never income. */
export function incomeEffect(entry: EntryShape): number {
  if (entry.kind === 'income') return entry.amount_minor
  if (entry.kind === 'reversal' && entry.base_type === 'income') return -entry.amount_minor
  return 0
}

/** How much of an original can still be refunded or reversed. */
export function remainingToOffset(
  original: { amount_minor: number },
  linked: { amount_minor: number; status: EntryStatus }[],
): number {
  const used = linked.filter((e) => isCounted(e.status)).reduce((sum, e) => sum + e.amount_minor, 0)
  return Math.max(original.amount_minor - used, 0)
}

/** Can this entry get a refund (purchases) or a reversal (income or purchases)? */
export function offsetActions(entry: { kind: EntryKind; status: EntryStatus }): ('refund' | 'reversal')[] {
  if (entry.status !== 'posted') return []
  if (entry.kind === 'expense') return ['refund', 'reversal']
  if (entry.kind === 'income') return ['reversal']
  return []
}

// --- Accounts -------------------------------------------------------------------

export const ACCOUNT_GROUPS: { type: AccountType; title: string }[] = [
  { type: 'bank', title: 'Bank accounts' },
  { type: 'credit_card', title: 'Credit cards' },
  { type: 'wallet', title: 'Wallets' },
  { type: 'cash', title: 'Cash' },
  { type: 'other', title: 'Other' },
]

export function isLiability(type: AccountType): boolean {
  return type === 'credit_card'
}

export interface CardFigures {
  /** What's owed (≥ 0). */
  outstandingMinor: number
  /** Overpaid amount when the card is in credit (≥ 0). */
  inCreditMinor: number
  limitMinor: number | null
  /** limit − outstanding; null without a limit. Negative means over the limit. */
  availableMinor: number | null
}

export function cardFigures(account: Pick<AccountBalanceRow, 'balance_minor' | 'credit_limit_minor'>): CardFigures {
  const outstandingMinor = Math.max(-account.balance_minor, 0)
  const limitMinor = account.credit_limit_minor ?? null
  return {
    outstandingMinor,
    inCreditMinor: Math.max(account.balance_minor, 0),
    limitMinor,
    availableMinor: limitMinor === null ? null : limitMinor - outstandingMinor,
  }
}

export interface BalanceSummary {
  /** Sum of active bank, wallet, cash and other balances (overdrafts included). */
  availableMinor: number
  /** Sum of what's owed on active cards. */
  cardDuesMinor: number
  /** available − card dues, over tracked accounts only. */
  netMinor: number
  assetAccounts: number
  cardAccounts: number
  /** Part of the active balances that is still pending. */
  pendingMinor: number
  /** Entries on active accounts waiting for review. */
  reviewCount: number
}

/**
 * Home/Accounts headline figures. Card debt is never added into available
 * money; a card's credit balance (overpayment) is not counted as cash either.
 */
export function balanceSummary(
  accounts: Pick<AccountBalanceRow, 'type' | 'status' | 'balance_minor' | 'pending_minor' | 'review_count'>[],
): BalanceSummary {
  const active = accounts.filter((a) => a.status === 'active')
  const assets = active.filter((a) => !isLiability(a.type))
  const cards = active.filter((a) => isLiability(a.type))
  const availableMinor = assets.reduce((sum, a) => sum + a.balance_minor, 0)
  const cardDuesMinor = cards.reduce((sum, a) => sum + Math.max(-a.balance_minor, 0), 0)
  return {
    availableMinor,
    cardDuesMinor,
    netMinor: availableMinor - cardDuesMinor,
    assetAccounts: assets.length,
    cardAccounts: cards.length,
    pendingMinor: active.reduce((sum, a) => sum + (a.pending_minor ?? 0), 0),
    reviewCount: active.reduce((sum, a) => sum + (a.review_count ?? 0), 0),
  }
}

export function groupAccounts<T extends Pick<AccountBalanceRow, 'type'>>(accounts: T[]) {
  return ACCOUNT_GROUPS.map((group) => ({ ...group, accounts: accounts.filter((a) => a.type === group.type) })).filter(
    (group) => group.accounts.length > 0,
  )
}
