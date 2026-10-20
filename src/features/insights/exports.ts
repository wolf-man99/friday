// The spreadsheet exports on Profile. Columns only ever get appended, never
// reordered or renamed, so sheets and scripts built on older exports keep
// working. Amounts are positive rupee decimals; the type, status and refund
// link say what each row did.

import type { AccountBalanceRow, CategoryRow, LedgerEntryRow } from '@/data/database.types'
import type { CsvValue } from '@/lib/csv'
import { localDate, localTime } from '@/lib/dates'
import { minorToDecimalString } from '@/lib/money'

export interface CsvTable {
  headers: string[]
  rows: CsvValue[][]
}

const money = (minor: number) => minorToDecimalString(minor, { alwaysFraction: true })

export const TRANSACTION_COLUMNS = [
  'date',
  'time',
  'type',
  'amount',
  'currency',
  'account',
  'category',
  'transfer_from',
  'transfer_to',
  'merchant',
  'note',
  'id',
  // Phase 1: ledger state and the purchase a refund (or reversal) belongs to.
  'status',
  'source',
  'refund_of',
]

export function transactionsCsv(
  entries: LedgerEntryRow[],
  {
    accountsById,
    categoriesById,
    timeZone,
  }: { accountsById: Map<string, Pick<AccountBalanceRow, 'name'>>; categoriesById: Map<string, Pick<CategoryRow, 'name'>>; timeZone: string },
): CsvTable {
  const accountName = (id: string | null) => (id ? (accountsById.get(id)?.name ?? '') : '')
  const categoryName = (id: string | null) => (id ? (categoriesById.get(id)?.name ?? '') : '')
  const rows = entries.map((e) => {
    const transfer = e.kind === 'transfer'
    return [
      localDate(e.occurred_at, timeZone),
      localTime(e.occurred_at, timeZone),
      e.kind,
      money(e.amount_minor),
      e.currency,
      transfer ? '' : accountName(e.account_id),
      transfer ? '' : categoryName(e.category_id),
      transfer ? accountName(e.account_id) : '',
      transfer ? accountName(e.counter_account_id) : '',
      e.merchant ?? '',
      e.note ?? '',
      e.id,
      e.status ?? 'posted',
      e.source_type ?? 'manual',
      e.related_transaction_id ?? '',
    ]
  })
  return { headers: TRANSACTION_COLUMNS, rows }
}

export const ACCOUNT_COLUMNS = [
  'name',
  'type',
  'status',
  'currency',
  'opening_balance',
  'opening_date',
  'income',
  'expenses',
  'transfers_in',
  'transfers_out',
  'balance',
  'id',
  // Phase 1
  'institution',
  'credit_limit',
  'refunds',
  'reversed_income',
  'pending',
]

export function accountsCsv(accounts: AccountBalanceRow[]): CsvTable {
  const rows = accounts.map((a) => [
    a.name,
    a.type,
    a.status,
    a.currency,
    money(a.opening_balance_minor),
    a.opening_date,
    money(a.income_minor),
    money(a.expense_minor),
    money(a.transfers_in_minor),
    money(a.transfers_out_minor),
    money(a.balance_minor),
    a.id,
    a.institution_name ?? '',
    a.credit_limit_minor === null || a.credit_limit_minor === undefined ? '' : money(a.credit_limit_minor),
    money(a.refunds_minor ?? 0),
    money(a.reversed_income_minor ?? 0),
    money(a.pending_minor ?? 0),
  ])
  return { headers: ACCOUNT_COLUMNS, rows }
}
