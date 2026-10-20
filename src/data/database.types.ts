// Hand-maintained types for supabase/migrations. Keep in sync with the SQL
// (or regenerate with `supabase gen types typescript` and adjust imports).

export type AccountType = 'bank' | 'credit_card' | 'wallet' | 'cash' | 'other'
export type AccountStatus = 'active' | 'archived'
/** The income/expense side of the books: categories, recurring rules, Quick Add. */
export type TransactionType = 'income' | 'expense'
/** transactions.type (migration 0003 adds refunds and reversals). */
export type LedgerType = TransactionType | 'refund' | 'reversal'
/** Every kind of ledger entry, including transfers (their own table). */
export type EntryKind = LedgerType | 'transfer'
/** What Quick Add records. Refunds and reversals start from their original. */
export type CaptureKind = TransactionType | 'transfer'
/** posted and pending count in balances and insights; needs_review and voided don't. */
export type EntryStatus = 'pending' | 'posted' | 'needs_review' | 'voided'
export type SourceType = 'manual' | 'email' | 'bank_import' | 'wallet_import' | 'other_import'
export type ImportSourceType = Exclude<SourceType, 'manual'>
export type ProcessingStatus = 'received' | 'parsed' | 'needs_review' | 'imported' | 'ignored' | 'failed'
export type ReviewReason =
  | 'missing_details'
  | 'unsupported_currency'
  | 'unknown_account'
  | 'needs_link'
  | 'low_confidence'
  | 'possible_duplicate'
  | 'linked_entry_removed'
  | 'possible_transfer'
  | 'settlement_differs'
  | 'before_tracking_start'
export type RecurringCadence = 'daily' | 'weekly' | 'monthly' | 'yearly'
export type OccurrenceStatus = 'due' | 'confirmed' | 'skipped'

type Timestamps = { created_at: string; updated_at: string }

export type ProfileRow = Timestamps & {
  id: string
  display_name: string | null
  timezone: string
  base_currency: string
  /** The account Quick Add preselects (migration 0002). */
  default_account_id: string | null
}

export type AccountRow = Timestamps & {
  id: string
  user_id: string
  name: string
  type: AccountType
  currency: string
  opening_balance_minor: number
  opening_date: string
  color: string
  status: AccountStatus
  sort_order: number
  /** Bank or provider, e.g. "HDFC Bank" (0003). */
  institution_name: string | null
  /** Credit cards only (0003). */
  credit_limit_minor: number | null
}

export type CategoryRow = Timestamps & {
  id: string
  user_id: string
  name: string
  transaction_type: TransactionType
  icon: string
  color: string
  is_default: boolean
  is_archived: boolean
  sort_order: number
}

export type TransactionRow = Timestamps & {
  id: string
  user_id: string
  account_id: string
  type: LedgerType
  amount_minor: number
  currency: string
  category_id: string | null
  occurred_at: string
  note: string | null
  merchant: string | null
  idempotency_key: string | null
  created_via: CreatedVia
  deleted_at: string | null
  status: EntryStatus
  /** While voided: the status Restore returns it to. */
  voided_from: EntryStatus | null
  /** The purchase a refund refunds, or the entry a reversal reverses. */
  related_transaction_id: string | null
  /** Reversals only: the type of the entry reversed. */
  reversal_of_type: TransactionType | null
  /** Generated: the side this entry nets against. */
  base_type: TransactionType
  source_type: SourceType
  source_confidence: number | null
}

export type CreatedVia = 'manual' | 'quick_add' | 'recurring' | 'import'

export type TransferRow = Timestamps & {
  id: string
  user_id: string
  source_account_id: string
  destination_account_id: string
  amount_minor: number
  currency: string
  occurred_at: string
  note: string | null
  idempotency_key: string | null
  created_via: CreatedVia
  deleted_at: string | null
  status: EntryStatus
  voided_from: EntryStatus | null
  source_type: SourceType
  source_confidence: number | null
}

export type RecurringRuleRow = Timestamps & {
  id: string
  user_id: string
  name: string
  type: TransactionType
  amount_minor: number
  account_id: string
  category_id: string | null
  note: string | null
  cadence: RecurringCadence
  interval_count: number
  start_date: string
  next_due_date: string
  end_date: string | null
  active: boolean
}

