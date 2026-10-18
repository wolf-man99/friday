import { Check, SkipForward } from 'lucide-react'
import { Link } from 'react-router'
import type { CategoryRow, RecurringRuleRow } from '@/data/database.types'
import { Button } from '@/components/ui/Button'
import { cn } from '@/components/ui/cn'
import { diffDays, formatRelativeDay } from '@/lib/dates'
import { formatMoney } from '@/lib/money'
import { describeSchedule } from '@/lib/recurrence'
import { CategoryBadge } from './CategoryTile'

export function dueChip(dueDate: string, todayDate: string) {
  const delta = diffDays(dueDate, todayDate)
  if (delta < 0) return { text: `Overdue · ${formatRelativeDay(dueDate, todayDate)}`, className: 'bg-pink' }
  if (delta === 0) return { text: 'Due today', className: 'bg-orange' }
  if (delta === 1) return { text: 'Due tomorrow', className: 'bg-yellow' }
  return { text: `Due ${formatRelativeDay(dueDate, todayDate)}`, className: 'bg-sky' }
}

interface RecurringDueCardProps {
  rule: RecurringRuleRow
  dueDate: string
  todayDate: string
  category?: CategoryRow
  accountName?: string
  onConfirm: () => void
  onSkip: () => void
  busy?: 'confirm' | 'skip' | null
}

/** A template waiting for a decision. Nothing is recorded until Confirm. */
export function RecurringDueCard({
  rule,
  dueDate,
  todayDate,
  category,
  accountName,
  onConfirm,
  onSkip,
  busy,
}: RecurringDueCardProps) {
  const chip = dueChip(dueDate, todayDate)
  const sign = rule.type === 'expense' ? '−' : '+'
  return (
    <article className="flex flex-col gap-3 rounded-card bg-paper p-4 outline-strong shadow-brutal" aria-label={`${rule.name}, ${chip.text}`}>
      <div className="flex items-start gap-3">
        <CategoryBadge icon={category?.icon ?? 'repeat'} color={category?.color ?? 'peach'} />
        <div className="min-w-0 flex-1">
          <Link to={`/recurring/${rule.id}`} className="block truncate font-display text-lg font-extrabold tracking-tight underline-offset-4 hover:underline">
            {rule.name}
          </Link>
          <p className="label-mono text-muted">
            {describeSchedule({ cadence: rule.cadence, intervalCount: rule.interval_count })}
            {accountName ? ` · ${accountName}` : ''}
          </p>
        </div>
        <p className={cn('tabular font-display text-lg font-extrabold', rule.type === 'income' && 'text-positive')}>
          {sign}
          {formatMoney(rule.amount_minor)}
        </p>
      </div>
      <span className={cn('label-mono self-start rounded-pill px-3 py-1.5 outline-regular', chip.className)}>{chip.text}</span>
      <div className="grid grid-cols-2 gap-3">
        <Button size="sm" icon={<SkipForward className="size-4" strokeWidth={2.5} />} onClick={onSkip} loading={busy === 'skip'} disabled={Boolean(busy)}>
          Skip
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Check className="size-4" strokeWidth={3} />}
          onClick={onConfirm}
          loading={busy === 'confirm'}
          disabled={Boolean(busy)}
        >
          Confirm
        </Button>
      </div>
    </article>
  )
}
