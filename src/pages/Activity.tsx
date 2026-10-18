import { ListOrdered, Search, SearchX, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useSettings } from '@/app/settings'
import { DayGroupHeader, TransactionRow } from '@/components/finance/TransactionRow'
import { PeriodSelector } from '@/components/finance/PeriodSelector'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button, LinkButton } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SelectChip, ToggleChip } from '@/components/ui/Chip'
import { TextField } from '@/components/ui/Field'
import { Dialog } from '@/components/ui/Dialog'
import { EmptyState, InlineError, LoadingBlock } from '@/components/ui/States'
import type { EntryKind, LedgerEntryRow } from '@/data/database.types'
import { useFeed } from '@/data/hooks'
import {
  addDays,
  formatRange,
  formatRelativeDay,
  localDate,
  monthRange,
  rangeToUtc,
  weekRange,
  type DateRange,
} from '@/lib/dates'
import { friendlyError } from '@/lib/errors'
import { activitySearch, readActivityParams, shiftMonth, type ActivityFilters, type PeriodMode } from './activityParams'

const KIND_CHIPS: { value: EntryKind | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'expense', label: 'Money out' },
  { value: 'income', label: 'Money in' },
  { value: 'transfer', label: 'Transfers' },
]

export function Activity() {
  const { todayDate, timeZone, accounts, accountsById, categories, categoriesById } = useSettings()
  const [params, setParams] = useSearchParams()
  const filters = readActivityParams(params, todayDate)
  const [searchText, setSearchText] = useState(filters.q)
  const [customOpen, setCustomOpen] = useState(false)

  function apply(patch: Partial<ActivityFilters>) {
    const next = { ...filters, ...patch }
    setParams(activitySearch(next), { replace: true })
  }

  // Debounce search typing into the URL.
  useEffect(() => {
    if (searchText === filters.q) return
    const timer = window.setTimeout(() => apply({ q: searchText.trim() }), 300)
    return () => window.clearTimeout(timer)
  }, [searchText])

  const utcRange = useMemo(
    () => (filters.range ? rangeToUtc(filters.range, timeZone) : null),
    [filters.range?.from, filters.range?.to, timeZone],
  )

  const searchCategoryIds = useMemo(() => {
    const q = filters.q.toLowerCase()
    return q ? categories.filter((c) => c.name.toLowerCase().includes(q)).map((c) => c.id) : []
  }, [filters.q, categories])

  const feed = useFeed(
    {
      range: utcRange,
      kind: filters.kind,
      accountId: filters.account,
      categoryId: filters.category && filters.category !== 'none' ? filters.category : null,
      uncategorised: filters.category === 'none',
      search: filters.q,
    },
    searchCategoryIds,
  )

  const entries = useMemo(() => feed.data?.pages.flat() ?? [], [feed.data])
  const groups = useMemo(() => groupByDay(entries, timeZone), [entries, timeZone])
  const filtersActive = Boolean(filters.kind || filters.account || filters.category || filters.q)

  const periodOptions = [
    { value: 'month', label: 'Month' },
    { value: 'week', label: 'Week' },
    { value: 'all', label: 'All time' },
    { value: 'custom', label: filters.period === 'custom' && filters.range ? formatRange(filters.range) : 'Custom…' },
  ]

  function changePeriod(mode: string) {
    const period = mode as PeriodMode
    if (period === 'custom') {
      setCustomOpen(true)
      return
    }
    const anchor = filters.range?.to && filters.range.to < todayDate ? filters.range.to : todayDate
    const range = period === 'month' ? monthRange(anchor) : period === 'week' ? weekRange(anchor) : null
    apply({ period, range })
  }

  function shift(direction: 1 | -1) {
    if (!filters.range) return
    if (filters.period === 'week') {
      apply({ range: { from: addDays(filters.range.from, 7 * direction), to: addDays(filters.range.to, 7 * direction) } })
    } else {
      apply({ range: shiftMonth(filters.range, direction) })
    }
  }

  const categoryOptions = [
    { value: '', label: 'Any category' },
    { value: 'none', label: 'Uncategorised' },
    ...categories
      .filter((c) => !filters.kind || filters.kind === c.transaction_type)
      .map((c) => ({ value: c.id, label: `${c.name}${c.is_archived ? ' (archived)' : ''}` })),
  ]

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Activity" scribble="every rupee" />

      <div className="flex min-h-12 items-center gap-2 rounded-pill bg-paper px-4 outline-strong focus-within:shadow-brutal">
        <Search aria-hidden="true" className="size-5 shrink-0" strokeWidth={2.5} />
        <label htmlFor="activity-search" className="sr-only">
          Search notes and categories
        </label>
        <input
          id="activity-search"
          type="search"
          placeholder="Search notes or categories"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          className="min-h-11 w-full bg-transparent focus:outline-none"
        />
        {searchText && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setSearchText('')
              apply({ q: '' })
            }}
            className="grid size-9 place-items-center rounded-full"
          >
            <X aria-hidden="true" className="size-4" strokeWidth={3} />
          </button>
        )}
      </div>

      <div role="group" aria-label="Filter by type" className="-mx-4 flex gap-2 overflow-x-auto px-4 py-0.5 no-scrollbar">
        {KIND_CHIPS.map((chip) => (
          <ToggleChip
            key={chip.label}
            selected={filters.kind === chip.value}
            onClick={() => apply({ kind: chip.value, category: chip.value === 'transfer' ? null : filters.category })}
          >
            {chip.label}
          </ToggleChip>
        ))}
      </div>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 py-0.5 no-scrollbar">
        <SelectChip label="Period" value={filters.period} options={periodOptions} onChange={changePeriod} active={filters.period !== 'month'} />
        <SelectChip
          label="Account"
          value={filters.account ?? ''}
          options={[{ value: '', label: 'Any account' }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
          onChange={(value) => apply({ account: value || null })}
          active={Boolean(filters.account)}
        />
        {filters.kind !== 'transfer' && (
          <SelectChip
            label="Category"
            value={filters.category ?? ''}
            options={categoryOptions}
            onChange={(value) => apply({ category: value || null })}
            active={Boolean(filters.category)}
          />
        )}
      </div>

      {filters.range && (filters.period === 'month' || filters.period === 'week') && (
        <PeriodSelector
          unit={filters.period}
          label={formatRange(filters.range)}
          onPrevious={() => shift(-1)}
          onNext={() => shift(1)}
          nextDisabled={filters.range.to >= todayDate}
        />
      )}
      {filters.period === 'custom' && filters.range && (
        <p className="text-center font-display text-lg font-extrabold">{formatRange(filters.range)}</p>
      )}

      {feed.isPending ? (
        <LoadingBlock rows={5} label="Loading transactions" />
      ) : feed.error ? (
        <InlineError message={friendlyError(feed.error)} onRetry={() => void feed.refetch()} />
      ) : entries.length === 0 ? (
        filtersActive || filters.period !== 'all' ? (
          <EmptyState
            icon={<SearchX className="size-9" strokeWidth={2.5} />}
            tone="sky"
            title="No transactions match"
            body={filtersActive ? 'Try a different search or clear the filters.' : `Nothing recorded in ${filters.range ? formatRange(filters.range) : 'this period'}.`}
            action={
              filtersActive ? (
                <Button
                  onClick={() => {
                    setSearchText('')
                    apply({ kind: null, account: null, category: null, q: '' })
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button onClick={() => apply({ period: 'all', range: null })}>Show all time</Button>
              )
            }
          />
        ) : (
          <EmptyState
            icon={<ListOrdered className="size-9" strokeWidth={2.5} />}
            tone="lime"
            scribble="blank page!"
            title="No entries yet"
            body="Everything you record shows up here, grouped by day."
            action={
              <LinkButton to="/add" variant="primary">
                Add an entry
              </LinkButton>
            }
          />
        )
      ) : (
        <div className="flex flex-col gap-3" aria-busy={feed.isFetching}>
          {groups.map((group) => (
            <section key={group.date} aria-label={formatRelativeDay(group.date, todayDate)}>
              <DayGroupHeader
                label={formatRelativeDay(group.date, todayDate)}
                expenseMinor={group.expenseMinor}
                incomeMinor={group.incomeMinor}
              />
              <Card padded={false} className="p-1.5">
                <ul>
                  {group.entries.map((entry) => (
                    <li key={entry.id}>
                      <TransactionRow
                        entry={entry}
                        category={entry.category_id ? categoriesById.get(entry.category_id) : undefined}
                        account={accountsById.get(entry.account_id)}
                        counterAccount={entry.counter_account_id ? accountsById.get(entry.counter_account_id) : undefined}
                      />
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}
          {feed.hasNextPage && (
            <Button block loading={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
              Load more
            </Button>
          )}
          {feed.hasNextPage && (
            <p className="text-center text-sm text-muted">Day totals cover the entries loaded so far.</p>
          )}
        </div>
      )}

      <CustomRangeDialog
        open={customOpen}
        initial={filters.range ?? monthRange(todayDate)}
        onClose={() => setCustomOpen(false)}
        onApply={(range) => {
          setCustomOpen(false)
          apply({ period: 'custom', range })
        }}
      />
    </div>
  )
}

interface DayGroup {
  date: string
  entries: LedgerEntryRow[]
  expenseMinor: number
  incomeMinor: number
}

function groupByDay(entries: LedgerEntryRow[], timeZone: string): DayGroup[] {
  const groups: DayGroup[] = []
  for (const entry of entries) {
    const date = localDate(entry.occurred_at, timeZone)
    let group = groups[groups.length - 1]
    if (!group || group.date !== date) {
      group = { date, entries: [], expenseMinor: 0, incomeMinor: 0 }
      groups.push(group)
    }
    group.entries.push(entry)
    if (entry.kind === 'expense') group.expenseMinor += entry.amount_minor
    if (entry.kind === 'income') group.incomeMinor += entry.amount_minor
  }
  return groups
}

function CustomRangeDialog({
  open,
  initial,
  onClose,
  onApply,
}: {
  open: boolean
  initial: DateRange
  onClose: () => void
  onApply: (range: DateRange) => void
}) {
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  useEffect(() => {
    if (open) {
      setFrom(initial.from)
      setTo(initial.to)
    }
  }, [open])
  const invalid = !from || !to || from > to
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Custom dates"
      variant="sheet"
      footer={
        <Button variant="primary" block disabled={invalid} onClick={() => onApply({ from, to })}>
          Show these dates
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextField
          label="To (inclusive)"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          error={from && to && from > to ? 'The end date must be on or after the start date' : null}
        />
      </div>
    </Dialog>
  )
}