export type RecurringOccurrenceRow = {
  id: string
  user_id: string
  rule_id: string
  due_date: string
  status: OccurrenceStatus
  transaction_id: string | null
  resolved_at: string | null
  created_at: string
}

export type AccountBalanceRow = {
  id: string
  user_id: string
  name: string
  type: AccountType
  currency: string
  color: string
  status: AccountStatus
  sort_order: number
  opening_balance_minor: number
  opening_date: string
  income_minor: number
  expense_minor: number
  transfers_in_minor: number
  transfers_out_minor: number
  /** opening + income − expense + refunds − reversed income + transfers in − out (counted entries). */
  balance_minor: number
  institution_name: string | null
  credit_limit_minor: number | null
  /** Refunds and reversed purchases credited to this account. */
  refunds_minor: number
  /** Income reversed out of this account. */
  reversed_income_minor: number
  /** The part of balance_minor that is still pending. */
  pending_minor: number
  /** Entries on this account waiting for review (not in the balance). */
  review_count: number
  /** Cards only: what is owed, never negative. */
  outstanding_minor: number | null
  /** Cards with a limit only: limit − outstanding (negative when over the limit). */
  available_credit_minor: number | null
  /**
   * Set when older history was imported (migration 0005): the balance counts
   * entries from this date on; earlier ones count in spending only.
   */
  balance_from?: string | null
}

export type GmailImportStatus = 'listing' | 'scanning' | 'confirm_accounts' | 'importing' | 'done' | 'undone' | 'cancelled' | 'failed'

export type GmailImportJobRow = {
  id: string
  user_id: string
  connection_id: string
  months: string[]
  status: GmailImportStatus
  total_messages: number
  scanned: number
  skipped: number
  recorded: number
  matched: number
  review: number
  ignored: number
  truncated: boolean
  error_code: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
  undone_at: string | null
}

export type LedgerEntryRow = Timestamps & {
  id: string
  user_id: string
  kind: EntryKind
  account_id: string
  counter_account_id: string | null
  category_id: string | null
  amount_minor: number
  currency: string
  occurred_at: string
  note: string | null
  merchant: string | null
  status: EntryStatus
  source_type: SourceType
  created_via: CreatedVia
  related_transaction_id: string | null
  /** null for transfers. */
  base_type: TransactionType | null
  source_confidence: number | null
  voided_from: EntryStatus | null
}

export type PeriodSummaryRow = {
  /** Income minus reversed income. */
  income_minor: number
  /** Net spending: expenses minus refunds and reversed purchases. */
  expense_minor: number
  net_minor: number
  income_count: number
  expense_count: number
  transfer_count: number
  /** Refunds and reversed purchases in the period (already netted out of expense_minor). */
  refund_minor: number
  refund_count: number
  pending_count: number
}

export type CategoryBreakdownRow = {
  category_id: string | null
  /** Net: gross minus refunds/reversals. Can be ≤ 0 when refunds outweigh the period's spending. */
  total_minor: number
  transaction_count: number
  gross_minor: number
  refund_minor: number
}

export type AccountActivityRow = {
  account_id: string
  money_in_minor: number
  money_out_minor: number
  transfers_in_minor: number
  transfers_out_minor: number
  entry_count: number
}

export type LedgerAttentionRow = {
  review_events: number
  review_entries: number
  pending_entries: number
}

export type SourceEventRow = {
  id: string
  user_id: string
  source_type: ImportSourceType
  source_connection_id: string | null
  external_event_id: string
  external_transaction_id: string | null
  payload_fingerprint: string | null
  received_at: string
  parsed_at: string | null
  processing_status: ProcessingStatus
  confidence: number | null
  parsed_kind: EntryKind | null
  parsed_amount_minor: number | null
  parsed_currency: string | null
  parsed_occurred_at: string | null
  parsed_merchant: string | null
  parsed_account_hint: string | null
  parsed_entry_status: 'pending' | 'posted' | 'cancelled' | 'declined' | null
  review_reason: ReviewReason | null
  suggested_account_id: string | null
  suggested_destination_account_id: string | null
  suggested_category_id: string | null
  suggested_match_kind: 'transaction' | 'transfer' | null
  suggested_match_id: string | null
  resulting_transaction_id: string | null
  resulting_transfer_id: string | null
  link_type: 'created' | 'matched' | null
  linked_at: string | null
  error_code: string | null
  created_at: string
  updated_at: string
}

