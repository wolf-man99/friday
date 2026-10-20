import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { UtcRange } from '@/lib/dates'
import { isOutdatedSchema } from '@/lib/errors'
import type { ValidEntry } from '@/lib/entry'
import * as api from './api'
import * as gmail from './gmail'
import type {
  AccountInsert,
  CategoryInsert,
  EntryKind,
  EntryStatus,
  ProfileRow,
  RecurringRuleInsert,
  TransactionType,
} from './database.types'

// Everything derived from the ledger lives under ['ledger'], so one
// invalidation after any write refreshes balances, summaries, feeds and charts.
export const keys = {
  profile: ['profile'] as const,
  categories: ['categories'] as const,
  ledger: ['ledger'] as const,
  accounts: ['ledger', 'accounts'] as const,
  feed: (filters: api.FeedFilters, extra?: unknown) => ['ledger', 'feed', filters, extra] as const,
  summary: (range: UtcRange) => ['ledger', 'summary', range] as const,
  breakdown: (range: UtcRange, type: TransactionType) => ['ledger', 'breakdown', range, type] as const,
  trend: (range: UtcRange, bucket: string) => ['ledger', 'trend', range, bucket] as const,
  entry: (kind: EntryKind, id: string) => ['ledger', 'entry', kind, id] as const,
  linked: (id: string) => ['ledger', 'linked', id] as const,
  feedEntry: (id: string) => ['ledger', 'feed-entry', id] as const,
  audit: (kind: EntryKind, id: string) => ['ledger', 'audit', kind, id] as const,
  sources: (kind: EntryKind, id: string) => ['ledger', 'sources', kind, id] as const,
  activity: (range: UtcRange) => ['ledger', 'account-activity', range] as const,
  attention: ['ledger', 'attention'] as const,
  // Review items live under ['ledger'] too: confirming one changes balances.
  reviewEvents: ['ledger', 'review', 'events'] as const,
  reviewEntries: ['ledger', 'review', 'entries'] as const,
  candidates: (input: unknown) => ['ledger', 'candidates', input] as const,
  recurring: ['recurring'] as const,
  rules: ['recurring', 'rules'] as const,
  due: ['recurring', 'due'] as const,
  resolved: ['recurring', 'resolved'] as const,
  gmail: ['gmail'] as const,
  gmailImport: ['gmail', 'import'] as const,
}

// --- Reads ------------------------------------------------------------------------

/** Once per session: is the database on the newest migration? */
export function useSchemaCheck() {
  return useQuery({
    queryKey: ['schema'],
    queryFn: api.checkSchema,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: (count, error) => count < 2 && !isOutdatedSchema(error),
  })
}

export function useProfile(enabled = true) {
  return useQuery({ queryKey: keys.profile, queryFn: api.fetchProfile, enabled, staleTime: 5 * 60_000 })
}

export function useAccounts() {
  return useQuery({ queryKey: keys.accounts, queryFn: api.fetchAccounts })
}

export function useCategories() {
  return useQuery({ queryKey: keys.categories, queryFn: api.fetchCategories, staleTime: 5 * 60_000 })
}

