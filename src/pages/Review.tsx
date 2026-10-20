import { Ban, Check, Inbox, Undo2 } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useSettings } from '@/app/settings'
import { RefundPicker } from '@/components/finance/RefundPicker'
import { ReviewEventCard } from '@/components/finance/ReviewEventCard'
import { entryTitle, TransactionRow } from '@/components/finance/TransactionRow'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { EmptyState, InlineError, LoadingBlock } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import type { EntryStatus, LedgerEntryRow, SourceEventRow } from '@/data/database.types'
import {
  useIgnoreSourceEvent,
  useIncomeInCategories,
  useReviewEntries,
  useReviewEvents,
  useSetEntryStatus,
  useStalePending,
} from '@/data/hooks'
import { ConfirmEventSheet } from '@/features/review/ConfirmEventSheet'
import { eventTitle, refundIncomeCategoryIds } from '@/features/review/confirm'
import { LinkEventSheet } from '@/features/review/LinkEventSheet'
import { formatDate, formatRelativeDay, localDate } from '@/lib/dates'
import { friendlyError } from '@/lib/errors'
import { canChangeStatus, restoreTarget, STATUS_EXPLAINER, STATUS_LABEL } from '@/lib/ledger'
import { formatMoney } from '@/lib/money'

/** Pending longer than this probably settled (or was cancelled) without Friday hearing. */
const STALE_DAYS = 5

type Busy = { id: string; action: 'confirm' | 'void' | 'posted' | 'cancelled' } | null

/**
 * The review queue: what Friday wasn't sure about. Nothing here creates a
 * ledger entry on its own — only an explicit Confirm does. See
 * docs/ledger-model.md, "Import boundary".
 */
