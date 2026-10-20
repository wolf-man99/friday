import { ChartPie, ChevronRight, Lightbulb } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useSettings } from '@/app/settings'
import { BreakdownLegend, Donut, toSlices, type BreakdownSlice } from '@/components/finance/CategoryBreakdown'
import { CategoryBadge } from '@/components/finance/CategoryTile'
import { AccountGlyph } from '@/components/finance/icons'
import { PeriodSelector } from '@/components/finance/PeriodSelector'
import { TrendChart } from '@/components/finance/TrendChart'
import { PageHeader } from '@/components/layout/PageHeader'
import { LinkButton } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { cn } from '@/components/ui/cn'
import { PillSwitch } from '@/components/ui/PillSwitch'
import { EmptyState, InlineError, LoadingBlock, Skeleton } from '@/components/ui/States'
import { TONE_BG, toneOf } from '@/components/ui/tones'
import type { CategoryBreakdownRow, TransactionType } from '@/data/database.types'
import { useAccountActivity, useCashflowTrend, useCategoryBreakdown, usePeriodSummary } from '@/data/hooks'
import { compareTotals, describeAccountActivity, offsetSentence, spendingHeadline, splitBreakdown } from '@/features/insights/figures'
import { buildObservations } from '@/features/insights/observations'
import {
  addDays,
  addMonths,
  formatDate,
  formatMonthYear,
  formatRange,
  formatShortMonth,
  monthRange,
  parseISODate,
  previousRange,
  rangeToUtc,
  toISODate,
  weekRange,
  type DateRange,
  type UtcRange,
} from '@/lib/dates'
import { friendlyError } from '@/lib/errors'
import { fitAmountClass, formatMoney } from '@/lib/money'
import { activityHref } from './activityParams'

type Mode = 'week' | 'month' | 'year'

function rangeFor(mode: Mode, anchor: string): DateRange {
  if (mode === 'week') return weekRange(anchor)
  if (mode === 'month') return monthRange(anchor)
  const { year } = parseISODate(anchor)
  return { from: toISODate(year, 1, 1), to: toISODate(year, 12, 31) }
}

function shiftAnchor(mode: Mode, anchor: string, direction: 1 | -1) {
  if (mode === 'week') return addDays(anchor, 7 * direction)
  if (mode === 'month') return addMonths(anchor, direction)
  return addMonths(anchor, 12 * direction)
}

/** Window shown by the trend chart, ending with the selected period. */
function trendWindow(mode: Mode, range: DateRange): { range: DateRange; bucket: 'week' | 'month' } {
  if (mode === 'week') return { range: { from: addDays(range.from, -7 * 7), to: range.to }, bucket: 'week' }
  if (mode === 'month') return { range: { from: addMonths(range.from, -5), to: range.to }, bucket: 'month' }
  return { range, bucket: 'month' }
}

function describePeriod(mode: Mode, range: DateRange) {
  if (mode === 'year') return String(parseISODate(range.from).year)
  return formatRange(range)
}