export function useFeed(filters: api.FeedFilters, searchCategoryIds: string[] = []) {
  return useInfiniteQuery({
    queryKey: keys.feed(filters, searchCategoryIds),
    queryFn: ({ pageParam }) => api.fetchFeedPage(filters, pageParam, { searchCategoryIds }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => (lastPage.length === api.FEED_PAGE_SIZE ? pages.length : undefined),
    placeholderData: keepPreviousData,
  })
}

export function useRecentEntries(range: UtcRange, limit = 6) {
  return useQuery({
    queryKey: keys.feed({ range }, { limit }),
    queryFn: () => api.fetchFeedPage({ range }, 0, { pageSize: limit }),
    placeholderData: keepPreviousData,
  })
}

export function useEntry(kind: EntryKind | undefined, id: string | undefined) {
  return useQuery({
    queryKey: keys.entry(kind ?? 'expense', id ?? ''),
    queryFn: () => api.fetchEntry(kind!, id!),
    enabled: Boolean(kind && id),
  })
}

/** Refunds and reversals recorded against an entry. */
export function useLinkedEntries(originalId: string | null | undefined) {
  return useQuery({
    queryKey: keys.linked(originalId ?? ''),
    queryFn: () => api.fetchLinkedEntries(originalId!),
    enabled: Boolean(originalId),
  })
}

/** One feed row by id (e.g. the purchase a refund belongs to). */
export function useLedgerEntry(id: string | null | undefined) {
  return useQuery({ queryKey: keys.feedEntry(id ?? ''), queryFn: () => api.fetchLedgerEntry(id!), enabled: Boolean(id) })
}

export function useEntryAudit(kind: EntryKind | undefined, id: string | undefined) {
  return useQuery({
    queryKey: keys.audit(kind ?? 'expense', id ?? ''),
    queryFn: () => api.fetchEntryAudit(kind!, id!),
    enabled: Boolean(kind && id),
  })
}

export function useEntrySources(kind: EntryKind | undefined, id: string | undefined) {
  return useQuery({
    queryKey: keys.sources(kind ?? 'expense', id ?? ''),
    queryFn: () => api.fetchEntrySources(kind!, id!),
    enabled: Boolean(kind && id),
  })
}

export function useAccountActivity(range: UtcRange) {
  return useQuery({
    queryKey: keys.activity(range),
    queryFn: () => api.fetchAccountActivity(range),
    placeholderData: keepPreviousData,
  })
}

/** Review queue and pending counts for badges. */
export function useAttention() {
  return useQuery({ queryKey: keys.attention, queryFn: api.fetchAttention })
}

export function useReviewEvents() {
  return useQuery({ queryKey: keys.reviewEvents, queryFn: api.fetchReviewEvents })
}

export function useReviewEntries() {
  return useQuery({ queryKey: keys.reviewEntries, queryFn: api.fetchReviewEntries })
}

export function useIncomeInCategories(categoryIds: string[]) {
  return useQuery({
    queryKey: ['ledger', 'income-in-categories', categoryIds] as const,
    queryFn: () => api.fetchIncomeInCategories(categoryIds),
    enabled: categoryIds.length > 0,
  })
}

export function useStalePending(days = 5) {
  return useQuery({ queryKey: ['ledger', 'stale-pending', days] as const, queryFn: () => api.fetchStalePending(days) })
}

export function useMatchCandidates(input: Parameters<typeof api.fetchMatchCandidates>[0] | null) {
  return useQuery({
    queryKey: keys.candidates({ match: input }),
    queryFn: () => api.fetchMatchCandidates(input!),
    enabled: Boolean(input),
  })
}

export function useOffsetCandidates(input: Parameters<typeof api.fetchOffsetCandidates>[0] | null) {
  return useQuery({
    queryKey: keys.candidates({ offset: input }),
    queryFn: () => api.fetchOffsetCandidates(input!),
    enabled: Boolean(input),
  })
}

export function usePeriodSummary(range: UtcRange) {
  return useQuery({
    queryKey: keys.summary(range),
    queryFn: () => api.fetchPeriodSummary(range),
    placeholderData: keepPreviousData,
  })
}

export function useCategoryBreakdown(range: UtcRange, type: TransactionType = 'expense') {
  return useQuery({
    queryKey: keys.breakdown(range, type),
    queryFn: () => api.fetchCategoryBreakdown(range, type),
    placeholderData: keepPreviousData,
  })
}

export function useCashflowTrend(range: UtcRange, bucket: 'day' | 'week' | 'month') {
  return useQuery({
    queryKey: keys.trend(range, bucket),
    queryFn: () => api.fetchCashflowTrend(range, bucket),
    placeholderData: keepPreviousData,
  })
}

export function useRecurringRules() {
  return useQuery({ queryKey: keys.rules, queryFn: api.fetchRecurringRules })
}

export function useDueOccurrences() {
  return useQuery({ queryKey: keys.due, queryFn: api.fetchDueOccurrences })
}

export function useResolvedOccurrences() {
  return useQuery({ queryKey: keys.resolved, queryFn: () => api.fetchRecentResolvedOccurrences() })
}

/** Turns arrived due dates into prompts. Runs on app open and when refocused. */
export function useRecurringSync(enabled: boolean) {
  const client = useQueryClient()
  return useQuery({
    queryKey: ['recurring', 'sync'],
    queryFn: async () => {
      const created = await api.syncRecurring()
      if (created > 0) await client.invalidateQueries({ queryKey: keys.recurring, refetchType: 'active' })
      return created
    },
    enabled,
    staleTime: 10 * 60_000,
  })
}

// --- Writes -----------------------------------------------------------------------

function useInvalidate() {
  const client = useQueryClient()
  return (...queryKeys: (readonly unknown[])[]) =>
    Promise.all(queryKeys.map((queryKey) => client.invalidateQueries({ queryKey })))
}

export function useCaptureHistory() {
  return useQuery({ queryKey: ['ledger', 'capture-history'], queryFn: () => api.fetchCaptureHistory(), staleTime: 60_000 })
}

export function useCreateEntry() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ entry, occurredAt, idempotencyKey }: { entry: ValidEntry; occurredAt: string; idempotencyKey: string }) =>
      api.recordEntry(entry, occurredAt, idempotencyKey),
    // Also after failures: a lost response may still have committed.
    onSettled: () => invalidate(keys.ledger),
  })
}

