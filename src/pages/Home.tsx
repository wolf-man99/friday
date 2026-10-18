import { ArrowRight, Plus, Repeat } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useSettings } from '@/app/settings'
import { describeBalance } from '@/components/finance/AccountCard'
import { HeroAmount } from '@/components/finance/Amount'
import { CategoryGlyph, AccountGlyph } from '@/components/finance/icons'
import { toSlices } from '@/components/finance/CategoryBreakdown'
import { PeriodSelector } from '@/components/finance/PeriodSelector'
import { RecurringDueCard } from '@/components/finance/RecurringDueCard'
import { TransactionRow } from '@/components/finance/TransactionRow'
import { Wordmark } from '@/components/layout/PageHeader'
import { LinkButton } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { cn } from '@/components/ui/cn'
import { EmptyState, InlineError, Skeleton } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { TONE_BG, toneOf } from '@/components/ui/tones'
import {
  useCategoryBreakdown,
  useConfirmOccurrence,
  useDueOccurrences,
  usePeriodSummary,
  useRecentEntries,
  useRecurringRules,
  useSkipOccurrence,
} from '@/data/hooks'
import { occurredAtFor } from '@/data/api'
import { addMonths, diffDays, formatMonthYear, formatRelativeDay, localDate, monthRange, rangeToUtc } from '@/lib/dates'
import { friendlyError } from '@/lib/errors'
import { fitAmountClass, formatMoney, percentOf } from '@/lib/money'
import { activityHref } from './activityParams'

