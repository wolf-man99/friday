import { RotateCcw } from 'lucide-react'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useSettings } from '@/app/settings'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field'
import { useToast } from '@/components/ui/Toast'
import { occurredAtFor } from '@/data/api'
import type { TransactionRow } from '@/data/database.types'
import { useRecordLinkedEntry, useUpdateLinkedEntry } from '@/data/hooks'
import { newIdempotencyKey } from '@/features/capture/draft'
import { overLimitMessage, validateLinkedEntry, type LinkedErrors, type LinkedKind } from '@/features/detail/linkedEntry'
import { localDate } from '@/lib/dates'
import { NOTE_MAX } from '@/lib/entry'
import { classifyError, friendlyError } from '@/lib/errors'
import {
  amountProblem,
  AMOUNT_PROBLEM_MESSAGE,
  formatAmountInput,
  formatMoney,
  minorToDecimalString,
  parseAmountToMinor,
} from '@/lib/money'
import { ACCOUNT_TYPE_LABEL } from './icons'

const NOUN: Record<LinkedKind, string> = { refund: 'refund', reversal: 'reversal' }

export interface LinkedOriginal {
  id: string
  amount_minor: number
  account_id: string
  merchant: string | null
}

interface LinkedEntryFormProps {
  open: boolean
  onClose: () => void
  kind: LinkedKind
  /** What it refunds or reverses; null only for a refund recorded without its purchase. */
  original: LinkedOriginal | null
  /** A few words naming the original, e.g. "Amazon · −₹2,000". */
  originalLabel?: string
  /** The most this entry can be (what's left on the original, counting this entry's own amount when editing). */
  maxMinor: number | null
  /** Editing an existing refund or reversal. */
  existing?: TransactionRow
  /** After a "changed elsewhere" conflict: reload the latest version. */
  onReload?: () => void
}

/**
 * Records money back against an original (refund or reversal), or edits one.
 * A sheet so the original stays in view behind it. Each opening gets its own
 * request key, reused on retry, so a lost response can never record twice.
 */
export function LinkedEntryForm(props: LinkedEntryFormProps) {
  const { open, onClose, kind, existing } = props
  const title = existing ? `Edit ${NOUN[kind]}` : kind === 'refund' ? 'Record a refund' : 'Reverse it'
  return (
    <Dialog open={open} onClose={onClose} title={title} variant="sheet">
      {/* Mounted only while open: every opening starts fresh with a new key. */}
      <LinkedEntryFields {...props} />
    </Dialog>
  )
}

type SubmitError = { message: string; conflict: boolean } | null

