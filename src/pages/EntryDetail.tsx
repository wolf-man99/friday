import {
  ArchiveRestore,
  Ban,
  Check,
  CheckCheck,
  ChevronDown,
  Link2,
  Pencil,
  RotateCcw,
  SearchX,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { useSettings } from '@/app/settings'
import { Amount } from '@/components/finance/Amount'
import { CategoryGlyph, TransferGlyph } from '@/components/finance/icons'
import { LinkedEntryForm } from '@/components/finance/LinkedEntryForm'
import { RefundPicker } from '@/components/finance/RefundPicker'
import { KindBadge, SourceBadge, StatusBadge } from '@/components/finance/StatusBadge'
import { TransactionRow } from '@/components/finance/TransactionRow'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button, LinkButton } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { cn } from '@/components/ui/cn'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { TextField } from '@/components/ui/Field'
import { EmptyState, InlineError, LoadingBlock } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { TONE_BG, toneOf } from '@/components/ui/tones'
import type { LedgerEntry } from '@/data/api'
import type { AccountBalanceRow, EntryKind, EntryStatus, LedgerEntryRow, SourceEventRow } from '@/data/database.types'
import {
  useEntry,
  useEntryAudit,
  useEntrySources,
  useLedgerEntry,
  useLinkedEntries,
  useSetEntryDeleted,
  useSetEntryStatus,
} from '@/data/hooks'
import {
  confidenceText,
  CREATED_VIA_LABEL,
  describeAudit,
  entryTypeLabel,
  formatDateTime,
  kindExplainer,
  remainingText,
} from '@/features/detail/describe'
import { formatDate, formatRelativeDay, localDate } from '@/lib/dates'
import { classifyError, friendlyError } from '@/lib/errors'
import {
  canChangeStatus,
  isCounted,
  KIND_LABEL,
  offsetActions,
  remainingToOffset,
  restoreTarget,
  SOURCE_LABEL,
  STATUS_EXPLAINER,
  STATUS_LABEL,
} from '@/lib/ledger'
import { fitAmountClass, formatMoney } from '@/lib/money'

const KINDS: readonly EntryKind[] = ['expense', 'income', 'refund', 'reversal', 'transfer']

function isEntryKind(value: string | undefined): value is EntryKind {
  return (KINDS as readonly string[]).includes(value ?? '')
}

const SCRIBBLE: Record<EntryKind, string> = {
  expense: 'money out',
  income: 'money in',
  refund: 'money back',
  reversal: 'undone',
  transfer: 'moved',
}

const NOUN: Record<EntryKind, string> = {
  expense: 'expense',
  income: 'income',
  refund: 'refund',
  reversal: 'reversal',
  transfer: 'transfer',
}

/** One ledger entry: what it is, where it came from, what's linked to it, and safe ways to correct it. */
export function EntryDetail() {
  const params = useParams<{ kind: string; id: string }>()
  const kind = isEntryKind(params.kind) ? params.kind : undefined
  const entryQuery = useEntry(kind, kind ? params.id : undefined)

  if (!kind || !params.id) return <NotFound />
  if (entryQuery.isPending) {
    return (
      <div>
        <PageHeader title="Details" back="/activity" />
        <LoadingBlock rows={5} label="Loading entry" />
      </div>
    )
  }
  if (entryQuery.error || !entryQuery.data) {
    // PostgREST's "no rows" for .single(): the id isn't one of yours.
    if (!entryQuery.data && (entryQuery.error as { code?: string } | null)?.code === 'PGRST116') return <NotFound />
    return (
      <div>
        <PageHeader title="Details" back="/activity" />
        <InlineError message={friendlyError(entryQuery.error)} onRetry={() => void entryQuery.refetch()} />
      </div>
    )
  }
  return <Details entry={entryQuery.data} onReload={() => void entryQuery.refetch()} />
}

function NotFound() {
  return (
    <div>
      <PageHeader title="Details" back="/activity" />
      <EmptyState
        icon={<SearchX className="size-9" strokeWidth={2.25} />}
        tone="sky"
        title="Entry not found"
        body="It may have been removed, or the link is wrong."
        action={
          <LinkButton to="/activity" variant="primary">
            Go to activity
          </LinkButton>
        }
      />
    </div>
  )
}

