import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpDown,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  History,
  RotateCcw,
  Sparkles,
  Trash,
  WifiOff,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useSettings } from '@/app/settings'
import { AccountGlyph, CategoryGlyph } from '@/components/finance/icons'
import { AmountInput } from '@/components/finance/AmountInput'
import { CategoryTile } from '@/components/finance/CategoryTile'
import { useOnline } from '@/components/layout/OfflineBanner'
import { Button, LinkButton } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { cn } from '@/components/ui/cn'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { TextAreaField, TextField } from '@/components/ui/Field'
import { IconButton } from '@/components/ui/IconButton'
import { PillSwitch, type PillOption } from '@/components/ui/PillSwitch'
import { EmptyState, InlineError, LoadingBlock } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { occurredAtFor, type LedgerEntry } from '@/data/api'
import type {
  AccountBalanceRow,
  CaptureKind,
  EntryKind,
  TransactionRow,
  TransactionType,
  TransferRow,
} from '@/data/database.types'
import { useCaptureHistory, useCreateEntry, useEntry, useSetEntryDeleted, useUpdateEntry } from '@/data/hooks'
import { pickAccount, type AccountSource } from '@/features/capture/defaults'
import { clearDraft, isDirty, loadDraft, newIdempotencyKey, saveDraft, switchKind, type CaptureDraft } from '@/features/capture/draft'
import { knownMerchants, recentShortcuts, suggestCategory, type RecentShortcut } from '@/features/capture/suggest'
import { track, type ErrorClass } from '@/lib/analytics'
import { formatDate, formatRelativeDay, localDate } from '@/lib/dates'
import { MERCHANT_MAX, validateEntry, type EntryErrors } from '@/lib/entry'
import { classifyError, friendlyError } from '@/lib/errors'
import { AMOUNT_PROBLEM_MESSAGE, amountProblem, formatAmountInput, formatMoney, minorToDecimalString } from '@/lib/money'
import { goBack } from '@/lib/navigation'
import { lastAccountKey, lastDestinationKey, readPref, writePref } from '@/lib/prefs'

const KIND_OPTIONS: PillOption<CaptureKind>[] = [
  { value: 'expense', label: 'Expense', icon: <ArrowUpRight className="size-4" strokeWidth={2.75} /> },
  { value: 'income', label: 'Income', icon: <ArrowDownLeft className="size-4" strokeWidth={2.75} /> },
  { value: 'transfer', label: 'Transfer', icon: <ArrowLeftRight className="size-4" strokeWidth={2.75} /> },
]

const HEADLINE: Record<CaptureKind, string> = {
  expense: 'Money out.',
  income: 'Money in.',
  transfer: 'Moving money.',
}

const SAVE_LABEL: Record<CaptureKind, string> = {
  expense: 'Save expense',
  income: 'Save income',
  transfer: 'Record transfer',
}

const NOUN: Record<CaptureKind, string> = { expense: 'expense', income: 'income', transfer: 'transfer' }

const VISIBLE_CATEGORIES = 8

function isKind(value: string | null | undefined): value is CaptureKind {
  return value === 'expense' || value === 'income' || value === 'transfer'
}

/**
 * Quick Add (/add) and editing an income, expense or transfer
 * (/entry/:kind/:id/edit) share one amount-first screen. Editing starts from
 * the entry's details page and returns there.
 */
export function EntryEditor() {
  const params = useParams<{ kind: string; id: string }>()
  const editing = Boolean(params.id)
  const kind = isKind(params.kind) ? params.kind : undefined
  const entryQuery = useEntry(editing ? kind : undefined, params.id)
  // Bumped only when the user asks for the latest version after a conflict;
  // background refetches never reset a form someone is editing.
  const [reloads, setReloads] = useState(0)

  if (editing) {
    const details = `/entry/${params.kind}/${params.id}`
    // Refunds and reversals have their own form on the details page.
    if (params.kind === 'refund' || params.kind === 'reversal') return <Navigate to={details} replace />
    if (!kind) {
      return (
        <EditorFrame title="Not found">
          <InlineError message="This entry doesn’t exist." />
        </EditorFrame>
      )
    }
    if (entryQuery.isPending) return <EditorFrame title="Loading…" fallback={details}><LoadingBlock rows={4} /></EditorFrame>
    // Only a first load that fails replaces the form: a failed background
    // refetch must never throw away someone's edits.
    if (!entryQuery.data || entryQuery.data.deleted_at) {
      return (
        <EditorFrame title="Not found" fallback={details}>
          <InlineError
            message={entryQuery.error ? friendlyError(entryQuery.error) : 'This entry was deleted or doesn’t exist.'}
            onRetry={entryQuery.error ? () => void entryQuery.refetch() : undefined}
          />
        </EditorFrame>
      )
    }
    if (!isEditable(entryQuery.data)) {
      return <Navigate to={`/entry/${entryQuery.data.kind}/${entryQuery.data.id}`} replace />
    }
    if (entryQuery.data.status === 'voided') {
      return (
        <EditorFrame title="Voided" fallback={details}>
          <InlineError message="Voided entries can’t be edited. Restore it from its details first." />
        </EditorFrame>
      )
    }
    return (
      <EntryForm
        key={`${entryQuery.data.id}:${reloads}`}
        existing={entryQuery.data}
        onReloadExisting={async () => {
          await entryQuery.refetch()
          setReloads((n) => n + 1)
        }}
      />
    )
  }
  return <EntryForm key="new" />
}

