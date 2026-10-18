// Client-side validation for the quick-add / edit form. The database enforces
// the same rules; this gives instant, specific feedback before a round trip.

import type { EntryKind } from '@/data/database.types'
import { MAX_AMOUNT_MINOR, parseAmountToMinor } from './money'

export interface EntryDraft {
  kind: EntryKind
  amountText: string
  accountId: string | null
  /** Transfers only. */
  destinationAccountId: string | null
  /** Income / expense only; null saves as uncategorised. */
  categoryId: string | null
  /** Local calendar date (YYYY-MM-DD). */
  date: string
  note: string
}

export type EntryErrors = Partial<Record<'amount' | 'account' | 'destination' | 'note', string>>

export interface ValidEntry {
  kind: EntryKind
  amountMinor: number
  accountId: string
  destinationAccountId: string | null
  categoryId: string | null
  date: string
  note: string | null
}

export const NOTE_MAX = 500

export function validateEntry(draft: EntryDraft): { ok: true; value: ValidEntry } | { ok: false; errors: EntryErrors } {
  const errors: EntryErrors = {}
  const amountMinor = parseAmountToMinor(draft.amountText)

  if (draft.amountText.trim() === '') errors.amount = 'Enter an amount'
  else if (amountMinor === null) errors.amount = 'Use numbers only, with up to 2 decimals'
  else if (amountMinor <= 0) errors.amount = 'Amount must be more than zero'
  else if (amountMinor > MAX_AMOUNT_MINOR) errors.amount = 'That amount is too large'

  if (!draft.accountId) {
    errors.account = draft.kind === 'transfer' ? 'Choose a source account' : 'Choose an account'
  }

  if (draft.kind === 'transfer') {
    if (!draft.destinationAccountId) errors.destination = 'Choose a destination account'
    else if (draft.destinationAccountId === draft.accountId) errors.destination = 'Pick two different accounts'
  }

  if (draft.note.length > NOTE_MAX) errors.note = `Keep notes under ${NOTE_MAX} characters`

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: {
      kind: draft.kind,
      amountMinor: amountMinor!,
      accountId: draft.accountId!,
      destinationAccountId: draft.kind === 'transfer' ? draft.destinationAccountId : null,
      categoryId: draft.kind === 'transfer' ? null : draft.categoryId,
      date: draft.date,
      note: draft.note.trim() === '' ? null : draft.note.trim(),
    },
  }
}

/** Whether the draft has the minimum fields to enable Save. */
export function canSave(draft: EntryDraft): boolean {
  return validateEntry(draft).ok
}
