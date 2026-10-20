import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { Amount } from '@/components/finance/Amount'
import { CategoryBadge } from '@/components/finance/CategoryTile'
import { TransferGlyph } from '@/components/finance/icons'
import { StatusBadge } from '@/components/finance/StatusBadge'
import { entryTitle } from '@/components/finance/TransactionRow'
import { cn } from '@/components/ui/cn'
import type { AccountBalanceRow, CategoryRow, LedgerEntryRow } from '@/data/database.types'
import { formatDate, localDate } from '@/lib/dates'

// Radio rows for picking a ledger entry inside a review sheet (the purchase a
// refund belongs to, or the entry an import is about). A real radio sits under
// each row, so arrow keys and screen readers work like any radio group.

interface ChoiceOptionProps {
  name: string
  value: string
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  children: ReactNode
}

export function ChoiceOption({ name, value, selected, disabled, onSelect, children }: ChoiceOptionProps) {
  return (
    <label
      className={cn(
        'flex min-h-16 items-center gap-3 rounded-2xl px-3 py-2.5 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink',
        disabled
          ? 'cursor-not-allowed bg-canvas outline-regular'
          : selected
            ? 'cursor-pointer bg-peach outline-strong'
            : 'cursor-pointer bg-paper outline-regular hover:bg-peach/50',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
        className="sr-only"
      />
      {children}
      <span
        aria-hidden="true"
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-full outline-regular',
          selected ? 'bg-ink text-paper' : 'bg-paper',
          disabled && 'opacity-40',
        )}
      >
        {selected && <Check className="size-3.5" strokeWidth={3.5} />}
      </span>
    </label>
  )
}

interface EntryOptionBodyProps {
  entry: LedgerEntryRow
  categoriesById: Map<string, CategoryRow>
  accountsById: Map<string, AccountBalanceRow>
  timeZone: string
  /** Marks the entry the import pointed at. */
  suggested?: boolean
  /** Why it can't be picked, shown under the details. */
  problem?: string | null
}

/** One entry's essentials: what, when, where, how much — and its status in words. */
export function EntryOptionBody({ entry, categoriesById, accountsById, timeZone, suggested, problem }: EntryOptionBodyProps) {
  const category = entry.category_id ? categoriesById.get(entry.category_id) : undefined
  const account = accountsById.get(entry.account_id)
  const counter = entry.counter_account_id ? accountsById.get(entry.counter_account_id) : undefined
  const where = entry.kind === 'transfer' ? `${account?.name ?? 'Account'} → ${counter?.name ?? 'Account'}` : account?.name
  const meta = [formatDate(localDate(entry.occurred_at, timeZone), { withYear: true }), where].filter(Boolean).join(' · ')
  return (
    <>
      {entry.kind === 'transfer' ? (
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-[0.7rem] bg-purple outline-regular">
          <TransferGlyph className="size-4" />
        </span>
      ) : (
        <CategoryBadge icon={category?.icon ?? 'tag'} color={category?.color ?? 'peach'} size="sm" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold">{entryTitle(entry, category, counter)}</span>
          {suggested && (
            <span className="label-mono shrink-0 rounded-pill bg-orange px-2 py-0.5 outline-regular">Suggested</span>
          )}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <StatusBadge status={entry.status} />
          <span className="label-mono min-w-0 max-w-full truncate text-muted">{meta}</span>
        </span>
        {problem && <span className="text-sm font-semibold">{problem}</span>}
      </span>
      <Amount
        minor={entry.amount_minor}
        kind={entry.kind}
        baseType={entry.base_type}
        className="shrink-0 font-display font-extrabold tracking-tight"
      />
    </>
  )
}
