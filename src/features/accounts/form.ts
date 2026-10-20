// Turns the account form's text into the values saved on `accounts`. Cards
// store what was owed as a negative opening balance (docs/ledger-model.md
// "Credit cards"); a credit limit only exists on cards, which the database
// also enforces (accounts_credit_limit_valid).

import type { AccountRow, AccountType } from '@/data/database.types'
import { amountProblem, formatAmountInput, MAX_AMOUNT_MINOR, minorToDecimalString, parseAmountToMinor } from '@/lib/money'
import { isLiability } from '@/lib/ledger'

/** Matches accounts_institution_length. */
export const INSTITUTION_MAX_LENGTH = 60

export interface AccountFormInput {
  type: AccountType
  name: string
  color: string
  institution: string
  /** Cards: what was owed; others: what the account held. Always typed as a magnitude. */
  openingText: string
  /** Overdrawn account, or a card in credit. */
  openingNegative: boolean
  openingDate: string
  creditLimitText: string
}

export type AccountFormErrors = Partial<Record<'name' | 'institution' | 'opening' | 'creditLimit', string>>

export type AccountValues = Pick<
  AccountRow,
  'name' | 'type' | 'color' | 'opening_balance_minor' | 'opening_date' | 'institution_name' | 'credit_limit_minor'
>

const LIMIT_PROBLEM: Record<Exclude<NonNullable<ReturnType<typeof amountProblem>>, 'empty'>, string> = {
  negative: 'A limit can’t be negative',
  precision: 'Use at most 2 decimal places (paise)',
  malformed: 'Use numbers only, like 50000 or 1,50,000',
  zero: 'A limit must be more than zero — or leave it blank',
  too_large: 'That amount is too large',
}

/** Validates the form; returns the values to save or the problems to show. */
export function accountValues(input: AccountFormInput): { values: AccountValues; errors?: undefined } | { values?: undefined; errors: AccountFormErrors } {
  const errors: AccountFormErrors = {}
  const card = isLiability(input.type)

  const name = input.name.trim()
  if (!name) errors.name = 'Give this account a name'

  const institution = input.institution.trim()
  if (institution.length > INSTITUTION_MAX_LENGTH) errors.institution = `Keep it to ${INSTITUTION_MAX_LENGTH} characters`

  const opening = input.openingText.trim() === '' ? 0 : parseAmountToMinor(input.openingText)
  if (opening === null) errors.opening = 'Use numbers only, with up to 2 decimals'
  else if (opening > MAX_AMOUNT_MINOR) errors.opening = 'That amount is too large'

  let creditLimit: number | null = null
  if (card) {
    const problem = amountProblem(input.creditLimitText)
    if (problem && problem !== 'empty') errors.creditLimit = LIMIT_PROBLEM[problem]
    else if (!problem) creditLimit = parseAmountToMinor(input.creditLimitText)
  }

  if (Object.keys(errors).length) return { errors }

  const magnitude = (input.openingNegative ? -1 : 1) * opening!
  // `|| 0` keeps a blank opening balance a plain 0 rather than −0.
  const openingMinor = (card ? -magnitude : magnitude) || 0
  return {
    values: {
      name,
      type: input.type,
      color: input.color,
      opening_balance_minor: openingMinor,
      opening_date: input.openingDate,
      institution_name: institution || null,
      credit_limit_minor: creditLimit,
    },
  }
}

/** The form's starting text for an existing account (or blanks for a new one). */
export function accountFormText(
  account?: Pick<AccountRow, 'type' | 'opening_balance_minor' | 'institution_name' | 'credit_limit_minor'>,
): Pick<AccountFormInput, 'openingText' | 'openingNegative' | 'institution' | 'creditLimitText'> {
  if (!account) return { openingText: '', openingNegative: false, institution: '', creditLimitText: '' }
  // Cards are typed as what was owed, so flip the stored sign back.
  const shown = isLiability(account.type) ? -account.opening_balance_minor : account.opening_balance_minor
  return {
    openingText: formatAmountInput(minorToDecimalString(Math.abs(shown))),
    openingNegative: shown < 0,
    institution: account.institution_name ?? '',
    creditLimitText: account.credit_limit_minor ? formatAmountInput(minorToDecimalString(account.credit_limit_minor)) : '',
  }
}