export function Insights() {
  const { todayDate, timeZone, categoriesById } = useSettings()
  const [mode, setMode] = useState<Mode>('month')
  const [anchor, setAnchor] = useState(todayDate)
  const [type, setType] = useState<TransactionType>('expense')

  const range = rangeFor(mode, anchor)
  const previous = previousRange(range)
  const trend = trendWindow(mode, range)
  const isCurrent = range.to >= todayDate

  const utc = useMemo(() => rangeToUtc(range, timeZone), [range.from, range.to, timeZone])
  const prevUtc = useMemo(() => rangeToUtc(previous, timeZone), [previous.from, previous.to, timeZone])
  const trendUtc = useMemo(() => rangeToUtc(trend.range, timeZone), [trend.range.from, trend.range.to, timeZone])

  const summary = usePeriodSummary(utc)
  const prevSummary = usePeriodSummary(prevUtc)
  const breakdown = useCategoryBreakdown(utc, type)
  const prevBreakdown = useCategoryBreakdown(prevUtc, 'expense')
  const expenseBreakdown = useCategoryBreakdown(utc, 'expense')
  const trendData = useCashflowTrend(trendUtc, trend.bucket)

  // The donut draws only categories with a net total above zero; the rest are said in words.
  const split = useMemo(() => splitBreakdown(breakdown.data ?? []), [breakdown.data])
  const slices = useMemo(() => toSlices(split.drawn, categoriesById), [split.drawn, categoriesById])
  const offsets = useMemo(() => toSlices(split.offset, categoriesById), [split.offset, categoriesById])
  const periodLabel = describePeriod(mode, range)
  const previousLabel = describePeriod(mode, previous)
  const headline = spendingHeadline(summary.data)
  const prevHeadline = spendingHeadline(prevSummary.data)

  const observations = useMemo(
    () =>
      buildObservations({
        current: expenseBreakdown.data ?? [],
        previous: prevBreakdown.data ?? [],
        categoryName: (id) => (id ? (categoriesById.get(id)?.name ?? 'A category') : 'Uncategorised'),
        previousLabel,
        income: summary.data?.income_minor ?? 0,
        spending: summary.data?.expense_minor ?? 0,
      }),
    [expenseBreakdown.data, prevBreakdown.data, categoriesById, previousLabel, summary.data],
  )

  // No kind filter: a category's list then shows its refunds too, which the net figure includes.
  const hrefFor = (slice: BreakdownSlice) => activityHref({ range, category: slice.categoryId ?? 'none', period: 'custom' })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Insights" scribble="where'd it go?" />

      <PillSwitch
        label="Period length"
        options={[
          { value: 'week', label: 'Week' },
          { value: 'month', label: 'Month' },
          { value: 'year', label: 'Year' },
        ]}
        value={mode}
        onChange={(next) => {
          setMode(next)
          setAnchor(todayDate)
        }}
      />
      <PeriodSelector
        unit={mode}
        label={periodLabel}
        onPrevious={() => setAnchor(shiftAnchor(mode, range.from, -1))}
        onNext={() => setAnchor(shiftAnchor(mode, range.from, 1))}
        nextDisabled={isCurrent}
      />

      {summary.error ? (
        <InlineError message={friendlyError(summary.error)} onRetry={() => void summary.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Card tone="orange" shadow="md" className="col-span-2">
            <p className="label-mono">Spent · {periodLabel}</p>
            {summary.isPending ? (
              <Skeleton className="my-1 h-12 w-2/3 bg-ink/15" />
            ) : (
              <p className="display tabular break-all text-[clamp(2.25rem,12vw,3rem)]" aria-label={`Spent ${formatMoney(headline.spentMinor)}`}>
                {formatMoney(headline.spentMinor)}
              </p>
            )}
            {summary.data && (headline.refundsMinor > 0 || headline.cameBackMinor > 0) && (
              <p className="text-sm font-semibold">
                {headline.refundsMinor > 0 && `Net of refunds ${formatMoney(headline.refundsMinor)}.`}
                {headline.cameBackMinor > 0 && ` ${formatMoney(headline.cameBackMinor)} more came back than went out.`}
              </p>
            )}
            <Comparison
              current={summary.data ? headline.spentMinor : undefined}
              previous={prevSummary.data ? prevHeadline.spentMinor : undefined}
              previousLabel={previousLabel}
              noun="spending"
            />
          </Card>
          <Card tone="lime" shadow="md">
            <p className="label-mono">Money in</p>
            <p className={cn('display tabular', fitAmountClass(formatMoney(summary.data?.income_minor ?? 0), ['text-2xl', 'text-xl', 'text-base']))}>
              {summary.data ? formatMoney(summary.data.income_minor) : '…'}
            </p>
            <Comparison
              current={summary.data?.income_minor}
              previous={prevSummary.data?.income_minor}
              previousLabel={previousLabel}
              noun="income"
              compact
            />
          </Card>
          <Card tone="paper" shadow="md">
            <p className="label-mono">Net cash flow</p>
            <p
              className={cn('display tabular', fitAmountClass(formatMoney(summary.data?.net_minor ?? 0, { sign: 'always' }), ['text-2xl', 'text-xl', 'text-base']))}
              aria-label={summary.data ? `Net cash flow ${formatMoney(summary.data.net_minor).replace('−', 'minus ')}` : undefined}
            >
              {summary.data ? formatMoney(summary.data.net_minor, { sign: 'always' }) : '…'}
            </p>
            <p className="text-sm text-muted">Transfers excluded</p>
          </Card>
        </div>
      )}

      <Card shadow="md" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="display text-2xl">By category</h2>
        </div>
        <PillSwitch
          label="Breakdown of"
          options={[
            { value: 'expense', label: 'Spending' },
            { value: 'income', label: 'Income' },
          ]}
          value={type}
          onChange={setType}
        />
        {breakdown.isPending ? (
          <LoadingBlock rows={3} label="Loading breakdown" />
        ) : breakdown.error ? (
          <InlineError message={friendlyError(breakdown.error)} onRetry={() => void breakdown.refetch()} />
        ) : slices.length === 0 && offsets.length === 0 ? (
          <EmptyState
            icon={<ChartPie className="size-9" strokeWidth={2.5} />}
            tone="purple"
            title={type === 'expense' ? 'No spending recorded' : 'No income recorded'}
            body={`Nothing in ${periodLabel} yet.`}
            action={
              <LinkButton to={`/add?kind=${type}`} variant="primary" size="sm">
                Add {type === 'expense' ? 'an expense' : 'income'}
              </LinkButton>
            }
          />
        ) : (
          <>
            {slices.length > 0 ? (
              <>
                <Donut slices={slices} total={split.drawnTotalMinor} centerLabel={type === 'expense' ? 'Spent' : 'Received'} />
                <BreakdownLegend
                  slices={slices}
                  total={split.drawnTotalMinor}
                  hrefFor={hrefFor}
                  offsetWord={type === 'expense' ? 'refunds' : 'reversals'}
                />
              </>
            ) : (
              <p className="text-sm font-medium">
                {type === 'expense' ? `No net spending in any category in ${periodLabel}.` : `No net income in any category in ${periodLabel}.`}
              </p>
            )}
            {offsets.length > 0 && (
              <OffsetList
                slices={offsets}
                rows={split.offset}
                type={type}
                hrefFor={hrefFor}
                netNote={
                  type !== 'expense' || !summary.data
                    ? null
                    : headline.cameBackMinor > 0
                      ? `Overall, ${formatMoney(headline.cameBackMinor)} more came back than went out.`
                      : `Overall, net spending was ${formatMoney(headline.spentMinor)}.`
                }
              />
            )}
          </>
        )}
      </Card>

      {observations.length > 0 && (
        <Card tone="yellow" shadow="md" className="flex flex-col gap-3">
          <h2 className="display flex items-center gap-2 text-2xl">
            <Lightbulb aria-hidden="true" className="size-6" strokeWidth={2.5} />
            Worth knowing
          </h2>
          <ul className="flex flex-col gap-2">
            {observations.map((text) => (
              <li key={text} className="rounded-2xl bg-paper px-3 py-2.5 text-[0.95rem] font-medium outline-regular">
                {text}
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink/80">Based only on what you’ve recorded, compared with {previousLabel}.</p>
        </Card>
      )}

      <Card shadow="md" className="flex flex-col gap-3">
        <h2 className="display text-2xl">{trend.bucket === 'week' ? 'Last 8 weeks' : mode === 'year' ? `Month by month` : 'Last 6 months'}</h2>
        {trendData.isPending ? (
          <Skeleton className="h-44" />
        ) : trendData.error ? (
          <InlineError message={friendlyError(trendData.error)} onRetry={() => void trendData.refetch()} />
        ) : (
          <TrendChart
            rows={trendData.data ?? []}
            activeBucket={mode === 'year' ? undefined : range.from}
            labelFor={(start) => (trend.bucket === 'week' ? formatDate(start) : formatShortMonth(start))}
            longLabelFor={(start) =>
              trend.bucket === 'week' ? `Week of ${formatDate(start, { withYear: true })}` : formatMonthYear(start)
            }
            hrefFor={(start) =>
              activityHref({
                range: trend.bucket === 'week' ? { from: start, to: addDays(start, 6) } : monthRange(start),
                period: trend.bucket === 'week' ? 'week' : 'month',
              })
            }
          />
        )}
      </Card>

      <AccountActivity range={range} utc={utc} periodLabel={periodLabel} />
    </div>
  )
}

/** Categories the donut leaves out because refunds (or reversals) matched or outweighed them. */
function OffsetList({
  slices,
  rows,
  type,
  hrefFor,
  netNote,
}: {
  slices: BreakdownSlice[]
  rows: CategoryBreakdownRow[]
  type: TransactionType
  hrefFor: (slice: BreakdownSlice) => string
  netNote: string | null
}) {
  return (
    <div className="flex flex-col gap-2 border-t-2 border-ink/10 pt-3">
      <h3 className="label-mono">{type === 'expense' ? 'More came back than went out' : 'Reversed'}</h3>
      <ul className="flex flex-col gap-1">
        {slices.map((slice, index) => {
          const sentence = offsetSentence(slice.name, rows[index], type)
          return (
            <li key={slice.categoryId ?? 'none'}>
              <Link
                to={hrefFor(slice)}
                aria-label={`${sentence}. Show transactions`}
                className="flex min-h-11 items-center gap-3 rounded-2xl px-2 py-1.5 hover:bg-peach/50 focus-visible:bg-peach/50"
              >
                <CategoryBadge icon={slice.icon} color={slice.color} size="sm" />
                <span aria-hidden="true" className="min-w-0 flex-1 text-[0.95rem] font-medium">
                  {sentence}
                </span>
                <ChevronRight aria-hidden="true" className="size-4 shrink-0" strokeWidth={2.5} />
              </Link>
            </li>
          )
        })}
      </ul>
      {netNote && <p className="text-sm text-muted">{netNote}</p>}
    </div>
  )
}

/** Money in and out per account for the period, with transfers kept on their own lines. */
function AccountActivity({ range, utc, periodLabel }: { range: DateRange; utc: UtcRange; periodLabel: string }) {
  const { accountsById } = useSettings()
  const activity = useAccountActivity(utc)
  const rows = activity.data ?? []
  return (
    <Card as="section" shadow="md" aria-labelledby="by-account" className="flex flex-col gap-3">
      <h2 id="by-account" className="display text-2xl">
        By account
      </h2>
      {activity.isPending ? (
        <LoadingBlock rows={2} label="Loading account activity" />
      ) : activity.error ? (
        <InlineError message={friendlyError(activity.error)} onRetry={() => void activity.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-sm font-medium">No account activity in {periodLabel}.</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {rows.map((row) => {
            const account = accountsById.get(row.account_id)
            const name = account ? `${account.name}${account.status === 'archived' ? ' (archived)' : ''}` : 'Unknown account'
            const hasTransfers = row.transfers_in_minor > 0 || row.transfers_out_minor > 0
            return (
              <li key={row.account_id}>
                <Link
                  to={activityHref({ period: 'custom', range, account: row.account_id })}
                  aria-label={describeAccountActivity(name, row, periodLabel)}
                  className="flex min-h-16 items-center gap-3 rounded-2xl px-2 py-2.5 hover:bg-peach/50 focus-visible:bg-peach/50"
                >
                  <span
                    aria-hidden="true"
                    className={cn('grid size-10 shrink-0 place-items-center rounded-full outline-regular', TONE_BG[toneOf(account?.color)])}
                  >
                    {account && <AccountGlyph type={account.type} className="size-4" />}
                  </span>
                  <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate font-semibold">{name}</span>
                    <span className="flex flex-wrap gap-x-4 gap-y-1">
                      <Figure label="In" value={formatMoney(row.money_in_minor, { sign: 'always' })} positive={row.money_in_minor > 0} />
                      <Figure label="Out" value={formatMoney(-row.money_out_minor)} />
                      {hasTransfers && <Figure label="Transfers in" value={formatMoney(row.transfers_in_minor)} />}
                      {hasTransfers && <Figure label="Transfers out" value={formatMoney(row.transfers_out_minor)} />}
                    </span>
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0" strokeWidth={2.5} />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-sm text-muted">
        In includes refunds; out includes reversed income. Transfers between your accounts are shown apart and never count as
        income or spending.
      </p>
    </Card>
  )
}

function Figure({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <span className="flex flex-col">
      <span className="label-mono text-muted">{label}</span>
      <span className={cn('tabular whitespace-nowrap font-display font-extrabold', positive && 'text-positive')}>{value}</span>
    </span>
  )
}

function Comparison({
  current,
  previous,
  previousLabel,
  noun,
  compact,
}: {
  current?: number
  previous?: number
  previousLabel: string
  noun: string
  compact?: boolean
}) {
  const change = compareTotals(current, previous)
  if (change.kind === 'unknown') return <p className="text-sm">&nbsp;</p>
  if (change.kind === 'no-base') {
    return <p className="text-sm font-medium">{compact ? `Nothing in ${previousLabel}` : `No ${noun} in ${previousLabel} to compare with.`}</p>
  }
  if (change.kind === 'same') return <p className="text-sm font-medium">Same as {previousLabel}</p>
  const arrow = change.up ? '▲' : '▼'
  return (
    <p className="text-sm font-medium">
      {compact ? (
        <>
          {arrow} {change.percent}% vs {previousLabel}
        </>
      ) : (
        <>
          {arrow} {formatMoney(change.diffMinor)} {change.up ? 'more' : 'less'} than {previousLabel} ({change.percent}%)
        </>
      )}
    </p>
  )
}
