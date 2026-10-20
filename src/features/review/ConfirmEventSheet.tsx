import { Check } from 'lucide-react'
import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useSettings } from '@/app/settings'
import { ACCOUNT_TYPE_LABEL } from '@/components/finance/icons'
import { Button } from '@/components/ui/Button'
import { ToggleChip } from '@/components/ui/Chip'
import { cn } from '@/components/ui/cn'
import { Dialog } from '@/components/ui/Dialog'
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field'
import { PillSwitch } from '@/components/ui/PillSwitch'
import { InlineError, LoadingBlock } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { occurredAtFor } from '@/data/api'
import type { EntryKind, LedgerEntryRow, SourceEventRow } from '@/data/database.types'
import { CandidateSearchField, ShowOlderButton, useCandidateBrowse } from '@/components/finance/CandidateSearch'
import { useConfirmSourceEvent, useLedgerEntry, useOffsetCandidates } from '@/data/hooks'
import { localDate } from '@/lib/dates'
import { MERCHANT_MAX, NOTE_MAX } from '@/lib/entry'
import { classifyError, friendlyError } from '@/lib/errors'
import { IMPORT_SOURCE_SHORT, KIND_LABEL, STATUS_EXPLAINER, STATUS_LABEL } from '@/lib/ledger'
import { AMOUNT_PROBLEM_MESSAGE, amountProblem, formatAmountInput, formatMoney, minorToDecimalString } from '@/lib/money'
import {
  categorySide,
  confirmDraftFrom,
  confirmKinds,
  originalQuery,
  typedAmount,
  UNLINKED,
  validateConfirm,
  withKind,
  type ConfirmDraft,
  type ConfirmErrors,
} from './confirm'
import { ChoiceOption, EntryOptionBody } from './EntryChoice'

interface ConfirmEventSheetProps {
  event: SourceEventRow
  onClose: () => void
}

/**
 * Confirm (and correct) a piece of import evidence. Only this explicit
 * confirm records anything, and the database records at most one entry per
 * event however many times it's sent — so retrying after an error is safe.
 */
export function ConfirmEventSheet({ event, onClose }: ConfirmEventSheetProps) {
  return (
    <Dialog open onClose={onClose} title="Confirm it" variant="sheet">
      <ConfirmEventForm event={event} onClose={onClose} />
    </Dialog>
  )
}

const ACCOUNT_LABEL: Record<EntryKind, string> = {
  expense: 'Paid from',
  income: 'Received in',
  transfer: 'From',
  refund: 'Money came back to',
  reversal: 'Account',
}

const KIND_HINT: Partial<Record<EntryKind, string>> = {
  transfer: 'Between your own accounts — not spending or income. Paying a card bill is a transfer.',
  refund: 'Money back for a purchase. It lowers your spending; it isn’t income.',
  reversal: 'The bank pulled a posted payment back. It cancels the original out on the same account.',
}

