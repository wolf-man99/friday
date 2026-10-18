import { ChartPie, Lightbulb } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSettings } from '@/app/settings'
import { BreakdownLegend, Donut, toSlices, type BreakdownSlice } from '@/components/finance/CategoryBreakdown'
import { PeriodSelector } from '@/components/finance/PeriodSelector'
import { TrendChart } from '@/components/finance/TrendChart'
import { PageHeader } from '@/components/layout/PageHeader'
import { LinkButton } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { cn } from '@/components/ui/cn'
import { PillSwitch } from '@/components/ui/PillSwitch'
import { EmptyState, InlineError, LoadingBlock, Skeleton } from '@/components/ui/States'
import type { CategoryBreakdownRow, CategoryRow, TransactionType } from '@/data/database.types'
import { useCashflowTrend, useCategoryBreakdown, usePeriodSummary } from '@/data/hooks'
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
} from '@/lib/dates'
import { friendlyError } from '@/lib/errors'
import { fitAmountClass, formatMoney, percentOf } from '@/lib/money'
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

  const slices = useMemo(() => toSlices(breakdown.data ?? [], categoriesById), [breakdown.data, categoriesById])
  const total = slices.reduce((sum, s) => sum + s.totalMinor, 0)
  const periodLabel = describePeriod(mode, range)
  const previousLabel = describePeriod(mode, previous)

  const observations = useMemo(
    () =>
      buildObservations({
        current: expenseBreakdown.data ?? [],
        previous: prevBreakdown.data ?? [],
        categories: categoriesById,
        previousLabel,
        income: summary.data?.income_minor ?? 0,
        net: summary.data?.net_minor ?? 0,
      }),
    [expenseBreakdown.data, prevBreakdown.data, categoriesById, previousLabel, summary.data],
  )

  const hrefFor = (slice: BreakdownSlice) => activityHref({ range, kind: type, category: slice.categoryId ?? 'none', period: 'custom' })

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
              <p className="display tabular break-all text-[clamp(2.25rem,12vw,3rem)]">{formatMoney(summary.data!.expense_minor)}</p>
            )}
            <Comparison
              current={summary.data?.expense_minor}
              previous={prevSummary.data?.expense_minor}
              previousLabel={previousLabel}
              noun="spent"
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
              noun="received"
              compact
            />
          </Card>
          <Card tone="paper" shadow="md">
            <p className="label-mono">Net cash flow</p>
            <p className={cn('display tabular', fitAmountClass(formatMoney(summary.data?.net_minor ?? 0, { sign: 'always' }), ['text-2xl', 'text-xl', 'text-base']))}>
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
        ) : slices.length === 0 ? (
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
            <Donut slices={slices} total={total} centerLabel={type === 'expense' ? 'Spent' : 'Received'} />
            <BreakdownLegend slices={slices} total={total} hrefFor={hrefFor} />
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
    </div>
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
  if (current === undefined || previous === undefined) return <p className="text-sm">&nbsp;</p>
  if (previous === 0) {
    return <p className="text-sm font-medium">{compact ? `Nothing in ${previousLabel}` : `Nothing ${noun} in ${previousLabel} to compare with.`}</p>
  }
  const diff = current - previous
  const pct = Math.round((Math.abs(diff) / previous) * 100)
  if (diff === 0) return <p className="text-sm font-medium">Same as {previousLabel}</p>
  const direction = diff > 0 ? 'more' : 'less'
  return (
    <p className="text-sm font-medium">
      {compact ? (
        <>
          {diff > 0 ? '▲' : '▼'} {pct}% vs {previousLabel}
        </>
      ) : (
        <>
          {diff > 0 ? '▲' : '▼'} {formatMoney(Math.abs(diff))} {direction} than {previousLabel} ({pct}%)
        </>
      )}
    </p>
  )
}

const MIN_COMPARABLE = 500_00 // ₹500 — below this, swings are noise.

function buildObservations({
  current,
  previous,
  categories,
  previousLabel,
  income,
  net,
}: {
  current: CategoryBreakdownRow[]
  previous: CategoryBreakdownRow[]
  categories: Map<string, CategoryRow>
  previousLabel: string
  income: number
  net: number
}): string[] {
  const notes: string[] = []
  const total = current.reduce((s, r) => s + r.total_minor, 0)
  const name = (id: string | null) => (id ? (categories.get(id)?.name ?? 'A category') : 'Uncategorised')

  if (current.length > 1 && total > 0) {
    const top = current[0]
    notes.push(`${name(top.category_id)} was your biggest spend: ${formatMoney(top.total_minor)}, ${percentOf(top.total_minor, total)}% of the total.`)
  }

  const prevById = new Map(previous.map((r) => [r.category_id, r.total_minor]))
  const changes = current
    .map((row) => ({ row, before: prevById.get(row.category_id) ?? 0 }))
    .filter(({ row, before }) => before >= MIN_COMPARABLE && row.total_minor >= MIN_COMPARABLE)
    .map(({ row, before }) => ({ row, pct: Math.round(((row.total_minor - before) / before) * 100) }))
    .filter(({ pct }) => Math.abs(pct) >= 20)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 3)
  for (const { row, pct } of changes) {
    notes.push(`${name(row.category_id)} spending is ${Math.abs(pct)}% ${pct > 0 ? 'higher' : 'lower'} than ${previousLabel}.`)
  }

  if (income > 0 && net > 0) {
    notes.push(`You kept ${percentOf(net, income)}% of what came in (${formatMoney(net)}).`)
  } else if (income > 0 && net < 0) {
    notes.push(`Spending was ${formatMoney(-net)} more than what came in.`)
  }
  return notes
}
