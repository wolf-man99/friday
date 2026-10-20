import { useId, useMemo, useRef, useState } from 'react'
import { useSettings } from '@/app/settings'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { InlineError, LoadingBlock } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import type { SourceEventRow } from '@/data/database.types'
import { useLedgerEntry, useLinkSourceEvent, useMatchCandidates } from '@/data/hooks'
import { classifyError, friendlyError } from '@/lib/errors'
import { formatMoney } from '@/lib/money'
import { linkProblem, matchQuery } from './confirm'
import { ChoiceOption, EntryOptionBody } from './EntryChoice'

interface LinkEventSheetProps {
  event: SourceEventRow
  onClose: () => void
}

/**
 * "Same as an existing entry": the evidence is about a transaction Friday
 * already has. Linking records nothing new — the entry stays one entry, with
 * this import attached as more evidence (and a pending entry it settles is
 * marked posted).
 */
export function LinkEventSheet({ event, onClose }: LinkEventSheetProps) {
  return (
    <Dialog open onClose={onClose} title="Same as an existing entry" variant="sheet">
      <LinkEventBody event={event} onClose={onClose} />
    </Dialog>
  )
}

function LinkEventBody({ event, onClose }: LinkEventSheetProps) {
  const { accountsById, categoriesById, timeZone } = useSettings()
  const toast = useToast()
  const link = useLinkSourceEvent()
  const submitting = useRef(false)
  const name = useId()
  const query = useMemo(() => matchQuery(event), [event])
  const candidates = useMatchCandidates(query)
  const suggested = useLedgerEntry(event.suggested_match_id)
  const [choice, setChoice] = useState<string | null>(event.suggested_match_id)
  const [error, setError] = useState<string | null>(null)

  // The entry the import pointed at first, then lookalikes by amount and date.
  const rows = useMemo(() => {
    const list = candidates.data ?? []
    const first = suggested.data
    return first ? [first, ...list.filter((row) => row.id !== first.id)] : list
  }, [candidates.data, suggested.data])
  const chosen = rows.find((row) => row.id === choice && !linkProblem(event, row))
  const loading = (query !== null && candidates.isPending) || (Boolean(event.suggested_match_id) && suggested.isPending)
  const loadError = candidates.error ?? suggested.error

  async function confirm() {
    if (submitting.current || !chosen) return
    submitting.current = true
    setError(null)
    try {
      await link.mutateAsync({ eventId: event.id, entryKind: chosen.kind, entryId: chosen.id })
      toast({ message: `Linked to the ${formatMoney(chosen.amount_minor)} entry — Friday kept one entry` })
      onClose()
    } catch (err) {
      setError(
        classifyError(err) === 'network'
          ? 'Couldn’t confirm the link — the connection dropped. Trying again is safe.'
          : friendlyError(err),
      )
    } finally {
      submitting.current = false
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Friday keeps one entry and records this as more evidence. Nothing new is added to your balances.
        {event.parsed_entry_status === 'posted' && ' If the entry was pending, it’s marked posted.'}
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className="label-mono mb-2">Which entry is it?</legend>
        {loading ? (
          <LoadingBlock rows={2} label="Loading entries" />
        ) : loadError ? (
          <InlineError
            message={friendlyError(loadError)}
            onRetry={() => {
              void candidates.refetch()
              void suggested.refetch()
            }}
          />
        ) : rows.length === 0 ? (
          <p className="rounded-2xl bg-canvas px-4 py-3 text-sm outline-regular">
            {query
              ? 'Nothing with the same amount within a week of it. If it’s new, confirm it instead.'
              : 'Friday can only look for matches when it knows the amount. Confirm it instead, with the amount filled in.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const problem = linkProblem(event, row)
              return (
                <li key={row.id}>
                  <ChoiceOption
                    name={name}
                    value={row.id}
                    selected={choice === row.id && !problem}
                    disabled={Boolean(problem)}
                    onSelect={() => {
                      setChoice(row.id)
                      setError(null)
                    }}
                  >
                    <EntryOptionBody
                      entry={row}
                      categoriesById={categoriesById}
                      accountsById={accountsById}
                      timeZone={timeZone}
                      suggested={row.id === event.suggested_match_id}
                      problem={problem}
                    />
                  </ChoiceOption>
                </li>
              )
            })}
          </ul>
        )}
      </fieldset>

      {error && (
        <p role="alert" className="rounded-2xl bg-paper px-3.5 py-3 text-sm font-semibold outline-regular">
          {error}
        </p>
      )}

      <div className="flex gap-3 pt-1">
        <Button block onClick={onClose} disabled={link.isPending}>
          Cancel
        </Button>
        <Button block variant="primary" loading={link.isPending} disabled={!chosen} onClick={() => void confirm()}>
          Link it
        </Button>
      </div>
    </div>
  )
}
