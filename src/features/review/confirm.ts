// The review queue's decisions, client side. Nothing here records anything:
// the database's confirm_source_event / link_source_event / ignore_source_event
// do, idempotently per event, under the per-user import lock
// (supabase/migrations/20261020000000_ledger_model.sql). This module only
// prefills the confirm form from the evidence and gives instant, specific
// feedback. See docs/ledger-model.md, "Import boundary".

import type { ConfirmEventInput } from '@/data/api'
import type { CategoryRow, EntryKind, SourceEventRow, TransactionType } from '@/data/database.types'
import { localDate } from '@/lib/dates'
import { MERCHANT_MAX, NOTE_MAX } from '@/lib/entry'
import { directionOf, KIND_LABEL, REVIEW_REASON_TEXT, type Direction } from '@/lib/ledger'
import { AMOUNT_PROBLEM_MESSAGE, amountProblem, formatAmountInput, formatMoney, minorToDecimalString, parseAmountToMinor } from '@/lib/money'

/** The confirm form's "No purchase in Friday" choice: an unlinked refund. */
export const UNLINKED = 'none'

export interface ConfirmDraft {
  kind: EntryKind
  amountText: string
  /** Expense/refund/reversal: the entry's account. Income: where it arrived. Transfer: where it left. '' = not chosen. */
  accountId: string
  /** Transfers only. */
  destinationAccountId: string
  /** '' = no category. */
  categoryId: string
  /** Refunds and reversals: the original's id, or UNLINKED (refunds only). */
  originalId: string | null
  /** Local calendar date (YYYY-MM-DD). */
  date: string
  merchant: string
  note: string
  status: 'posted' | 'pending'
}

export interface ConfirmContext {
  /** Accounts a new entry may use (active ones). */
  activeAccountIds: Set<string>
  categoriesById: Map<string, CategoryRow>
}

export type ConfirmErrors = Partial<
  Record<'amount' | 'account' | 'destination' | 'category' | 'original' | 'date' | 'merchant' | 'note', string>
>

/** What confirm_source_event takes, minus the instant (resolved from `date` by the screen). */
export type ValidConfirm = Omit<ConfirmEventInput, 'occurredAt'> & { date: string }

/** The kinds an event can be confirmed as. Reversals only when the evidence says so. */
export function confirmKinds(event: Pick<SourceEventRow, 'parsed_kind'>): EntryKind[] {
  const kinds: EntryKind[] = ['expense', 'income', 'transfer', 'refund']
  if (event.parsed_kind === 'reversal') kinds.push('reversal')
  return kinds
}

/** The category side an entry of this kind uses; null when it takes none of its own. */
export function categorySide(kind: EntryKind): TransactionType | null {
  if (kind === 'expense' || kind === 'refund') return 'expense'
  if (kind === 'income') return 'income'
  return null
}

function categoryFits(categoryId: string | null | undefined, kind: EntryKind, categoriesById: Map<string, CategoryRow>) {
  if (!categoryId) return false
  const category = categoriesById.get(categoryId)
  return Boolean(category && !category.is_archived && category.transaction_type === categorySide(kind))
}

/** Prefills the confirm form from what the import read. Never picks an account it wasn't told about. */
export function confirmDraftFrom(
  event: SourceEventRow,
  ctx: ConfirmContext & { timeZone: string; todayDate: string },
): ConfirmDraft {
  const usable = (id: string | null) => (id && ctx.activeAccountIds.has(id) ? id : '')
  // Money "received" on a card is almost always a bill payment: a transfer
  // into the card, from an account the evidence doesn't name.
  const asTransfer = event.review_reason === 'possible_transfer' && event.parsed_kind !== 'transfer'
  const kind: EntryKind = asTransfer ? 'transfer' : (event.parsed_kind ?? 'expense')
  const linksOriginal =
    (event.parsed_kind === 'refund' || event.parsed_kind === 'reversal') && event.suggested_match_kind === 'transaction'
  // Another currency's figure is never prefilled as rupees.
  const inRupees = !event.parsed_currency || event.parsed_currency === 'INR'

  return {
    kind,
    amountText:
      inRupees && event.parsed_amount_minor && event.parsed_amount_minor > 0
        ? formatAmountInput(minorToDecimalString(event.parsed_amount_minor))
        : '',
    accountId: asTransfer ? '' : usable(event.suggested_account_id),
    destinationAccountId: asTransfer
      ? usable(event.suggested_account_id)
      : usable(event.suggested_destination_account_id),
    categoryId: categoryFits(event.suggested_category_id, kind, ctx.categoriesById) ? event.suggested_category_id! : '',
    originalId: linksOriginal && kind === event.parsed_kind ? event.suggested_match_id : null,
    date: event.parsed_occurred_at ? localDate(event.parsed_occurred_at, ctx.timeZone) : ctx.todayDate,
    merchant: event.parsed_merchant ?? '',
    note: '',
    status: event.parsed_entry_status === 'pending' ? 'pending' : 'posted',
  }
}

