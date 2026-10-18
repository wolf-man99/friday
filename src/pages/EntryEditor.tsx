import { ArrowDownLeft, ArrowLeftRight, ArrowUpDown, ArrowUpRight, Check, ChevronDown, Trash, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useSettings } from '@/app/settings'
import { AccountGlyph } from '@/components/finance/icons'
import { AmountInput } from '@/components/finance/AmountInput'
import { CategoryTile } from '@/components/finance/CategoryTile'
import { Button } from '@/components/ui/Button'
import { cn } from '@/components/ui/cn'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { TextAreaField, TextField } from '@/components/ui/Field'
import { IconButton } from '@/components/ui/IconButton'
import { PillSwitch, type PillOption } from '@/components/ui/PillSwitch'
import { InlineError, LoadingBlock } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { occurredAtFor } from '@/data/api'
import type { AccountBalanceRow, EntryKind } from '@/data/database.types'
import { useCreateEntry, useEntry, useSetEntryDeleted, useUpdateEntry } from '@/data/hooks'
import { formatDate, formatRelativeDay, localDate } from '@/lib/dates'
import { validateEntry, type EntryDraft, type EntryErrors } from '@/lib/entry'
import { friendlyError } from '@/lib/errors'
import { formatAmountInput, formatMoney, minorToDecimalString } from '@/lib/money'
import { goBack } from '@/lib/navigation'
import { lastAccountKey, lastDestinationKey, readPref, writePref } from '@/lib/prefs'

const KIND_OPTIONS: PillOption<EntryKind>[] = [
  { value: 'expense', label: 'Expense', icon: <ArrowUpRight className="size-4" strokeWidth={2.75} /> },
  { value: 'income', label: 'Income', icon: <ArrowDownLeft className="size-4" strokeWidth={2.75} /> },
  { value: 'transfer', label: 'Transfer', icon: <ArrowLeftRight className="size-4" strokeWidth={2.75} /> },
]

const HEADLINE: Record<EntryKind, string> = {
  expense: 'Money out.',
  income: 'Money in.',
  transfer: 'Moving money.',
}

const SAVE_LABEL: Record<EntryKind, string> = {
  expense: 'Save expense',
  income: 'Save income',
  transfer: 'Record transfer',
}

const NOUN: Record<EntryKind, string> = { expense: 'expense', income: 'income', transfer: 'transfer' }

const VISIBLE_CATEGORIES = 8

function isKind(value: string | null | undefined): value is EntryKind {
  return value === 'expense' || value === 'income' || value === 'transfer'
}

/** Quick Add (create) and entry details (edit) share one amount-first screen. */
export function EntryEditor() {
  const params = useParams<{ kind: string; id: string }>()
  const editing = Boolean(params.id && isKind(params.kind))
  const entryQuery = useEntry(editing ? (params.kind as EntryKind) : undefined, params.id)

  if (editing) {
    if (entryQuery.isPending) return <EditorFrame title="Loading…"><LoadingBlock rows={4} /></EditorFrame>
    if (entryQuery.error || !entryQuery.data || entryQuery.data.deleted_at) {
      return (
        <EditorFrame title="Not found">
          <InlineError
            message={entryQuery.error ? friendlyError(entryQuery.error) : 'This entry was deleted or doesn’t exist.'}
            onRetry={entryQuery.error ? () => void entryQuery.refetch() : undefined}
          />
        </EditorFrame>
      )
    }
  }
  return <EntryForm key={params.id ?? 'new'} existing={editing ? entryQuery.data : undefined} />
}

function EditorFrame({ title, children }: { title: string; children: React.ReactNode }) {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="flex items-center gap-3">
        <IconButton label="Close" icon={<X className="size-5" strokeWidth={2.75} />} onClick={() => goBack(navigate, '/activity')} />
        <h1 className="display text-3xl">{title}</h1>
      </div>
      {children}
    </div>
  )
}

type Existing = NonNullable<ReturnType<typeof useEntry>['data']>

