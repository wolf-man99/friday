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

export interface GmailStore {
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
}