/** Switching type keeps everything typed, but drops a category from the other side. */
export function withKind(draft: ConfirmDraft, kind: EntryKind, categoriesById: Map<string, CategoryRow>): ConfirmDraft {
  if (kind === draft.kind) return draft
  return {
    ...draft,
    kind,
    categoryId: categoryFits(draft.categoryId, kind, categoriesById) ? draft.categoryId : '',
    // An unlinked refund has no equivalent for a reversal.
    originalId: kind === 'reversal' && draft.originalId === UNLINKED ? null : draft.originalId,
  }
}

const ACCOUNT_MISSING: Record<EntryKind, string> = {
  expense: 'Choose the account it was paid from',
  income: 'Choose the account it arrived in',
  transfer: 'Choose the account the money left',
  refund: 'Choose the account the money came back to',
  reversal: 'Choose the account it happened on',
}

export function validateConfirm(
  draft: ConfirmDraft,
  ctx: ConfirmContext,
): { ok: true; value: ValidConfirm } | { ok: false; errors: ConfirmErrors } {
  const errors: ConfirmErrors = {}
  const { kind } = draft

  const problem = amountProblem(draft.amountText)
  if (problem) errors.amount = AMOUNT_PROBLEM_MESSAGE[problem]

  if (!draft.accountId) errors.account = ACCOUNT_MISSING[kind]
  else if (!ctx.activeAccountIds.has(draft.accountId)) errors.account = 'That account is archived — choose another'

  if (kind === 'transfer') {
    if (!draft.destinationAccountId) errors.destination = 'Choose where the money went'
    else if (draft.destinationAccountId === draft.accountId) errors.destination = 'Pick two different accounts'
    else if (!ctx.activeAccountIds.has(draft.destinationAccountId)) errors.destination = 'That account is archived — choose another'
  }

  const linked = (kind === 'refund' || kind === 'reversal') && draft.originalId !== null && draft.originalId !== UNLINKED
  if (kind === 'refund' && draft.originalId === null) {
    errors.original = 'Pick the purchase this refunds, or “No purchase in Friday”'
  }
  if (kind === 'reversal' && !linked) errors.original = 'Pick the entry this reverses'

  // A linked refund takes its purchase's category; transfers and reversals have none of their own.
  const takesCategory = kind === 'expense' || kind === 'income' || (kind === 'refund' && !linked)
  if (takesCategory && draft.categoryId && !categoryFits(draft.categoryId, kind, ctx.categoriesById)) {
    errors.category = 'That category doesn’t match this type of entry'
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) errors.date = 'Pick a date'
  if (kind !== 'transfer' && draft.merchant.trim().length > MERCHANT_MAX) {
    errors.merchant = `Keep merchant names under ${MERCHANT_MAX} characters`
  }
  if (draft.note.length > NOTE_MAX) errors.note = `Keep notes under ${NOTE_MAX} characters`

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const merchant = draft.merchant.trim()
  const note = draft.note.trim()
  return {
    ok: true,
    value: {
      kind,
      amountMinor: parseAmountToMinor(draft.amountText)!,
      accountId: draft.accountId,
      destinationAccountId: kind === 'transfer' ? draft.destinationAccountId : null,
      categoryId: takesCategory && draft.categoryId ? draft.categoryId : null,
      relatedTransactionId: linked ? draft.originalId : null,
      // Transfers have no merchant column.
      merchant: kind === 'transfer' || merchant === '' ? null : merchant,
      note: note === '' ? null : note,
      status: draft.status,
      date: draft.date,
    },
  }
}

/** Which originals a refund or reversal could belong to (useOffsetCandidates input), or null. */
export function originalQuery(
  kind: EntryKind,
  accountId: string,
  amountMinor: number | null,
  { onlyThisAccount = true } = {},
): { kinds: ('expense' | 'income')[]; accountId?: string; minAmountMinor?: number } | null {
  const minAmountMinor = amountMinor && amountMinor > 0 ? amountMinor : undefined
  if (kind === 'refund') {
    // A refund can land on another account than the purchase; narrowing is a convenience.
    return { kinds: ['expense'], accountId: onlyThisAccount && accountId ? accountId : undefined, minAmountMinor }
  }
  if (kind === 'reversal') {
    // A reversal always sits on its original's account.
    return accountId ? { kinds: ['expense', 'income'], accountId, minAmountMinor } : null
  }
  return null
}