function EditorFrame({ title, fallback = '/activity', children }: { title: string; fallback?: string; children: React.ReactNode }) {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="flex items-center gap-3">
        <IconButton label="Close" icon={<X className="size-5" strokeWidth={2.75} />} onClick={() => goBack(navigate, fallback)} />
        <h1 className="display text-3xl">{title}</h1>
      </div>
      {children}
    </div>
  )
}

type Existing = ({ kind: TransactionType } & TransactionRow) | ({ kind: 'transfer' } & TransferRow)

/** Refunds and reversals have their own form on the entry's details page. */
function isEditable(entry: LedgerEntry): entry is Existing {
  return isKind(entry.kind)
}

type SaveState =
  | { status: 'idle' }
  | { status: 'error'; message: string; errorClass: ErrorClass }
  | { status: 'mismatch'; id: string; kind: EntryKind; voided: boolean }

function EntryForm({ existing: loaded, onReloadExisting }: { existing?: Existing; onReloadExisting?: () => Promise<void> }) {
  // The version this edit started from. Saves are checked against it, so a
  // change made elsewhere in the meantime is reported, never overwritten.
  const [existing] = useState(loaded)
  const { profile, activeAccounts, accountsById, categories, timeZone, todayDate } = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  const [search] = useSearchParams()
  const toast = useToast()
  const online = useOnline()
  const amountRef = useRef<HTMLInputElement>(null)
  const returnTo = (location.state as { from?: string } | null)?.from ?? '/'
  const userId = profile.id
  const mode = existing ? 'edit' : 'create'
  // Edits return to the entry's details page (or wherever the user came from).
  const detailsPath = existing ? `/entry/${existing.kind}/${existing.id}` : null

  const createEntry = useCreateEntry()
  const updateEntry = useUpdateEntry()
  const setDeleted = useSetEntryDeleted()
  const history = useCaptureHistory()

  const openedAt = useRef(performance.now())
  const attempts = useRef(0)
  const submitting = useRef(false)

  // --- Draft ------------------------------------------------------------------

  function freshDraft(kind: CaptureKind, keep?: Partial<CaptureDraft>): { draft: CaptureDraft; source: AccountSource | null } {
    const source = pickAccount(activeAccounts, {
      contextId: search.get('account'),
      defaultId: profile.default_account_id,
      recentId: readPref(lastAccountKey(kind)),
    })
    const destination =
      kind === 'transfer'
        ? pickAccount(activeAccounts, { recentId: readPref(lastDestinationKey), excludeId: source.id }).id
        : null
    return {
      draft: {
        kind,
        amountText: '',
        accountId: source.id,
        destinationAccountId: destination,
        categoryId: null,
        categorySource: null,
        date: search.get('date') ?? todayDate,
        note: '',
        merchant: '',
        idempotencyKey: newIdempotencyKey(),
        updatedAt: Date.now(),
        ...keep,
      },
      source: source.source,
    }
  }

  const [initial] = useState(() => {
    if (existing) {
      const isTransfer = existing.kind === 'transfer'
      const draft: CaptureDraft = {
        kind: existing.kind,
        amountText: formatAmountInput(minorToDecimalString(existing.amount_minor)),
        accountId: isTransfer ? existing.source_account_id : existing.account_id,
        destinationAccountId: isTransfer ? existing.destination_account_id : null,
        categoryId: isTransfer ? null : existing.category_id,
        categorySource: !isTransfer && existing.category_id ? 'user' : null,
        date: localDate(existing.occurred_at, timeZone),
        note: existing.note ?? '',
        merchant: !isTransfer ? (existing.merchant ?? '') : '',
        idempotencyKey: '',
        updatedAt: Date.now(),
      }
      return { draft, restored: null as CaptureDraft | null, source: null as AccountSource | null }
    }
    const restored = loadDraft(userId)
    if (restored) return { draft: restored, restored, source: null }
    const kind = isKind(search.get('kind')) ? (search.get('kind') as CaptureKind) : 'expense'
    const { draft, source } = freshDraft(kind)
    return { draft, restored: null, source }
  })

  const [draft, setDraft] = useState<CaptureDraft>(initial.draft)
  const [accountSource, setAccountSource] = useState<AccountSource | 'user' | 'restored' | null>(
    initial.restored ? 'restored' : initial.source,
  )
  const [recovered, setRecovered] = useState<CaptureDraft | null>(initial.restored)
  const [errors, setErrors] = useState<EntryErrors>({})
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' })
  const [amountBlurred, setAmountBlurred] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(
    Boolean(initial.draft.note || initial.draft.merchant) || Boolean(search.get('date')),
  )
  const [showAllCategories, setShowAllCategories] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const mismatchRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (saveState.status === 'mismatch') mismatchRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [saveState.status])

  // Keep the draft on this device until it is saved or discarded.
  useEffect(() => {
    if (mode === 'create') saveDraft(userId, draft)
  }, [draft, mode, userId])

  useEffect(() => {
    if (mode !== 'create') return
    track('quick_add_opened', { context: returnTo.split('?')[0] || '/', draft_restored: Boolean(initial.restored) })
    if (initial.restored) {
      track('draft_recovered', {
        type: initial.restored.kind,
        age_s: Math.round((Date.now() - initial.restored.updatedAt) / 1000),
      })
    }
    // Focus the amount for a fresh entry; a recovered one may already be complete.
    if (!initial.draft.amountText) amountRef.current?.focus()
  }, [])

  // --- Choices ------------------------------------------------------------------

  const availableAccountIds = useMemo(() => {
    const ids = new Set(activeAccounts.map((a) => a.id))
    // Editing history on an archived account is fine; new entries can't use it.
    if (existing) {
      for (const id of [initial.draft.accountId, initial.draft.destinationAccountId]) if (id) ids.add(id)
    }
    return ids
  }, [activeAccounts, existing, initial.draft.accountId, initial.draft.destinationAccountId])

  // Accounts offered: active ones, plus one already on this draft so the user sees it.
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

  // --- Suggestions (new entries only, never over a user's own choice) ------------------

  const usableCategoryIds = useMemo(
    () => new Set(categories.filter((c) => c.transaction_type === draft.kind && !c.is_archived).map((c) => c.id)),
    [categories, draft.kind],
  )
  const suggestion = useMemo(() => {
    if (existing || draft.kind === 'transfer') return null
    return suggestCategory(history.data ?? [], {
      kind: draft.kind as TransactionType,
      merchant: draft.merchant,
      usableCategoryIds,
    })
  }, [existing, draft.kind, draft.merchant, history.data, usableCategoryIds])

  const lastShown = useRef<string | null>(null)
  useEffect(() => {
    if (existing || draft.kind === 'transfer' || draft.categorySource === 'user' || history.isPending) return
    const next = suggestion?.categoryId ?? null
    if (next !== draft.categoryId) {
      setDraft((d) =>
        d.categorySource === 'user' ? d : { ...d, categoryId: next, categorySource: next ? 'suggested' : null },
      )
    }
    if (suggestion && lastShown.current !== suggestion.categoryId) {
      lastShown.current = suggestion.categoryId
      track('suggestion_shown', { type: draft.kind, reason: suggestion.reason, basis: suggestion.basis })
    }
  }, [suggestion, draft.kind, draft.categorySource, draft.categoryId, existing, history.isPending])

  const merchants = useMemo(() => knownMerchants(history.data ?? []), [history.data])
  const shortcuts = useMemo(() => recentShortcuts(history.data ?? []), [history.data])

  // --- Editing the draft ------------------------------------------------------------

  function update(patch: Partial<CaptureDraft>) {
    setDraft((d) => ({ ...d, ...patch, updatedAt: Date.now() }))
    if (saveState.status !== 'idle') setSaveState({ status: 'idle' })
    if (Object.keys(errors).length) setErrors({})
  }

  function changeKind(kind: CaptureKind) {
    track('transaction_type_selected', { type: kind, previous: draft.kind })
    const destination =
      kind === 'transfer'
        ? (draft.destinationAccountId ??
          pickAccount(activeAccounts, { recentId: readPref(lastDestinationKey), excludeId: draft.accountId }).id)
        : null
    setDraft((d) => switchKind(d, kind, destination))
    lastShown.current = null
    setErrors({})
    setSaveState({ status: 'idle' })
    setShowAllCategories(false)
    // Picking the type first is common; carry straight on to the amount.
    if (!draft.amountText) amountRef.current?.focus()
  }

  function selectCategory(categoryId: string) {
    const wasSuggested = draft.categorySource === 'suggested'
    if (draft.categoryId === categoryId) {
      if (wasSuggested) {
        track('suggestion_changed', { type: draft.kind, to: 'confirmed' })
        update({ categorySource: 'user' })
      } else {
        update({ categoryId: null, categorySource: 'user' })
      }
      return
    }
    if (wasSuggested) track('suggestion_changed', { type: draft.kind, to: 'other_category' })
    update({ categoryId, categorySource: 'user' })
  }

  function rejectSuggestion() {
    track('suggestion_changed', { type: draft.kind, to: 'none' })
    update({ categoryId: null, categorySource: 'user' })
  }

  function applyShortcut(shortcut: RecentShortcut) {
    const account = availableAccountIds.has(shortcut.accountId) ? shortcut.accountId : draft.accountId
    setDraft((d) => ({
      ...switchKind(d, shortcut.kind, null),
      amountText: formatAmountInput(minorToDecimalString(shortcut.amountMinor)),
      accountId: account,
      categoryId: shortcut.categoryId && usableIdsFor(shortcut.kind).has(shortcut.categoryId) ? shortcut.categoryId : null,
      categorySource: 'user',
      merchant: shortcut.merchant ?? '',
      updatedAt: Date.now(),
    }))
    if (account !== draft.accountId) setAccountSource('user')
    amountRef.current?.focus()
  }

  function usableIdsFor(kind: TransactionType) {
    return new Set(categories.filter((c) => c.transaction_type === kind && !c.is_archived).map((c) => c.id))
  }

  function startFresh() {
    clearDraft(userId)
    const next = freshDraft(draft.kind === 'transfer' ? 'transfer' : draft.kind)
    setDraft(next.draft)
    setAccountSource(next.source)
    setRecovered(null)
    setSaveState({ status: 'idle' })
    setErrors({})
    lastShown.current = null
    amountRef.current?.focus()
  }

  // --- Validation ---------------------------------------------------------------------

  const validation = validateEntry(draft, { availableAccountIds })
  const problem = amountProblem(draft.amountText)
  const liveAmountError =
    problem && problem !== 'empty' && (problem !== 'zero' || amountBlurred) ? AMOUNT_PROBLEM_MESSAGE[problem] : undefined
  const unavailable = (id: string | null) =>
    id && !availableAccountIds.has(id) ? 'That account is no longer available — choose another' : undefined
  const blockingHint = validation.ok
    ? null
    : (Object.values(validation.errors)[0] ?? null)
  const saving = createEntry.isPending || updateEntry.isPending
  const retryable =
    saveState.status === 'error' && ['network', 'offline', 'server', 'unknown'].includes(saveState.errorClass)

  // --- Saving -------------------------------------------------------------------------

  async function submit(addAnother = false, freshKey = false) {
    if (submitting.current) return
    const result = validateEntry(draft, { availableAccountIds })
    if (!result.ok) {
      setErrors(result.errors)
      if (result.errors.amount) amountRef.current?.focus()
      return
    }
    const entry = result.value
    const elapsed = () => performance.now() - openedAt.current

    if (!online) {
      setSaveState({
        status: 'error',
        errorClass: 'offline',
        message:
          mode === 'create'
            ? 'You’re offline. Nothing was sent — your entry is kept on this device. Save it once you’re back online.'
            : 'You’re offline. Nothing was sent — save your changes once you’re back online.',
      })
      track('transaction_save_failed', { type: entry.kind, attempt: attempts.current, elapsed_ms: elapsed(), error_class: 'offline', mode })
      return
    }

    const originalDate = existing ? localDate(existing.occurred_at, timeZone) : null
    const occurredAt =
      existing && originalDate === entry.date ? existing.occurred_at : occurredAtFor(entry.date, todayDate, timeZone)

    let key = draft.idempotencyKey
    if (freshKey) {
      key = newIdempotencyKey()
      setDraft((d) => ({ ...d, idempotencyKey: key }))
    }

    submitting.current = true
    attempts.current += 1
    setSaveState({ status: 'idle' })
    track('transaction_save_attempted', {
      type: entry.kind,
      attempt: attempts.current,
      elapsed_ms: elapsed(),
      category_source: draft.categoryId ? (draft.categorySource === 'suggested' ? 'suggested' : 'user') : 'none',
      account_source: accountSource ?? 'none',
      has_note: Boolean(entry.note),
      has_merchant: Boolean(entry.merchant),
      mode,
    })

    try {
      if (existing) {
        await updateEntry.mutateAsync({
          previousKind: existing.kind,
          id: existing.id,
          expectedUpdatedAt: existing.updated_at,
          entry,
          occurredAt,
        })
        track('transaction_save_succeeded', { type: entry.kind, attempt: attempts.current, elapsed_ms: elapsed(), replayed: false, mode })
        toast({ message: `Updated ${NOUN[entry.kind]} · ${formatMoney(entry.amountMinor)}` })
        // Its kind may have changed (expense ↔ income); the details page reads it fresh.
        goBack(navigate, `/entry/${entry.kind}/${existing.id}`)
        return
      }

      const saved = await createEntry.mutateAsync({ entry, occurredAt, idempotencyKey: key })
      if (!saved.created && (!saved.matches || saved.voided)) {
        // The key was already used: never claim these new values were saved.
        setSaveState({ status: 'mismatch', id: saved.id, kind: saved.kind, voided: saved.voided })
        track('transaction_save_failed', { type: entry.kind, attempt: attempts.current, elapsed_ms: elapsed(), error_class: 'conflict', mode })
        return
      }

      clearDraft(userId)
      writePref(lastAccountKey(entry.kind), entry.accountId)
      if (entry.destinationAccountId) writePref(lastDestinationKey, entry.destinationAccountId)
      track('transaction_save_succeeded', {
        type: entry.kind,
        attempt: attempts.current,
        elapsed_ms: elapsed(),
        replayed: !saved.created,
        mode,
      })
      announceSaved(entry.kind, entry.amountMinor, entry.categoryId, saved.id, saved.kind)

      if (addAnother) {
        const next = freshDraft(entry.kind, { accountId: entry.accountId, destinationAccountId: entry.destinationAccountId })
        setDraft(next.draft)
        setAccountSource(accountSource)
        setDetailsOpen(false)
        setRecovered(null)
        lastShown.current = null
        attempts.current = 0
        openedAt.current = performance.now()
        amountRef.current?.focus()
      } else {
        navigate(returnTo, { replace: true })
      }
    } catch (error) {
      const errorClass = classifyError(error)
      const message =
        errorClass === 'network'
          ? `Couldn’t confirm the save — the connection dropped. ${mode === 'create' ? 'Your entry is still here. ' : ''}Trying again is safe: it can’t be saved twice.`
          : friendlyError(error)
      setSaveState({ status: 'error', message, errorClass })
      track('transaction_save_failed', { type: entry.kind, attempt: attempts.current, elapsed_ms: elapsed(), error_class: errorClass, mode })
    } finally {
      submitting.current = false
    }
  }

  function announceSaved(kind: CaptureKind, amountMinor: number, categoryId: string | null, id: string, savedKind: EntryKind) {
    const savedAt = Date.now()
    const category = categoryId ? categories.find((c) => c.id === categoryId)?.name : null
    const message =
      kind === 'transfer'
        ? `Moved ${formatMoney(amountMinor)}`
        : `Saved ${kind === 'expense' ? '−' : '+'}${formatMoney(amountMinor)}${category ? ` · ${category}` : ''}`
    toast({
      message,
      actions: [
        { label: 'Edit', onClick: () => navigate(`/entry/${savedKind}/${id}/edit`, { state: { from: returnTo } }) },
        {
          label: 'Undo',
          onClick: async () => {
            try {
              await setDeleted.mutateAsync({ kind: savedKind, id, deleted: true })
              track('transaction_undo_used', { type: savedKind, seconds_after_save: Math.round((Date.now() - savedAt) / 1000) })
              toast({ message: 'Undone — that entry is gone.' })
            } catch (error) {
              toast({ message: friendlyError(error), tone: 'error' })
            }
          },
        },
      ],
    })
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
      goBack(navigate, detailsPath ?? '/activity')
    } catch (error) {
      setConfirmDelete(false)
      setSaveState({ status: 'error', message: friendlyError(error), errorClass: classifyError(error) })
    }
  }

  // --- Leaving -----------------------------------------------------------------------

  const changedSinceOpen = JSON.stringify(stripMeta(draft)) !== JSON.stringify(stripMeta(initial.draft))

  function leave() {
    if (existing) {
      if (changedSinceOpen) setConfirmDiscard(true)
      else goBack(navigate, detailsPath ?? '/activity')
      return
    }
    if (isDirty(draft)) {
      setConfirmDiscard(true)
      return
    }
    clearDraft(userId)
    navigate(returnTo, { replace: true })
  }

  function discard() {
    setConfirmDiscard(false)
    if (existing) {
      goBack(navigate, detailsPath ?? '/activity')
      return
    }
    clearDraft(userId)
    navigate(returnTo, { replace: true })
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void submit(false)
  }

  // --- Render -----------------------------------------------------------------------

  if (!existing && activeAccounts.length === 0) {
    return (
      <EditorFrame title="Quick add">
        <EmptyState
          icon={<AccountGlyph type="bank" className="size-9" />}
          tone="sky"
          title="Add an account first"
          body="Friday needs somewhere for money to come from or go to. Your archived accounts can’t take new entries."
          action={
            <LinkButton to="/accounts/new" variant="primary">
              Add an account
            </LinkButton>
          }
        />
      </EditorFrame>
    )
  }

  const kindOptions = existing
    ? existing.kind === 'transfer'
      ? []
      : KIND_OPTIONS.filter((o) => o.value !== 'transfer')
    : KIND_OPTIONS

  const detailsSummary = [
    formatRelativeDay(draft.date, todayDate) === 'Today' ? 'Today' : formatDate(draft.date, { withYear: true }),
    draft.kind !== 'transfer' && draft.merchant.trim() ? draft.merchant.trim() : null,
    draft.note ? `“${draft.note.length > 20 ? draft.note.slice(0, 20) + '…' : draft.note}”` : 'No note',
  ]
    .filter(Boolean)
    .join(' · ')

  const suggestedCategory = draft.categorySource === 'suggested' ? categories.find((c) => c.id === draft.categoryId) : null
  const destinationAccount = draft.destinationAccountId ? accountsById.get(draft.destinationAccountId) : undefined
  const cardPayment = draft.kind === 'transfer' && destinationAccount?.type === 'credit_card'
  const showShortcuts = !existing && shortcuts.length > 0 && draft.amountText === '' && !recovered

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-1 flex-col">
      <div className="flex items-center gap-3 py-2">
        <IconButton
          label={existing ? 'Close without saving' : 'Cancel'}
          icon={<X className="size-5" strokeWidth={2.75} />}
          onClick={leave}
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

      {recovered && (
        <Card tone="yellow" padded={false} className="mt-2 flex items-center gap-3 px-4 py-3" role="status">
          <History aria-hidden="true" className="size-5 shrink-0" strokeWidth={2.5} />
          <p className="flex-1 text-sm font-semibold">
            Picked up your unsaved {NOUN[recovered.kind]} from{' '}
            {formatRelativeDay(localDate(new Date(recovered.updatedAt), timeZone), todayDate).toLowerCase()}.
          </p>
          <Button size="sm" onClick={startFresh}>
            Start fresh
          </Button>
        </Card>
      )}

      {kindOptions.length > 0 && (
        <PillSwitch label="Entry type" options={kindOptions} value={draft.kind} onChange={changeKind} size="lg" className="mt-3" />
      )}

      <div className={showShortcuts ? 'pt-7 pb-4' : 'py-7'}>
        <AmountInput
          ref={amountRef}
          value={draft.amountText}
          onChange={(amountText) => {
            setAmountBlurred(false)
            update({ amountText })
          }}
          onBlur={() => setAmountBlurred(true)}
          error={errors.amount ?? liveAmountError}
          label={`${NOUN[draft.kind]} amount in rupees`}
          onEnter={() => amountRef.current?.blur()}
        />
      </div>

      {showShortcuts && (
        <section aria-labelledby="shortcuts-heading" className="-mx-4 mb-5 flex flex-col gap-2 px-4">
          <h2 id="shortcuts-heading" className="label-mono">
            Again?
          </h2>
          <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1.5 pt-0.5 no-scrollbar">
            {shortcuts.map((shortcut, index) => {
              const category = shortcut.categoryId ? categories.find((c) => c.id === shortcut.categoryId) : undefined
              const title = shortcut.merchant ?? category?.name ?? 'Uncategorised'
              return (
                <li key={index} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => applyShortcut(shortcut)}
                    aria-label={`Fill in ${title}, ${shortcut.kind === 'income' ? 'income' : 'expense'} of ${formatMoney(shortcut.amountMinor)}. You can change it before saving.`}
                    className="pressable flex min-h-11 items-center gap-2 rounded-pill bg-paper py-1 pl-1.5 pr-3.5 font-display text-sm font-semibold tracking-tight outline-regular"
                  >
                    <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-peach">
                      <CategoryGlyph icon={category?.icon ?? 'tag'} className="size-4" />
                    </span>
                    <span aria-hidden="true" className="max-w-32 truncate">
                      {title}
                    </span>
                    <span aria-hidden="true" className="tabular font-extrabold">
                      {shortcut.kind === 'income' ? '+' : '−'}
                      {formatMoney(shortcut.amountMinor)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <div className="flex flex-col gap-6 pb-44">
        {draft.kind === 'transfer' ? (
          <section aria-labelledby="transfer-heading" className="flex flex-col gap-4">
            <h2 id="transfer-heading" className="sr-only">
              Accounts
            </h2>
            <AccountChips
              label="From"
              accounts={accountChoices}
              available={availableAccountIds}
              defaultId={profile.default_account_id}
              selected={draft.accountId}
              disabledId={null}
              onSelect={(id) => {
                setAccountSource('user')
                update({ accountId: id, destinationAccountId: draft.destinationAccountId === id ? null : draft.destinationAccountId })
              }}
              error={errors.account ?? unavailable(draft.accountId)}
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
              available={availableAccountIds}
              defaultId={null}
              selected={draft.destinationAccountId}
              disabledId={draft.accountId}
              onSelect={(id) => update({ destinationAccountId: id })}
              error={errors.destination ?? unavailable(draft.destinationAccountId)}
            />
            {cardPayment ? (
              <p className="rounded-2xl bg-purple/40 px-4 py-3 text-sm outline-regular">
                <strong>Card payment — not spending.</strong> It reduces what you owe on {destinationAccount?.name}. The
                purchases on the card were already counted as spending, so this doesn’t count them twice.
              </p>
            ) : (
              <p className="rounded-2xl bg-purple/40 px-4 py-3 text-sm outline-regular">
                <strong>Not spending, not income.</strong> A transfer just moves money between your accounts — it changes
                both balances and stays out of your totals.
              </p>
            )}
          </section>
        ) : (
          <>
            <AccountChips
              label={draft.kind === 'expense' ? 'Paid from' : 'Received into'}
              accounts={accountChoices}
              available={availableAccountIds}
              defaultId={profile.default_account_id}
              selected={draft.accountId}
              disabledId={null}
              onSelect={(id) => {
                setAccountSource('user')
                update({ accountId: id })
              }}
              error={errors.account ?? unavailable(draft.accountId)}
            />

            <section aria-labelledby="category-heading" className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="category-heading" className="label-mono">
                  Category
                </h2>
                {!draft.categoryId && <span className="text-sm text-muted">Optional</span>}
              </div>
              <div className="grid grid-cols-4 gap-2.5 pt-1.5">
                {visibleCategories.map((category) => (
                  <CategoryTile
                    key={category.id}
                    name={category.name}
                    icon={category.icon}
                    color={category.color}
                    selected={draft.categoryId === category.id}
                    suggested={draft.categoryId === category.id && draft.categorySource === 'suggested'}
                    onSelect={() => selectCategory(category.id)}
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
              <p className="min-h-5 text-sm text-muted" aria-live="polite">
                {suggestedCategory ? (
                  <span className="flex items-center gap-2">
                    <Sparkles aria-hidden="true" className="size-4 shrink-0 text-ink" strokeWidth={2.5} />
                    <span className="min-w-0 flex-1">
                      Suggested from your history
                      {suggestion?.reason === 'merchant' && draft.merchant.trim() ? ` for ${draft.merchant.trim()}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={rejectSuggestion}
                      className="min-h-11 shrink-0 px-1 font-semibold text-ink underline underline-offset-2"
                    >
                      Not this
                    </button>
                  </span>
                ) : !draft.categoryId && categoryChoices.length > 0 ? (
                  'No category — it’ll be saved as Uncategorised.'
                ) : null}
              </p>
              {categoryChoices.length === 0 && (
                <p className="text-sm text-muted">No {draft.kind} categories yet — add some from Profile → Categories.</p>
              )}
            </section>

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
            <span className="min-w-0 flex-1">
              <span className="block font-display font-extrabold tracking-tight">Add details</span>
              <span className="label-mono block truncate text-muted">{detailsSummary}</span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn('size-5 shrink-0 transition-transform', detailsOpen && 'rotate-180')}
              strokeWidth={2.5}
            />
          </button>
          {detailsOpen && (
            <div id="entry-details" className="flex flex-col gap-4 border-t-2 border-ink px-4 pb-4 pt-4">
              {draft.kind !== 'transfer' && (
                <>
                  <TextField
                    label={draft.kind === 'expense' ? 'Merchant or payee' : 'From (payer)'}
                    placeholder={draft.kind === 'expense' ? 'e.g. Blue Tokai' : 'e.g. Acme Corp'}
                    value={draft.merchant}
                    maxLength={MERCHANT_MAX + 20}
                    autoComplete="off"
                    list="known-merchants"
                    onChange={(event) => update({ merchant: event.target.value })}
                    error={errors.merchant}
                  />
                  <datalist id="known-merchants">
                    {merchants.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </>
              )}
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

        {saveState.status === 'mismatch' && (
          <Card ref={mismatchRef} tone="yellow" className="flex flex-col gap-3" role="alert">
            <h2 className="display text-xl">{saveState.voided ? 'Saved earlier, then undone' : 'Already saved earlier'}</h2>
            <p className="text-sm">
              {saveState.voided
                ? 'Friday saved this entry on an earlier try and it was undone afterwards. Nothing new was saved now.'
                : 'Friday had already saved this entry on an earlier try, before the connection dropped — with different details from what you see now. Your latest changes were not saved.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {!saveState.voided && (
                <Button
                  size="sm"
                  onClick={() => {
                    clearDraft(userId)
                    navigate(`/entry/${saveState.kind}/${saveState.id}`, { replace: true, state: { from: returnTo } })
                  }}
                >
                  Open the saved entry
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={() => void submit(false, true)}>
                {saveState.voided ? 'Save it again' : 'Save this as a separate entry'}
              </Button>
            </div>
          </Card>
        )}
      </div>

      <div
        className="fixed inset-x-0 bottom-0 z-30 mx-auto flex w-full max-w-[30rem] flex-col gap-1.5 bg-gradient-to-t from-canvas from-70% to-transparent px-4 pt-6"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)' }}
      >
        {saveState.status === 'error' ? (
          <div role="alert" className="flex flex-col gap-2 rounded-2xl bg-paper px-3.5 py-3 outline-regular shadow-brutal-sm">
            <p className="flex items-start gap-2 text-sm font-semibold">
              {saveState.errorClass === 'offline' || saveState.errorClass === 'network' ? (
                <WifiOff aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-negative" strokeWidth={2.5} />
              ) : (
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-negative" strokeWidth={2.5} />
              )}
              {saveState.message}
            </p>
            {saveState.errorClass === 'conflict' && onReloadExisting && (
              <Button size="sm" icon={<RotateCcw className="size-4" strokeWidth={2.75} />} onClick={() => void onReloadExisting()}>
                Load the latest version
              </Button>
            )}
          </div>
        ) : (
          !online && (
            <p role="status" className="flex items-center justify-center gap-1.5 text-sm font-semibold">
              <WifiOff aria-hidden="true" className="size-4" strokeWidth={2.5} />
              Offline — {mode === 'create' ? 'your entry stays on this device' : 'reconnect to save'}
            </p>
          )
        )}
        <Button
          type="submit"
          variant="primary"
          size="xl"
          block
          loading={saving}
          disabled={!validation.ok}
          aria-describedby={blockingHint ? 'save-hint' : undefined}
          icon={!saving ? <Check className="size-6" strokeWidth={3} /> : undefined}
        >
          {retryable ? 'Try again' : existing ? 'Save changes' : SAVE_LABEL[draft.kind]}
        </Button>
        {blockingHint && (draft.amountText !== '' || draft.kind === 'transfer') ? (
          <p id="save-hint" className="text-center text-sm font-semibold text-muted">
            {blockingHint}
          </p>
        ) : (
          !existing && (
            <button
              type="button"
              disabled={!validation.ok || saving}
              onClick={() => void submit(true)}
              className="min-h-11 font-display text-sm font-bold underline underline-offset-4 disabled:opacity-40"
            >
              Save & add another
            </button>
          )
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
      <ConfirmDialog
        open={confirmDiscard}
        title={existing ? 'Discard your changes?' : 'Discard this entry?'}
        body={existing ? 'The saved entry stays as it was.' : 'What you’ve typed will be cleared. Nothing has been saved.'}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        danger
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={discard}
      />
    </form>
  )
}

/** Fields that matter for "has anything changed" checks. */
function stripMeta({ updatedAt: _u, idempotencyKey: _k, categorySource: _c, ...rest }: CaptureDraft) {
  return rest
}

interface AccountChipsProps {
  label: string
  accounts: AccountBalanceRow[]
  available: Set<string>
  defaultId: string | null
  selected: string | null
  disabledId: string | null
  onSelect: (id: string) => void
  error?: string
}

function AccountChips({ label, accounts, available, defaultId, selected, disabledId, onSelect, error }: AccountChipsProps) {
  const headingId = `accounts-${label.replace(/\s+/g, '-').toLowerCase()}`
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="label-mono">
        {label}
      </h2>
      <div role="radiogroup" aria-labelledby={headingId} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1.5 pt-0.5 no-scrollbar">
        {accounts.map((account) => {
          const isSelected = account.id === selected
          const usable = available.has(account.id)
          const disabled = account.id === disabledId || (!usable && !isSelected)
          const isDefault = account.id === defaultId
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
                !usable && isSelected && 'line-through decoration-2',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('grid size-8 place-items-center rounded-full', isSelected ? 'bg-orange text-ink' : 'bg-peach')}
              >
                {isSelected ? <Check className="size-4" strokeWidth={3.5} /> : <AccountGlyph type={account.type} className="size-4" />}
              </span>
              {account.name}
              {isDefault && <span className="label-mono text-[0.6rem] opacity-80">Default</span>}
              {!usable && <span className="label-mono text-[0.6rem]">Archived</span>}
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