export function Home() {
  const { todayDate, timeZone, accounts, accountsById, categoriesById, profile } = useSettings()
  const [anchor, setAnchor] = useState(todayDate)
  const range = monthRange(anchor)
  const utc = useMemo(() => rangeToUtc({ from: range.from, to: range.to }, timeZone), [range.from, range.to, timeZone])
  const isCurrentMonth = range.from === monthRange(todayDate).from
  const monthName = formatMonthYear(range.from)

  const summary = usePeriodSummary(utc)
  const breakdown = useCategoryBreakdown(utc, 'expense')
  const recent = useRecentEntries(utc, 6)

  const slices = useMemo(() => toSlices(breakdown.data ?? [], categoriesById), [breakdown.data, categoriesById])
  const spent = summary.data?.expense_minor ?? 0
  const received = summary.data?.income_minor ?? 0
  const net = summary.data?.net_minor ?? 0
  const hasEntries = (summary.data?.expense_count ?? 0) + (summary.data?.income_count ?? 0) + (summary.data?.transfer_count ?? 0) > 0

  const active = accounts.filter((a) => a.status === 'active')
  const assets = active.filter((a) => a.type !== 'credit_card')
  const cards = active.filter((a) => a.type === 'credit_card')
  const trackedMinor = assets.reduce((sum, a) => sum + a.balance_minor, 0)
  const owedMinor = cards.reduce((sum, a) => sum + Math.max(0, -a.balance_minor), 0)

  const greeting = profile.display_name ? `Hey ${profile.display_name.split(' ')[0]}` : 'Hey there'

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3 pt-2">
        <Wordmark />
        <span aria-hidden="true" className="scribble -rotate-3 text-2xl">
          {greeting}!
        </span>
      </header>

      <PeriodSelector
        unit="month"
        label={monthName}
        onPrevious={() => setAnchor(addMonths(range.from, -1))}
        onNext={() => setAnchor(addMonths(range.from, 1))}
        nextDisabled={isCurrentMonth}
      />

      <DuePrompts />

      {/* Hero: a flow for the period, never presented as a balance. */}
      <Card tone="orange" shadow="lg" className="relative overflow-hidden px-5 pb-5 pt-4">
        <div className="flex items-start justify-between gap-2">
          <p className="label-mono">Spent {isCurrentMonth ? 'this month' : `in ${monthName}`}</p>
          <Link
            to={activityHref({ range, kind: 'expense' })}
            className="label-mono -mr-1 -mt-1 inline-flex min-h-11 items-center gap-1 rounded-pill px-3 underline underline-offset-2"
          >
            Details <ArrowRight aria-hidden="true" className="size-3.5" strokeWidth={3} />
          </Link>
        </div>
        {summary.isPending ? (
          <Skeleton className="my-2 h-16 w-3/4 bg-ink/15" />
        ) : summary.error ? (
          <InlineError message={friendlyError(summary.error)} onRetry={() => void summary.refetch()} className="mt-2" />
        ) : (
          <HeroAmount minor={spent} className="mt-1 block text-[clamp(3rem,15vw,4.5rem)]" />
        )}
        <p className="mt-1 text-sm font-semibold">
          {summary.data ? `${summary.data.expense_count} ${summary.data.expense_count === 1 ? 'expense' : 'expenses'}` : ' '}
        </p>
        <span aria-hidden="true" className="scribble absolute bottom-2 right-4 rotate-[-6deg] text-[1.6rem]">
          where&rsquo;d it go? ↓
        </span>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card tone="lime" shadow="md" className="flex flex-col gap-1">
          <p className="label-mono">Money in.</p>
          <p className={cn('display tabular', fitAmountClass(formatMoney(received, { sign: 'always' })))} aria-label={`Received ${formatMoney(received)}`}>
            {summary.isPending ? '…' : formatMoney(received, { sign: received > 0 ? 'always' : 'auto' })}
          </p>
          <Link to={activityHref({ range, kind: 'income' })} className="mt-auto text-sm font-semibold underline underline-offset-2">
            See income
          </Link>
        </Card>
        <Card tone={net >= 0 ? 'paper' : 'pink'} shadow="md" className="flex flex-col gap-1">
          <p className="label-mono">Net cash flow</p>
          <p className={cn('display tabular', fitAmountClass(formatMoney(net, { sign: 'always' })))} aria-label={`Net cash flow ${formatMoney(net).replace('−', 'minus ')}`}>
            {summary.isPending ? '…' : formatMoney(net, { sign: 'always' })}
          </p>
          <p className="mt-auto text-sm font-semibold">
            {summary.isPending ? ' ' : net > 0 ? 'More in than out' : net < 0 ? 'More out than in' : 'Even so far'}
          </p>
        </Card>
      </div>

      {slices.length > 0 && (
        <section aria-labelledby="top-categories" className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h2 id="top-categories" className="display text-2xl">
              Where it went
            </h2>
            <Link to="/insights" className="text-sm font-semibold underline underline-offset-2">
              Insights
            </Link>
          </div>
          <ul className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 pt-1 no-scrollbar">
            {slices.slice(0, 6).map((slice, index) => (
              <li key={slice.categoryId ?? 'none'} className="shrink-0">
                <Link
                  to={activityHref({ range, kind: 'expense', category: slice.categoryId ?? 'none' })}
                  className={cn(
                    'pressable flex h-36 flex-col justify-between rounded-[1.5rem] p-3.5 outline-strong shadow-brutal',
                    TONE_BG[toneOf(slice.color)],
                    index === 0 ? 'w-44' : 'w-36',
                  )}
                  aria-label={`${slice.name}: ${formatMoney(slice.totalMinor)}, ${percentOf(slice.totalMinor, spent)}% of spending`}
                >
                  <span aria-hidden="true" className="flex items-center justify-between">
                    <span className="grid size-9 place-items-center rounded-full bg-paper outline-regular">
                      <CategoryGlyph icon={slice.icon} className="size-[1.1rem]" />
                    </span>
                    <span className="label-mono rounded-pill bg-paper px-2 py-0.5 outline-regular">
                      {percentOf(slice.totalMinor, spent)}%
                    </span>
                  </span>
                  <span aria-hidden="true" className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{slice.name}</span>
                    <span className={cn('display tabular block truncate', index === 0 ? 'text-2xl' : 'text-xl')}>
                      {formatMoney(slice.totalMinor)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="balances" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 id="balances" className="display text-2xl">
            Tracked balances
          </h2>
          <Link to="/accounts" className="text-sm font-semibold underline underline-offset-2">
            Accounts
          </Link>
        </div>
        <Card tone="paper" shadow="md" padded={false} className="divide-y-2 divide-ink/10 overflow-hidden">
          <div className="flex items-end justify-between gap-3 bg-peach px-4 py-3">
            <div>
              <p className="label-mono">Across {assets.length} {assets.length === 1 ? 'account' : 'accounts'}</p>
              <p className="display tabular text-3xl">{formatMoney(trackedMinor)}</p>
            </div>
            {cards.length > 0 && (
              <div className="text-right">
                <p className="label-mono">Card dues</p>
                <p className="display tabular text-xl">{formatMoney(owedMinor)}</p>
              </div>
            )}
          </div>
          <ul>
            {active.map((account) => {
              const { label, amount } = describeBalance(account)
              return (
                <li key={account.id}>
                  <Link to={`/accounts/${account.id}`} className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-peach/40">
                    <span aria-hidden="true" className={cn('grid size-9 place-items-center rounded-full outline-regular', TONE_BG[toneOf(account.color)])}>
                      <AccountGlyph type={account.type} className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-semibold">{account.name}</span>
                    <span className="flex flex-col items-end">
                      <span className="label-mono text-muted">{label}</span>
                      <span className="tabular font-display font-extrabold">{amount}</span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </Card>
        <p className="text-sm text-muted">
          Only the accounts you track in Friday — not your full net worth.
        </p>
      </section>

      <section aria-labelledby="recent" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 id="recent" className="display text-2xl">
            Recent
          </h2>
          {hasEntries && (
            <Link to={activityHref({ range })} className="text-sm font-semibold underline underline-offset-2">
              See all
            </Link>
          )}
        </div>
        {recent.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : recent.error ? (
          <InlineError message={friendlyError(recent.error)} onRetry={() => void recent.refetch()} />
        ) : recent.data && recent.data.length > 0 ? (
          <Card padded={false} className="p-1.5">
            <ul>
              {recent.data.map((entry) => (
                <li key={entry.id}>
                  <TransactionRow
                    entry={entry}
                    category={entry.category_id ? categoriesById.get(entry.category_id) : undefined}
                    account={accountsById.get(entry.account_id)}
                    counterAccount={entry.counter_account_id ? accountsById.get(entry.counter_account_id) : undefined}
                    meta={formatRelativeDay(localDate(entry.occurred_at, timeZone), todayDate)}
                  />
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Card tone="canvas" className="border-dashed">
            <EmptyState
              icon={<Plus className="size-9" strokeWidth={3} />}
              tone="orange"
              scribble={isCurrentMonth ? 'fresh start!' : undefined}
              title={isCurrentMonth ? 'Nothing logged yet' : `Nothing logged in ${monthName}`}
              body={isCurrentMonth ? 'Tap + whenever money comes or goes. It takes a few seconds.' : undefined}
              action={
                isCurrentMonth ? (
                  <LinkButton to="/add" state={{ from: '/' }} variant="primary" size="lg" icon={<Plus aria-hidden="true" className="size-5" strokeWidth={3} />}>
                    Add your first entry
                  </LinkButton>
                ) : undefined
              }
            />
          </Card>
        )}
      </section>
    </div>
  )
}

/** Recurring items whose date has arrived. Nothing posts until confirmed. */
function DuePrompts() {
  const { todayDate, timeZone, categoriesById, accountsById } = useSettings()
  const due = useDueOccurrences()
  const rules = useRecurringRules()
  const confirm = useConfirmOccurrence()
  const skip = useSkipOccurrence()
  const toast = useToast()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<{ id: string; action: 'confirm' | 'skip' } | null>(null)

  const rulesById = new Map((rules.data ?? []).map((r) => [r.id, r]))
  const items = (due.data ?? []).filter((o) => rulesById.has(o.rule_id))
  if (items.length === 0) return null

  async function act(ruleId: string, dueDate: string, occurrenceId: string, action: 'confirm' | 'skip') {
    setBusy({ id: occurrenceId, action })
    try {
      if (action === 'confirm') {
        const rule = rulesById.get(ruleId)!
        // A past due date records on that day; today records now.
        const occurredAt = diffDays(dueDate, todayDate) < 0 ? occurredAtFor(dueDate, todayDate, timeZone) : undefined
        const transactionId = await confirm.mutateAsync({ ruleId, dueDate, overrides: { occurredAt } })
        toast({
          message: `Recorded ${rule.name} · ${formatMoney(rule.amount_minor)}`,
          action: { label: 'Edit', onClick: () => navigate(`/entry/${rule.type}/${transactionId}`) },
        })
      } else {
        await skip.mutateAsync({ ruleId, dueDate })
        toast({ message: 'Skipped — nothing was recorded.' })
      }
    } catch (error) {
      toast({ message: friendlyError(error), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="due-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 id="due-heading" className="display flex items-center gap-2 text-2xl">
          <Repeat aria-hidden="true" className="size-5" strokeWidth={2.75} />
          Needs a nod
        </h2>
        <Link to="/recurring" className="text-sm font-semibold underline underline-offset-2">
          {items.length > 2 ? `All ${items.length}` : 'Recurring'}
        </Link>
      </div>
      {items.slice(0, 2).map((occurrence) => {
        const rule = rulesById.get(occurrence.rule_id)!
        return (
          <RecurringDueCard
            key={occurrence.id}
            rule={rule}
            dueDate={occurrence.due_date}
            todayDate={todayDate}
            category={rule.category_id ? categoriesById.get(rule.category_id) : undefined}
            accountName={accountsById.get(rule.account_id)?.name}
            busy={busy?.id === occurrence.id ? busy.action : null}
            onConfirm={() => void act(rule.id, occurrence.due_date, occurrence.id, 'confirm')}
            onSkip={() => void act(rule.id, occurrence.due_date, occurrence.id, 'skip')}
          />
        )
      })}
    </section>
  )
}
