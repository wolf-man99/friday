import { Link } from 'react-router'
import type { AccountBalanceRow, CategoryRow, LedgerEntryRow } from '@/data/database.types'
import { cn } from '@/components/ui/cn'
import { formatMoney } from '@/lib/money'
import { Amount } from './Amount'
import { CategoryBadge } from './CategoryTile'
import { TransferGlyph } from './icons'

interface TransactionRowProps {
  entry: LedgerEntryRow
  category?: CategoryRow
  account?: AccountBalanceRow
  counterAccount?: AccountBalanceRow
  /** e.g. a time or date shown under the amount. */
  meta?: string
}

export function entryTitle(entry: LedgerEntryRow, category?: CategoryRow) {
  if (entry.merchant) return entry.merchant
  if (entry.note) return entry.note
  if (entry.kind === 'transfer') return 'Transfer'
  return category?.name ?? 'Uncategorised'
}

/** One ledger entry; the whole row opens it for editing. */
export function TransactionRow({ entry, category, account, counterAccount, meta }: TransactionRowProps) {
  const title = entryTitle(entry, category)
  const isTransfer = entry.kind === 'transfer'
  const detail = isTransfer
    ? `${account?.name ?? 'Account'} → ${counterAccount?.name ?? 'Account'}`
    : [entry.note || entry.merchant ? (category?.name ?? 'Uncategorised') : null, account?.name].filter(Boolean).join(' · ')

  return (
    <Link
      to={`/entry/${entry.kind}/${entry.id}`}
      className="flex min-h-16 items-center gap-3 rounded-2xl px-2 py-2.5 hover:bg-peach/50 focus-visible:bg-peach/50"
      aria-label={`${title}, ${entry.kind === 'expense' ? 'spent' : entry.kind === 'income' ? 'received' : 'moved'} ${formatMoney(entry.amount_minor)}, ${detail}${meta ? `, ${meta}` : ''}`}
    >
      {isTransfer ? (
        <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-[0.9rem] bg-purple outline-regular">
          <TransferGlyph />
        </span>
      ) : (
        <CategoryBadge icon={category?.icon ?? 'tag'} color={category?.color ?? 'peach'} />
      )}
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold">{title}</span>
        <span className="label-mono truncate text-muted">{isTransfer && entry.note ? `Transfer · ${detail}` : detail}</span>
      </span>
      <span aria-hidden="true" className="flex flex-col items-end">
        <Amount
          minor={entry.amount_minor}
          kind={entry.kind}
          className={cn('font-display text-lg font-extrabold tracking-tight')}
        />
        {meta && <span className="label-mono text-muted">{meta}</span>}
      </span>
    </Link>
  )
}

interface DayGroupHeaderProps {
  label: string
  expenseMinor: number
  incomeMinor: number
}

export function DayGroupHeader({ label, expenseMinor, incomeMinor }: DayGroupHeaderProps) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-2 pb-1 pt-4">
      <h3 className="display text-lg">{label}</h3>
      <p className="label-mono text-muted">
        {expenseMinor > 0 && <span>Out {formatMoney(expenseMinor)}</span>}
        {expenseMinor > 0 && incomeMinor > 0 && <span> · </span>}
        {incomeMinor > 0 && <span className="text-positive">In {formatMoney(incomeMinor)}</span>}
      </p>
    </div>
  )
}
