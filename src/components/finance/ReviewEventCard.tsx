import { Check, CircleHelp, EyeOff, Link2 } from 'lucide-react'
import { useId } from 'react'
import type { SourceEventRow } from '@/data/database.types'
import { Button } from '@/components/ui/Button'
import { cn } from '@/components/ui/cn'
import { confidenceLabel, eventAmount, eventTitle, reasonText } from '@/features/review/confirm'
import { formatDate, formatRelativeDay, localDate, localTime } from '@/lib/dates'
import { IMPORT_SOURCE_SHORT, KIND_LABEL } from '@/lib/ledger'
import { SourceBadge } from './StatusBadge'

const pill = 'label-mono inline-flex items-center whitespace-nowrap rounded-pill px-2 py-0.5 outline-regular'

const PARSED_STATE: Record<'pending' | 'cancelled' | 'declined', { label: string; tone: string }> = {
  pending: { label: 'Pending', tone: 'bg-yellow' },
  cancelled: { label: 'Cancelled', tone: 'bg-line' },
  declined: { label: 'Declined', tone: 'bg-line' },
}

interface ReviewEventCardProps {
  event: SourceEventRow
  timeZone: string
  todayDate: string
  accountName?: string
  destinationName?: string
  categoryName?: string
  onConfirm: () => void
  onLink: () => void
  onIgnore: () => void
  /** While a decision about this event is being saved. */
  busy?: boolean
}

/**
 * One piece of import evidence waiting for a decision. Nothing on this card
 * is in the ledger: only Confirm (or linking it to an existing entry) records
 * anything.
 */
export function ReviewEventCard({
  event,
  timeZone,
  todayDate,
  accountName,
  destinationName,
  categoryName,
  onConfirm,
  onLink,
  onIgnore,
  busy,
}: ReviewEventCardProps) {
  const titleId = useId()
  const title = eventTitle(event)
  const amount = eventAmount(event)
  const confidence = confidenceLabel(event.confidence)
  const source = IMPORT_SOURCE_SHORT[event.source_type]
  const receivedDay = localDate(event.received_at, timeZone)
  const received = `${formatRelativeDay(receivedDay, todayDate)}, ${localTime(event.received_at, timeZone)}`
  const occurred = event.parsed_occurred_at
    ? formatDate(localDate(event.parsed_occurred_at, timeZone), { withYear: true })
    : 'Date unknown'
  const state = event.parsed_entry_status && event.parsed_entry_status !== 'posted' ? PARSED_STATE[event.parsed_entry_status] : null
  const kindText = event.parsed_kind ? KIND_LABEL[event.parsed_kind] : 'Type unknown'
  // Buttons repeat what they act on for screen readers: there may be many cards.
  const about = `${title}${amount ? `, ${amount.spoken}` : ''}`

  const suggestedAccount =
    event.parsed_kind === 'transfer' && accountName && destinationName ? `${accountName} → ${destinationName}` : accountName

  return (
    <article aria-labelledby={titleId} className="flex flex-col gap-3 rounded-card bg-paper p-4 outline-strong shadow-brutal">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SourceBadge source={event.source_type} />
        <span className="label-mono text-muted">
          <span className="sr-only">From {source.toLowerCase()}, received </span>
          {received}
        </span>
        {confidence && <span className={cn(pill, 'ml-auto bg-canvas')}>{confidence}</span>}
      </div>

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="truncate font-display text-lg font-extrabold tracking-tight">
            {title}
          </h3>
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {state && <span className={cn(pill, state.tone)}>{state.label}</span>}
            <span className="label-mono text-muted">
              {kindText} · {occurred}
            </span>
          </p>
        </div>
        {amount ? (
          <p
            className={cn(
              'tabular shrink-0 whitespace-nowrap font-display text-lg font-extrabold tracking-tight',
              amount.direction === 'in' && 'text-positive',
            )}
          >
            <span aria-hidden="true">{amount.text}</span>
            <span className="sr-only">{amount.spoken}</span>
          </p>
        ) : (
          <p className="shrink-0 text-sm font-semibold text-muted">Amount unknown</p>
        )}
      </div>

      <p className="flex items-start gap-2 rounded-2xl bg-yellow px-3 py-2.5 text-sm font-semibold outline-regular">
        <CircleHelp aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={2.5} />
        <span>
          <span className="sr-only">Why it’s here: </span>
          {reasonText(event)}
        </span>
      </p>

      {(event.parsed_account_hint || suggestedAccount || categoryName) && (
        <dl className="flex flex-col gap-1.5 text-sm">
          {event.parsed_account_hint && (
            <div className="flex justify-between gap-3">
              <dt className="shrink-0 text-muted">Account it mentions</dt>
              <dd className="min-w-0 truncate text-right font-semibold">{event.parsed_account_hint}</dd>
            </div>
          )}
          {suggestedAccount && (
            <div className="flex justify-between gap-3">
              <dt className="shrink-0 text-muted">Suggested account</dt>
              <dd className="min-w-0 truncate text-right font-semibold">{suggestedAccount}</dd>
            </div>
          )}
          {categoryName && (
            <div className="flex justify-between gap-3">
              <dt className="shrink-0 text-muted">Suggested category</dt>
              <dd className="min-w-0 truncate text-right font-semibold">{categoryName}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Button
          aria-label={`Ignore ${about}`}
          size="sm"
          icon={<EyeOff className="size-4" strokeWidth={2.5} />}
          onClick={onIgnore}
          disabled={busy}
        >
          Ignore
        </Button>
        <Button
          aria-label={`Confirm ${about}`}
          size="sm"
          variant="primary"
          icon={<Check className="size-4" strokeWidth={3} />}
          onClick={onConfirm}
          disabled={busy}
        >
          Confirm
        </Button>
      </div>
      <Button
        aria-label={`Same as an existing entry: ${about}`}
        size="sm"
        block
        icon={<Link2 className="size-4" strokeWidth={2.5} />}
        onClick={onLink}
        disabled={busy}
      >
        Same as an existing entry
      </Button>
    </article>
  )
}
