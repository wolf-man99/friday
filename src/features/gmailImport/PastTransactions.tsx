import { useQueryClient } from '@tanstack/react-query'
import { CalendarRange, CircleCheck, History, Inbox, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useSettings } from '@/app/settings'
import { ACCOUNT_TYPE_LABEL } from '@/components/finance/icons'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ToggleChip } from '@/components/ui/Chip'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { SelectField, TextField } from '@/components/ui/Field'
import { InlineError, LoadingBlock } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import type { GmailImportJobRow } from '@/data/database.types'
import {
  cancelImport,
  confirmImportAccounts,
  gmailErrorMessage,
  runImport,
  scanImport,
  startImport,
  undoImport,
  type AccountDecision,
  type DiscoveredAccount,
} from '@/data/gmail'
import { keys, useGmailImport, useGmailImportAccounts, useGmailImportStep } from '@/data/hooks'
import { formatDate, type ISODate } from '@/lib/dates'
import { amountProblem, formatAmountInput, parseAmountToMinor } from '@/lib/money'
import {
  compatibleAccounts,
  defaultChoice,
  groupKey,
  importMonths,
  instrumentLabel,
  IMPORT_RUNNING,
  monthsLabel,
  toDecisions,
  type Choice,
} from './plan'

/**
 * Import past months from Gmail: choose months → Friday reads the alert
 * emails → confirm the accounts and cards they mention → it records what it's
 * sure about and sends the rest to Review → summary, with Undo.
 */
export function PastTransactions({ prompt = false }: { prompt?: boolean }) {
  const latest = useGmailImport()
  const job = latest.data ?? null
  const driverError = useImportDriver(job)
  const [picking, setPicking] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  if (latest.isPending) return <LoadingBlock rows={2} label="Loading imports" />
  if (latest.isError) return <InlineError message={gmailErrorMessage(latest.error)} onRetry={() => void latest.refetch()} />

  const running = job !== null && IMPORT_RUNNING.includes(job.status)
  return (
    <section aria-labelledby="past-heading" className="flex flex-col gap-3">
      <h2 id="past-heading" className="display text-2xl">
        {prompt && !job ? 'Track your past transactions?' : 'Past transactions'}
      </h2>
      {driverError && <InlineError message={driverError} />}
      {job?.status === 'listing' && <Progress title="Finding alert emails…" />}
      {job?.status === 'scanning' && (
        <Progress
          title="Reading alert emails…"
          detail={`${job.scanned} of ${job.total_messages}`}
          value={job.total_messages ? job.scanned / job.total_messages : undefined}
          job={job}
        />
      )}
      {job?.status === 'confirm_accounts' && <AccountsStep job={job} />}
      {job?.status === 'importing' && <Progress title="Recording transactions…" detail="This takes a moment." />}
      {job && !running && !picking && <Outcome job={job} onMore={() => setPicking(true)} />}
      {!running && (picking || !job) && !(dismissed && !job) && (
        <MonthPicker prompt={prompt && !job} onDone={() => setPicking(false)} onNotNow={prompt && !job ? () => setDismissed(true) : undefined} />
      )}
      {!running && !job && dismissed && (
        <Button block icon={<History className="size-5" strokeWidth={2.5} />} onClick={() => setDismissed(false)}>
          Import past transactions
        </Button>
      )}
    </section>
  )
}

// -----------------------------------------------------------------------------
// Keeping an import moving (reading, then recording) while this page is open
// -----------------------------------------------------------------------------

// One loop per import step, even if the page re-renders or remounts.
const driving = new Set<string>()

function useImportDriver(job: GmailImportJobRow | null): string | null {
  const client = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const id = job?.id
  const status = job?.status

  useEffect(() => {
    if (!id || (status !== 'scanning' && status !== 'importing')) return
    const key = `${id}:${status}`
    if (driving.has(key)) return
    driving.add(key)
    setError(null)
    const step = status === 'scanning' ? scanImport : runImport
    void (async () => {
      try {
        for (let round = 0; round < 1000; round++) {
          const progress = await step(id)
          client.setQueryData<GmailImportJobRow | null>(keys.gmailImport, (old) =>
            old && old.id === id
              ? { ...old, status: progress.status, scanned: progress.scanned ?? old.scanned, total_messages: progress.total ?? old.total_messages }
              : old,
          )
          if (progress.status !== status) break
        }
      } catch (err) {
        setError(gmailErrorMessage(err))
      } finally {
        driving.delete(key)
        void client.invalidateQueries({ queryKey: keys.gmailImport })
        void client.invalidateQueries({ queryKey: keys.ledger })
      }
    })()
  }, [id, status, client])

  return error
}

