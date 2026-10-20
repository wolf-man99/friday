// Words for the entry details screen: what kind of entry it is, where it came
// from, and its change history. Signs, totals and status rules come from
// src/lib/ledger.ts; this module only phrases them. See docs/ledger-model.md.

import type { AccountType, CreatedVia, EntryKind, EntryStatus, LedgerAuditRow, TransactionType } from '@/data/database.types'
import { formatDate, localDate, localTime } from '@/lib/dates'
import { KIND_LABEL, STATUS_LABEL } from '@/lib/ledger'
import { formatMoney } from '@/lib/money'

export const CREATED_VIA_LABEL: Record<CreatedVia, string> = {
  quick_add: 'Quick Add',
  recurring: 'Recurring',
  import: 'Import',
  manual: 'Manual',
}

/** "18 Oct 2026, 14:05" in the user's timezone. */
export function formatDateTime(instant: string, timeZone: string): string {
  return `${formatDate(localDate(instant, timeZone), { withYear: true })}, ${localTime(instant, timeZone)}`
}

/** The entry's type in words; a transfer that pays a card off is a "Card payment". */
export function entryTypeLabel(kind: EntryKind, destinationType?: AccountType | null): string {
  if (kind === 'transfer' && destinationType === 'credit_card') return 'Card payment'
  return KIND_LABEL[kind]
}

/** What an entry does to the numbers, for kinds whose effect isn't obvious. */
export function kindExplainer(
  kind: EntryKind,
  baseType?: TransactionType | null,
  destinationType?: AccountType | null,
): string | null {
  switch (kind) {
    case 'refund':
      return 'Money back for a purchase. It lowers your spending and is never counted as income.'
    case 'reversal':
      return baseType === 'income'
        ? 'Income that was pulled back. It cancels the original out of your income.'
        : 'A purchase the bank pulled back. It cancels the original’s spending.'
    case 'transfer':
      return destinationType === 'credit_card'
        ? 'Pays down the card’s dues. Not spending — the purchases already counted.'
        : 'Moves money between your accounts. Not spending, not income.'
    default:
      return null
  }
}

/** "₹X left that can be refunded or reversed" under an original's money-back list. */
export function remainingText(kind: 'expense' | 'income', remainingMinor: number): string {
  if (remainingMinor <= 0) return kind === 'expense' ? 'Fully refunded or reversed' : 'Fully reversed'
  return `${formatMoney(remainingMinor)} left that can be ${kind === 'expense' ? 'refunded or reversed' : 'reversed'}`
}

/** Confidence 0–1 → "92% confidence"; null when unknown. */
export function confidenceText(confidence: number | null | undefined): string | null {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) return null
  return `${Math.round(confidence * 100)}% confidence`
}

// --- History ------------------------------------------------------------------

export interface AuditContext {
  timeZone: string
  accountName?: (id: string) => string | undefined
  categoryName?: (id: string) => string | undefined
}

export interface AuditLine {
  title: string
  /** Changed fields in words, e.g. "Amount ₹250 → ₹300". */
  changes: string[]
  reason: string | null
  at: string
}

type Facts = Record<string, unknown>

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function isStatus(value: unknown): value is EntryStatus {
  return value === 'posted' || value === 'pending' || value === 'needs_review' || value === 'voided'
}

function isKind(value: unknown): value is EntryKind {
  return typeof value === 'string' && value in KIND_LABEL
}

function statusTitle(from: unknown, to: unknown): string {
  if (!isStatus(to)) return 'Status changed'
  if (to === 'voided') return 'Voided'
  if (from === 'voided') return `Restored as ${STATUS_LABEL[to].toLowerCase()}`
  if (from === 'needs_review') return to === 'posted' ? 'Confirmed' : `Confirmed as ${STATUS_LABEL[to].toLowerCase()}`
  if (from === 'pending' && to === 'posted') return 'Marked as posted'
  return `Status: ${isStatus(from) ? STATUS_LABEL[from] : 'unknown'} → ${STATUS_LABEL[to]}`
}

function fieldChange(field: string, before: Facts, after: Facts, context: AuditContext): string | null {
  const was = before[field]
  const now = after[field]
  const name = (id: unknown, lookup: AuditContext['accountName'], fallback: string) =>
    (text(id) && lookup?.(id as string)) || fallback
  switch (field) {
    case 'amount_minor':
      return typeof was === 'number' && typeof now === 'number'
        ? `Amount ${formatMoney(was)} → ${formatMoney(now)}`
        : 'Amount changed'
    case 'type':
      return isKind(was) && isKind(now) ? `Type ${KIND_LABEL[was]} → ${KIND_LABEL[now]}` : 'Type changed'
    case 'occurred_at': {
      const a = text(was)
      const b = text(now)
      if (!a || !b) return 'Date changed'
      const from = localDate(a, context.timeZone)
      const to = localDate(b, context.timeZone)
      // Same day, new instant (e.g. kept while editing): not worth a line.
      return from === to ? null : `Date ${formatDate(from, { withYear: true })} → ${formatDate(to, { withYear: true })}`
    }
    case 'account_id':
    case 'source_account_id':
    case 'destination_account_id': {
      const label = field === 'destination_account_id' ? 'To account' : field === 'source_account_id' ? 'From account' : 'Account'
      if (!context.accountName) return `${label} changed`
      return `${label} ${name(was, context.accountName, 'another account')} → ${name(now, context.accountName, 'another account')}`
    }
    case 'category_id': {
      if (!context.categoryName) return 'Category changed'
      const from = text(was) ? name(was, context.categoryName, 'another category') : 'Uncategorised'
      const to = text(now) ? name(now, context.categoryName, 'another category') : 'Uncategorised'
      return `Category ${from} → ${to}`
    }
    case 'note':
      return 'Note changed'
    case 'merchant':
      return 'Merchant changed'
    case 'related_transaction_id':
      return text(now) ? 'Linked to the original' : 'Unlinked from the original'
    case 'currency':
      return 'Currency changed'
    case 'source_type':
      return 'Source changed'
    case 'status':
      return null
    default:
      return `${field.replace(/_/g, ' ')} changed`
  }
}

/** One history row in words. Legacy 'void' rows (before statuses existed) were deletions. */
export function describeAudit(row: LedgerAuditRow, context: AuditContext): AuditLine {
  const after: Facts = row.snapshot ?? {}
  const before: Facts = row.previous ?? {}
  const base = { reason: row.reason?.trim() || null, at: row.created_at }
  switch (row.action) {
    case 'create': {
      const status = after.status
      const title = isStatus(status) && status !== 'posted' ? `Added as ${STATUS_LABEL[status].toLowerCase()}` : 'Added'
      return { ...base, title, changes: [] }
    }
    case 'delete':
    case 'void':
      return { ...base, title: 'Deleted', changes: [] }
    case 'restore':
      return { ...base, title: 'Restored after deleting', changes: [] }
    case 'status':
    case 'update': {
      const fields = row.changed_fields ?? []
      let title = 'Edited'
      if (fields.includes('status')) title = statusTitle(before.status, after.status)
      else if (fields.includes('type') && after.type === 'refund' && before.type === 'income') title = 'Turned into a refund'
      else if (fields.includes('related_transaction_id') && after.type === 'refund') title = 'Linked to its purchase'
      const changes = fields
        .filter((field) => !(title === 'Turned into a refund' && field === 'type'))
        .map((field) => fieldChange(field, before, after, context))
        .filter((line): line is string => Boolean(line))
      return { ...base, title, changes }
    }
  }
}
