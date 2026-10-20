// Persistence for the Gmail functions: thin wrappers over the service-role
// database functions in migration 20261021000000_gmail_connection.sql. The
// secrets live in the friday_private schema, which the API doesn't expose.

/** The slice of supabase-js the store needs (service-role client). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message)
  }
}

export type ConsumeOutcome = 'ok' | 'expired' | 'used' | 'unknown'
export type CompleteOutcome = 'ok' | 'wrong_user' | 'wrong_browser' | 'expired' | 'unknown'

export interface CompleteResult {
  outcome: CompleteOutcome
  connectionId: string | null
  accountEmail: string | null
  /** For outcomes other than ok: the grant's token, when it's safe to revoke. */
  refreshTokenEnc: string | null
  /** For ok: a credential for another Gmail account this replaced, when it's safe to revoke. */
  replacedTokenEnc: string | null
  /** Whose token refreshTokenEnc is (needed to decrypt it for revocation). */
  ownerId: string | null
}

export interface Credentials {
  connectionId: string
  accountEmail: string
  refreshTokenEnc: string
}

export interface ConsumedState {
  outcome: ConsumeOutcome
  userId: string | null
  codeVerifier: string | null
  browserHash: string | null
}

export interface PendingGrant {
  userId: string
  ticketHash: string
  accountEmail: string
  scopes: string[]
  refreshTokenEnc: string
  browserHash: string
}

/** A token disconnect deleted; revocable is false when another live connection uses that Gmail account. */
export interface DeletedToken {
  refreshTokenEnc: string
  revocable: boolean
}

// --- Importing past months -------------------------------------------------------

export interface ImportRange {
  month: string
  start: Date
  end: Date
}

/** What an alert email said, as stored for the import (never the email itself). */
export interface StoredAlert {
  institutionKey: string
  institutionName: string
  instrument: string
  accountMask: string | null
  /** null: which way the money went isn't clear (reviewed by the person). */
  kind: string | null
  transferHint: string | null
  /** null: no amount could be read (reviewed by the person). */
  amountMinor: number | null
  currency: string
  occurredAt: string
  merchant: string | null
  reference: string | null
  entryStatus: string
  categoryHint: string | null
  confidence: number
  senderVerified: boolean
}

export type ScannedItem = { messageId: string; skip: string } | { messageId: string; alert: StoredAlert }

export interface DiscoveredAccount {
  institutionKey: string
  institutionName: string
  instrument: string
  accountMask: string
  messages: number
  firstAt: string | null
  lastAt: string | null
  linkedAccountId: string | null
  linkedIgnored: boolean
  suggestedAccountId: string | null
  suggestedName: string
  suggestedType: string | null
}

export interface AccountDecision {
  institutionKey: string
  instrument: string
  accountMask: string
  action: 'link' | 'create' | 'ignore' | 'review'
  accountId?: string
  name?: string
  type?: string
  openingBalanceMinor?: number
}

export interface ImportStore {
  importBegin(userId: string, months: string[]): Promise<{ jobId: string; ranges: ImportRange[] }>
  importAddMessages(userId: string, jobId: string, messageIds: string[], truncated: boolean): Promise<number>
  importPending(userId: string, jobId: string, limit: number): Promise<{ messageIds: string[]; timeZone: string }>
  importSave(userId: string, jobId: string, items: ScannedItem[]): Promise<{ scanned: number; total: number; status: string }>
  importAccounts(userId: string, jobId: string): Promise<DiscoveredAccount[]>
  importApplyAccounts(userId: string, jobId: string, decisions: AccountDecision[]): Promise<{ created: number; linked: number; kept: number }>
  importRun(userId: string, jobId: string, limit: number): Promise<{ processed: number; remaining: number; status: string }>
  importUndo(userId: string, jobId: string): Promise<{ removed: number; kept: number }>
  importCancel(userId: string, jobId: string): Promise<void>
  importFail(userId: string, jobId: string, errorCode: string): Promise<void>
}