function Progress({ title, detail, value, job }: { title: string; detail?: string; value?: number; job?: GmailImportJobRow }) {
  const cancel = useGmailImportStep(cancelImport)
  return (
    <Card shadow="md" className="flex flex-col gap-3" role="status" aria-live="polite">
      <p className="display text-xl">{title}</p>
      <div className="h-3 overflow-hidden rounded-pill bg-ink/10 outline-regular">
        <div
          className={value === undefined ? 'h-full w-1/3 animate-pulse rounded-pill bg-orange motion-reduce:animate-none' : 'h-full rounded-pill bg-orange'}
          style={value === undefined ? undefined : { width: `${Math.max(4, Math.round(value * 100))}%` }}
        />
      </div>
      {detail && <p className="text-sm text-muted">{detail}</p>}
      <p className="text-sm text-muted">Nothing is recorded until you’ve confirmed your accounts.</p>
      {job && (
        <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
          Cancel import
        </Button>
      )}
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Choosing months
// -----------------------------------------------------------------------------

function MonthPicker({ prompt, onDone, onNotNow }: { prompt: boolean; onDone: () => void; onNotNow?: () => void }) {
  const { todayDate } = useSettings()
  const months = useMemo(() => importMonths(todayDate), [todayDate])
  const [chosen, setChosen] = useState<string[]>(() => months.map((m) => m.value))
  const start = useGmailImportStep(startImport)
  const toast = useToast()

  const toggle = (value: string) =>
    setChosen((current) => (current.includes(value) ? current.filter((m) => m !== value) : [...current, value]))

  return (
    <Card tone="peach" shadow="md" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="font-semibold">
          {prompt
            ? 'Friday can read the bank, card and wallet alert emails from the last few months and record those transactions.'
            : 'Read alert emails from these months and record their transactions.'}
        </p>
        <p className="text-sm text-muted">
          You’ll confirm each account first. Anything Friday isn’t sure about waits in Review, and you can undo the import.
        </p>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="label-mono mb-2">Months</legend>
        <div className="flex flex-wrap gap-2">
          {months.map((month) => (
            <ToggleChip key={month.value} selected={chosen.includes(month.value)} onClick={() => toggle(month.value)} icon={<CalendarRange aria-hidden="true" className="size-4" strokeWidth={2.5} />}>
              {month.label}
            </ToggleChip>
          ))}
        </div>
      </fieldset>
      {start.isError && <InlineError message={gmailErrorMessage(start.error)} />}
      <div className="flex flex-col gap-2">
        <Button
          variant="primary"
          size="lg"
          block
          disabled={chosen.length === 0}
          loading={start.isPending}
          onClick={() =>
            start.mutate(chosen, {
              onSuccess: ({ total, truncated }) => {
                onDone()
                if (total === 0) toast({ message: 'No alert emails in those months' })
                else if (truncated) toast({ message: `Reading the newest ${total} alert emails` })
              },
            })
          }
        >
          {chosen.length === 0 ? 'Choose a month' : `Find transactions in ${chosen.length === 3 ? 'all 3 months' : monthsLabel(chosen)}`}
        </Button>
        {onNotNow && (
          <Button variant="ghost" block onClick={onNotNow}>
            Not now
          </Button>
        )}
      </div>
    </Card>
  )
}

// -----------------------------------------------------------------------------
// Confirming accounts
// -----------------------------------------------------------------------------

function AccountsStep({ job }: { job: GmailImportJobRow }) {
  const { accounts } = useSettings()
  const found = useGmailImportAccounts(job.id)
  const confirm = useGmailImportStep((decisions: AccountDecision[]) => confirmImportAccounts(job.id, decisions))
  const cancel = useGmailImportStep(cancelImport)
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [problem, setProblem] = useState<{ key: string; message: string } | null>(null)
  const groups = useMemo(() => found.data ?? [], [found.data])
  const historyStart = `${[...job.months].sort()[0]}-01` as ISODate

  useEffect(() => {
    setChoices((current) => {
      const next = { ...current }
      for (const group of groups) next[groupKey(group)] ??= defaultChoice(group, accounts)
      return next
    })
  }, [groups, accounts])

  if (found.isPending) return <LoadingBlock rows={3} label="Finding your accounts" />
  if (found.isError) return <InlineError message={gmailErrorMessage(found.error)} onRetry={() => void found.refetch()} />

  const submit = () => {
    const parse = (text: string) => (amountProblem(text) ? null : parseAmountToMinor(text))
    const result = toDecisions(groups, choices, parse)
    if (!result.ok) return setProblem({ key: result.key, message: result.message })
    setProblem(null)
    confirm.mutate(result.decisions)
  }

  return (
    <div className="flex flex-col gap-3">
      <Card tone="sky" shadow="md" className="flex flex-col gap-1">
        <p className="display text-xl">
          Found {job.scanned - job.skipped} transaction email{job.scanned - job.skipped === 1 ? '' : 's'} in {monthsLabel(job.months)}
        </p>
        <p className="text-sm">Confirm which account each one belongs to. Nothing is recorded until you do.</p>
      </Card>
      <ul className="flex flex-col gap-3">
        {groups.map((group) => {
          const key = groupKey(group)
          return (
            <li key={key}>
              <AccountRow
                group={group}
                choice={choices[key]}
                historyStart={historyStart}
                error={problem?.key === key ? problem.message : null}
                onChange={(choice) => {
                  setChoices((current) => ({ ...current, [key]: choice }))
                  if (problem?.key === key) setProblem(null)
                }}
              />
            </li>
          )
        })}
      </ul>
      {confirm.isError && <InlineError message={gmailErrorMessage(confirm.error)} />}
      <Button variant="primary" size="lg" block loading={confirm.isPending} onClick={submit}>
        Import transactions
      </Button>
      <Button variant="ghost" block disabled={confirm.isPending} loading={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
        Cancel import
      </Button>
    </div>
  )
}

function AccountRow({
  group,
  choice,
  historyStart,
  error,
  onChange,
}: {
  group: DiscoveredAccount
  choice: Choice | undefined
  historyStart: ISODate
  error: string | null
  onChange: (choice: Choice) => void
}) {
  const { accounts } = useSettings()
  const options = compatibleAccounts(group, accounts)
  if (!choice) return null
  const value = choice.kind === 'link' ? `link:${choice.accountId}` : choice.kind
  const linked = choice.kind === 'link' ? options.find((a) => a.id === choice.accountId) : undefined
  const label = instrumentLabel(group)
  const span =
    group.firstAt && group.lastAt
      ? `${formatDate(group.firstAt.slice(0, 10) as ISODate)} – ${formatDate(group.lastAt.slice(0, 10) as ISODate)}`
      : null

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <p className="font-display text-lg font-extrabold tracking-tight">{label}</p>
        <p className="text-sm text-muted">
          {group.messages} email{group.messages === 1 ? '' : 's'}
          {span ? ` · ${span}` : ''}
        </p>
      </div>
      <SelectField
        label={`Use ${label} as`}
        value={value}
        error={error ?? undefined}
        onChange={(e) => {
          const next = e.target.value
          if (next.startsWith('link:')) onChange({ ...choice, kind: 'link', accountId: next.slice(5) })
          else onChange({ ...choice, kind: next as Choice['kind'] })
        }}
      >
        {options.map((account) => (
          <option key={account.id} value={`link:${account.id}`}>
            {account.name} · {ACCOUNT_TYPE_LABEL[account.type]}
          </option>
        ))}
        <option value="create">A new account</option>
        <option value="review">Not sure — send its transactions to Review</option>
        <option value="ignore">Ignore this account</option>
      </SelectField>

      {choice.kind === 'create' && (
        <div className="flex flex-col gap-3 rounded-2xl bg-canvas p-3 outline-regular">
          <TextField label="Name" value={choice.name} maxLength={60} onChange={(e) => onChange({ ...choice, name: e.target.value })} />
          <SelectField label="Type" value={choice.type} onChange={(e) => onChange({ ...choice, type: e.target.value as Choice['type'] })}>
            <option value="bank">{ACCOUNT_TYPE_LABEL.bank}</option>
            <option value="credit_card">{ACCOUNT_TYPE_LABEL.credit_card}</option>
            <option value="wallet">{ACCOUNT_TYPE_LABEL.wallet}</option>
          </SelectField>
          <TextField
            label={`${choice.type === 'credit_card' ? 'Amount owed' : 'Balance'} on ${formatDate(historyStart, { withYear: true })} (optional)`}
            prefix="₹"
            inputMode="decimal"
            autoComplete="off"
            value={choice.openingText}
            onChange={(e) => onChange({ ...choice, openingText: formatAmountInput(e.target.value) })}
            hint="Leave empty to start from ₹0: the balance then shows only imported transactions."
          />
        </div>
      )}
      {linked && linked.opening_date > historyStart && (
        <p className="text-sm text-muted">
          Earlier transactions will count in your spending; {linked.name}’s balance stays exactly as it is.
        </p>
      )}
      {choice.kind === 'review' && <p className="text-sm text-muted">Each of its transactions waits in Review for you to place.</p>}
      {choice.kind === 'ignore' && <p className="text-sm text-muted">Friday won’t import anything from this account, now or later.</p>}
    </Card>
  )
}

// -----------------------------------------------------------------------------
// After an import
// -----------------------------------------------------------------------------

function Outcome({ job, onMore }: { job: GmailImportJobRow; onMore: () => void }) {
  const undo = useGmailImportStep(undoImport)
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)

  if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'undone') {
    return (
      <Card className="flex flex-col gap-3">
        <p className="font-semibold">
          {job.status === 'failed'
            ? 'The last import stopped because Gmail didn’t respond. Nothing was recorded.'
            : job.status === 'undone'
              ? `The ${monthsLabel(job.months)} import was undone.`
              : 'The last import was cancelled. Nothing was recorded.'}
        </p>
        <Button block icon={<History className="size-5" strokeWidth={2.5} />} onClick={onMore}>
          Import past transactions
        </Button>
      </Card>
    )
  }

  const notTransactions = job.skipped + job.ignored
  return (
    <Card tone="mint" shadow="md" className="flex flex-col gap-3">
      <p className="label-mono">
        <CircleCheck aria-hidden="true" className="mr-1 inline size-4" strokeWidth={2.5} />
        Imported {monthsLabel(job.months)}
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
        <dt>Recorded</dt>
        <dd className="tabular font-semibold">{job.recorded}</dd>
        {job.matched > 0 && (
          <>
            <dt>Already in Friday</dt>
            <dd className="tabular font-semibold">{job.matched}</dd>
          </>
        )}
        <dt>Waiting in Review</dt>
        <dd className="tabular font-semibold">{job.review}</dd>
        <dt className="text-muted">Skipped (not transactions, or ignored accounts)</dt>
        <dd className="tabular text-muted">{notTransactions}</dd>
      </dl>
      {job.truncated && <p className="text-sm">There were more alert emails than one import reads; the newest {job.total_messages} were read.</p>}
      {job.review > 0 && (
        <Link to="/review" className="inline-flex items-center gap-2 font-semibold underline">
          <Inbox aria-hidden="true" className="size-4" strokeWidth={2.5} /> Open Review ({job.review})
        </Link>
      )}
      <div className="flex flex-col gap-2">
        <Button block icon={<History className="size-5" strokeWidth={2.5} />} onClick={onMore}>
          Import other months
        </Button>
        <Button variant="ghost" block icon={<Undo2 className="size-5" strokeWidth={2.5} />} onClick={() => setConfirming(true)}>
          Undo this import
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Undo this import?"
        body={
          <div className="flex flex-col gap-3">
            <p>
              This removes the {job.recorded} transaction{job.recorded === 1 ? '' : 's'} it recorded and takes its items out of
              Review. Entries you typed yourself are never touched, and accounts it created stay.
            </p>
            {undo.isError && (
              <p role="alert" className="text-sm font-semibold text-negative">
                {gmailErrorMessage(undo.error)}
              </p>
            )}
          </div>
        }
        confirmLabel="Undo import"
        danger
        busy={undo.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          undo.mutate(job.id, {
            onSuccess: ({ removed, kept }) => {
              setConfirming(false)
              toast({
                message: kept > 0 ? `Removed ${removed}; kept ${kept} that a refund now depends on` : `Import undone · removed ${removed}`,
              })
            },
          })
        }
      />
    </Card>
  )
}