export type SourceConnectionRow = Timestamps & {
  id: string
  user_id: string
  source_type: ImportSourceType
  label: string
  status: 'active' | 'paused' | 'needs_reconnect' | 'disconnected'
  /** 'gmail' for a Gmail connection (migration 0004). Secrets never live in this table. */
  provider: 'gmail' | null
  account_email: string | null
  scopes: string[]
  connected_at: string | null
  disconnected_at: string | null
  last_checked_at: string | null
  /** A short code such as invalid_grant — never message text. */
  last_error_code: string | null
}

export type LedgerAuditRow = {
  id: number
  user_id: string
  entity: 'transaction' | 'transfer'
  entity_id: string
  action: 'create' | 'update' | 'status' | 'delete' | 'restore' | 'void'
  changed_fields: string[]
  snapshot: Record<string, unknown>
  previous: Record<string, unknown> | null
  reason: string | null
  created_at: string
}

export type IngestResultRow = {
  event_id: string
  processing_status: ProcessingStatus
  review_reason: ReviewReason | null
  entry_kind: EntryKind | null
  entry_id: string | null
  replayed: boolean
}

export type RecordEntryRow = {
  kind: EntryKind
  id: string
  /** false: this request key was already used; the original entry is returned. */
  created: boolean
  /** false: the earlier request had different financial details. */
  matches: boolean
  voided: boolean
  updated_at: string
}

export type CashflowTrendRow = {
  bucket_start: string
  income_minor: number
  expense_minor: number
}

type Table<Row, Insert, Update = Partial<Insert>> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: []
}

type View<Row> = { Row: Row; Relationships: [] }

type Owned = 'id' | 'user_id' | 'created_at' | 'updated_at'

type AccountOptional = 'currency' | 'color' | 'status' | 'sort_order' | 'opening_date' | 'institution_name' | 'credit_limit_minor'

export type AccountInsert = Omit<AccountRow, Owned | AccountOptional> & Partial<Pick<AccountRow, AccountOptional>>

export type CategoryInsert = Pick<CategoryRow, 'name' | 'transaction_type'> &
  Partial<Pick<CategoryRow, 'icon' | 'color' | 'sort_order' | 'is_archived'>>

export type TransactionInsert = Pick<TransactionRow, 'account_id' | 'type' | 'amount_minor'> &
  Partial<Pick<TransactionRow, 'category_id' | 'occurred_at' | 'note' | 'currency' | 'deleted_at'>>

export type TransferInsert = Pick<TransferRow, 'source_account_id' | 'destination_account_id' | 'amount_minor'> &
  Partial<Pick<TransferRow, 'occurred_at' | 'note' | 'currency' | 'deleted_at'>>

export type RecurringRuleInsert = Pick<
  RecurringRuleRow,
  'name' | 'type' | 'amount_minor' | 'account_id' | 'cadence' | 'start_date'
> &
  Partial<Pick<RecurringRuleRow, 'category_id' | 'note' | 'interval_count' | 'end_date' | 'active'>>