export interface GmailStore extends ImportStore {
  begin(userId: string, stateHash: string, codeVerifier: string, browserHash: string): Promise<void>
  consume(stateHash: string): Promise<ConsumedState>
  storePendingGrant(grant: PendingGrant): Promise<void>
  /** Deletes the user's expired grants; returns the tokens that are safe to revoke. */
  takeExpiredGrants(userId: string): Promise<string[]>
  completeGrant(userId: string, ticketHash: string, browserHash: string): Promise<CompleteResult>
  getCredentials(userId: string): Promise<Credentials | null>
  /** Deletes exactly this credential (not a newer one) and asks the person to reconnect. */
  markNeedsReconnect(userId: string, connectionId: string, refreshTokenEnc: string, errorCode: string): Promise<void>
  recordCheck(userId: string, connectionId: string): Promise<void>
  disconnect(userId: string): Promise<DeletedToken[]>
}

type Row = Record<string, unknown>

export class SupabaseGmailStore implements GmailStore {
  constructor(private readonly client: RpcClient) {}

  private async rows(fn: string, args: Record<string, unknown>): Promise<Row[]> {
    const { data, error } = await this.client.rpc(fn, args)
    // Database messages are written for people; never include arguments.
    if (error) throw new StoreError(error.message, error.code ?? null)
    if (data === null || data === undefined) return []
    return Array.isArray(data) ? (data as Row[]) : [data as Row]
  }

  async begin(userId: string, stateHash: string, codeVerifier: string, browserHash: string) {
    await this.rows('gmail_oauth_begin', {
      p_user_id: userId,
      p_state_hash: stateHash,
      p_code_verifier: codeVerifier,
      p_browser_hash: browserHash,
    })
  }

  async consume(stateHash: string) {
    const [row] = await this.rows('gmail_oauth_consume', { p_state_hash: stateHash })
    return {
      outcome: (row?.outcome as ConsumeOutcome) ?? 'unknown',
      userId: (row?.user_id as string | null) ?? null,
      codeVerifier: (row?.code_verifier as string | null) ?? null,
      browserHash: (row?.browser_hash as string | null) ?? null,
    }
  }

  async storePendingGrant(grant: PendingGrant) {
    await this.rows('gmail_store_pending_grant', {
      p_user_id: grant.userId,
      p_ticket_hash: grant.ticketHash,
      p_account_email: grant.accountEmail,
      p_scopes: grant.scopes,
      p_refresh_token_enc: grant.refreshTokenEnc,
      p_browser_hash: grant.browserHash,
    })
  }

  async takeExpiredGrants(userId: string) {
    const rows = await this.rows('gmail_take_expired_grants', { p_user_id: userId })
    return rows.map((row) => String(row.refresh_token_enc))
  }

  async completeGrant(userId: string, ticketHash: string, browserHash: string): Promise<CompleteResult> {
    const [row] = await this.rows('gmail_complete_grant', { p_user_id: userId, p_ticket_hash: ticketHash, p_browser_hash: browserHash })
    return {
      outcome: (row?.outcome as CompleteOutcome) ?? 'unknown',
      connectionId: (row?.connection_id as string | null) ?? null,
      accountEmail: (row?.account_email as string | null) ?? null,
      refreshTokenEnc: (row?.refresh_token_enc as string | null) ?? null,
      replacedTokenEnc: (row?.replaced_token_enc as string | null) ?? null,
      ownerId: (row?.owner_id as string | null) ?? null,
    }
  }

  async getCredentials(userId: string) {
    const [row] = await this.rows('gmail_get_credentials', { p_user_id: userId })
    if (!row) return null
    return {
      connectionId: String(row.connection_id),
      accountEmail: String(row.account_email),
      refreshTokenEnc: String(row.refresh_token_enc),
    }
  }

  async markNeedsReconnect(userId: string, connectionId: string, refreshTokenEnc: string, errorCode: string) {
    await this.rows('gmail_mark_needs_reconnect', {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_refresh_token_enc: refreshTokenEnc,
      p_error_code: errorCode,
    })
  }

  async recordCheck(userId: string, connectionId: string) {
    await this.rows('gmail_record_check', { p_user_id: userId, p_connection_id: connectionId })
  }