function ConfirmEventForm({ event, onClose }: ConfirmEventSheetProps) {
  const { activeAccounts, accountsById, categories, categoriesById, timeZone, todayDate } = useSettings()
  const toast = useToast()
  const navigate = useNavigate()
  const confirm = useConfirmSourceEvent()
  const submitting = useRef(false)
  const kindName = useId()
  const originalName = useId()

  const ctx = useMemo(
    () => ({ activeAccountIds: new Set(activeAccounts.map((a) => a.id)), categoriesById }),
    [activeAccounts, categoriesById],
  )
  // What the import suggested, kept to mark those choices "(suggested)" after edits.
  const [suggested] = useState<ConfirmDraft>(() => confirmDraftFrom(event, { ...ctx, timeZone, todayDate }))
  const [draft, setDraft] = useState<ConfirmDraft>(suggested)
  const [errors, setErrors] = useState<ConfirmErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [onlyThisAccount, setOnlyThisAccount] = useState(true)

  function change(patch: Partial<ConfirmDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
    if (Object.keys(errors).length) setErrors({})
    if (submitError) setSubmitError(null)
  }

  const { kind } = draft
  // The suggested account first; everything else in the usual order.
  const suggestedFirst = (id: string) =>
    [...activeAccounts].sort((a, b) => Number(b.id === id) - Number(a.id === id))
  const accountChoices = suggestedFirst(suggested.accountId)
  const destinationChoices = suggestedFirst(suggested.destinationAccountId)
  const side = categorySide(kind)
  const categoryChoices = useMemo(
    () =>
      categories
        .filter((c) => c.transaction_type === side && !c.is_archived)
        .sort((a, b) => Number(b.id === suggested.categoryId) - Number(a.id === suggested.categoryId)),
    [categories, side, suggested.categoryId],
  )

  // Refunds and reversals: the original they belong to.
  const amountMinor = typedAmount(draft.amountText)
  const offsetsOriginal = kind === 'refund' || kind === 'reversal'
  const browse = useCandidateBrowse()
  const baseOriginalQuery = offsetsOriginal ? originalQuery(kind, draft.accountId, amountMinor, { onlyThisAccount }) : null
  const originals = useOffsetCandidates(baseOriginalQuery ? { ...baseOriginalQuery, ...browse.query } : null)
  const suggestedOriginalId =
    (event.parsed_kind === 'refund' || event.parsed_kind === 'reversal') && event.suggested_match_kind === 'transaction'
      ? event.suggested_match_id
      : null
  const suggestedOriginal = useLedgerEntry(offsetsOriginal ? suggestedOriginalId : null)
  const originalRows = useMemo(() => {
    const rows = originals.data ?? []
    const suggested = suggestedOriginal.data
    const fits =
      suggested &&
      suggested.status === 'posted' &&
      (kind === 'refund' ? suggested.kind === 'expense' : suggested.kind === 'expense' || suggested.kind === 'income') &&
      (kind === 'refund' || suggested.account_id === draft.accountId)
    return fits ? [suggested, ...rows.filter((row) => row.id !== suggested.id)] : rows
  }, [originals.data, suggestedOriginal.data, kind, draft.accountId])
  const linkedRefund = kind === 'refund' && originalRows.some((row) => row.id === draft.originalId)
  const showCategory = kind === 'expense' || kind === 'income' || (kind === 'refund' && draft.originalId === UNLINKED)

  const problem = amountProblem(draft.amountText)
  const liveAmountError = problem && problem !== 'empty' ? AMOUNT_PROBLEM_MESSAGE[problem] : null
  const foreign = event.parsed_currency && event.parsed_currency !== 'INR' ? event.parsed_currency : null
  const source = IMPORT_SOURCE_SHORT[event.source_type].toLowerCase()

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault()
    if (submitting.current) return
    // A pick that's no longer listed (the account or amount changed) doesn't count.
    const listed = draft.originalId === UNLINKED || originalRows.some((row) => row.id === draft.originalId)
    const result = validateConfirm(offsetsOriginal && !listed ? { ...draft, originalId: null } : draft, ctx)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    const { date, ...input } = result.value
    // Keep the exact instant the evidence gave when the day wasn't changed.
    const occurredAt =
      event.parsed_occurred_at && localDate(event.parsed_occurred_at, timeZone) === date
        ? event.parsed_occurred_at
        : occurredAtFor(date, todayDate, timeZone)
    submitting.current = true
    setSubmitError(null)
    try {
      const saved = await confirm.mutateAsync({ eventId: event.id, input: { ...input, occurredAt } })
      toast({
        message: `${KIND_LABEL[saved.kind]} recorded · ${formatMoney(input.amountMinor)}`,
        action: { label: 'Open', onClick: () => navigate(`/entry/${saved.kind}/${saved.id}`) },
      })
      onClose()
    } catch (error) {
      setSubmitError(
        classifyError(error) === 'network'
          ? 'Couldn’t confirm — the connection dropped. Trying again is safe: Friday records this item only once.'
          : friendlyError(error),
      )
    } finally {
      submitting.current = false
    }
  }

  const accountHint = event.parsed_account_hint ? `The ${source} said “${event.parsed_account_hint}”.` : undefined
  const noMoneyMoved =
    event.parsed_entry_status === 'cancelled' || event.parsed_entry_status === 'declined' ? event.parsed_entry_status : null

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Check the details. Friday records one entry when you confirm — nothing before that.
      </p>
      {noMoneyMoved && (
        <p role="note" className="rounded-2xl bg-peach px-3.5 py-3 text-sm font-semibold outline-regular">
          The {source} says this payment was {noMoneyMoved}, so no money moved. Usually there’s nothing to record: close this
          and choose Ignore — or “Same as an existing entry” if it cancels a pending one.
        </p>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="label-mono mb-2">Type</legend>
        <div className="flex flex-wrap gap-2">
          {confirmKinds(event).map((option) => {
            const selected = option === kind
            return (
              <label
                key={option}
                className={cn(
                  'inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-pill px-4 font-display text-sm tracking-tight has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink',
                  selected ? 'bg-ink font-extrabold text-paper outline-strong' : 'bg-paper font-semibold outline-regular hover:bg-peach',
                )}
              >
                <input
                  type="radio"
                  name={kindName}
                  value={option}
                  checked={selected}
                  onChange={() => {
                    setDraft((current) => withKind(current, option, categoriesById))
                    setErrors({})
                    setSubmitError(null)
                  }}
                  className="sr-only"
                />
                {selected && <Check aria-hidden="true" className="size-4" strokeWidth={3} />}
                {KIND_LABEL[option]}
              </label>
            )
          })}
        </div>
        {KIND_HINT[kind] && <p className="text-sm text-muted">{KIND_HINT[kind]}</p>}
      </fieldset>

      <TextField
        label="Amount"
        prefix="₹"
        inputMode="decimal"
        autoComplete="off"
        value={draft.amountText}
        onChange={(e) => change({ amountText: formatAmountInput(e.target.value) })}
        error={errors.amount ?? liveAmountError}
        hint={
          foreign
            ? `The ${source} said ${foreign}${event.parsed_amount_minor ? ` ${minorToDecimalString(event.parsed_amount_minor, { alwaysFraction: true })}` : ''}. Enter what it came to in rupees — Friday tracks INR only for now.`
            : event.parsed_amount_minor === null
              ? `The ${source} didn’t show an amount.`
              : undefined
        }
      />

      <SelectField
        label={ACCOUNT_LABEL[kind]}
        value={draft.accountId}
        onChange={(e) => change({ accountId: e.target.value })}
        error={errors.account}
        hint={accountHint}
      >
        {!draft.accountId && <option value="">Choose an account</option>}
        {accountChoices.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name} · {ACCOUNT_TYPE_LABEL[account.type]}
            {account.id === suggested.accountId ? ' (suggested)' : ''}
          </option>
        ))}
      </SelectField>

      {kind === 'transfer' && (
        <SelectField
          label="To"
          value={draft.destinationAccountId}
          onChange={(e) => change({ destinationAccountId: e.target.value })}
          error={errors.destination}
          hint={event.review_reason === 'possible_transfer' ? 'Paying a card bill moves money to the card — it isn’t income.' : undefined}
        >
          {!draft.destinationAccountId && <option value="">Choose an account</option>}
          {destinationChoices.map((account) => (
            <option key={account.id} value={account.id} disabled={account.id === draft.accountId}>
              {account.name} · {ACCOUNT_TYPE_LABEL[account.type]}
              {account.id === suggested.destinationAccountId ? ' (suggested)' : ''}
            </option>
          ))}
        </SelectField>
      )}

      {offsetsOriginal && (
        <fieldset className="flex flex-col gap-2">
          <legend className="label-mono mb-2">{kind === 'refund' ? 'Which purchase?' : 'Which entry does it reverse?'}</legend>
          {kind === 'refund' && draft.accountId && (
            <div>
              <ToggleChip selected={onlyThisAccount} onClick={() => setOnlyThisAccount((v) => !v)}>
                <span className="max-w-[12rem] truncate">Only {accountsById.get(draft.accountId)?.name ?? 'this account'}</span>
              </ToggleChip>
            </div>
          )}
          {baseOriginalQuery && (
            <CandidateSearchField
              label={kind === 'refund' ? 'Search purchases' : 'Search entries'}
              value={browse.search}
              onChange={browse.setSearch}
            />
          )}
          <OriginalList
            name={originalName}
            kind={kind}
            hasAccount={Boolean(draft.accountId)}
            amountMinor={amountMinor}
            loading={originals.isPending && originals.fetchStatus !== 'idle'}
            error={originals.error}
            onRetry={() => void originals.refetch()}
            rows={originalRows}
            suggestedId={suggestedOriginalId}
            selectedId={draft.originalId}
            onSelect={(id) => change({ originalId: id })}
          />
          {!originals.isPending && !originals.error && browse.hasMore(originals.data?.length ?? 0) && (
            <ShowOlderButton onClick={browse.more} />
          )}
          {kind === 'refund' && (
            <ChoiceOption
              name={originalName}
              value={UNLINKED}
              selected={draft.originalId === UNLINKED}
              onSelect={() => change({ originalId: UNLINKED })}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">No purchase in Friday</span>
                <span className="text-sm text-muted">Record an unlinked refund in an expense category. You can link it later.</span>
              </span>
            </ChoiceOption>
          )}
          {errors.original && (
            <p role="alert" className="text-sm font-semibold text-negative">
              {errors.original}
            </p>
          )}
          {linkedRefund && <p className="text-sm text-muted">It takes the purchase’s category.</p>}
        </fieldset>
      )}

      {showCategory && (
        <SelectField
          label={kind === 'refund' ? 'Expense category' : 'Category'}
          value={draft.categoryId}
          onChange={(e) => change({ categoryId: e.target.value })}
          error={errors.category}
          hint={kind === 'refund' ? 'The refund lowers spending in this category.' : undefined}
        >
          <option value="">No category</option>
          {categoryChoices.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
              {category.id === suggested.categoryId ? ' (suggested)' : ''}
            </option>
          ))}
        </SelectField>
      )}

      {event.parsed_entry_status === 'pending' && (
        <div className="flex flex-col gap-1.5">
          <p aria-hidden="true" className="label-mono">
            Has it settled?
          </p>
          <PillSwitch
            label="Has it settled?"
            options={[
              { value: 'posted', label: STATUS_LABEL.posted },
              { value: 'pending', label: STATUS_LABEL.pending },
            ]}
            value={draft.status}
            onChange={(status) => change({ status })}
          />
          <p className="text-sm text-muted">{STATUS_EXPLAINER[draft.status]}</p>
        </div>
      )}

      <TextField
        label="Date"
        type="date"
        value={draft.date}
        onChange={(e) => {
          if (e.target.value) change({ date: e.target.value })
        }}
        error={errors.date}
      />

      {kind !== 'transfer' && (
        <TextField
          label="Merchant or description (optional)"
          autoComplete="off"
          maxLength={MERCHANT_MAX}
          value={draft.merchant}
          onChange={(e) => change({ merchant: e.target.value })}
          error={errors.merchant}
        />
      )}
      <TextAreaField
        label="Note (optional)"
        maxLength={NOTE_MAX}
        value={draft.note}
        onChange={(e) => change({ note: e.target.value })}
        error={errors.note}
      />

      {submitError && (
        <p role="alert" className="rounded-2xl bg-paper px-3.5 py-3 text-sm font-semibold outline-regular">
          {submitError}
        </p>
      )}

      <div className="flex gap-3 pt-1">
        <Button block onClick={onClose} disabled={confirm.isPending}>
          Cancel
        </Button>
        <Button type="submit" block variant="primary" loading={confirm.isPending}>
          Record {KIND_LABEL[kind].toLowerCase()}
        </Button>
      </div>
    </form>
  )
}

