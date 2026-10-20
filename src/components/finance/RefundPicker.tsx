import { Check, RotateCcw } from 'lucide-react'
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSettings } from '@/app/settings'
import { Button } from '@/components/ui/Button'
import { cn } from '@/components/ui/cn'
import { Dialog } from '@/components/ui/Dialog'
import { SelectField } from '@/components/ui/Field'
import { InlineError, LoadingBlock } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { useMakeRefund, useOffsetCandidates } from '@/data/hooks'
import { formatDate, localDate } from '@/lib/dates'
import { classifyError, friendlyError } from '@/lib/errors'
import { formatMoney } from '@/lib/money'
import { Amount } from './Amount'
import { CandidateSearchField, ShowOlderButton, useCandidateBrowse } from './CandidateSearch'
import { CategoryBadge } from './CategoryTile'
import { entryTitle } from './TransactionRow'

export interface RefundPickerEntry {
  id: string
  /** Income that was really a refund, or a refund recorded without its purchase. */
  kind: 'income' | 'refund'
  amount_minor: number
  occurred_at: string
  updated_at: string
}

interface RefundPickerProps {
  open: boolean
  onClose: () => void
  entry: RefundPickerEntry
  /** After the change is saved (the entry is now a refund). */
  onDone: () => void
  /** After a "changed elsewhere" conflict: reload the latest version. */
  onReload?: () => void
}

const NONE = 'none'

/**
 * Turns income that was really money back into a refund of a purchase (or an
 * unlinked refund in an expense category), or links a refund to its purchase.
 * Either way it then lowers spending instead of counting as income.
 */
export function RefundPicker(props: RefundPickerProps) {
  const title = props.entry.kind === 'income' ? 'This was a refund' : 'Link to purchase'
  return (
    <Dialog open={props.open} onClose={props.onClose} title={title} variant="sheet">
      <RefundPickerBody {...props} />
    </Dialog>
  )
}

function RefundPickerBody({ onClose, entry, onDone, onReload }: RefundPickerProps) {
  const { accountsById, categories, categoriesById, timeZone } = useSettings()
  const toast = useToast()
  const makeRefund = useMakeRefund()
  const submitting = useRef(false)
  const name = useId()
  const isIncome = entry.kind === 'income'
  const browse = useCandidateBrowse()
  const candidates = useOffsetCandidates({
    kinds: ['expense'],
    minAmountMinor: entry.amount_minor,
    before: entry.occurred_at,
    ...browse.query,
  })
  const [choice, setChoice] = useState<string | null>(null)
  const [categoryId, setCategoryId] = useState('')
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null)

  const expenseCategories = useMemo(
    () => categories.filter((c) => c.transaction_type === 'expense' && !c.is_archived),
    [categories],
  )
  const rows = candidates.data ?? []
  const chosen = rows.find((row) => row.id === choice)

  async function confirm() {
    if (submitting.current || !choice) return
    submitting.current = true
    setError(null)
    try {
      await makeRefund.mutateAsync({
        id: entry.id,
        originalId: choice === NONE ? null : choice,
        categoryId: choice === NONE ? categoryId || null : null,
        expectedUpdatedAt: entry.updated_at,
      })
      const title = chosen ? entryTitle(chosen, chosen.category_id ? categoriesById.get(chosen.category_id) : undefined) : null
      toast({
        message: title
          ? `Now a refund of ${title} — it lowers your spending`
          : 'Now a refund — it lowers your spending instead of counting as income',
      })
      onDone()
    } catch (err) {
      setError({ message: friendlyError(err), conflict: classifyError(err) === 'conflict' })
    } finally {
      submitting.current = false
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {isIncome
          ? 'Money back for a purchase isn’t income. As a refund it lowers your spending in that purchase’s category instead.'
          : 'Pick the purchase this money came back for, so it nets against the right spending.'}
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className="label-mono mb-2">Which purchase?</legend>
        <p className="-mt-1 text-sm text-muted">
          Posted purchases of {formatMoney(entry.amount_minor)} or more, on or before{' '}
          {formatDate(localDate(entry.occurred_at, timeZone), { withYear: true })}.
        </p>
        <CandidateSearchField value={browse.search} onChange={browse.setSearch} />
        {candidates.isPending ? (
          <LoadingBlock rows={2} label="Loading purchases" />
        ) : candidates.error ? (
          <InlineError message={friendlyError(candidates.error)} onRetry={() => void candidates.refetch()} />
        ) : rows.length === 0 ? (
          <p className="rounded-2xl bg-canvas px-4 py-3 text-sm outline-regular">
            {browse.search.trim() ? 'No purchases match that search.' : 'No purchases like that yet.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const category = row.category_id ? categoriesById.get(row.category_id) : undefined
              const selected = choice === row.id
              const title = entryTitle(row, category)
              const meta = [
                formatDate(localDate(row.occurred_at, timeZone), { withYear: true }),
                accountsById.get(row.account_id)?.name,
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <li key={row.id}>
                  <CandidateOption name={name} value={row.id} selected={selected} onSelect={() => setChoice(row.id)}>
                    <CategoryBadge icon={category?.icon ?? 'tag'} color={category?.color ?? 'peach'} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-semibold">{title}</span>
                      <span className="label-mono truncate text-muted">{meta}</span>
                    </span>
                    <Amount
                      minor={row.amount_minor}
                      kind="expense"
                      className="shrink-0 font-display font-extrabold tracking-tight"
                    />
                  </CandidateOption>
                </li>
              )
            })}
          </ul>
        )}
        {!candidates.isPending && !candidates.error && browse.hasMore(rows.length) && <ShowOlderButton onClick={browse.more} />}
        {isIncome && (
          <CandidateOption name={name} value={NONE} selected={choice === NONE} onSelect={() => setChoice(NONE)}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold">No purchase in Friday</span>
              <span className="text-sm text-muted">Keep it as an unlinked refund in an expense category.</span>
            </span>
          </CandidateOption>
        )}
      </fieldset>

      {isIncome && choice === NONE && (
        <SelectField
          label="Expense category"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          hint="The refund lowers spending in this category."
        >
          <option value="">No category</option>
          {expenseCategories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </SelectField>
      )}

      {error && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-2xl bg-paper px-3.5 py-3 text-sm font-semibold outline-regular"
        >
          <p>{error.message}</p>
          {error.conflict && onReload && (
            <Button
              size="sm"
              icon={<RotateCcw className="size-4" strokeWidth={2.75} />}
              onClick={() => {
                onReload()
                onClose()
              }}
            >
              Load the latest version
            </Button>
          )}
        </div>
      )}

      <div className="flex gap-3 pt-1">
        <Button block onClick={onClose} disabled={makeRefund.isPending}>
          Cancel
        </Button>
        <Button block variant="primary" loading={makeRefund.isPending} disabled={!choice} onClick={() => void confirm()}>
          {isIncome ? 'Make it a refund' : 'Link purchase'}
        </Button>
      </div>
    </div>
  )
}

function CandidateOption({
  name,
  value,
  selected,
  onSelect,
  children,
}: {
  name: string
  value: string
  selected: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <label
      className={cn(
        'flex min-h-16 cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink',
        selected ? 'bg-peach outline-strong' : 'bg-paper outline-regular hover:bg-peach/50',
      )}
    >
      <input type="radio" name={name} value={value} checked={selected} onChange={onSelect} className="sr-only" />
      {children}
      <span
        aria-hidden="true"
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-full outline-regular',
          selected ? 'bg-ink text-paper' : 'bg-paper',
        )}
      >
        {selected && <Check className="size-3.5" strokeWidth={3.5} />}
      </span>
    </label>
  )
}
