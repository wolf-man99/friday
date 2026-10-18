// Hand-maintained types for supabase/migrations. Keep in sync with the SQL
// (or regenerate with `supabase gen types typescript` and adjust imports).

export type AccountType = 'cash' | 'bank' | 'credit_card' | 'other'
export type AccountStatus = 'active' | 'archived'
export type TransactionType = 'income' | 'expense'
export type EntryKind = TransactionType | 'transfer'
export type RecurringCadence = 'daily' | 'weekly' | 'monthly' | 'yearly'
export type OccurrenceStatus = 'due' | 'confirmed' | 'skipped'

type Timestamps = { created_at: string; updated_at: string }

export type ProfileRow = Timestamps & {
  id: string
  display_name: string | null
  timezone: string
  base_currency: string
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
  type: TransactionType
  amount_minor: number
  currency: string
  category_id: string | null
  occurred_at: string
  note: string | null
  deleted_at: string | null
}

export type TransferRow = Timestamps & {
  id: string
  user_id: string
  source_account_id: string
  destination_account_id: string
  amount_minor: number
  currency: string
  occurred_at: string
  note: string | null
  deleted_at: string | null
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
  balance_minor: number
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
}

export type PeriodSummaryRow = {
  income_minor: number
  expense_minor: number
  net_minor: number
  income_count: number
  expense_count: number
  transfer_count: number
}

export type CategoryBreakdownRow = {
  category_id: string | null
  total_minor: number
  transaction_count: number
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

export type AccountInsert = Omit<AccountRow, Owned | 'currency' | 'color' | 'status' | 'sort_order' | 'opening_date'> &
  Partial<Pick<AccountRow, 'currency' | 'color' | 'status' | 'sort_order' | 'opening_date'>>

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
      skip_recurring_occurrence: { Args: { p_rule_id: string; p_due_date: string }; Returns: undefined }
      delete_all_my_data: { Args: Record<string, never>; Returns: undefined }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