interface OriginalListProps {
  name: string
  kind: EntryKind
  hasAccount: boolean
  amountMinor: number | null
  loading: boolean
  error: unknown
  onRetry: () => void
  rows: LedgerEntryRow[]
  suggestedId: string | null
  selectedId: string | null
  onSelect: (id: string) => void
}

function OriginalList({ name, kind, hasAccount, amountMinor, loading, error, onRetry, rows, suggestedId, selectedId, onSelect }: OriginalListProps) {
  const { accountsById, categoriesById, timeZone } = useSettings()
  if (kind === 'reversal' && !hasAccount) {
    return <p className="text-sm text-muted">Choose the account first — a reversal sits on its original’s account.</p>
  }
  if (loading) return <LoadingBlock rows={2} label="Loading entries" />
  if (error) return <InlineError message={friendlyError(error)} onRetry={onRetry} />
  return (
    <>
      <p className="-mt-1 text-sm text-muted">
        Posted {kind === 'refund' ? 'purchases' : 'entries'}
        {amountMinor ? ` of ${formatMoney(amountMinor)} or more` : ''}, newest first.
      </p>
      {rows.length === 0 ? (
        <p className="rounded-2xl bg-canvas px-4 py-3 text-sm outline-regular">
          No {kind === 'refund' ? 'purchases' : 'entries'} like that yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <ChoiceOption name={name} value={row.id} selected={selectedId === row.id} onSelect={() => onSelect(row.id)}>
                <EntryOptionBody
                  entry={row}
                  categoriesById={categoriesById}
                  accountsById={accountsById}
                  timeZone={timeZone}
                  suggested={row.id === suggestedId}
                />
              </ChoiceOption>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