export function useUpdateEntry() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (args: {
      previousKind: EntryKind
      id: string
      expectedUpdatedAt: string | null
      entry: ValidEntry
      occurredAt: string
      reason?: string | null
    }) => api.updateEntry(args.previousKind, args.id, args.expectedUpdatedAt, args.entry, args.occurredAt, args.reason),
    onSettled: () => invalidate(keys.ledger),
  })
}

/** Record a refund or reversal against its original (idempotent per key). */
export function useRecordLinkedEntry() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: { input: api.LinkedEntryInput; idempotencyKey: string }) =>
      api.recordLinkedEntry(input, idempotencyKey),
    onSettled: () => invalidate(keys.ledger),
  })
}

export function useUpdateLinkedEntry() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (args: {
      kind: 'refund' | 'reversal'
      id: string
      expectedUpdatedAt: string | null
      values: Parameters<typeof api.updateLinkedEntry>[3]
      reason?: string | null
    }) => api.updateLinkedEntry(args.kind, args.id, args.expectedUpdatedAt, args.values, args.reason),
    onSettled: () => invalidate(keys.ledger),
  })
}

export function useSetEntryStatus() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (args: {
      kind: EntryKind
      id: string
      status: EntryStatus
      reason?: string | null
      expectedUpdatedAt?: string | null
    }) => api.setEntryStatus(args.kind, args.id, args.status, { reason: args.reason, expectedUpdatedAt: args.expectedUpdatedAt }),
    onSettled: () => invalidate(keys.ledger),
  })
}

export function useMakeRefund() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (args: { id: string } & Parameters<typeof api.makeRefund>[1]) => api.makeRefund(args.id, args),
    onSettled: () => invalidate(keys.ledger),
  })
}

export function useConfirmSourceEvent() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ eventId, input }: { eventId: string; input: api.ConfirmEventInput }) => api.confirmSourceEvent(eventId, input),
    onSettled: () => invalidate(keys.ledger),
  })
}

export function useLinkSourceEvent() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ eventId, entryKind, entryId }: { eventId: string; entryKind: EntryKind; entryId: string }) =>
      api.linkSourceEvent(eventId, entryKind, entryId),
    onSettled: () => invalidate(keys.ledger),
  })
}