type ActionError = { message: string; conflict: boolean } | null
type LinkedFormState = { kind: 'refund' | 'reversal'; mode: 'create' | 'edit' } | null

function Details({ entry, onReload }: { entry: LedgerEntry; onReload: () => void }) {
  const { accountsById, categoriesById, timeZone, todayDate } = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const setStatus = useSetEntryStatus()
  const setDeleted = useSetEntryDeleted()
  const acting = useRef(false)

  const tx = entry.kind === 'transfer' ? null : entry
  const transfer = entry.kind === 'transfer' ? entry : null
  const account = accountsById.get(transfer ? transfer.source_account_id : tx!.account_id)
  const destination = transfer ? accountsById.get(transfer.destination_account_id) : undefined
  const category = tx?.category_id ? categoriesById.get(tx.category_id) : undefined
  const baseType = tx?.base_type ?? null
  const status = entry.status
  const deleted = Boolean(entry.deleted_at)
  const voided = status === 'voided'
  const isOriginal = entry.kind === 'expense' || entry.kind === 'income'
  const isOffset = entry.kind === 'refund' || entry.kind === 'reversal'
  const relatedId = isOffset ? (tx?.related_transaction_id ?? null) : null

  // Money back recorded against this entry, or the original this entry belongs to.
  const linked = useLinkedEntries(isOriginal ? entry.id : null)
  const original = useLedgerEntry(relatedId)
  const siblings = useLinkedEntries(relatedId)
  const audit = useEntryAudit(entry.kind, entry.id)
  const sources = useEntrySources(entry.kind, entry.id)

  const [actionError, setActionError] = useState<ActionError>(null)
  const [linkedForm, setLinkedForm] = useState<LinkedFormState>(null)
  const [picker, setPicker] = useState(false)
  const [confirmVoid, setConfirmVoid] = useState(false)
  const [voidReason, setVoidReason] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const typeLabel = entryTypeLabel(entry.kind, destination?.type)
  // Merchant → note → category → the kind itself.
  const title = tx?.merchant || entry.note || category?.name || typeLabel
  const noun = transfer ? typeLabel.toLowerCase() : NOUN[entry.kind]

  // --- What can be done -----------------------------------------------------------

  const linkedRows = linked.data ?? []
  const remaining = isOriginal && linked.data ? remainingToOffset(entry, linked.data) : null
  const hasCountedLinked = linkedRows.some((row) => isCounted(row.status))
  const offsets = deleted ? [] : offsetActions(entry)
  const busy = setStatus.isPending || setDeleted.isPending
  // Until money back is known, don't offer anything it could block.
  const linkedUnknown = isOriginal && !linked.data
  const canEdit = !deleted && !voided && (!relatedId || (original.isSuccess && siblings.isSuccess))
  const canRefund = offsets.includes('refund') && remaining !== null && remaining > 0
  const canReverse = offsets.includes('reversal') && remaining !== null && remaining > 0
  const canMakeRefund = !deleted && entry.kind === 'income' && status === 'posted' && linked.data?.length === 0
  const canLinkPurchase = !deleted && entry.kind === 'refund' && !relatedId && !voided
  const canPost = !deleted && status === 'pending' && canChangeStatus(status, 'posted')
  const canConfirm = !deleted && status === 'needs_review' && canChangeStatus(status, 'posted')
  const restoreTo = restoreTarget(entry)
  const canRestore = !deleted && voided && canChangeStatus(status, restoreTo, entry.voided_from)
  const canVoid = !deleted && !voided && canChangeStatus(status, 'voided') && !linkedUnknown && !hasCountedLinked
  const canDelete = !deleted && !linkedUnknown && !hasCountedLinked

  // --- Doing it -----------------------------------------------------------------

  async function run(action: () => Promise<unknown>, done: string | null) {
    if (acting.current) return false
    acting.current = true
    setActionError(null)
    try {
      await action()
      if (done) toast({ message: done })
      return true
    } catch (error) {
      setActionError({ message: friendlyError(error), conflict: classifyError(error) === 'conflict' })
      return false
    } finally {
      acting.current = false
    }
  }

  function changeStatus(to: EntryStatus, done: string, reason: string | null = null) {
    return run(
      () => setStatus.mutateAsync({ kind: entry.kind, id: entry.id, status: to, reason, expectedUpdatedAt: entry.updated_at }),
      done,
    )
  }

  async function voidEntry() {
    const ok = await changeStatus('voided', 'Voided — it no longer counts anywhere', voidReason.trim() || null)
    // On failure the reason is kept and the error shows on the page.
    setConfirmVoid(false)
    if (ok) setVoidReason('')
  }

  async function remove() {
    const ok = await run(() => setDeleted.mutateAsync({ kind: entry.kind, id: entry.id, deleted: true }), null)
    setConfirmDelete(false)
    if (!ok) return
    toast({
      message: `Deleted ${noun} · ${formatMoney(entry.amount_minor)}`,
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            await setDeleted.mutateAsync({ kind: entry.kind, id: entry.id, deleted: false })
            toast({ message: 'Restored.' })
          } catch (error) {
            toast({ message: friendlyError(error), tone: 'error' })
          }
        },
      },
    })
  }

  function restoreDeleted() {
    return run(() => setDeleted.mutateAsync({ kind: entry.kind, id: entry.id, deleted: false }), 'Restored.')
  }

  function edit() {
    if (entry.kind === 'refund' || entry.kind === 'reversal') {
      setLinkedForm({ kind: entry.kind, mode: 'edit' })
      return
    }
    navigate(`/entry/${entry.kind}/${entry.id}/edit`, { state: { from: location.pathname } })
  }

  // --- Render ---------------------------------------------------------------------

  const date = localDate(entry.occurred_at, timeZone)
  const relative = formatRelativeDay(date, todayDate)
  const dateText =
    relative === 'Today' || relative === 'Yesterday'
      ? `${relative} · ${formatDate(date, { withYear: true })}`
      : formatDate(date, { withYear: true })
  const amountClass = fitAmountClass(formatMoney(entry.amount_minor, { sign: 'always' }), [
    'text-[3.25rem]',
    'text-[2.6rem]',
    'text-[2rem]',
  ])
  const tone = transfer ? 'purple' : toneOf(category?.color)
  const explainer = kindExplainer(entry.kind, baseType, destination?.type)
  const confidence = entry.source_type !== 'manual' ? confidenceText(entry.source_confidence) : null

  const statusAction = canConfirm ? (
    <Button
      variant="primary"
      block
      disabled={busy}
      icon={<CheckCheck className="size-5" strokeWidth={2.75} />}
      onClick={() => void changeStatus('posted', 'Confirmed — it counts now')}
    >
      Confirm
    </Button>
  ) : canPost ? (
    <Button
      variant="primary"
      block
      disabled={busy}
      icon={<Check className="size-5" strokeWidth={2.75} />}
      onClick={() => void changeStatus('posted', 'Marked as posted')}
    >
      Mark as posted
    </Button>
  ) : canRestore ? (
    <Button
      variant="primary"
      block
      disabled={busy}
      icon={<ArchiveRestore className="size-5" strokeWidth={2.5} />}
      onClick={() => void changeStatus(restoreTo, `Restored — ${STATUS_LABEL[restoreTo].toLowerCase()} again`)}
    >
      Restore
    </Button>
  ) : null

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={typeLabel} scribble={SCRIBBLE[entry.kind]} back="/activity" />

      {deleted && (
        <Card tone="yellow" padded={false} className="flex flex-col gap-3 px-4 py-3" role="status">
          <p className="flex items-start gap-3 text-sm font-semibold">
            <Trash2 aria-hidden="true" className="mt-0.5 size-5 shrink-0" strokeWidth={2.5} />
            This entry was deleted. It isn’t in any list, balance or insight.
          </p>
          <Button
            size="sm"
            variant="primary"
            className="self-start"
            disabled={busy}
            loading={setDeleted.isPending}
            onClick={() => void restoreDeleted()}
          >
            Restore
          </Button>
        </Card>
      )}

      <Card tone="paper" shadow="lg" padded={false} className={cn('overflow-hidden', deleted && 'opacity-70')}>
        <div className={cn('flex flex-col gap-3 p-4', TONE_BG[tone])}>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-full bg-paper outline-regular">
              {transfer ? <TransferGlyph /> : <CategoryGlyph icon={category?.icon ?? (isOffset ? 'undo' : 'tag')} />}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-xl font-extrabold tracking-tight [overflow-wrap:anywhere]">{title}</h2>
              <p className="label-mono truncate">
                {transfer ? `${account?.name ?? 'Account'} → ${destination?.name ?? 'Account'}` : dateText}
              </p>
            </div>
          </div>
          <Amount
            minor={entry.amount_minor}
            kind={entry.kind}
            baseType={baseType}
            colored={false}
            className={cn('display block', amountClass, (voided || deleted) && 'line-through decoration-[3px]')}
          />
          {(isOffset || status !== 'posted' || entry.source_type !== 'manual' || deleted) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <KindBadge kind={entry.kind} />
              <StatusBadge status={status} />
              <SourceBadge source={entry.source_type} />
              {deleted && <span className="label-mono rounded-pill bg-paper px-2 py-0.5 outline-regular">Deleted</span>}
            </div>
          )}
        </div>

        <dl className="flex flex-col divide-y-2 divide-ink/10 border-t-[3px] border-ink px-4 text-sm">
          <Fact label="Type">
            {typeLabel}
            {explainer && <Sub>{explainer}</Sub>}
          </Fact>
          <Fact label="Date">{dateText}</Fact>
          {transfer ? (
            <>
              <Fact label="From">
                <AccountName account={account} />
              </Fact>
              <Fact label="To">
                <AccountName account={destination} />
              </Fact>
            </>
          ) : (
            <>
              <Fact label="Account">
                <AccountName account={account} />
              </Fact>
              <Fact label="Category">
                {category?.name ?? 'Uncategorised'}
                {category?.is_archived && ' (archived)'}
                {isOffset && relatedId && ' · from the original'}
              </Fact>
              {tx!.merchant && <Fact label={entry.kind === 'income' ? 'Payer' : 'Merchant'}>{tx!.merchant}</Fact>}
            </>
          )}
          {entry.note && (
            <Fact label="Note" stacked>
              <span className="whitespace-pre-wrap font-medium">{entry.note}</span>
            </Fact>
          )}
          <Fact label="Status" stacked>
            {STATUS_LABEL[status]}
            {deleted ? ' · deleted' : ''}
            <Sub>{deleted ? 'Deleted entries don’t count anywhere.' : STATUS_EXPLAINER[status]}</Sub>
          </Fact>
          <Fact label="Source">
            {SOURCE_LABEL[entry.source_type]}
            {confidence && <Sub>{confidence}</Sub>}
          </Fact>
          <Fact label="Created via">{CREATED_VIA_LABEL[entry.created_via] ?? 'Manual'}</Fact>
          <Fact label="Added">{formatDateTime(entry.created_at, timeZone)}</Fact>
          <Fact label="Last changed">{formatDateTime(entry.updated_at, timeZone)}</Fact>
        </dl>
      </Card>

      {actionError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-2xl bg-paper px-3.5 py-3 text-sm font-semibold outline-regular"
        >
          <p>{actionError.message}</p>
          {actionError.conflict && (
            <Button
              size="sm"
              icon={<RotateCcw className="size-4" strokeWidth={2.75} />}
              onClick={() => {
                setActionError(null)
                onReload()
              }}
            >
              Load the latest version
            </Button>
          )}
        </div>
      )}

      {!deleted && (
        <section aria-label="Actions" className="flex flex-col gap-3">
          {statusAction}
          <div className="grid grid-cols-2 gap-3">
            {canEdit && (
              <Button size="sm" block disabled={busy} icon={<Pencil className="size-4" strokeWidth={2.5} />} onClick={edit}>
                Edit
              </Button>
            )}
            {canRefund && (
              <Button
                size="sm"
                block
                disabled={busy}
                icon={<Undo2 className="size-4" strokeWidth={2.5} />}
                onClick={() => setLinkedForm({ kind: 'refund', mode: 'create' })}
              >
                Record refund
              </Button>
            )}
            {canReverse && (
              <Button
                size="sm"
                block
                disabled={busy}
                icon={<RotateCcw className="size-4" strokeWidth={2.5} />}
                onClick={() => setLinkedForm({ kind: 'reversal', mode: 'create' })}
              >
                Reverse
              </Button>
            )}
            {(canMakeRefund || canLinkPurchase) && (
              <Button
                size="sm"
                block
                className="col-span-2"
                disabled={busy}
                icon={<Link2 className="size-4" strokeWidth={2.5} />}
                onClick={() => setPicker(true)}
              >
                {canMakeRefund ? 'This was a refund' : 'Link to purchase'}
              </Button>
            )}
            {canVoid && (
              <Button
                size="sm"
                block
                disabled={busy}
                icon={<Ban className="size-4" strokeWidth={2.5} />}
                onClick={() => setConfirmVoid(true)}
              >
                Void
              </Button>
            )}
            {canDelete && (
              <Button
                size="sm"
                block
                variant="danger"
                disabled={busy}
                icon={<Trash2 className="size-4" strokeWidth={2.5} />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            )}
          </div>
          {hasCountedLinked && (
            <p className="text-sm text-muted">
              It has money back recorded against it, so it can’t be voided or deleted until those are voided or deleted.
            </p>
          )}
          {canRestore && (
            <p className="text-sm text-muted">
              Restore brings it back as {STATUS_LABEL[restoreTo].toLowerCase()}, the way it was before it was voided. Voided
              entries can’t be edited until then.
            </p>
          )}
        </section>
      )}

      {isOffset && (
        <section aria-labelledby="original-heading" className="flex flex-col gap-3">
          <h2 id="original-heading" className="display text-2xl">
            {entry.kind === 'refund' ? 'Refund of' : 'Reversal of'}
          </h2>
          {relatedId ? (
            original.isPending ? (
              <LoadingBlock rows={1} label="Loading the original" />
            ) : original.error ? (
              <InlineError message={friendlyError(original.error)} onRetry={() => void original.refetch()} />
            ) : original.data ? (
              <Card padded={false} className="p-1.5">
                <EntryRow entry={original.data} />
              </Card>
            ) : (
              <p className="text-sm text-muted">The original isn’t in your ledger any more.</p>
            )
          ) : (
            <Card tone="canvas" className="flex flex-col items-start gap-3 border-dashed">
              <p className="text-sm">
                Not linked to a purchase yet. It still lowers spending
                {category ? ` in ${category.name}` : ''}; linking it puts it against the purchase it came back for.
              </p>
              {canLinkPurchase && (
                <Button
                  size="sm"
                  disabled={busy}
                  icon={<Link2 className="size-4" strokeWidth={2.5} />}
                  onClick={() => setPicker(true)}
                >
                  Link to purchase
                </Button>
              )}
            </Card>
          )}
        </section>
      )}

      {isOriginal && (linkedRows.length > 0 || offsets.length > 0 || linked.isPending || linked.error) && (
        <section aria-labelledby="money-back-heading" className="flex flex-col gap-3">
          <h2 id="money-back-heading" className="display text-2xl">
            {entry.kind === 'expense' ? 'Money back' : 'Reversals'}
          </h2>
          {linked.isPending ? (
            <LoadingBlock rows={1} label="Loading refunds and reversals" />
          ) : linked.error ? (
            <InlineError message={friendlyError(linked.error)} onRetry={() => void linked.refetch()} />
          ) : (
            <>
              {linkedRows.length > 0 ? (
                <Card padded={false} className="p-1.5">
                  <ul>
                    {linkedRows.map((row) => (
                      <li key={row.id}>
                        <EntryRow entry={row} />
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : (
                <p className="text-sm text-muted">
                  None yet. If {entry.kind === 'expense' ? 'money comes back for this purchase' : 'this income is pulled back'},
                  record it here so your {entry.kind === 'expense' ? 'spending' : 'income'} stays right.
                </p>
              )}
              {offsets.length > 0 && remaining !== null && (
                <p className="text-sm font-semibold">{remainingText(entry.kind as 'expense' | 'income', remaining)}</p>
              )}
            </>
          )}
        </section>
      )}

      <Evidence sources={sources.data ?? []} timeZone={timeZone} />

      <History entry={entry} audit={audit} />

      {linkedForm && (
        <LinkedEntryForm
          open
          onClose={() => setLinkedForm(null)}
          kind={linkedForm.kind}
          onReload={onReload}
          {...(linkedForm.mode === 'create'
            ? {
                original: { id: entry.id, amount_minor: entry.amount_minor, account_id: tx!.account_id, merchant: tx!.merchant },
                originalLabel: `${title} · ${formatMoney(entry.amount_minor)}`,
                maxMinor: remaining,
              }
            : {
                existing: tx!,
                original: original.data
                  ? {
                      id: original.data.id,
                      amount_minor: original.data.amount_minor,
                      account_id: original.data.account_id,
                      merchant: original.data.merchant,
                    }
                  : null,
                // What's left on the original if this entry weren't there.
                maxMinor:
                  original.data && siblings.data
                    ? remainingToOffset(
                        original.data,
                        siblings.data.filter((row) => row.id !== entry.id),
                      )
                    : null,
              })}
        />
      )}

      {(entry.kind === 'income' || entry.kind === 'refund') && (
        <RefundPicker
          open={picker}
          onClose={() => setPicker(false)}
          entry={{
            id: entry.id,
            kind: entry.kind,
            amount_minor: entry.amount_minor,
            occurred_at: entry.occurred_at,
            updated_at: entry.updated_at,
          }}
          onReload={onReload}
          onDone={() => {
            setPicker(false)
            // Income became a refund: its address changes with its kind.
            if (entry.kind === 'income') navigate(`/entry/refund/${entry.id}`, { replace: true, state: location.state })
          }}
        />
      )}

      <ConfirmDialog
        open={confirmVoid}
        title={`Void this ${noun}?`}
        body={
          <div className="flex flex-col gap-3">
            <p>
              <strong>Void</strong> it if it never really happened — a cancelled hold, a payment that failed before it settled, or
              a duplicate. It stays in your history, struck through, and stops counting.
            </p>
            <p className="text-sm">
              <strong>Delete</strong> is for something added by mistake: it disappears everywhere.
              {isOriginal && status === 'posted' && (
                <>
                  {' '}
                  If the money really moved and came back later, use{' '}
                  <strong>{entry.kind === 'expense' ? 'Record refund' : 'Reverse'}</strong> instead.
                </>
              )}
            </p>
            <TextField
              label="Reason (optional)"
              placeholder="e.g. Card hold was cancelled"
              value={voidReason}
              maxLength={200}
              onChange={(event) => setVoidReason(event.target.value)}
            />
          </div>
        }
        confirmLabel="Void"
        busy={setStatus.isPending}
        onCancel={() => {
          setConfirmVoid(false)
          setVoidReason('')
        }}
        onConfirm={() => void voidEntry()}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete this ${noun}?`}
        body={
          transfer
            ? 'Both account balances go back to how they were. You can undo right after, or restore it from here.'
            : 'It’ll disappear from your lists, balances and insights. You can undo right after, or restore it from here.'
        }
        confirmLabel="Delete"
        danger
        busy={setDeleted.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </div>
  )
}

function Fact({ label, stacked, children }: { label: string; stacked?: boolean; children: ReactNode }) {
  if (stacked) {
    return (
      <div className="flex flex-col gap-1 py-2.5">
        <dt className="label-mono text-muted">{label}</dt>
        <dd className="font-semibold [overflow-wrap:anywhere]">{children}</dd>
      </div>
    )
  }
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="label-mono shrink-0 pt-0.5 text-muted">{label}</dt>
      <dd className="min-w-0 text-right font-semibold [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

function Sub({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 block text-sm font-normal text-muted">{children}</span>
}

function AccountName({ account }: { account?: AccountBalanceRow }) {
  if (!account) return <>Unknown account</>
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      {account.name}
      {account.status === 'archived' && (
        <span className="label-mono rounded-pill bg-paper px-2 py-0.5 outline-regular">Archived</span>
      )}
    </span>
  )
}

/** A related entry as a normal feed row (it opens its own details). */
function EntryRow({ entry }: { entry: LedgerEntryRow }) {
  const { accountsById, categoriesById, timeZone } = useSettings()
  return (
    <TransactionRow
      entry={entry}
      category={entry.category_id ? categoriesById.get(entry.category_id) : undefined}
      account={accountsById.get(entry.account_id)}
      counterAccount={entry.counter_account_id ? accountsById.get(entry.counter_account_id) : undefined}
      meta={formatDate(localDate(entry.occurred_at, timeZone))}
    />
  )
}

const LINK_TYPE_TEXT: Record<NonNullable<SourceEventRow['link_type']>, string> = {
  created: 'Created this entry',
  matched: 'Matched to this entry',
}

/** Import evidence behind this entry. Friday keeps only parsed facts, never the email itself. */
function Evidence({ sources, timeZone }: { sources: SourceEventRow[]; timeZone: string }) {
  if (sources.length === 0) return null
  return (
    <section aria-labelledby="evidence-heading" className="flex flex-col gap-3">
      <h2 id="evidence-heading" className="display text-2xl">
        Import evidence
      </h2>
      <Card padded={false} className="overflow-hidden">
        <ul className="divide-y-2 divide-ink/10">
          {sources.map((event) => {
            const read = [
              event.parsed_amount_minor !== null ? formatMoney(event.parsed_amount_minor) : null,
              event.parsed_merchant,
              event.parsed_account_hint,
              event.parsed_entry_status,
            ].filter(Boolean)
            const confidence = confidenceText(event.confidence)
            return (
              <li key={event.id} className="flex flex-col gap-0.5 px-4 py-3 text-sm">
                <p className="font-semibold">
                  {SOURCE_LABEL[event.source_type]} · {event.link_type ? LINK_TYPE_TEXT[event.link_type] : 'Linked'}
                </p>
                <p className="text-muted">
                  Received {formatDateTime(event.received_at, timeZone)}
                  {confidence ? ` · ${confidence}` : ''}
                </p>
                {read.length > 0 && <p className="text-muted [overflow-wrap:anywhere]">Read as {read.join(' · ')}</p>}
              </li>
            )
          })}
        </ul>
      </Card>
      <p className="text-sm text-muted">Friday keeps only the details it needs to match — never the message itself.</p>
    </section>
  )
}

function History({ entry, audit }: { entry: LedgerEntry; audit: ReturnType<typeof useEntryAudit> }) {
  const { accountsById, categoriesById, timeZone } = useSettings()
  const [open, setOpen] = useState(false)
  const rows = audit.data ?? []
  const lines = rows
    .map((row) => ({
      id: row.id,
      ...describeAudit(row, {
        timeZone,
        accountName: (id) => accountsById.get(id)?.name,
        categoryName: (id) => categoriesById.get(id)?.name,
      }),
    }))
    .reverse()
  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-3">
      <h2 id="history-heading" className="display text-2xl">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="entry-history"
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-12 w-full items-center justify-between gap-3 text-left"
        >
          <span>History</span>
          <span className="flex items-center gap-2">
            {audit.data && (
              <span className="label-mono text-muted">
                {rows.length} {rows.length === 1 ? 'change' : 'changes'}
              </span>
            )}
            <ChevronDown
              aria-hidden="true"
              className={cn('size-6 transition-transform', open && 'rotate-180')}
              strokeWidth={2.75}
            />
          </span>
        </button>
      </h2>
      {open && (
        <div id="entry-history">
          {audit.isPending ? (
            <LoadingBlock rows={2} label="Loading history" />
          ) : audit.error ? (
            <InlineError message={friendlyError(audit.error)} onRetry={() => void audit.refetch()} />
          ) : lines.length === 0 ? (
            <p className="text-sm text-muted">
              No changes recorded. This {KIND_LABEL[entry.kind].toLowerCase()} was added before Friday kept a history.
            </p>
          ) : (
            <Card padded={false} className="p-4">
              <ol className="flex flex-col gap-4">
                {lines.map((line) => (
                  <li key={line.id} className="flex flex-col gap-0.5 border-l-[3px] border-ink pl-3">
                    <p className="font-display font-extrabold tracking-tight">{line.title}</p>
                    {line.changes.length > 0 && <p className="text-sm">{line.changes.join(' · ')}</p>}
                    {line.reason && <p className="text-sm text-muted [overflow-wrap:anywhere]">“{line.reason}”</p>}
                    <p className="label-mono text-muted">{formatDateTime(line.at, timeZone)}</p>
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </div>
      )}
    </section>
  )
}
