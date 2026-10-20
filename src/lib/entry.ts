// Client-side validation for the quick-add / edit form. The database enforces
// the same rules; this gives instant, specific feedback before a round trip.

import type { CaptureKind } from '@/data/database.types'
import { AMOUNT_PROBLEM_MESSAGE, amountProblem, parseAmountToMinor } from './money'

export interface EntryDraft {
  kind: CaptureKind
  amountText: string
  accountId: string | null
  /** Transfers only. */
  destinationAccountId: string | null
  /** Income / expense only; null saves as uncategorised. */
  categoryId: string | null
  /** Local calendar date (YYYY-MM-DD). */
  date: string
  note: string
  /** Expense / income only; optional. */
  merchant?: string
}

export type EntryErrors = Partial<Record<'amount' | 'account' | 'destination' | 'note' | 'merchant', string>>

export interface ValidEntry {
  kind: CaptureKind
  amountMinor: number
  accountId: string
  destinationAccountId: string | null
  categoryId: string | null
  date: string
  note: string | null
  merchant: string | null
}

export const NOTE_MAX = 500
export const MERCHANT_MAX = 120

export interface ValidationContext {
  /** Accounts that can take new entries; anything else is reported, never swapped. */
  availableAccountIds?: Set<string>
}

export function validateEntry(
  draft: EntryDraft,
  context: ValidationContext = {},
): { ok: true; value: ValidEntry } | { ok: false; errors: EntryErrors } {
  const errors: EntryErrors = {}
  const problem = amountProblem(draft.amountText)
  const amountMinor = problem ? null : parseAmountToMinor(draft.amountText)
  if (problem) errors.amount = AMOUNT_PROBLEM_MESSAGE[problem]
  const gone = (id: string | null) => Boolean(id && context.availableAccountIds && !context.availableAccountIds.has(id))

  const unavailable = 'That account is no longer available — choose another'
  if (!draft.accountId) {
    errors.account = draft.kind === 'transfer' ? 'Choose a source account' : 'Choose an account'
  } else if (gone(draft.accountId)) {
    errors.account = unavailable
  }

  if (draft.kind === 'transfer') {
    if (!draft.destinationAccountId) errors.destination = 'Choose a destination account'
    else if (draft.destinationAccountId === draft.accountId) errors.destination = 'Pick two different accounts'
    else if (gone(draft.destinationAccountId)) errors.destination = unavailable
  }

  if (draft.note.length > NOTE_MAX) errors.note = `Keep notes under ${NOTE_MAX} characters`
  const merchant = draft.kind === 'transfer' ? '' : (draft.merchant ?? '').trim()
  if (merchant.length > MERCHANT_MAX) errors.merchant = `Keep merchant names under ${MERCHANT_MAX} characters`

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
      merchant: merchant === '' ? null : merchant,
    },
  }
}

/** Whether the draft has the minimum fields to enable Save. */
export function canSave(draft: EntryDraft, context?: ValidationContext): boolean {
  return validateEntry(draft, context).ok
}