export function useIgnoreSourceEvent() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (eventId: string) => api.ignoreSourceEvent(eventId),
    onSettled: () => invalidate(keys.ledger),
  })
}

export function useSetEntryDeleted() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ kind, id, deleted }: { kind: EntryKind; id: string; deleted: boolean }) =>
      api.setEntryDeleted(kind, id, deleted),
    onSuccess: () => invalidate(keys.ledger),
  })
}

export function useSaveAccount() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, values }: { id?: string; values: AccountInsert | Partial<AccountInsert> }) =>
      id ? api.updateAccount(id, values) : api.createAccount(values as AccountInsert),
    onSuccess: () => invalidate(keys.ledger),
  })
}

export function useSaveCategory() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, values }: { id?: string; values: CategoryInsert | Partial<CategoryInsert> }) =>
      id ? api.updateCategory(id, values) : api.createCategory(values as CategoryInsert),
    onSuccess: () => invalidate(keys.categories),
  })
}

export function useSaveRecurringRule() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, values }: { id?: string; values: RecurringRuleInsert | Partial<RecurringRuleInsert> }) =>
      id ? api.updateRecurringRule(id, values) : api.createRecurringRule(values as RecurringRuleInsert),
    onSuccess: () => invalidate(keys.recurring),
  })
}

export function useDeleteRecurringRule() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.deleteRecurringRule(id),
    onSuccess: () => invalidate(keys.recurring),
  })
}

export function useConfirmOccurrence() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ ruleId, dueDate, overrides }: { ruleId: string; dueDate: string; overrides?: api.ConfirmOverrides }) =>
      api.confirmOccurrence(ruleId, dueDate, overrides),
    onSuccess: () => invalidate(keys.recurring, keys.ledger),
  })
}

export function useSkipOccurrence() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ ruleId, dueDate }: { ruleId: string; dueDate: string }) => api.skipOccurrence(ruleId, dueDate),
    onSuccess: () => invalidate(keys.recurring),
  })
}

export function useUpdateProfile() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<ProfileRow, 'display_name' | 'timezone' | 'default_account_id'>> }) =>
      api.updateProfile(patch, id),
    onSuccess: (profile) => {
      client.setQueryData(keys.profile, profile)
      // Reporting boundaries depend on the timezone.
      return client.invalidateQueries({ queryKey: keys.ledger })
    },
  })
}

export function useDeleteAllData() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.deleteAllMyData,
    onSuccess: () => client.invalidateQueries(),
  })
}

// --- Gmail connection ----------------------------------------------------------

export function useGmailConnection() {
  return useQuery({ queryKey: keys.gmail, queryFn: gmail.fetchGmailConnection })
}

export function useStartGmail() {
  return useMutation({ mutationFn: gmail.startGmailConnection })
}

export function useCompleteGmail() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: gmail.completeGmailConnection,
    onSettled: () => client.invalidateQueries({ queryKey: keys.gmail }),
  })
}

export function useDisconnectGmail() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: gmail.disconnectGmail,
    onSettled: () => client.invalidateQueries({ queryKey: keys.gmail }),
  })
}

/** The latest Gmail import (its progress is driven from the Gmail page). */
export function useGmailImport() {
  return useQuery({ queryKey: keys.gmailImport, queryFn: gmail.fetchLatestImport })
}

export function useGmailImportAccounts(jobId: string | null) {
  return useQuery({
    queryKey: [...keys.gmailImport, 'accounts', jobId],
    queryFn: () => gmail.importAccounts(jobId!),
    enabled: jobId !== null,
    staleTime: Infinity,
  })
}

/** Any import step; afterwards the import, the ledger and accounts are re-read. */
export function useGmailImportStep<A, R>(step: (arg: A) => Promise<R>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: step,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.gmailImport })
      void client.invalidateQueries({ queryKey: keys.ledger })
    },
  })
}