export type Database = {
  public: {
    Tables: {
      profiles: Table<ProfileRow, Pick<ProfileRow, 'id'> & Partial<ProfileRow>>
      accounts: Table<AccountRow, AccountInsert>
      categories: Table<CategoryRow, CategoryInsert>
      transactions: Table<TransactionRow, TransactionInsert>
      transfers: Table<TransferRow, TransferInsert>
      recurring_rules: Table<RecurringRuleRow, RecurringRuleInsert>
      recurring_occurrences: Table<RecurringOccurrenceRow, Pick<RecurringOccurrenceRow, 'rule_id' | 'due_date'>>
      source_events: Table<SourceEventRow, never, never>
      source_connections: Table<SourceConnectionRow, never, never>
      ledger_audit: Table<LedgerAuditRow, never, never>
      gmail_import_jobs: Table<GmailImportJobRow, never, never>
    }
    Views: {
      account_balances: View<AccountBalanceRow>
      ledger_entries: View<LedgerEntryRow>
    }
    Functions: {
      ensure_profile: { Args: Record<string, never>; Returns: ProfileRow }
      period_summary: { Args: { p_from: string; p_to: string }; Returns: PeriodSummaryRow[] }
      category_breakdown: {
        Args: { p_from: string; p_to: string; p_type?: TransactionType }
        Returns: CategoryBreakdownRow[]
      }
      account_activity: { Args: { p_from: string; p_to: string }; Returns: AccountActivityRow[] }
      ledger_attention: { Args: Record<string, never>; Returns: LedgerAttentionRow[] }
      cashflow_trend: {
        Args: { p_from: string; p_to: string; p_bucket?: 'day' | 'week' | 'month' }
        Returns: CashflowTrendRow[]
      }
      sync_recurring_occurrences: { Args: Record<string, never>; Returns: number }
      confirm_recurring_occurrence: {
        Args: {
          p_rule_id: string
          p_due_date: string
          p_amount_minor?: number | null
          p_account_id?: string | null
          p_category_id?: string | null
          p_occurred_at?: string | null
          p_note?: string | null
        }
        Returns: string
      }
      record_entry: {
        Args: {
          p_idempotency_key: string
          p_kind: EntryKind
          p_amount_minor: number
          p_account_id: string
          p_destination_account_id?: string | null
          p_category_id?: string | null
          p_occurred_at?: string | null
          p_note?: string | null
          p_merchant?: string | null
          p_created_via?: CreatedVia
          p_related_transaction_id?: string | null
          p_status?: EntryStatus
          p_source_type?: SourceType
          p_source_confidence?: number | null
        }
        Returns: RecordEntryRow[]
      }
      update_entry: {
        Args: {
          p_kind: EntryKind
          p_id: string
          p_expected_updated_at: string | null
          p_new_kind: EntryKind
          p_amount_minor: number
          p_account_id: string
          p_destination_account_id?: string | null
          p_category_id?: string | null
          p_occurred_at?: string | null
          p_note?: string | null
          p_merchant?: string | null
          p_reason?: string | null
        }
        Returns: string
      }
      /** Delete (Undo) or restore. Named before 0003 introduced the voided status. */
      set_entry_voided: { Args: { p_kind: EntryKind; p_id: string; p_voided: boolean }; Returns: string }
      set_entry_status: {
        Args: {
          p_kind: EntryKind
          p_id: string
          p_status: EntryStatus
          p_reason?: string | null
          p_expected_updated_at?: string | null
        }
        Returns: string
      }
      set_entry_deleted: { Args: { p_kind: EntryKind; p_id: string; p_deleted: boolean }; Returns: string }
      make_refund: {
        Args: {
          p_id: string
          p_original_id?: string | null
          p_category_id?: string | null
          p_expected_updated_at?: string | null
          p_reason?: string | null
        }
        Returns: string
      }
      submit_source_event: {
        Args: {
          p_source_type: ImportSourceType
          p_external_event_id: string
          p_external_transaction_id?: string | null
          p_payload_fingerprint?: string | null
          p_kind?: EntryKind | null
          p_amount_minor?: number | null
          p_currency?: string | null
          p_occurred_at?: string | null
          p_merchant?: string | null
          p_account_hint?: string | null
          p_account_id?: string | null
          p_destination_account_id?: string | null
          p_category_id?: string | null
          p_entry_status?: 'pending' | 'posted' | 'cancelled' | 'declined'
          p_confidence?: number | null
        }
        Returns: IngestResultRow[]
      }
      confirm_source_event: {
        Args: {
          p_event_id: string
          p_kind: EntryKind
          p_amount_minor: number
          p_account_id: string
          p_destination_account_id?: string | null
          p_category_id?: string | null
          p_occurred_at?: string | null
          p_merchant?: string | null
          p_note?: string | null
          p_related_transaction_id?: string | null
          p_status?: 'posted' | 'pending'
        }
        Returns: { kind: EntryKind; id: string }[]
      }
      link_source_event: { Args: { p_event_id: string; p_entry_kind: EntryKind; p_entry_id: string }; Returns: undefined }
      ignore_source_event: { Args: { p_event_id: string }; Returns: undefined }
      skip_recurring_occurrence: { Args: { p_rule_id: string; p_due_date: string }; Returns: undefined }
      delete_all_my_data: { Args: Record<string, never>; Returns: undefined }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
