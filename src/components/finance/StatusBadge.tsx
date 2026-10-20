import { cn } from '@/components/ui/cn'
import type { EntryKind, EntryStatus, SourceType } from '@/data/database.types'
import { IMPORT_SOURCE_SHORT, STATUS_LABEL } from '@/lib/ledger'

// Small toned pills for ledger state, matching the list-row pill used for
// recurring due dates (label-mono, outline, accent fill).

const STATUS_TONE: Record<Exclude<EntryStatus, 'posted'>, string> = {
  pending: 'bg-yellow',
  needs_review: 'bg-orange',
  voided: 'bg-line',
}

const pill = 'label-mono inline-flex items-center whitespace-nowrap rounded-pill px-2 py-0.5 outline-regular'

/** Pending / Needs review / Voided. Posted entries need no badge. */
export function StatusBadge({ status, className }: { status: EntryStatus; className?: string }) {
  if (status === 'posted') return null
  return <span className={cn(pill, STATUS_TONE[status], className)}>{STATUS_LABEL[status]}</span>
}

/** Refund / Reversal marker for entries that give money back against an original. */
export function KindBadge({ kind, className }: { kind: EntryKind; className?: string }) {
  if (kind !== 'refund' && kind !== 'reversal') return null
  return (
    <span className={cn(pill, kind === 'refund' ? 'bg-mint' : 'bg-sky', className)}>
      {kind === 'refund' ? 'Refund' : 'Reversal'}
    </span>
  )
}

/** Where an entry came from, when it wasn't typed in. */
export function SourceBadge({ source, className }: { source: SourceType; className?: string }) {
  if (source === 'manual') return null
  return <span className={cn(pill, 'bg-paper', className)}>{IMPORT_SOURCE_SHORT[source]}</span>
}

/** Words for screen readers, appended to a row's aria-label. */
export function describeEntryState(entry: { kind: EntryKind; status: EntryStatus; source_type?: SourceType }): string {
  const parts: string[] = []
  if (entry.kind === 'refund') parts.push('refund')
  if (entry.kind === 'reversal') parts.push('reversal')
  if (entry.status !== 'posted') parts.push(STATUS_LABEL[entry.status].toLowerCase())
  if (entry.source_type && entry.source_type !== 'manual') parts.push(`imported from ${IMPORT_SOURCE_SHORT[entry.source_type].toLowerCase()}`)
  return parts.join(', ')
}
