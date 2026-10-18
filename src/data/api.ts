// Typed data-access layer. Every read and write goes through here so screens
// never build queries by hand. Row-level security scopes everything to the
// signed-in user; these functions add validation-friendly shapes on top.

import { supabase } from '@/lib/supabase'
import { zonedTimeToUtc, type UtcRange } from '@/lib/dates'
import type { ValidEntry } from '@/lib/entry'
import type {
  AccountBalanceRow,
  AccountInsert,
  AccountRow,
  CashflowTrendRow,
  CategoryBreakdownRow,
  CategoryInsert,
  CategoryRow,
  EntryKind,
  LedgerEntryRow,
  PeriodSummaryRow,
  ProfileRow,
  RecurringOccurrenceRow,
  RecurringRuleInsert,
  RecurringRuleRow,
  TransactionRow,
  TransactionType,
  TransferRow,
} from './database.types'

function unwrap<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.error) throw result.error
  return result.data as NonNullable<T>
}

// --- Profile -----------------------------------------------------------------

export async function fetchProfile(): Promise<ProfileRow> {
  // ensure_profile() returns the caller's profile, creating it (and default
  // categories) if the sign-up trigger never ran for this user.
  return unwrap(await supabase.rpc('ensure_profile'))
}

export async function updateProfile(patch: Partial<Pick<ProfileRow, 'display_name' | 'timezone'>>, id: string) {
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
  kind?: EntryKind | null
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
  if (filters.kind) query = query.eq('kind', filters.kind)
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId)
  if (filters.uncategorised) query = query.is('category_id', null).neq('kind', 'transfer')

  // Each .or() becomes its own query param; PostgREST ANDs them together.
  if (filters.accountId) {
    query = query.or(`account_id.eq.${filters.accountId},counter_account_id.eq.${filters.accountId}`)
  }
  const search = sanitiseSearch(filters.search ?? '')
  if (search) {
    const terms = [`note.ilike.*${search}*`]
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

export type LedgerEntry =
  | ({ kind: 'income' | 'expense' } & TransactionRow)
  | ({ kind: 'transfer' } & TransferRow)

export async function fetchEntry(kind: EntryKind, id: string): Promise<LedgerEntry> {
  if (kind === 'transfer') {
    const row = unwrap(await supabase.from('transfers').select('*').eq('id', id).single())
    return { ...row, kind: 'transfer' }
  }
  const row = unwrap(await supabase.from('transactions').select('*').eq('id', id).single())
  return { ...row, kind: row.type }
}

/**
 * The instant to store for a chosen local date: now if it is today, otherwise
 * midday local time (keeps the entry safely inside that day).
 */
export function occurredAtFor(date: string, todayDate: string, timeZone: string): string {
  if (date === todayDate) return new Date().toISOString()
  return zonedTimeToUtc(date, '12:00', timeZone).toISOString()
}

export async function createEntry(entry: ValidEntry, occurredAt: string): Promise<{ kind: EntryKind; id: string }> {
  if (entry.kind === 'transfer') {
    const row = unwrap(
      await supabase
        .from('transfers')
        .insert({
          source_account_id: entry.accountId,
          destination_account_id: entry.destinationAccountId!,
          amount_minor: entry.amountMinor,
          occurred_at: occurredAt,
          note: entry.note,
        })
        .select('id')
        .single(),
    )
    return { kind: 'transfer', id: row.id }
  }
  const row = unwrap(
    await supabase
      .from('transactions')
      .insert({
        account_id: entry.accountId,
        type: entry.kind,
        amount_minor: entry.amountMinor,
        category_id: entry.categoryId,
        occurred_at: occurredAt,
        note: entry.note,
      })
      .select('id')
      .single(),
  )
  return { kind: entry.kind, id: row.id }
}

export async function updateEntry(
  previousKind: EntryKind,
  id: string,
  entry: ValidEntry,
  occurredAt: string,
): Promise<void> {
  if ((previousKind === 'transfer') !== (entry.kind === 'transfer')) {
    throw new Error('A transfer can’t be turned into income or an expense. Delete it and record a new entry.')
  }
  if (entry.kind === 'transfer') {
    unwrap(
      await supabase
        .from('transfers')
        .update({
          source_account_id: entry.accountId,
          destination_account_id: entry.destinationAccountId!,
          amount_minor: entry.amountMinor,
          occurred_at: occurredAt,
          note: entry.note,
        })
        .eq('id', id)
        .select('id')
        .single(),
    )
    return
  }
  unwrap(
    await supabase
      .from('transactions')
      .update({
        account_id: entry.accountId,
        type: entry.kind,
        amount_minor: entry.amountMinor,
        category_id: entry.categoryId,
        occurred_at: occurredAt,
        note: entry.note,
      })
      .eq('id', id)
      .select('id')
      .single(),
  )
}

/** Soft delete: the row stays for undo/audit but leaves every total. */
export async function setEntryDeleted(kind: EntryKind, id: string, deleted: boolean): Promise<void> {
  const table = kind === 'transfer' ? 'transfers' : 'transactions'
  unwrap(
    await supabase
      .from(table)
      .update({ deleted_at: deleted ? new Date().toISOString() : null })
      .eq('id', id)
      .select('id')
      .single(),
  )
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
  const [profile, accounts, categories, transactions, transfers, rules, occurrences] = await Promise.all([
    supabase.from('profiles').select('*'),
    supabase.from('accounts').select('*'),
    supabase.from('categories').select('*'),
    fetchAllRows('transactions'),
    fetchAllRows('transfers'),
    supabase.from('recurring_rules').select('*'),
    fetchAllRows('recurring_occurrences'),
  ])
  return {
    format: 'friday-backup',
    version: 1,
    exported_at: new Date().toISOString(),
    profile: unwrap(profile),
    accounts: unwrap(accounts),
    categories: unwrap(categories),
    transactions,
    transfers,
    recurring_rules: unwrap(rules),
    recurring_occurrences: occurrences,
  }
}

async function fetchAllRows(table: 'transactions' | 'transfers' | 'recurring_occurrences') {
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
