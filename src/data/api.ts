// Typed data-access layer. Every read and write goes through here so screens
// never build queries by hand. Row-level security scopes everything to the
// signed-in user; these functions add validation-friendly shapes on top.

import { supabase } from '@/lib/supabase'
import { zonedTimeToUtc, type UtcRange } from '@/lib/dates'
import type { HistoryItem } from '@/features/capture/suggest'
import type { ValidEntry } from '@/lib/entry'
import type {
  AccountActivityRow,
  AccountBalanceRow,
  AccountInsert,
  AccountRow,
  CashflowTrendRow,
  CategoryBreakdownRow,
  CategoryInsert,
  CategoryRow,
  EntryKind,
  EntryStatus,
  IngestResultRow,
  LedgerAttentionRow,
  LedgerAuditRow,
  LedgerEntryRow,
  LedgerType,
  PeriodSummaryRow,
  ProfileRow,
  RecordEntryRow,
  RecurringOccurrenceRow,
  RecurringRuleInsert,
  RecurringRuleRow,
  SourceEventRow,
  TransactionRow,
  TransactionType,
  TransferRow,
} from './database.types'

function unwrap<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.error) throw result.error
  return result.data as NonNullable<T>
}

// --- Schema ------------------------------------------------------------------

/**
 * Reads a column added by the newest migration. Fails with an outdated-schema
 * error when that migration hasn't been applied, so the app can say so up
 * front instead of failing in the middle of a save.
 */
export async function checkSchema(): Promise<true> {
  const { error } = await supabase.from('ledger_entries').select('status, related_transaction_id').limit(1)
  if (error) throw error
  return true
}

// --- Profile -----------------------------------------------------------------

export async function fetchProfile(): Promise<ProfileRow> {
  // ensure_profile() returns the caller's profile, creating it (and default
  // categories) if the sign-up trigger never ran for this user.
  return unwrap(await supabase.rpc('ensure_profile'))
}

export async function updateProfile(
  patch: Partial<Pick<ProfileRow, 'display_name' | 'timezone' | 'default_account_id'>>,
  id: string,
) {
  return unwrap(await supabase.from('profiles').update(patch).eq('id', id).select().single())
}

// --- Accounts -----------------------------------------------------------------

export async function fetchAccounts(): Promise<AccountBalanceRow[]> {
  return unwrap(
    await supabase
      .from('account_balances')
      .select('*')
      .order('status')
      .order('sort_order')
      .order('name'),
  )
}

export async function createAccount(input: AccountInsert): Promise<AccountRow> {
  return unwrap(await supabase.from('accounts').insert(input).select().single())
}

export async function updateAccount(id: string, patch: Partial<AccountInsert>): Promise<AccountRow> {
  return unwrap(await supabase.from('accounts').update(patch).eq('id', id).select().single())
}

// --- Categories ---------------------------------------------------------------

export async function fetchCategories(): Promise<CategoryRow[]> {
  return unwrap(
    await supabase
      .from('categories')
      .select('*')
      .order('transaction_type')
      .order('sort_order')
      .order('name'),
  )
}

export async function createCategory(input: CategoryInsert): Promise<CategoryRow> {
  return unwrap(await supabase.from('categories').insert(input).select().single())
}

export async function updateCategory(id: string, patch: Partial<CategoryInsert>): Promise<CategoryRow> {
  return unwrap(await supabase.from('categories').update(patch).eq('id', id).select().single())
}

// --- Ledger entries -------------------------------------------------------------

export interface FeedFilters {
  range?: UtcRange | null
  /** 'refund' also finds reversals: both give money back against an original. */
  kind?: EntryKind | null
  /** 'attention' finds pending and needs-review entries. */
  status?: EntryStatus | 'attention' | null
  accountId?: string | null
  categoryId?: string | null
  /** 'none' finds uncategorised income/expenses. */
  uncategorised?: boolean
  search?: string
}

export const FEED_PAGE_SIZE = 50