/** Entries that could be the same transaction (useMatchCandidates input), or null without an amount. */
export function matchQuery(
  event: Pick<SourceEventRow, 'parsed_amount_minor' | 'parsed_occurred_at' | 'received_at' | 'parsed_kind'>,
): { amountMinor: number; around: string; kinds?: EntryKind[] } | null {
  if (!event.parsed_amount_minor || event.parsed_amount_minor <= 0) return null
  return {
    amountMinor: event.parsed_amount_minor,
    around: event.parsed_occurred_at ?? event.received_at,
    kinds: event.parsed_kind ? [event.parsed_kind] : undefined,
  }
}

/** Can this event be linked to that entry? Mirrors link_source_event's checks. */
export function linkProblem(
  event: Pick<SourceEventRow, 'parsed_kind'>,
  entry: { kind: EntryKind; status: string },
): string | null {
  if (entry.status === 'voided') return 'Voided — restore it first, or confirm this as a new entry.'
  if (event.parsed_kind && entry.kind !== event.parsed_kind) {
    if (event.parsed_kind === 'refund' || event.parsed_kind === 'reversal') {
      return 'This looks like money back for it — use Confirm and pick it as the original instead.'
    }
    return `That’s ${KIND_NOUN[entry.kind]}, but this looks like ${KIND_NOUN[event.parsed_kind]}.`
  }
  return null
}

const KIND_NOUN: Record<EntryKind, string> = {
  expense: 'an expense',
  income: 'income',
  transfer: 'a transfer',
  refund: 'a refund',
  reversal: 'a reversal',
}

/** Income categories named "Refunds" (archived or not): money back once recorded as income. */
export function refundIncomeCategoryIds(categories: Pick<CategoryRow, 'id' | 'name' | 'transaction_type'>[]): string[] {
  return categories
    .filter((c) => c.transaction_type === 'income' && c.name.trim().toLowerCase() === 'refunds')
    .map((c) => c.id)
}

/** A name for evidence: the merchant, else its type. */
export function eventTitle(event: Pick<SourceEventRow, 'parsed_merchant' | 'parsed_kind'>): string {
  if (event.parsed_merchant) return event.parsed_merchant
  if (event.parsed_kind) return KIND_LABEL[event.parsed_kind]
  return 'Unknown item'
}

/** The reason in words. */
export function reasonText(event: Pick<SourceEventRow, 'review_reason'>): string {
  return event.review_reason ? REVIEW_REASON_TEXT[event.review_reason] : 'Friday needs you to check this one.'
}

/** "62% sure", or null when the source gave no confidence. */
export function confidenceLabel(confidence: number | null): string | null {
  if (confidence === null || !Number.isFinite(confidence)) return null
  return `${Math.round(Math.min(Math.max(confidence, 0), 1) * 100)}% sure`
}

export interface EventAmount {
  text: string
  /** For screen readers, e.g. "₹250 spent". */
  spoken: string
  /** null when the evidence doesn't say which way it went (a reversal of something unknown). */
  direction: Direction | null
}

const SPOKEN: Record<EntryKind, string> = {
  expense: 'spent',
  income: 'received',
  refund: 'refunded',
  reversal: 'reversed',
  transfer: 'moved',
}

/**
 * The parsed amount with its sign, or null when it couldn't be read. Amounts
 * in other currencies keep their own code (never shown as rupees).
 */
export function eventAmount(
  event: Pick<SourceEventRow, 'parsed_amount_minor' | 'parsed_kind' | 'parsed_currency'>,
): EventAmount | null {
  const minor = event.parsed_amount_minor
  if (minor === null || minor <= 0) return null
  // A reversal's direction depends on what it reverses, which isn't known yet.
  const direction =
    event.parsed_kind && event.parsed_kind !== 'reversal'
      ? directionOf({ kind: event.parsed_kind, base_type: event.parsed_kind === 'refund' ? 'expense' : null })
      : null
  const foreign = event.parsed_currency && event.parsed_currency !== 'INR' ? event.parsed_currency : null
  const body = foreign ? `${foreign} ${minorToDecimalString(minor, { alwaysFraction: true })}` : formatMoney(minor)
  const sign = direction === 'out' ? '−' : direction === 'in' ? '+' : ''
  return {
    text: `${sign}${body}`,
    spoken: event.parsed_kind ? `${body} ${SPOKEN[event.parsed_kind]}` : body,
    direction,
  }
}

/** Parsed amount in minor units when valid, for candidate lookups. */
export function typedAmount(amountText: string): number | null {
  return amountProblem(amountText) ? null : parseAmountToMinor(amountText)
}
