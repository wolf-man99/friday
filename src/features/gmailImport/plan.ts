// Importing past months from Gmail: which months to offer, what Friday
// suggests for each account or card the emails mention, and turning the
// person's choices into what the server expects.

import type { AccountBalanceRow, GmailImportJobRow } from '@/data/database.types'
import type { AccountDecision, DiscoveredAccount } from '@/data/gmail'
import { addMonths, formatMonthYear, type ISODate } from '@/lib/dates'

export interface ImportMonth {
  /** 'YYYY-MM' */
  value: string
  label: string
}

/** This month (to today) and the two before it, newest first. */
export function importMonths(todayDate: ISODate): ImportMonth[] {
  const first = `${todayDate.slice(0, 7)}-01` as ISODate
  return [0, 1, 2].map((back) => {
    const month = addMonths(first, -back)
    return { value: month.slice(0, 7), label: `${formatMonthYear(month)}${back === 0 ? ' (to today)' : ''}` }
  })
}

export function monthsLabel(months: string[]): string {
  return [...months]
    .sort()
    .map((m) => formatMonthYear(`${m}-01` as ISODate).split(' ')[0])
    .join(', ')
}

export const IMPORT_RUNNING: GmailImportJobRow['status'][] = ['listing', 'scanning', 'confirm_accounts', 'importing']

export type ChoiceKind = 'link' | 'create' | 'ignore' | 'review'

export interface Choice {
  kind: ChoiceKind
  accountId: string
  name: string
  type: 'bank' | 'credit_card' | 'wallet'
  openingText: string
}

export function groupKey(group: Pick<DiscoveredAccount, 'institutionKey' | 'instrument' | 'accountMask'>): string {
  return `${group.institutionKey}/${group.instrument}/${group.accountMask}`
}

/** Friday accounts this number could be: cards for cards, wallets for wallets, banks otherwise. */
export function compatibleAccounts(group: DiscoveredAccount, accounts: AccountBalanceRow[]): AccountBalanceRow[] {
  const types: AccountBalanceRow['type'][] =
    group.instrument === 'credit_card' ? ['credit_card']
      : group.instrument === 'wallet' ? ['wallet']
      : group.instrument === 'unknown' ? ['bank', 'wallet', 'credit_card']
      : ['bank']
  return accounts.filter((a) => a.status === 'active' && types.includes(a.type))
}

/** What Friday suggests: the account it's linked to (or looks like), else a new one; review when unsure. */
export function defaultChoice(group: DiscoveredAccount, accounts: AccountBalanceRow[]): Choice {
  const type = group.suggestedType ?? (group.instrument === 'credit_card' ? 'credit_card' : group.instrument === 'wallet' ? 'wallet' : 'bank')
  const base = { accountId: '', name: group.suggestedName, type, openingText: '' }
  if (group.linkedIgnored) return { ...base, kind: 'ignore' }
  const existing = group.linkedAccountId ?? group.suggestedAccountId
  if (existing && compatibleAccounts(group, accounts).some((a) => a.id === existing)) {
    return { ...base, kind: 'link', accountId: existing }
  }
  if (group.suggestedType === null) return { ...base, kind: 'review' }
  return { ...base, kind: 'create' }
}

export function instrumentLabel(group: Pick<DiscoveredAccount, 'institutionName' | 'instrument' | 'accountMask'>): string {
  const mask = group.accountMask ? ` ••${group.accountMask}` : ''
  switch (group.instrument) {
    case 'credit_card':
      return `${group.institutionName} credit card${mask}`
    case 'debit_card':
      return `${group.institutionName} debit card${mask}`
    case 'wallet':
      return `${group.institutionName} wallet`
    case 'bank':
      return `${group.institutionName} account${mask}`
    default:
      return mask ? `${group.institutionName}${mask}` : `${group.institutionName} (no account number)`
  }
}

/**
 * The choices as the server expects them. Opening balances are typed in
 * rupees; for a card it's what was owed, stored as a negative balance.
 * Returns the key of the first incomplete choice instead, if any.
 */
export function toDecisions(
  groups: DiscoveredAccount[],
  choices: Record<string, Choice>,
  parseAmount: (text: string) => number | null,
): { ok: true; decisions: AccountDecision[] } | { ok: false; key: string; message: string } {
  const decisions: AccountDecision[] = []
  for (const group of groups) {
    const key = groupKey(group)
    const choice = choices[key]
    const where = { institutionKey: group.institutionKey, instrument: group.instrument, accountMask: group.accountMask }
    if (!choice) return { ok: false, key, message: 'Choose what to do with this account.' }
    if (choice.kind === 'link') {
      if (!choice.accountId) return { ok: false, key, message: 'Choose one of your accounts.' }
      decisions.push({ ...where, action: 'link', accountId: choice.accountId })
    } else if (choice.kind === 'create') {
      const name = choice.name.trim()
      if (!name) return { ok: false, key, message: 'Give the new account a name.' }
      let openingBalanceMinor: number | undefined
      if (choice.openingText.trim()) {
        const minor = parseAmount(choice.openingText)
        if (minor === null) return { ok: false, key, message: 'Enter the balance in rupees, or leave it empty.' }
        openingBalanceMinor = choice.type === 'credit_card' ? -minor : minor
      }
      decisions.push({ ...where, action: 'create', name: name.slice(0, 60), type: choice.type, ...(openingBalanceMinor !== undefined ? { openingBalanceMinor } : {}) })
    } else {
      decisions.push({ ...where, action: choice.kind })
    }
  }
  return { ok: true, decisions }
}