function LinkedEntryFields({
  onClose,
  kind,
  original,
  originalLabel,
  maxMinor,
  existing: loaded,
  onReload,
}: LinkedEntryFormProps) {
  const { activeAccounts, accountsById, categories, todayDate, timeZone, profile } = useSettings()
  // The version this edit started from: a change made elsewhere meanwhile is
  // reported as a conflict, never silently overwritten by a background refresh.
  const [existing] = useState(loaded)
  // A refund recorded without its purchase has its own expense category.
  const unlinkedRefund = kind === 'refund' && Boolean(existing) && !existing?.related_transaction_id
  const [categoryId, setCategoryId] = useState(existing?.category_id ?? '')
  const expenseCategories = categories.filter(
    (category) => category.transaction_type === 'expense' && (!category.is_archived || category.id === existing?.category_id),
  )
  const toast = useToast()
  const record = useRecordLinkedEntry()
  const update = useUpdateLinkedEntry()
  const submitting = useRef(false)
  const [key, setKey] = useState(newIdempotencyKey)

  const fixedAccountId = kind === 'reversal' ? (existing?.account_id ?? original?.account_id ?? null) : null
  const [amountText, setAmountText] = useState(() => {
    const start = existing ? existing.amount_minor : maxMinor
    return start && start > 0 ? formatAmountInput(minorToDecimalString(start)) : ''
  })
  const [accountId, setAccountId] = useState<string | null>(() => {
    if (fixedAccountId) return fixedAccountId
    if (existing) return existing.account_id
    // Usually the money comes back where it was paid from; any active account works.
    const usable = (id: string | null | undefined) => (id && activeAccounts.some((a) => a.id === id) ? id : null)
    return usable(original?.account_id) ?? usable(profile.default_account_id) ?? activeAccounts[0]?.id ?? null
  })
  const [date, setDate] = useState(() => (existing ? localDate(existing.occurred_at, timeZone) : todayDate))
  const [note, setNote] = useState(existing?.note ?? '')
  const [errors, setErrors] = useState<LinkedErrors>({})
  const [submitError, setSubmitError] = useState<SubmitError>(null)

  // Active accounts, plus the one an existing refund already uses (it may be archived since).
  const accountChoices = useMemo(() => {
    const current = existing ? accountsById.get(existing.account_id) : undefined
    return current && !activeAccounts.includes(current) ? [...activeAccounts, current] : activeAccounts
  }, [activeAccounts, accountsById, existing])
  const usableAccountIds = useMemo(() => {
    const ids = new Set(activeAccounts.map((a) => a.id))
    if (existing) ids.add(existing.account_id)
    return ids
  }, [activeAccounts, existing])

  // Live feedback once something is typed; an empty amount is reported on save.
  const problem = amountProblem(amountText)
  const typedMinor = problem ? null : parseAmountToMinor(amountText)
  const liveAmountError =
    problem && problem !== 'empty'
      ? AMOUNT_PROBLEM_MESSAGE[problem]
      : typedMinor !== null
        ? overLimitMessage(kind, typedMinor, maxMinor)
        : null

  const saving = record.isPending || update.isPending
  const fixedAccount = fixedAccountId ? accountsById.get(fixedAccountId) : undefined

  function clearErrors() {
    if (Object.keys(errors).length) setErrors({})
    if (submitError) setSubmitError(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current) return
    const result = validateLinkedEntry({ amountText, accountId, date, note }, { kind, maxMinor, usableAccountIds })
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    const value = result.value
    submitting.current = true
    setSubmitError(null)
    try {
      if (existing) {
        // Keep the exact instant when the day didn't change.
        const occurredAt =
          localDate(existing.occurred_at, timeZone) === value.date
            ? existing.occurred_at
            : occurredAtFor(value.date, todayDate, timeZone)
        await update.mutateAsync({
          kind,
          id: existing.id,
          expectedUpdatedAt: existing.updated_at,
          values: {
            amountMinor: value.amountMinor,
            accountId: kind === 'reversal' ? existing.account_id : value.accountId,
            occurredAt,
            note: value.note,
            merchant: existing.merchant,
            categoryId: unlinkedRefund ? categoryId || null : existing.category_id,
          },
        })
        toast({ message: `${kind === 'refund' ? 'Refund' : 'Reversal'} updated · ${formatMoney(value.amountMinor)}` })
        onClose()
        return
      }

      if (!original) return
      const saved = await record.mutateAsync({
        input: {
          kind,
          originalId: original.id,
          amountMinor: value.amountMinor,
          accountId: kind === 'reversal' ? original.account_id : value.accountId,
          occurredAt: occurredAtFor(value.date, todayDate, timeZone),
          note: value.note,
          // Reads as "Amazon · Refund" in lists rather than just the category.
          merchant: original.merchant,
        },
        idempotencyKey: key,
      })
      if (!saved.created && (!saved.matches || saved.voided)) {
        // This request key was already used for different details: never claim a save.
        setKey(newIdempotencyKey())
        setSubmitError({
          message: `An earlier try already recorded a ${NOUN[kind]} with different details, so nothing new was saved. Check the list on this page — or save again to record this as a separate ${NOUN[kind]}.`,
          conflict: false,
        })
        return
      }
      const left = maxMinor === null ? null : Math.max(maxMinor - value.amountMinor, 0)
      const leftText =
        left === null
          ? ''
          : left === 0
            ? ` · nothing left to ${kind === 'refund' ? 'refund' : 'reverse'}`
            : ` · ${formatMoney(left)} left`
      toast({ message: `${kind === 'refund' ? 'Refund' : 'Reversal'} recorded${leftText}` })
      onClose()
    } catch (error) {
      const errorClass = classifyError(error)
      setSubmitError({
        message:
          errorClass === 'network'
            ? 'Couldn’t confirm the save — the connection dropped. Trying again is safe: it can’t be recorded twice.'
            : friendlyError(error),
        conflict: errorClass === 'conflict',
      })
    } finally {
      submitting.current = false
    }
  }

  const verb = kind === 'refund' ? 'refund' : 'reverse'
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {original && (
        <p className="text-sm text-muted">
          {kind === 'refund' ? 'Money back for' : 'Undoes'}{' '}
          <span className="font-semibold text-ink">{originalLabel ?? 'the original'}</span>
          {maxMinor !== null && (
            <>
              {' '}
              · up to <span className="tabular font-semibold text-ink">{formatMoney(maxMinor)}</span> left to {verb}
            </>
          )}
          .
        </p>
      )}
      {kind === 'reversal' && !existing && (
        <p className="rounded-2xl bg-sky/40 px-4 py-3 text-sm outline-regular">
          <strong>For money the bank pulled back</strong> — a failed payment credited back, a chargeback, a bounced credit. It
          cancels the original out on the same account. A hold that never went through should be voided instead.
        </p>
      )}

      <TextField
        label="Amount"
        prefix="₹"
        inputMode="decimal"
        autoComplete="off"
        value={amountText}
        onChange={(event) => {
          setAmountText(formatAmountInput(event.target.value))
          clearErrors()
        }}
        error={errors.amount ?? liveAmountError}
        hint={maxMinor !== null ? `Up to ${formatMoney(maxMinor)}. Partial amounts are fine.` : undefined}
      />

      {kind === 'refund' ? (
        <SelectField
          label="Money came back to"
          value={accountId ?? ''}
          onChange={(event) => {
            setAccountId(event.target.value || null)
            clearErrors()
          }}
          error={errors.account}
          hint="Usually the account you paid from, but any of yours works."
        >
          {!accountId && <option value="">Choose an account</option>}
          {accountChoices.map((account) => (
            <option key={account.id} value={account.id} disabled={!usableAccountIds.has(account.id)}>
              {account.name} · {ACCOUNT_TYPE_LABEL[account.type]}
              {account.status === 'archived' ? ' (archived)' : ''}
            </option>
          ))}
        </SelectField>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="label-mono">Account</p>
          <p className="font-semibold">
            {fixedAccount?.name ?? 'The original’s account'}
            {fixedAccount?.status === 'archived' ? ' (archived)' : ''}
          </p>
          {errors.account ? (
            <p role="alert" className="text-sm font-semibold text-negative">
              {errors.account}
            </p>
          ) : (
            <p className="text-sm text-muted">A reversal always stays on the original’s account.</p>
          )}
        </div>
      )}

      {unlinkedRefund && (
        <SelectField
          label="Expense category"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          hint="With no purchase linked, the refund lowers spending in this category."
        >
          <option value="">No category</option>
          {expenseCategories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
              {category.is_archived ? ' (archived)' : ''}
            </option>
          ))}
        </SelectField>
      )}

      <TextField
        label="Date"
        type="date"
        value={date}
        onChange={(event) => {
          if (event.target.value) setDate(event.target.value)
          clearErrors()
        }}
        error={errors.date}
      />
      <TextAreaField
        label="Note (optional)"
        placeholder={kind === 'refund' ? 'e.g. Returned the shoes' : 'e.g. Payment failed, money back'}
        value={note}
        maxLength={NOTE_MAX}
        onChange={(event) => {
          setNote(event.target.value)
          clearErrors()
        }}
        error={errors.note}
      />

      {submitError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-2xl bg-paper px-3.5 py-3 text-sm font-semibold outline-regular"
        >
          <p>{submitError.message}</p>
          {submitError.conflict && onReload && (
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
        <Button block onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" block variant="primary" loading={saving}>
          {existing ? 'Save changes' : kind === 'refund' ? 'Record refund' : 'Record reversal'}
        </Button>
      </div>
    </form>
  )
}