export function Review() {
  const { accountsById, categories, categoriesById, timeZone, todayDate } = useSettings()
  const toast = useToast()
  const events = useReviewEvents()
  const entries = useReviewEntries()
  const stale = useStalePending(STALE_DAYS)
  const refundCategoryIds = useMemo(() => refundIncomeCategoryIds(categories), [categories])
  const refundsAsIncome = useIncomeInCategories(refundCategoryIds)
  const setStatus = useSetEntryStatus()
  const ignore = useIgnoreSourceEvent()

  const [confirming, setConfirming] = useState<SourceEventRow | null>(null)
  const [linking, setLinking] = useState<SourceEventRow | null>(null)
  const [ignoring, setIgnoring] = useState<SourceEventRow | null>(null)
  const [ignoreError, setIgnoreError] = useState<string | null>(null)
  const [refunding, setRefunding] = useState<LedgerEntryRow | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const acting = useRef(false)

  // Without a "Refunds" income category there is nothing to look for.
  const checksRefunds = refundCategoryIds.length > 0
  const loading = events.isPending || entries.isPending || stale.isPending || (checksRefunds && refundsAsIncome.isPending)
  const eventList = events.data ?? []
  const entryList = entries.data ?? []
  const staleList = stale.data ?? []
  const refundList = checksRefunds ? (refundsAsIncome.data ?? []) : []
  const failed = Boolean(events.error || entries.error || stale.error || (checksRefunds && refundsAsIncome.error))
  const total = eventList.length + entryList.length + staleList.length + refundList.length

  async function changeStatus(entry: LedgerEntryRow, to: EntryStatus, action: NonNullable<Busy>['action'], done: string, reason: string | null = null) {
    if (acting.current || !canChangeStatus(entry.status, to)) return
    acting.current = true
    setBusy({ id: entry.id, action })
    try {
      await setStatus.mutateAsync({ kind: entry.kind, id: entry.id, status: to, reason, expectedUpdatedAt: entry.updated_at })
      // Voiding is reversible: Restore puts it back the way it was.
      const back = restoreTarget({ status: 'voided', voided_from: entry.status })
      toast({
        message: done,
        action:
          to === 'voided'
            ? {
                label: 'Undo',
                onClick: async () => {
                  try {
                    await setStatus.mutateAsync({ kind: entry.kind, id: entry.id, status: back })
                    toast({ message: `Restored as ${STATUS_LABEL[back].toLowerCase()}.` })
                  } catch (error) {
                    toast({ message: friendlyError(error), tone: 'error' })
                  }
                },
              }
            : undefined,
      })
    } catch (error) {
      toast({ message: friendlyError(error), tone: 'error' })
    } finally {
      acting.current = false
      setBusy(null)
    }
  }

  async function confirmIgnore() {
    if (!ignoring || acting.current) return
    acting.current = true
    setIgnoreError(null)
    try {
      await ignore.mutateAsync(ignoring.id)
      toast({ message: `Ignored ${eventTitle(ignoring)} — nothing was recorded` })
      setIgnoring(null)
    } catch (error) {
      setIgnoreError(friendlyError(error))
    } finally {
      acting.current = false
    }
  }

  const row = (entry: LedgerEntryRow, meta: string) => (
    <TransactionRow
      entry={entry}
      category={entry.category_id ? categoriesById.get(entry.category_id) : undefined}
      account={accountsById.get(entry.account_id)}
      counterAccount={entry.counter_account_id ? accountsById.get(entry.counter_account_id) : undefined}
      meta={meta}
    />
  )
  // Repeats what a button acts on for screen readers: lists hold many rows.
  const about = (entry: LedgerEntryRow) =>
    `${entryTitle(entry, entry.category_id ? categoriesById.get(entry.category_id) : undefined)}, ${formatMoney(entry.amount_minor)}`
  const day = (entry: LedgerEntryRow) => formatRelativeDay(localDate(entry.occurred_at, timeZone), todayDate)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Review" back="/" scribble={loading ? undefined : total > 0 ? `${total} to check` : 'all clear'} />

      {loading ? (
        <LoadingBlock rows={3} label="Loading the review queue" />
      ) : total === 0 && !failed ? (
        <Card tone="canvas" className="border-dashed">
          <EmptyState
            icon={<Inbox className="size-9" strokeWidth={2.5} />}
            tone="mint"
            scribble="all clear"
            title="Nothing needs a look right now"
            body={
              <>
                Friday doesn’t read your email or bank yet. When imports arrive, anything it isn’t sure about waits here
                instead of touching your balances.
              </>
            }
          />
        </Card>
      ) : (
        <>
          <p className="-mt-2 text-sm text-muted">
            Things Friday wasn’t sure about. Nothing from an import is recorded until you confirm it.
          </p>

          {(events.error || eventList.length > 0) && (
            <Section id="review-imports" title="From imports" count={eventList.length}>
              {events.error ? (
                <InlineError message={friendlyError(events.error)} onRetry={() => void events.refetch()} />
              ) : (
                <>
                  <p className="-mt-1 text-sm text-muted">None of these are in your balances yet.</p>
                  {eventList.map((event) => (
                    <ReviewEventCard
                      key={event.id}
                      event={event}
                      timeZone={timeZone}
                      todayDate={todayDate}
                      accountName={event.suggested_account_id ? accountsById.get(event.suggested_account_id)?.name : undefined}
                      destinationName={
                        event.suggested_destination_account_id
                          ? accountsById.get(event.suggested_destination_account_id)?.name
                          : undefined
                      }
                      categoryName={event.suggested_category_id ? categoriesById.get(event.suggested_category_id)?.name : undefined}
                      busy={ignore.isPending && ignoring?.id === event.id}
                      onConfirm={() => setConfirming(event)}
                      onLink={() => setLinking(event)}
                      onIgnore={() => {
                        setIgnoreError(null)
                        setIgnoring(event)
                      }}
                    />
                  ))}
                </>
              )}
            </Section>
          )}

          {(entries.error || entryList.length > 0) && (
            <Section id="review-entries" title="Waiting for your OK" count={entryList.length}>
              {entries.error ? (
                <InlineError message={friendlyError(entries.error)} onRetry={() => void entries.refetch()} />
              ) : (
                <>
                  <p className="-mt-1 text-sm text-muted">{STATUS_EXPLAINER.needs_review}</p>
                  <EntryList>
                    {entryList.map((entry) => (
                      <li key={entry.id} className="flex flex-col gap-1.5 py-1.5">
                        {row(entry, day(entry))}
                        <div className="grid grid-cols-2 gap-2 px-2 pb-1">
                          <Button
                            aria-label={`Void ${about(entry)}`}
                            size="sm"
                            icon={<Ban className="size-4" strokeWidth={2.5} />}
                            loading={busy?.id === entry.id && busy.action === 'void'}
                            disabled={busy !== null}
                            onClick={() => void changeStatus(entry, 'voided', 'void', 'Voided — kept for the record, not counted')}
                          >
                            Void
                          </Button>
                          <Button
                            aria-label={`Confirm ${about(entry)}`}
                            size="sm"
                            variant="primary"
                            icon={<Check className="size-4" strokeWidth={3} />}
                            loading={busy?.id === entry.id && busy.action === 'confirm'}
                            disabled={busy !== null}
                            onClick={() => void changeStatus(entry, 'posted', 'confirm', 'Confirmed — it now counts in your balances')}
                          >
                            Confirm
                          </Button>
                        </div>
                      </li>
                    ))}
                  </EntryList>
                </>
              )}
            </Section>
          )}

          {(stale.error || staleList.length > 0) && (
            <Section id="review-pending" title="Still pending?" count={staleList.length}>
              {stale.error ? (
                <InlineError message={friendlyError(stale.error)} onRetry={() => void stale.refetch()} />
              ) : (
                <>
                  <p className="-mt-1 text-sm text-muted">
                    Pending for more than {STALE_DAYS} days. They already count in your balances — did they go through?
                  </p>
                  <EntryList>
                    {staleList.map((entry) => (
                      <li key={entry.id} className="flex flex-col gap-1.5 py-1.5">
                        {row(entry, `Since ${formatDate(localDate(entry.occurred_at, timeZone))}`)}
                        {/* Side by side when both labels fit; stacked full width on the narrowest phones. */}
                        <div className="flex flex-wrap gap-2 px-2 pb-1">
                          <Button
                            aria-label={`It was cancelled: ${about(entry)}`}
                            size="sm"
                            className="grow"
                            loading={busy?.id === entry.id && busy.action === 'cancelled'}
                            disabled={busy !== null}
                            onClick={() =>
                              void changeStatus(entry, 'voided', 'cancelled', 'Voided — it no longer counts anywhere', 'Cancelled')
                            }
                          >
                            It was cancelled
                          </Button>
                          <Button
                            aria-label={`It went through: ${about(entry)}`}
                            size="sm"
                            variant="primary"
                            className="grow"
                            loading={busy?.id === entry.id && busy.action === 'posted'}
                            disabled={busy !== null}
                            onClick={() => void changeStatus(entry, 'posted', 'posted', 'Marked as posted')}
                          >
                            It went through
                          </Button>
                        </div>
                      </li>
                    ))}
                  </EntryList>
                </>
              )}
            </Section>
          )}

          {checksRefunds && (refundsAsIncome.error || refundList.length > 0) && (
            <Section id="review-refunds" title="Refunds recorded as income" count={refundList.length}>
              {refundsAsIncome.error ? (
                <InlineError message={friendlyError(refundsAsIncome.error)} onRetry={() => void refundsAsIncome.refetch()} />
              ) : (
                <>
                  <p className="-mt-1 text-sm text-muted">
                    Money back for a purchase lowers your spending — it isn’t income. These sit in an income category
                    called Refunds.
                  </p>
                  <EntryList>
                    {refundList.map((entry) => (
                      <li key={entry.id} className="flex flex-col gap-1.5 py-1.5">
                        {row(entry, day(entry))}
                        <div className="px-2 pb-1">
                          <Button
                            aria-label={`Make it a refund: ${about(entry)}`}
                            size="sm"
                            block
                            icon={<Undo2 className="size-4" strokeWidth={2.5} />}
                            disabled={busy !== null}
                            onClick={() => setRefunding(entry)}
                          >
                            Make it a refund
                          </Button>
                        </div>
                      </li>
                    ))}
                  </EntryList>
                </>
              )}
            </Section>
          )}
        </>
      )}

      {confirming && <ConfirmEventSheet event={confirming} onClose={() => setConfirming(null)} />}
      {linking && <LinkEventSheet event={linking} onClose={() => setLinking(null)} />}
      {refunding && (
        <RefundPicker
          open
          entry={{
            id: refunding.id,
            kind: 'income',
            amount_minor: refunding.amount_minor,
            occurred_at: refunding.occurred_at,
            updated_at: refunding.updated_at,
          }}
          onClose={() => setRefunding(null)}
          onDone={() => setRefunding(null)}
          onReload={() => void refundsAsIncome.refetch()}
        />
      )}
      <ConfirmDialog
        open={ignoring !== null}
        title="Ignore this?"
        body={
          <div className="flex flex-col gap-3">
            <p>
              For things that aren’t a transaction — a promo, or a notification about something already in Friday. It
              leaves the queue and nothing is recorded.
            </p>
            {ignoreError && (
              <p role="alert" className="text-sm font-semibold text-negative">
                {ignoreError}
              </p>
            )}
          </div>
        }
        confirmLabel="Ignore"
        busy={ignore.isPending}
        onCancel={() => {
          if (ignore.isPending) return
          setIgnoring(null)
          setIgnoreError(null)
        }}
        onConfirm={() => void confirmIgnore()}
      />
    </div>
  )
}

function Section({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="display text-2xl">
          {title}
        </h2>
        {count > 0 && (
          <span className="label-mono shrink-0 text-muted">
            <span aria-hidden="true">{count}</span>
            <span className="sr-only">{count === 1 ? '1 item' : `${count} items`}</span>
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

function EntryList({ children }: { children: ReactNode }) {
  return (
    <Card padded={false} className="p-1.5">
      <ul className="divide-y-2 divide-ink/10">{children}</ul>
    </Card>
  )
}