function EntryForm({ existing }: { existing?: Existing }) {
  const { activeAccounts, accountsById, categories, timeZone, todayDate } = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  const [search] = useSearchParams()
  const toast = useToast()
  const amountRef = useRef<HTMLInputElement>(null)
  const returnTo = (location.state as { from?: string } | null)?.from ?? '/'

  const createEntry = useCreateEntry()
  const updateEntry = useUpdateEntry()
  const setDeleted = useSetEntryDeleted()

  const [draft, setDraft] = useState<EntryDraft>(() => initialDraft())
  const [errors, setErrors] = useState<EntryErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(Boolean(existing?.note) || Boolean(search.get('date')))
  const [showAllCategories, setShowAllCategories] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  function initialDraft(): EntryDraft {
    if (existing) {
      const isTransfer = existing.kind === 'transfer'
      return {
        kind: existing.kind,
        amountText: formatAmountInput(minorToDecimalString(existing.amount_minor)),
        accountId: isTransfer ? existing.source_account_id : existing.account_id,
        destinationAccountId: isTransfer ? existing.destination_account_id : null,
        categoryId: isTransfer ? null : existing.category_id,
        date: localDate(existing.occurred_at, timeZone),
        note: existing.note ?? '',
      }
    }
    const kind = isKind(search.get('kind')) ? (search.get('kind') as EntryKind) : 'expense'
    return {
      kind,
      amountText: '',
      accountId: pickAccount(search.get('account') ?? readPref(lastAccountKey(kind))),
      destinationAccountId: kind === 'transfer' ? pickDestination() : null,
      categoryId: null,
      date: search.get('date') ?? todayDate,
      note: '',
    }
  }

  function pickAccount(preferred: string | null, exclude?: string | null) {
    const usable = activeAccounts.filter((a) => a.id !== exclude)
    // Without a remembered choice, default to money you hold rather than a card.
    return (
      usable.find((a) => a.id === preferred)?.id ??
      usable.find((a) => a.type !== 'credit_card')?.id ??
      usable[0]?.id ??
      null
    )
  }

  function pickDestination(source?: string | null) {
    const sourceId = source ?? pickAccount(readPref(lastAccountKey('transfer')))
    return pickAccount(readPref(lastDestinationKey), sourceId)
  }

  // Accounts offered: active ones, plus an archived one already on this entry.
  const accountChoices = useMemo(() => {
    const list = [...activeAccounts]
    for (const id of [draft.accountId, draft.destinationAccountId]) {
      const account = id ? accountsById.get(id) : undefined
      if (account && !list.includes(account)) list.push(account)
    }
    return list
  }, [activeAccounts, accountsById, draft.accountId, draft.destinationAccountId])

  const categoryChoices = useMemo(() => {
    if (draft.kind === 'transfer') return []
    return categories.filter(
      (c) => c.transaction_type === draft.kind && (!c.is_archived || c.id === draft.categoryId),
    )
  }, [categories, draft.kind, draft.categoryId])

  const visibleCategories = useMemo(() => {
    if (showAllCategories || categoryChoices.length <= VISIBLE_CATEGORIES + 1) return categoryChoices
    const top = categoryChoices.slice(0, VISIBLE_CATEGORIES)
    const selected = categoryChoices.find((c) => c.id === draft.categoryId)
    return selected && !top.includes(selected) ? [...top.slice(0, -1), selected] : top
  }, [categoryChoices, showAllCategories, draft.categoryId])

  useEffect(() => {
    if (!existing) amountRef.current?.focus()
  }, [existing])

  function update(patch: Partial<EntryDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
    setSubmitError(null)
    if (Object.keys(errors).length) setErrors({})
  }

  function changeKind(kind: EntryKind) {
    setDraft((d) => {
      const accountId = d.accountId ?? pickAccount(readPref(lastAccountKey(kind)))
      return {
        ...d,
        kind,
        accountId,
        categoryId: null,
        destinationAccountId: kind === 'transfer' ? (d.destinationAccountId ?? pickDestination(accountId)) : null,
      }
    })
    setErrors({})
    setShowAllCategories(false)
    // Picking the type first is common; carry straight on to the amount.
    if (!draft.amountText) amountRef.current?.focus()
  }

  const validation = validateEntry(draft)
  const saving = createEntry.isPending || updateEntry.isPending

  async function submit(addAnother = false) {
    const result = validateEntry(draft)
    if (!result.ok) {
      setErrors(result.errors)
      if (result.errors.amount) amountRef.current?.focus()
      return
    }
    const entry = result.value
    const originalDate = existing ? localDate(existing.occurred_at, timeZone) : null
    const occurredAt =
      existing && originalDate === entry.date ? existing.occurred_at : occurredAtFor(entry.date, todayDate, timeZone)

    try {
      if (existing) {
        await updateEntry.mutateAsync({ previousKind: existing.kind, id: existing.id, entry, occurredAt })
        toast({ message: `Updated ${NOUN[entry.kind]} · ${formatMoney(entry.amountMinor)}` })
        goBack(navigate, '/activity')
        return
      }

      const created = await createEntry.mutateAsync({ entry, occurredAt })
      writePref(lastAccountKey(entry.kind), entry.accountId)
      if (entry.destinationAccountId) writePref(lastDestinationKey, entry.destinationAccountId)

      const what =
        entry.kind === 'transfer'
          ? `Moved ${formatMoney(entry.amountMinor)}`
          : `Saved ${entry.kind === 'expense' ? '−' : '+'}${formatMoney(entry.amountMinor)}${
              entry.categoryId ? ` · ${categories.find((c) => c.id === entry.categoryId)?.name ?? ''}` : ''
            }`
      toast({
        message: what,
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await setDeleted.mutateAsync({ kind: created.kind, id: created.id, deleted: true })
              toast({ message: 'Undone — that entry is gone.' })
            } catch (error) {
              toast({ message: friendlyError(error), tone: 'error' })
            }
          },
        },
      })

      if (addAnother) {
        setDraft((d) => ({ ...d, amountText: '', note: '', categoryId: null }))
        setDetailsOpen(false)
        amountRef.current?.focus()
      } else {
        navigate(returnTo, { replace: true })
      }
    } catch (error) {
      setSubmitError(friendlyError(error))
    }
  }

  async function remove() {
    if (!existing) return
    try {
      await setDeleted.mutateAsync({ kind: existing.kind, id: existing.id, deleted: true })
      setConfirmDelete(false)
      toast({
        message: `Deleted ${NOUN[existing.kind]} · ${formatMoney(existing.amount_minor)}`,
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await setDeleted.mutateAsync({ kind: existing.kind, id: existing.id, deleted: false })
              toast({ message: 'Restored.' })
            } catch (error) {
              toast({ message: friendlyError(error), tone: 'error' })
            }
          },
        },
      })
      goBack(navigate, '/activity')
    } catch (error) {
      setConfirmDelete(false)
      setSubmitError(friendlyError(error))
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void submit(false)
  }

  const kindOptions = existing
    ? existing.kind === 'transfer'
      ? []
      : KIND_OPTIONS.filter((o) => o.value !== 'transfer')
    : KIND_OPTIONS

  const detailsSummary = [
    formatRelativeDay(draft.date, todayDate) === 'Today' ? 'Today' : formatDate(draft.date, { withYear: true }),
    draft.note ? `“${draft.note.length > 24 ? draft.note.slice(0, 24) + '…' : draft.note}”` : 'No note',
  ].join(' · ')

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-1 flex-col">
      <div className="flex items-center gap-3 py-2">
        <IconButton
          label={existing ? 'Close without saving' : 'Cancel'}
          icon={<X className="size-5" strokeWidth={2.75} />}
          onClick={() => (existing ? goBack(navigate, '/activity') : navigate(returnTo, { replace: true }))}
        />
        <h1 className="flex-1 text-center">
          <span className="sr-only">{existing ? `Edit ${NOUN[draft.kind]}` : `Add ${NOUN[draft.kind]}`}</span>
          <span aria-hidden="true" className="scribble inline-block -rotate-2 text-[2rem] text-orange-press">
            {HEADLINE[draft.kind]}
          </span>
        </h1>
        {existing ? (
          <IconButton
            label={`Delete this ${NOUN[existing.kind]}`}
            icon={<Trash className="size-5" strokeWidth={2.5} />}
            onClick={() => setConfirmDelete(true)}
          />
        ) : (
          <span className="size-11" aria-hidden="true" />
        )}
      </div>

      {kindOptions.length > 0 && (
        <PillSwitch label="Entry type" options={kindOptions} value={draft.kind} onChange={changeKind} size="lg" className="mt-2" />
      )}

      <div className="py-7">
        <AmountInput
          ref={amountRef}
          value={draft.amountText}
          onChange={(amountText) => update({ amountText })}
          error={errors.amount}
          label={`${NOUN[draft.kind]} amount in rupees`}
          onEnter={() => amountRef.current?.blur()}
        />
      </div>

      <div className="flex flex-col gap-6 pb-40">
        {draft.kind === 'transfer' ? (
          <section aria-labelledby="transfer-heading" className="flex flex-col gap-4">
            <h2 id="transfer-heading" className="sr-only">
              Accounts
            </h2>
            <AccountChips
              label="From"
              accounts={accountChoices}
              selected={draft.accountId}
              disabledId={null}
              onSelect={(id) => update({ accountId: id, destinationAccountId: draft.destinationAccountId === id ? null : draft.destinationAccountId })}
              error={errors.account}
            />
            <div className="flex items-center gap-3">
              <span className="h-[3px] flex-1 rounded-full bg-ink" aria-hidden="true" />
              <Button
                size="sm"
                icon={<ArrowUpDown className="size-4" strokeWidth={2.75} />}
                onClick={() => update({ accountId: draft.destinationAccountId, destinationAccountId: draft.accountId })}
                disabled={!draft.accountId || !draft.destinationAccountId}
              >
                Swap
              </Button>
              <span className="h-[3px] flex-1 rounded-full bg-ink" aria-hidden="true" />
            </div>
            <AccountChips
              label="To"
              accounts={accountChoices}
              selected={draft.destinationAccountId}
              disabledId={draft.accountId}
              onSelect={(id) => update({ destinationAccountId: id })}
              error={errors.destination}
            />
            <p className="rounded-2xl bg-purple/40 px-4 py-3 text-sm outline-regular">
              <strong>Not spending, not income.</strong> A transfer just moves money between your accounts — it changes
              both balances and stays out of your totals.
            </p>
          </section>
        ) : (
          <>
            <section aria-labelledby="category-heading" className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between">
                <h2 id="category-heading" className="label-mono">
                  Category
                </h2>
                {!draft.categoryId && <span className="text-sm text-muted">Optional</span>}
              </div>
              <div className="grid grid-cols-4 gap-2.5">
                {visibleCategories.map((category) => (
                  <CategoryTile
                    key={category.id}
                    name={category.name}
                    icon={category.icon}
                    color={category.color}
                    selected={draft.categoryId === category.id}
                    onSelect={() => update({ categoryId: draft.categoryId === category.id ? null : category.id })}
                  />
                ))}
                {visibleCategories.length < categoryChoices.length && (
                  <button
                    type="button"
                    onClick={() => setShowAllCategories(true)}
                    className="pressable flex min-h-[5.25rem] flex-col items-center justify-center gap-1 rounded-[1.25rem] border-2 border-dashed border-ink bg-paper text-[0.75rem] font-semibold"
                  >
                    <ChevronDown aria-hidden="true" className="size-5" strokeWidth={2.5} />
                    {categoryChoices.length - visibleCategories.length} more
                  </button>
                )}
              </div>
              {categoryChoices.length === 0 && (
                <p className="text-sm text-muted">No {draft.kind} categories yet — add some from Profile → Categories.</p>
              )}
            </section>

            <AccountChips
              label={draft.kind === 'expense' ? 'Paid from' : 'Received into'}
              accounts={accountChoices}
              selected={draft.accountId}
              disabledId={null}
              onSelect={(id) => update({ accountId: id })}
              error={errors.account}
            />
          </>
        )}

        <section className="rounded-[1.25rem] bg-paper outline-regular">
          <button
            type="button"
            aria-expanded={detailsOpen}
            aria-controls="entry-details"
            onClick={() => setDetailsOpen((o) => !o)}
            className="flex min-h-14 w-full items-center gap-3 px-4 text-left"
          >
            <span className="flex-1">
              <span className="block font-display font-extrabold tracking-tight">Add details</span>
              <span className="label-mono text-muted">{detailsSummary}</span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn('size-5 transition-transform', detailsOpen && 'rotate-180')}
              strokeWidth={2.5}
            />
          </button>
          {detailsOpen && (
            <div id="entry-details" className="flex flex-col gap-4 border-t-2 border-ink px-4 pb-4 pt-4">
              <TextField
                label="Date"
                type="date"
                value={draft.date}
                onChange={(event) => event.target.value && update({ date: event.target.value })}
              />
              <TextAreaField
                label="Note"
                placeholder={draft.kind === 'transfer' ? 'e.g. ATM withdrawal' : 'e.g. Dinner with Priya'}
                value={draft.note}
                maxLength={500}
                onChange={(event) => update({ note: event.target.value })}
                error={errors.note}
              />
            </div>
          )}
        </section>

        {submitError && <InlineError message={submitError} />}
      </div>

      <div
        className="fixed inset-x-0 bottom-0 z-30 mx-auto flex w-full max-w-[30rem] flex-col gap-2 bg-gradient-to-t from-canvas from-70% to-transparent px-4 pt-6"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)' }}
      >
        <Button
          type="submit"
          variant="primary"
          size="xl"
          block
          loading={saving}
          disabled={!validation.ok}
          icon={!saving ? <Check className="size-6" strokeWidth={3} /> : undefined}
        >
          {existing ? 'Save changes' : SAVE_LABEL[draft.kind]}
        </Button>
        {!existing && (
          <button
            type="button"
            disabled={!validation.ok || saving}
            onClick={() => void submit(true)}
            className="min-h-11 font-display text-sm font-bold underline underline-offset-4 disabled:opacity-40"
          >
            Save & add another
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete this ${existing ? NOUN[existing.kind] : 'entry'}?`}
        body={
          existing?.kind === 'transfer'
            ? 'Both account balances go back to how they were. You can undo right after.'
            : 'It’ll disappear from your balances and insights. You can undo right after.'
        }
        confirmLabel="Delete"
        danger
        busy={setDeleted.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </form>
  )
}

interface AccountChipsProps {
  label: string
  accounts: AccountBalanceRow[]
  selected: string | null
  disabledId: string | null
  onSelect: (id: string) => void
  error?: string
}

function AccountChips({ label, accounts, selected, disabledId, onSelect, error }: AccountChipsProps) {
  const headingId = `accounts-${label.replace(/\s+/g, '-').toLowerCase()}`
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="label-mono">
        {label}
      </h2>
      <div role="radiogroup" aria-labelledby={headingId} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1.5 pt-0.5 no-scrollbar">
        {accounts.map((account) => {
          const isSelected = account.id === selected
          const disabled = account.id === disabledId
          return (
            <button
              key={account.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={disabled}
              onClick={() => onSelect(account.id)}
              className={cn(
                'pressable flex min-h-12 shrink-0 items-center gap-2 rounded-pill pl-2 pr-4 font-display text-sm tracking-tight',
                isSelected
                  ? 'bg-ink font-extrabold text-paper outline-strong shadow-[3px_3px_0_0_var(--color-orange)]'
                  : 'bg-paper font-semibold outline-regular',
                disabled && 'opacity-35',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('grid size-8 place-items-center rounded-full', isSelected ? 'bg-orange text-ink' : 'bg-peach')}
              >
                {isSelected ? <Check className="size-4" strokeWidth={3.5} /> : <AccountGlyph type={account.type} className="size-4" />}
              </span>
              {account.name}
            </button>
          )
        })}
      </div>
      {error && (
        <p role="alert" className="text-sm font-semibold text-negative">
          {error}
        </p>
      )}
    </section>
  )
}