/** Characters that would break PostgREST filter syntax. */
function sanitiseSearch(text: string) {
  return text.replace(/[%_*,()"'\\:]/g, ' ').trim()
}

export async function fetchFeedPage(
  filters: FeedFilters,
  page: number,
  options: { searchCategoryIds?: string[]; pageSize?: number } = {},
): Promise<LedgerEntryRow[]> {
  const pageSize = options.pageSize ?? FEED_PAGE_SIZE
  let query = supabase.from('ledger_entries').select('*')

  if (filters.range) query = query.gte('occurred_at', filters.range.from).lt('occurred_at', filters.range.to)
  if (filters.kind === 'refund') query = query.in('kind', ['refund', 'reversal'])
  else if (filters.kind) query = query.eq('kind', filters.kind)
  if (filters.status === 'attention') query = query.in('status', ['pending', 'needs_review'])
  else if (filters.status) query = query.eq('status', filters.status)
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId)
  if (filters.uncategorised) query = query.is('category_id', null).neq('kind', 'transfer')

  // Each .or() becomes its own query param; PostgREST ANDs them together.
  if (filters.accountId) {
    query = query.or(`account_id.eq.${filters.accountId},counter_account_id.eq.${filters.accountId}`)
  }
  const search = sanitiseSearch(filters.search ?? '')
  if (search) {
    const terms = [`note.ilike.*${search}*`, `merchant.ilike.*${search}*`]
    if (options.searchCategoryIds?.length) terms.push(`category_id.in.(${options.searchCategoryIds.join(',')})`)
    query = query.or(terms.join(','))
  }

  return unwrap(
    await query
      .order('occurred_at', { ascending: false })
      .order('created_at', { ascending: false })
      .range(page * pageSize, page * pageSize + pageSize - 1),
  )
}

export type LedgerEntry = ({ kind: LedgerType } & TransactionRow) | ({ kind: 'transfer' } & TransferRow)

/** One entry from its own table, including deleted and voided ones. */
export async function fetchEntry(kind: EntryKind, id: string): Promise<LedgerEntry> {
  if (kind === 'transfer') {
    const row = unwrap(await supabase.from('transfers').select('*').eq('id', id).single())
    return { ...row, kind: 'transfer' }
  }
  const row = unwrap(await supabase.from('transactions').select('*').eq('id', id).single())
  return { ...row, kind: row.type }
}

/** Refunds and reversals recorded against an entry (not deleted). */
export async function fetchLinkedEntries(originalId: string): Promise<LedgerEntryRow[]> {
  return unwrap(
    await supabase
      .from('ledger_entries')
      .select('*')
      .eq('related_transaction_id', originalId)
      .order('occurred_at', { ascending: true }),
  )
}

/** A single feed row by id (e.g. the original of a refund). */
export async function fetchLedgerEntry(id: string): Promise<LedgerEntryRow | null> {
  const rows = unwrap(await supabase.from('ledger_entries').select('*').eq('id', id).limit(1))
  return rows[0] ?? null
}

/** The change history of one entry, oldest first. */
export async function fetchEntryAudit(kind: EntryKind, id: string): Promise<LedgerAuditRow[]> {
  return unwrap(
    await supabase
      .from('ledger_audit')
      .select('*')
      .eq('entity', kind === 'transfer' ? 'transfer' : 'transaction')
      .eq('entity_id', id)
      .order('id', { ascending: true }),
  )
}

/** Import evidence linked to an entry. */
export async function fetchEntrySources(kind: EntryKind, id: string): Promise<SourceEventRow[]> {
  return unwrap(
    await supabase
      .from('source_events')
      .select('*')
      .eq(kind === 'transfer' ? 'resulting_transfer_id' : 'resulting_transaction_id', id)
      .order('received_at', { ascending: true }),
  )
}

/**
 * The instant to store for a chosen local date: now if it is today, otherwise
 * midday local time (keeps the entry safely inside that day).
 */
export function occurredAtFor(date: string, todayDate: string, timeZone: string): string {
  if (date === todayDate) return new Date().toISOString()
  return zonedTimeToUtc(date, '12:00', timeZone).toISOString()
}

/**
 * Records a new entry through the database's capture service. The request key
 * makes this safe to retry: a replay (double tap, lost response, second
 * device) returns the entry committed first instead of creating another.
 */
export async function recordEntry(
  entry: ValidEntry,
  occurredAt: string,
  idempotencyKey: string,
): Promise<RecordEntryRow> {
  const rows = unwrap(
    await supabase.rpc('record_entry', {
      p_idempotency_key: idempotencyKey,
      p_kind: entry.kind,
      p_amount_minor: entry.amountMinor,
      p_account_id: entry.accountId,
      p_destination_account_id: entry.destinationAccountId,
      p_category_id: entry.categoryId,
      p_occurred_at: occurredAt,
      p_note: entry.note,
      p_merchant: entry.merchant,
      p_created_via: 'quick_add',
    }),
  )
  if (!rows[0]) throw new Error('Friday didn’t confirm the save. Try again — it won’t create a duplicate.')
  return rows[0]
}

/**
 * Edits an entry. `expectedUpdatedAt` is the version the user started from
 * (the raw string from the API): if the entry changed since, nothing is
 * written and a conflict error comes back. Returns the new version.
 */
export async function updateEntry(
  previousKind: EntryKind,
  id: string,
  expectedUpdatedAt: string | null,
  entry: ValidEntry,
  occurredAt: string,
  reason?: string | null,
): Promise<string> {
  return unwrap(
    await supabase.rpc('update_entry', {
      p_kind: previousKind,
      p_id: id,
      p_expected_updated_at: expectedUpdatedAt,
      p_new_kind: entry.kind,
      p_amount_minor: entry.amountMinor,
      p_account_id: entry.accountId,
      p_destination_account_id: entry.destinationAccountId,
      p_category_id: entry.categoryId,
      p_occurred_at: occurredAt,
      p_note: entry.note,
      p_merchant: entry.merchant,
      p_reason: reason ?? null,
    }),
  )
}

/** Delete (Undo) or restore. Idempotent: repeating it changes nothing. */
export async function setEntryDeleted(kind: EntryKind, id: string, deleted: boolean): Promise<void> {
  unwrap(await supabase.rpc('set_entry_deleted', { p_kind: kind, p_id: id, p_deleted: deleted }))
}

/**
 * Turns income that was really a refund into a refund (linked to its
 * purchase, or unlinked with an expense category), or links a refund recorded
 * without its purchase. Returns the new version.
 */
export async function makeRefund(
  id: string,
  options: { originalId?: string | null; categoryId?: string | null; expectedUpdatedAt?: string | null; reason?: string | null },
): Promise<string> {
  return unwrap(
    await supabase.rpc('make_refund', {
      p_id: id,
      p_original_id: options.originalId ?? null,
      p_category_id: options.categoryId ?? null,
      p_expected_updated_at: options.expectedUpdatedAt ?? null,
      p_reason: options.reason ?? null,
    }),
  )
}

/**
 * pending → posted, posted → voided, confirming a reviewed entry, restoring a
 * voided one. The database rejects any other change. Returns the new version.
 */
export async function setEntryStatus(
  kind: EntryKind,
  id: string,
  status: EntryStatus,
  options: { reason?: string | null; expectedUpdatedAt?: string | null } = {},
): Promise<string> {
  return unwrap(
    await supabase.rpc('set_entry_status', {
      p_kind: kind,
      p_id: id,
      p_status: status,
      p_reason: options.reason ?? null,
      p_expected_updated_at: options.expectedUpdatedAt ?? null,
    }),
  )
}

export interface LinkedEntryInput {
  kind: 'refund' | 'reversal'
  originalId: string
  amountMinor: number
  /** Refunds may land on another account; reversals stay on the original's. */
  accountId: string
  occurredAt: string
  note: string | null
  merchant?: string | null
}

/**
 * Records a refund or reversal against its original. Idempotent per key like
 * recordEntry. The database checks the original is a posted entry of the right
 * type and that the total refunded/reversed never exceeds its amount.
 */
export async function recordLinkedEntry(input: LinkedEntryInput, idempotencyKey: string): Promise<RecordEntryRow> {
  const rows = unwrap(
    await supabase.rpc('record_entry', {
      p_idempotency_key: idempotencyKey,
      p_kind: input.kind,
      p_amount_minor: input.amountMinor,
      p_account_id: input.accountId,
      p_occurred_at: input.occurredAt,
      p_note: input.note,
      p_merchant: input.merchant ?? null,
      p_created_via: 'manual',
      p_related_transaction_id: input.originalId,
    }),
  )
  if (!rows[0]) throw new Error('Friday didn’t confirm the save. Try again — it won’t create a duplicate.')
  return rows[0]
}

/** Edits a refund or reversal: amount, account (refunds only), date, note. */
export async function updateLinkedEntry(
  kind: 'refund' | 'reversal',
  id: string,
  expectedUpdatedAt: string | null,
  values: { amountMinor: number; accountId: string; occurredAt: string; note: string | null; merchant?: string | null },
  reason?: string | null,
): Promise<string> {
  return unwrap(
    await supabase.rpc('update_entry', {
      p_kind: kind,
      p_id: id,
      p_expected_updated_at: expectedUpdatedAt,
      p_new_kind: kind,
      p_amount_minor: values.amountMinor,
      p_account_id: values.accountId,
      p_occurred_at: values.occurredAt,
      p_note: values.note,
      p_merchant: values.merchant ?? null,
      p_reason: reason ?? null,
    }),
  )
}

/** Recent income/expense entries (newest first) that power suggestions and shortcuts. */
export async function fetchCaptureHistory(limit = 200): Promise<HistoryItem[]> {
  const rows = unwrap(
    await supabase
      .from('ledger_entries')
      .select('kind, category_id, merchant, account_id, amount_minor')
      .in('kind', ['income', 'expense'])
      .neq('status', 'voided')
      .order('created_at', { ascending: false })
      .limit(limit),
  )
  return rows.map((row) => ({
    kind: row.kind as TransactionType,
    categoryId: row.category_id,
    merchant: row.merchant,
    accountId: row.account_id,
    amountMinor: row.amount_minor,
  }))
}

// --- Reports ----------------------------------------------------------------------

export async function fetchPeriodSummary(range: UtcRange): Promise<PeriodSummaryRow> {
  const rows = unwrap(await supabase.rpc('period_summary', { p_from: range.from, p_to: range.to }))
  return rows[0]
}

export async function fetchCategoryBreakdown(range: UtcRange, type: TransactionType): Promise<CategoryBreakdownRow[]> {
  return unwrap(await supabase.rpc('category_breakdown', { p_from: range.from, p_to: range.to, p_type: type }))
}

export async function fetchCashflowTrend(range: UtcRange, bucket: 'day' | 'week' | 'month'): Promise<CashflowTrendRow[]> {
  return unwrap(await supabase.rpc('cashflow_trend', { p_from: range.from, p_to: range.to, p_bucket: bucket }))
}

export async function fetchAccountActivity(range: UtcRange): Promise<AccountActivityRow[]> {
  return unwrap(await supabase.rpc('account_activity', { p_from: range.from, p_to: range.to }))
}

/** All-time counts of what needs a look: review queue and pending entries. */
export async function fetchAttention(): Promise<LedgerAttentionRow> {
  const rows = unwrap(await supabase.rpc('ledger_attention'))
  return rows[0] ?? { review_events: 0, review_entries: 0, pending_entries: 0 }
}

// --- Review queue -------------------------------------------------------------------

/** Imported evidence waiting for a decision, newest first. Nothing here is in the ledger yet. */
export async function fetchReviewEvents(): Promise<SourceEventRow[]> {
  return unwrap(
    await supabase
      .from('source_events')
      .select('*')
      .eq('processing_status', 'needs_review')
      .order('received_at', { ascending: false })
      .limit(200),
  )
}

/** Income recorded in the given categories (e.g. an old "Refunds" income category). */
export async function fetchIncomeInCategories(categoryIds: string[]): Promise<LedgerEntryRow[]> {
  if (categoryIds.length === 0) return []
  return unwrap(
    await supabase
      .from('ledger_entries')
      .select('*')
      .eq('kind', 'income')
      .neq('status', 'voided')
      .in('category_id', categoryIds)
      .order('occurred_at', { ascending: false })
      .limit(200),
  )
}

/** Pending entries older than `days` — holds that may never have settled. */
export async function fetchStalePending(days = 5): Promise<LedgerEntryRow[]> {
  return unwrap(
    await supabase
      .from('ledger_entries')
      .select('*')
      .eq('status', 'pending')
      .lt('occurred_at', new Date(Date.now() - days * 86_400_000).toISOString())
      .order('occurred_at', { ascending: true })
      .limit(100),
  )
}

/** Ledger entries marked needs_review (not counted until confirmed). */
export async function fetchReviewEntries(): Promise<LedgerEntryRow[]> {
  return unwrap(
    await supabase
      .from('ledger_entries')
      .select('*')
      .eq('status', 'needs_review')
      .order('occurred_at', { ascending: false })
      .limit(200),
  )
}

/**
 * Entries that could be the same real transaction as a piece of evidence:
 * same amount, within `days` of its date, not voided. Optional kinds/account.
 */
export async function fetchMatchCandidates(input: {
  amountMinor: number
  around: string
  days?: number
  kinds?: EntryKind[]
  accountId?: string | null
}): Promise<LedgerEntryRow[]> {
  const days = input.days ?? 7
  const at = new Date(input.around).getTime()
  let query = supabase
    .from('ledger_entries')
    .select('*')
    .eq('amount_minor', input.amountMinor)
    .neq('status', 'voided')
    .gte('occurred_at', new Date(at - days * 86_400_000).toISOString())
    .lte('occurred_at', new Date(at + days * 86_400_000).toISOString())
  if (input.kinds?.length) query = query.in('kind', input.kinds)
  if (input.accountId) query = query.or(`account_id.eq.${input.accountId},counter_account_id.eq.${input.accountId}`)
  return unwrap(await query.order('occurred_at', { ascending: false }).limit(20))
}

/** Posted purchases (or income) a refund/reversal could belong to, newest first. */
export async function fetchOffsetCandidates(input: {
  kinds: ('expense' | 'income')[]
  accountId?: string | null
  minAmountMinor?: number
  before?: string
  limit?: number
}): Promise<LedgerEntryRow[]> {
  let query = supabase.from('ledger_entries').select('*').in('kind', input.kinds).eq('status', 'posted')
  if (input.accountId) query = query.eq('account_id', input.accountId)
  if (input.minAmountMinor) query = query.gte('amount_minor', input.minAmountMinor)
  if (input.before) query = query.lte('occurred_at', input.before)
  return unwrap(await query.order('occurred_at', { ascending: false }).limit(input.limit ?? 30))
}

export interface ConfirmEventInput {
  kind: EntryKind
  amountMinor: number
  accountId: string
  destinationAccountId?: string | null
  categoryId?: string | null
  occurredAt?: string | null
  merchant?: string | null
  note?: string | null
  relatedTransactionId?: string | null
  status?: 'posted' | 'pending'
}

/** Confirm (optionally corrected) → exactly one entry. Re-confirming returns the same entry. */
export async function confirmSourceEvent(eventId: string, input: ConfirmEventInput) {
  const rows = unwrap(
    await supabase.rpc('confirm_source_event', {
      p_event_id: eventId,
      p_kind: input.kind,
      p_amount_minor: input.amountMinor,
      p_account_id: input.accountId,
      p_destination_account_id: input.destinationAccountId ?? null,
      p_category_id: input.categoryId ?? null,
      p_occurred_at: input.occurredAt ?? null,
      p_merchant: input.merchant ?? null,
      p_note: input.note ?? null,
      p_related_transaction_id: input.relatedTransactionId ?? null,
      p_status: input.status ?? 'posted',
    }),
  )
  if (!rows[0]) throw new Error('Friday didn’t confirm the save. Try again — it won’t create a duplicate.')
  return rows[0]
}

/** The evidence is about an entry that already exists. */
export async function linkSourceEvent(eventId: string, entryKind: EntryKind, entryId: string): Promise<void> {
  unwrap(await supabase.rpc('link_source_event', { p_event_id: eventId, p_entry_kind: entryKind, p_entry_id: entryId }))
}

/** Not a transaction (a promo, a duplicate notification). */
export async function ignoreSourceEvent(eventId: string): Promise<void> {
  unwrap(await supabase.rpc('ignore_source_event', { p_event_id: eventId }))
}

export type SubmitEventInput = Parameters<typeof supabase.rpc<'submit_source_event'>>[1]

/** Submit evidence about your own money (the client side of the import boundary). */
export async function submitSourceEvent(input: SubmitEventInput): Promise<IngestResultRow> {
  const rows = unwrap(await supabase.rpc('submit_source_event', input))
  return rows[0]
}

// --- Recurring --------------------------------------------------------------------

export async function syncRecurring(): Promise<number> {
  return unwrap(await supabase.rpc('sync_recurring_occurrences'))
}

export async function fetchRecurringRules(): Promise<RecurringRuleRow[]> {
  return unwrap(
    await supabase.from('recurring_rules').select('*').order('active', { ascending: false }).order('next_due_date'),
  )
}

export async function fetchDueOccurrences(): Promise<RecurringOccurrenceRow[]> {
  return unwrap(await supabase.from('recurring_occurrences').select('*').eq('status', 'due').order('due_date'))
}

export async function fetchRecentResolvedOccurrences(limit = 20): Promise<RecurringOccurrenceRow[]> {
  return unwrap(
    await supabase
      .from('recurring_occurrences')
      .select('*')
      .neq('status', 'due')
      .order('resolved_at', { ascending: false })
      .limit(limit),
  )
}

export async function createRecurringRule(input: RecurringRuleInsert): Promise<RecurringRuleRow> {
  return unwrap(await supabase.from('recurring_rules').insert(input).select().single())
}

export async function updateRecurringRule(id: string, patch: Partial<RecurringRuleInsert>): Promise<RecurringRuleRow> {
  return unwrap(await supabase.from('recurring_rules').update(patch).eq('id', id).select().single())
}

export async function deleteRecurringRule(id: string): Promise<void> {
  unwrap(await supabase.from('recurring_rules').delete().eq('id', id).select('id'))
}

export interface ConfirmOverrides {
  amountMinor?: number
  accountId?: string
  categoryId?: string | null
  occurredAt?: string
  note?: string | null
}

export async function confirmOccurrence(ruleId: string, dueDate: string, overrides: ConfirmOverrides = {}) {
  return unwrap(
    await supabase.rpc('confirm_recurring_occurrence', {
      p_rule_id: ruleId,
      p_due_date: dueDate,
      p_amount_minor: overrides.amountMinor ?? null,
      p_account_id: overrides.accountId ?? null,
      p_category_id: overrides.categoryId ?? null,
      p_occurred_at: overrides.occurredAt ?? null,
      p_note: overrides.note ?? null,
    }),
  )
}

export async function skipOccurrence(ruleId: string, dueDate: string): Promise<void> {
  unwrap(await supabase.rpc('skip_recurring_occurrence', { p_rule_id: ruleId, p_due_date: dueDate }))
}

// --- Export & deletion ------------------------------------------------------------

/** Every non-deleted ledger entry, fetched page by page past the API row limit. */
export async function fetchAllEntries(): Promise<LedgerEntryRow[]> {
  const pageSize = 1000
  const all: LedgerEntryRow[] = []
  for (let page = 0; ; page++) {
    const rows = await fetchFeedPage({}, page, { pageSize })
    all.push(...rows)
    if (rows.length < pageSize) return all
  }
}

export async function fetchBackup() {
  const [profile, accounts, categories, transactions, transfers, rules, occurrences, events, connections] = await Promise.all([
    supabase.from('profiles').select('*'),
    supabase.from('accounts').select('*'),
    supabase.from('categories').select('*'),
    fetchAllRows('transactions'),
    fetchAllRows('transfers'),
    supabase.from('recurring_rules').select('*'),
    fetchAllRows('recurring_occurrences'),
    fetchAllRows('source_events'),
    supabase.from('source_connections').select('*'),
  ])
  return {
    format: 'friday-backup',
    version: 2,
    exported_at: new Date().toISOString(),
    profile: unwrap(profile),
    accounts: unwrap(accounts),
    categories: unwrap(categories),
    transactions,
    transfers,
    recurring_rules: unwrap(rules),
    recurring_occurrences: occurrences,
    source_events: events,
    source_connections: unwrap(connections),
  }
}

async function fetchAllRows(table: 'transactions' | 'transfers' | 'recurring_occurrences' | 'source_events') {
  const pageSize = 1000
  const all: unknown[] = []
  for (let page = 0; ; page++) {
    const rows = unwrap(
      await supabase
        .from(table)
        .select('*')
        .order('created_at')
        .order('id')
        .range(page * pageSize, page * pageSize + pageSize - 1),
    ) as unknown[]
    all.push(...rows)
    if (rows.length < pageSize) return all
  }
}

export async function deleteAllMyData(): Promise<void> {
  unwrap(await supabase.rpc('delete_all_my_data'))
}