  async disconnect(userId: string) {
    const rows = await this.rows('gmail_disconnect', { p_user_id: userId })
    return rows.map((row) => ({ refreshTokenEnc: String(row.refresh_token_enc), revocable: row.revocable === true }))
  }

  // --- Importing past months -------------------------------------------------------

  async importBegin(userId: string, months: string[]) {
    const rows = await this.rows('gmail_import_begin', { p_user_id: userId, p_months: months })
    if (rows.length === 0) throw new StoreError('Import could not start', null)
    return {
      jobId: String(rows[0].job_id),
      ranges: rows.map((row) => ({ month: String(row.month), start: new Date(String(row.range_start)), end: new Date(String(row.range_end)) })),
    }
  }

  async importAddMessages(userId: string, jobId: string, messageIds: string[], truncated: boolean) {
    const [row] = await this.rows('gmail_import_add_messages', {
      p_user_id: userId,
      p_job_id: jobId,
      p_message_ids: messageIds,
      p_truncated: truncated,
    })
    return Number(row ?? 0)
  }

  async importPending(userId: string, jobId: string, limit: number) {
    const rows = await this.rows('gmail_import_pending', { p_user_id: userId, p_job_id: jobId, p_limit: limit })
    return { messageIds: rows.map((row) => String(row.message_id)), timeZone: String(rows[0]?.time_zone ?? 'Asia/Kolkata') }
  }

  async importSave(userId: string, jobId: string, items: ScannedItem[]) {
    const [row] = await this.rows('gmail_import_save', { p_user_id: userId, p_job_id: jobId, p_items: items })
    return { scanned: Number(row?.scanned ?? 0), total: Number(row?.total ?? 0), status: String(row?.status ?? 'scanning') }
  }

  async importAccounts(userId: string, jobId: string) {
    const rows = await this.rows('gmail_import_accounts', { p_user_id: userId, p_job_id: jobId })
    return rows.map((row) => ({
      institutionKey: String(row.institution_key),
      institutionName: String(row.institution_name),
      instrument: String(row.instrument),
      accountMask: String(row.account_mask ?? ''),
      messages: Number(row.messages),
      firstAt: (row.first_at as string | null) ?? null,
      lastAt: (row.last_at as string | null) ?? null,
      linkedAccountId: (row.linked_account_id as string | null) ?? null,
      linkedIgnored: row.linked_ignored === true,
      suggestedAccountId: (row.suggested_account_id as string | null) ?? null,
      suggestedName: String(row.suggested_name ?? row.institution_name),
      suggestedType: (row.suggested_type as string | null) ?? null,
    }))
  }

  async importApplyAccounts(userId: string, jobId: string, decisions: AccountDecision[]) {
    const [row] = await this.rows('gmail_import_apply_accounts', { p_user_id: userId, p_job_id: jobId, p_decisions: decisions })
    return { created: Number(row?.created_accounts ?? 0), linked: Number(row?.linked_accounts ?? 0), kept: Number(row?.kept_balances ?? 0) }
  }

  async importRun(userId: string, jobId: string, limit: number) {
    const [row] = await this.rows('gmail_import_run', { p_user_id: userId, p_job_id: jobId, p_limit: limit })
    return { processed: Number(row?.processed ?? 0), remaining: Number(row?.remaining ?? 0), status: String(row?.status ?? 'importing') }
  }

  async importUndo(userId: string, jobId: string) {
    const [row] = await this.rows('gmail_import_undo', { p_user_id: userId, p_job_id: jobId })
    return { removed: Number(row?.removed_entries ?? 0), kept: Number(row?.kept_entries ?? 0) }
  }

  async importCancel(userId: string, jobId: string) {
    await this.rows('gmail_import_cancel', { p_user_id: userId, p_job_id: jobId })
  }

  async importFail(userId: string, jobId: string, errorCode: string) {
    await this.rows('gmail_import_fail', { p_user_id: userId, p_job_id: jobId, p_error_code: errorCode })
  }
}
