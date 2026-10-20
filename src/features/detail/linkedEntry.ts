// Client-side checks for recording or editing a refund or reversal. The
// database enforces the same rules (a posted original, the same account for
// reversals, never more back than the original's amount) under a row lock;
// this only gives instant, specific feedback. See docs/ledger-model.md.

import { NOTE_MAX } from '@/lib/entry'
import { AMOUNT_PROBLEM_MESSAGE, amountProblem, formatMoney, parseAmountToMinor } from '@/lib/money'

export type LinkedKind = 'refund' | 'reversal'

export interface LinkedDraft {
  amountText: string
  accountId: string | null
  /** Local calendar date (YYYY-MM-DD). */
  date: string
  note: string
}

export interface LinkedLimits {
  kind: LinkedKind
  /** Most this entry can be: what's left on the original. null when it has no original. */
  maxMinor: number | null
  /** Accounts this entry may use (active ones, plus the one it already has when editing). */
  usableAccountIds: Set<string>
}

export type LinkedErrors = Partial<Record<'amount' | 'account' | 'date' | 'note', string>>

export interface ValidLinkedEntry {
  amountMinor: number
  accountId: string
  date: string
  note: string | null
}

const VERB: Record<LinkedKind, string> = { refund: 'refund', reversal: 'reverse' }

/** Why an amount can't be recorded against what's left, or null. */
export function overLimitMessage(kind: LinkedKind, amountMinor: number, maxMinor: number | null): string | null {
  if (maxMinor === null || amountMinor <= maxMinor) return null
  if (maxMinor <= 0) return `Nothing is left to ${VERB[kind]} on this entry`
  return `Only ${formatMoney(maxMinor)} is left to ${VERB[kind]} — enter that or less`
}

export function validateLinkedEntry(
  draft: LinkedDraft,
  limits: LinkedLimits,
): { ok: true; value: ValidLinkedEntry } | { ok: false; errors: LinkedErrors } {
  const errors: LinkedErrors = {}

  const problem = amountProblem(draft.amountText)
  const amountMinor = problem ? null : parseAmountToMinor(draft.amountText)
  if (problem) errors.amount = AMOUNT_PROBLEM_MESSAGE[problem]
  else {
    const over = overLimitMessage(limits.kind, amountMinor!, limits.maxMinor)
    if (over) errors.amount = over
  }

  if (!draft.accountId) {
    errors.account = 'Choose the account the money came back to'
  } else if (!limits.usableAccountIds.has(draft.accountId)) {
    errors.account =
      limits.kind === 'reversal'
        ? 'A reversal stays on the original’s account, and that account is archived. Restore the account first.'
        : 'That account is archived — choose another'
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) errors.date = 'Pick a date'
  if (draft.note.length > NOTE_MAX) errors.note = `Keep notes under ${NOTE_MAX} characters`

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const note = draft.note.trim()
  return {
    ok: true,
    value: { amountMinor: amountMinor!, accountId: draft.accountId!, date: draft.date, note: note === '' ? null : note },
  }
}
