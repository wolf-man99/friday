import { Link } from 'react-router'
import type { AccountBalanceRow, CategoryRow, EntryKind, LedgerEntryRow } from '@/data/database.types'
import { cn } from '@/components/ui/cn'
import { formatMoney } from '@/lib/money'
import { Amount } from './Amount'
import { CategoryBadge } from './CategoryTile'
import { TransferGlyph } from './icons'
import { describeEntryState, KindBadge, SourceBadge, StatusBadge } from './StatusBadge'

interface TransactionRowProps {
  entry: LedgerEntryRow
  category?: CategoryRow
  account?: AccountBalanceRow
  /** For transfers: the destination account. */
  counterAccount?: AccountBalanceRow
  /** e.g. a time or date shown under the amount. */
  meta?: string
}

const SPOKEN: Record<EntryKind, string> = {
  expense: 'spent',
  income: 'received',
  refund: 'refunded',
  reversal: 'reversed',
  transfer: 'moved',
}

/** "Card payment" when a transfer pays off a credit card, otherwise "Transfer". */
function transferLabel(counterAccount?: AccountBalanceRow) {
  return counterAccount?.type === 'credit_card' ? 'Card payment' : 'Transfer'
}

export function entryTitle(entry: LedgerEntryRow, category?: CategoryRow, counterAccount?: AccountBalanceRow) {
  if (entry.merchant) return entry.merchant
  if (entry.note) return entry.note
  if (entry.kind === 'transfer') return transferLabel(counterAccount)
  return category?.name ?? 'Uncategorised'
}

/** One ledger entry; the whole row opens its details. */
export function TransactionRow({ entry, category, account, counterAccount, meta }: TransactionRowProps) {
  const title = entryTitle(entry, category, counterAccount)
  const isTransfer = entry.kind === 'transfer'
  const isOffset = entry.kind === 'refund' || entry.kind === 'reversal'
  // Rows from before statuses existed read as posted, typed-in entries.
  const status = entry.status ?? 'posted'
  const source = entry.source_type ?? 'manual'
  const voided = status === 'voided'
  const from = account?.name ?? 'Account'
  const to = counterAccount?.name ?? 'Account'

  let detail: string
  let spokenDetail: string
  if (isTransfer) {
    // The title already says "Card payment"/"Transfer" unless a note replaced it.
    const label = entry.note ? `${transferLabel(counterAccount)} · ` : ''
    detail = `${label}${from} → ${to}`
    spokenDetail = `${entry.note ? `${transferLabel(counterAccount).toLowerCase()} ` : ''}from ${from} to ${to}`
  } else {
    // Refunds and reversals always name the category they net against; the
    // Refund/Reversal badge sits in front of it.
    const showCategory = isOffset || Boolean(entry.note || entry.merchant)
    const categoryName = category?.name ?? 'Uncategorised'
    const parts = [showCategory && title !== categoryName ? categoryName : null, account?.name].filter(Boolean)
    detail = parts.join(' · ')
    spokenDetail = parts.join(', ')
  }

  const state = describeEntryState({ kind: entry.kind, status, source_type: source })
  const label = [`${title}, ${SPOKEN[entry.kind]} ${formatMoney(entry.amount_minor)}`, spokenDetail, meta, state]
    .filter(Boolean)
    .join(', ')
  const hasBadges = isOffset || status !== 'posted' || source !== 'manual'

  return (
    <Link
      to={`/entry/${entry.kind}/${entry.id}`}
      className={cn(
        'flex min-h-16 items-center gap-3 rounded-2xl px-2 py-2.5 hover:bg-peach/50 focus-visible:bg-peach/50',
        // Voided entries stay in the history but don't count anywhere.
        voided && 'opacity-70',
      )}
      aria-label={label}
    >
      {isTransfer ? (
        <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-[0.9rem] bg-purple outline-regular">
          <TransferGlyph />
        </span>
      ) : (
        <CategoryBadge icon={category?.icon ?? (isOffset ? 'undo' : 'tag')} color={category?.color ?? 'peach'} />
      )}
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold">{title}</span>
        {/* Badges lead the detail line; the detail wraps under them when they fill the width. */}
        <span className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1', hasBadges && 'mt-0.5')}>
          <KindBadge kind={entry.kind} />
          <StatusBadge status={status} />
          <SourceBadge source={source} />
          {detail && <span className="label-mono min-w-0 max-w-full truncate text-muted">{detail}</span>}
        </span>
      </span>
      <span aria-hidden="true" className="flex shrink-0 flex-col items-end">
        <Amount
          minor={entry.amount_minor}
          kind={entry.kind}
          baseType={entry.base_type}
          colored={!voided}
          className={cn('font-display text-lg font-extrabold tracking-tight', voided && 'line-through decoration-2')}
        />
        {meta && <span className="label-mono text-muted">{meta}</span>}
      </span>
    </Link>
  )
}

interface DayGroupHeaderProps {
  label: string
  /** Net spending that day (expenses − refunds − reversed purchases); can be negative. */
  expenseMinor: number
  /** Net income that day (income − reversed income); can be negative. */
  incomeMinor: number
}

export function DayGroupHeader({ label, expenseMinor, incomeMinor }: DayGroupHeaderProps) {
  const parts: { key: string; text: string; positive?: boolean }[] = []
  if (expenseMinor > 0) parts.push({ key: 'out', text: `Out ${formatMoney(expenseMinor)}` })
  // More came back than went out: say so in words rather than a negative "Out".
  if (expenseMinor < 0) parts.push({ key: 'out', text: `Money back ${formatMoney(-expenseMinor)}` })
  if (incomeMinor > 0) parts.push({ key: 'in', text: `In ${formatMoney(incomeMinor)}`, positive: true })
  if (incomeMinor < 0) parts.push({ key: 'in', text: `In ${formatMoney(incomeMinor)}` })

  return (
    <div className="flex items-baseline justify-between gap-2 px-2 pb-1 pt-4">
      <h3 className="display shrink-0 text-lg">{label}</h3>
      <p className="label-mono min-w-0 text-right text-muted">
        {parts.map((part, index) => (
          <span key={part.key}>
            {index > 0 && ' · '}
            <span className={cn(part.positive && 'text-positive')}>{part.text}</span>
          </span>
        ))}
      </p>
    </div>
  )
}
