import { CalendarClock, Pause, Play, Plus, Repeat, Trash } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useSettings } from '@/app/settings'
import { CategoryBadge } from '@/components/finance/CategoryTile'
import { RecurringDueCard, dueChip } from '@/components/finance/RecurringDueCard'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button, LinkButton } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { cn } from '@/components/ui/cn'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field'
import { PillSwitch } from '@/components/ui/PillSwitch'
import { EmptyState, InlineError, LoadingBlock } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { occurredAtFor } from '@/data/api'
import type { RecurringCadence, RecurringRuleRow, TransactionType } from '@/data/database.types'
import {
  useConfirmOccurrence,
  useDeleteRecurringRule,
  useDueOccurrences,
  useRecurringRules,
  useSaveRecurringRule,
  useSkipOccurrence,
} from '@/data/hooks'
import { diffDays, formatDate } from '@/lib/dates'
import { friendlyError } from '@/lib/errors'
import { formatAmountInput, formatMoney, minorToDecimalString, parseAmountToMinor, MAX_AMOUNT_MINOR } from '@/lib/money'
import { goBack } from '@/lib/navigation'
import { describeSchedule, upcomingDates } from '@/lib/recurrence'

const UPCOMING_DAYS = 30

export function Recurring() {
  const { todayDate, timeZone, categoriesById, accountsById } = useSettings()
  const rules = useRecurringRules()
  const due = useDueOccurrences()
  const confirm = useConfirmOccurrence()
  const skip = useSkipOccurrence()
  const toast = useToast()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<{ key: string; action: 'confirm' | 'skip' } | null>(null)

  const rulesById = useMemo(() => new Map((rules.data ?? []).map((r) => [r.id, r])), [rules.data])
  const dueItems = (due.data ?? []).filter((o) => rulesById.has(o.rule_id))
  const upcoming = (rules.data ?? [])
    .filter((r) => r.active && (!r.end_date || r.next_due_date <= r.end_date))
    .filter((r) => diffDays(r.next_due_date, todayDate) > 0 && diffDays(r.next_due_date, todayDate) <= UPCOMING_DAYS)
    .sort((a, b) => a.next_due_date.localeCompare(b.next_due_date))

  async function act(rule: RecurringRuleRow, dueDate: string, action: 'confirm' | 'skip') {
    setBusy({ key: `${rule.id}:${dueDate}`, action })
    try {
      if (action === 'confirm') {
        const occurredAt = diffDays(dueDate, todayDate) < 0 ? occurredAtFor(dueDate, todayDate, timeZone) : undefined
        const transactionId = await confirm.mutateAsync({ ruleId: rule.id, dueDate, overrides: { occurredAt } })
        toast({
          message: `Recorded ${rule.name} · ${formatMoney(rule.amount_minor)}`,
          action: { label: 'Edit', onClick: () => navigate(`/entry/${rule.type}/${transactionId}/edit`) },
        })
      } else {
        await skip.mutateAsync({ ruleId: rule.id, dueDate })
        toast({ message: `Skipped ${rule.name} — nothing was recorded.` })
      }
    } catch (error) {
      toast({ message: friendlyError(error), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const card = (rule: RecurringRuleRow, dueDate: string, key: string) => (
    <RecurringDueCard
      key={key}
      rule={rule}
      dueDate={dueDate}
      todayDate={todayDate}
      category={rule.category_id ? categoriesById.get(rule.category_id) : undefined}
      accountName={accountsById.get(rule.account_id)?.name}
      busy={busy?.key === `${rule.id}:${dueDate}` ? busy.action : null}
      onConfirm={() => void act(rule, dueDate, 'confirm')}
      onSkip={() => void act(rule, dueDate, 'skip')}
    />
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Recurring"
        back="/profile"
        actions={
          <LinkButton to="/recurring/new" size="sm" variant="primary" icon={<Plus aria-hidden="true" className="size-4" strokeWidth={3} />}>
            Add<span className="sr-only"> recurring item</span>
          </LinkButton>
        }
      />
      <p className="text-sm text-muted">
        Bills and salaries that repeat. Friday reminds you when one is due — nothing is recorded until you confirm it.
      </p>

      {rules.isPending || due.isPending ? (
        <LoadingBlock rows={3} label="Loading recurring items" />
      ) : rules.error || due.error ? (
        <InlineError message={friendlyError(rules.error ?? due.error)} onRetry={() => void rules.refetch()} />
      ) : rules.data.length === 0 ? (
        <EmptyState
          icon={<Repeat className="size-9" strokeWidth={2.5} />}
          tone="purple"
          scribble="set & remember"
          title="No recurring items"
          body="Add rent, salary, subscriptions or SIPs and Friday will prompt you when they’re due."
          action={
            <LinkButton to="/recurring/new" variant="primary">
              Add a recurring item
            </LinkButton>
          }
        />
      ) : (
        <>
          {dueItems.length > 0 && (
            <section aria-labelledby="due-now" className="flex flex-col gap-3">
              <h2 id="due-now" className="display text-2xl">
                Due now
              </h2>
              {dueItems.map((o) => card(rulesById.get(o.rule_id)!, o.due_date, o.id))}
            </section>
          )}

          {upcoming.length > 0 && (
            <section aria-labelledby="coming-up" className="flex flex-col gap-3">
              <h2 id="coming-up" className="display text-2xl">
                Coming up
              </h2>
              <p className="-mt-2 text-sm text-muted">Paid early? Confirm it now and Friday moves on to the next date.</p>
              {upcoming.map((rule) => card(rule, rule.next_due_date, `${rule.id}-next`))}
            </section>
          )}

          <section aria-labelledby="all-rules" className="flex flex-col gap-3">
            <h2 id="all-rules" className="display text-2xl">
              All recurring
            </h2>
            <Card padded={false} className="p-1.5">
              <ul>
                {rules.data.map((rule) => {
                  const ended = Boolean(rule.end_date && rule.next_due_date > rule.end_date)
                  const chip = dueChip(rule.next_due_date, todayDate)
                  const category = rule.category_id ? categoriesById.get(rule.category_id) : undefined
                  return (
                    <li key={rule.id}>
                      <Link to={`/recurring/${rule.id}`} className="flex min-h-16 items-center gap-3 rounded-2xl px-2 py-2 hover:bg-peach/50">
                        <CategoryBadge icon={category?.icon ?? 'repeat'} color={category?.color ?? 'peach'} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-semibold">{rule.name}</span>
                          <span className="label-mono text-muted">
                            {describeSchedule({ cadence: rule.cadence, intervalCount: rule.interval_count })} ·{' '}
                            {!rule.active ? 'Paused' : ended ? 'Ended' : `Next ${formatDate(rule.next_due_date)}`}
                          </span>
                        </span>
                        <span className="flex flex-col items-end gap-1">
                          <span className={cn('tabular font-display font-extrabold', rule.type === 'income' && 'text-positive')}>
                            {rule.type === 'expense' ? '−' : '+'}
                            {formatMoney(rule.amount_minor)}
                          </span>
                          {rule.active && !ended && diffDays(rule.next_due_date, todayDate) <= 7 && (
                            <span className={cn('label-mono rounded-pill px-2 py-0.5 outline-regular', chip.className)}>{chip.text}</span>
                          )}
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </Card>
          </section>
        </>
      )}
    </div>
  )
}

const CADENCE_OPTIONS: { value: RecurringCadence; label: string }[] = [
  { value: 'daily', label: 'day(s)' },
  { value: 'weekly', label: 'week(s)' },
  { value: 'monthly', label: 'month(s)' },
  { value: 'yearly', label: 'year(s)' },
]

export function RecurringEditor() {
  const { id } = useParams()
  const { todayDate, activeAccounts, accountsById, categories } = useSettings()
  const rules = useRecurringRules()
  const save = useSaveRecurringRule()
  const remove = useDeleteRecurringRule()
  const navigate = useNavigate()
  const toast = useToast()
  const rule = id ? rules.data?.find((r) => r.id === id) : undefined

  if (id && rules.isPending) return <LoadingBlock rows={4} />
  if (id && !rule) {
    return (
      <div>
        <PageHeader title="Recurring" back="/recurring" />
        <InlineError message="That recurring item doesn’t exist." />
      </div>
    )
  }

  return (
    <RecurringForm
      key={rule?.id ?? 'new'}
      rule={rule}
      todayDate={todayDate}
      accounts={rule && !activeAccounts.some((a) => a.id === rule.account_id) ? [...activeAccounts, accountsById.get(rule.account_id)!].filter(Boolean) : activeAccounts}
      categories={categories}
      saving={save.isPending}
      deleting={remove.isPending}
      onSave={async (values) => {
        await save.mutateAsync({ id: rule?.id, values })
        toast({ message: rule ? 'Recurring item saved' : 'Recurring item added' })
        goBack(navigate, '/recurring')
      }}
      onTogglePause={
        rule
          ? async () => {
              await save.mutateAsync({ id: rule.id, values: { active: !rule.active } })
              toast({ message: rule.active ? 'Paused — no reminders until you resume.' : 'Resumed.' })
            }
          : undefined
      }
      onDelete={
        rule
          ? async () => {
              await remove.mutateAsync(rule.id)
              toast({ message: 'Recurring item deleted. Recorded entries stay.' })
              navigate('/recurring', { replace: true })
            }
          : undefined
      }
    />
  )
}

interface RecurringFormProps {
  rule?: RecurringRuleRow
  todayDate: string
  accounts: ReturnType<typeof useSettings>['activeAccounts']
  categories: ReturnType<typeof useSettings>['categories']
  saving: boolean
  deleting: boolean
  onSave: (values: Parameters<ReturnType<typeof useSaveRecurringRule>['mutateAsync']>[0]['values']) => Promise<void>
  onTogglePause?: () => Promise<void>
  onDelete?: () => Promise<void>
}

function RecurringForm({ rule, todayDate, accounts, categories, saving, deleting, onSave, onTogglePause, onDelete }: RecurringFormProps) {
  const [type, setType] = useState<TransactionType>(rule?.type ?? 'expense')
  const [name, setName] = useState(rule?.name ?? '')
  const [amountText, setAmountText] = useState(rule ? formatAmountInput(minorToDecimalString(rule.amount_minor)) : '')
  const [accountId, setAccountId] = useState(
    rule?.account_id ?? accounts.find((a) => a.type !== 'credit_card')?.id ?? accounts[0]?.id ?? '',
  )
  const [categoryId, setCategoryId] = useState(rule?.category_id ?? '')
  const [cadence, setCadence] = useState<RecurringCadence>(rule?.cadence ?? 'monthly')
  const [intervalCount, setIntervalCount] = useState(String(rule?.interval_count ?? 1))
  const [startDate, setStartDate] = useState(rule?.start_date ?? todayDate)
  const [endDate, setEndDate] = useState(rule?.end_date ?? '')
  const [note, setNote] = useState(rule?.note ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const interval = Number.parseInt(intervalCount, 10)
  const scheduleOk = Number.isInteger(interval) && interval >= 1 && interval <= 52 && Boolean(startDate)
  const preview = scheduleOk
    ? upcomingDates({ startDate, cadence, intervalCount: interval }, rule ? rule.next_due_date : startDate, 3, endDate || null)
    : []

  const categoryOptions = categories.filter((c) => c.transaction_type === type && (!c.is_archived || c.id === categoryId))

  async function submit(event: FormEvent) {
    event.preventDefault()
    const amountMinor = parseAmountToMinor(amountText)
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = 'Name it — e.g. Rent or Salary'
    if (amountMinor === null || amountMinor <= 0) next.amount = 'Enter an amount more than zero'
    else if (amountMinor > MAX_AMOUNT_MINOR) next.amount = 'That amount is too large'
    if (!accountId) next.account = 'Choose an account'
    if (!scheduleOk) next.interval = 'Use a whole number from 1 to 52'
    if (endDate && endDate < startDate) next.endDate = 'The end date must be after the first due date'
    setErrors(next)
    if (Object.keys(next).length) return
    try {
      setSubmitError(null)
      await onSave({
        name: name.trim(),
        type,
        amount_minor: amountMinor!,
        account_id: accountId,
        category_id: categoryId || null,
        cadence,
        interval_count: interval,
        start_date: startDate,
        end_date: endDate || null,
        note: note.trim() || null,
      })
    } catch (error) {
      setSubmitError(friendlyError(error))
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={rule ? rule.name : 'New recurring'} back="/recurring" />
      {rule && !rule.active && (
        <Card tone="yellow" className="flex items-center gap-3 py-3">
          <Pause aria-hidden="true" className="size-5" strokeWidth={2.75} />
          <p className="font-semibold">Paused — Friday won’t prompt for this until you resume it.</p>
        </Card>
      )}
      <Card shadow="md">
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <PillSwitch
            label="Type"
            options={[
              { value: 'expense', label: 'Expense' },
              { value: 'income', label: 'Income' },
            ]}
            value={type}
            onChange={(next) => {
              setType(next)
              setCategoryId('')
            }}
          />
          <TextField label="Name" placeholder={type === 'expense' ? 'e.g. Rent' : 'e.g. Salary'} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} error={errors.name} />
          <TextField
            label="Amount"
            prefix="₹"
            inputMode="decimal"
            placeholder="0"
            value={amountText}
            onChange={(e) => setAmountText(formatAmountInput(e.target.value))}
            error={errors.amount}
            hint="You can change the amount each time you confirm."
          />
          <SelectField label={type === 'expense' ? 'Paid from' : 'Received into'} value={accountId} onChange={(e) => setAccountId(e.target.value)} error={errors.account}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </SelectField>
          <SelectField label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorised</option>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>

          <fieldset className="flex flex-col gap-2">
            <legend className="label-mono mb-1.5">Repeats every</legend>
            <div className="grid grid-cols-[5rem_1fr] gap-2">
              <TextField label="Interval" className="[&>label]:sr-only" inputMode="numeric" value={intervalCount} onChange={(e) => setIntervalCount(e.target.value.replace(/\D/g, '').slice(0, 2))} />
              <SelectField label="Unit" className="[&>label]:sr-only" value={cadence} onChange={(e) => setCadence(e.target.value as RecurringCadence)}>
                {CADENCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </SelectField>
            </div>
            {errors.interval && (
              <p role="alert" className="text-sm font-semibold text-negative">
                {errors.interval}
              </p>
            )}
          </fieldset>
          <TextField label="First due date" type="date" value={startDate} onChange={(e) => e.target.value && setStartDate(e.target.value)} hint="Later dates are counted from this one, so month-end bills stay on the month end." />
          <TextField label="Ends (optional)" type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} error={errors.endDate} />
          <TextAreaField label="Note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />

          {preview.length > 0 && (
            <div className="rounded-2xl bg-peach p-3 outline-regular">
              <p className="label-mono flex items-center gap-1.5">
                <CalendarClock aria-hidden="true" className="size-4" strokeWidth={2.5} />
                {describeSchedule({ cadence, intervalCount: interval })} — next up
              </p>
              <p className="mt-1 font-semibold">{preview.map((d) => formatDate(d, { withYear: d.slice(0, 4) !== todayDate.slice(0, 4) })).join(' · ')}</p>
            </div>
          )}

          {submitError && <InlineError message={submitError} />}
          <Button type="submit" variant="primary" size="lg" block loading={saving}>
            {rule ? 'Save changes' : 'Add recurring item'}
          </Button>
        </form>
      </Card>

      {rule && (
        <div className="flex gap-3">
          <Button
            block
            icon={rule.active ? <Pause className="size-4" strokeWidth={2.75} /> : <Play className="size-4" strokeWidth={2.75} />}
            onClick={() => onTogglePause?.().catch((e) => setSubmitError(friendlyError(e)))}
            disabled={saving}
          >
            {rule.active ? 'Pause' : 'Resume'}
          </Button>
          <Button block variant="danger" icon={<Trash className="size-4" strokeWidth={2.5} />} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this recurring item?"
        body="Future reminders stop. Anything you already recorded from it stays in your history."
        confirmLabel="Delete"
        danger
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() =>
          void onDelete?.().catch((e) => {
            setConfirmDelete(false)
            setSubmitError(friendlyError(e))
          })
        }
      />
      {rule && <p className="text-center text-sm text-muted">Started {formatDate(rule.start_date, { withYear: true })} · next {formatDate(rule.next_due_date, { withYear: true })}</p>}
    </div>
  )
}
