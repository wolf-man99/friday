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
export type CompleteOutcome = 'ok' | 'wrong_user' | 'expired' | 'unknown'

export interface CompleteResult {
  outcome: CompleteOutcome
  connectionId: string | null
  accountEmail: string | null
  /** For outcomes other than ok: the grant's token, to revoke. */
  refreshTokenEnc: string | null
  /** For ok: a credential this replaced, to revoke. */
  replacedTokenEnc: string | null
  /** Whose token refreshTokenEnc is (needed to decrypt it for revocation). */
  ownerId: string | null
}

export interface Credentials {
  connectionId: string
  accountEmail: string
  refreshTokenEnc: string
}

export interface GmailStore {
  begin(userId: string, stateHash: string, codeVerifier: string): Promise<void>
  consume(stateHash: string): Promise<{ outcome: ConsumeOutcome; userId: string | null; codeVerifier: string | null }>
  storePendingGrant(input: { userId: string; ticketHash: string; accountEmail: string; scopes: string[]; refreshTokenEnc: string }): Promise<void>
  takeExpiredGrants(userId: string): Promise<string[]>
  completeGrant(userId: string, ticketHash: string): Promise<CompleteResult>
  getCredentials(userId: string): Promise<Credentials | null>
  markNeedsReconnect(userId: string, connectionId: string, errorCode: string): Promise<void>
  recordCheck(userId: string, connectionId: string): Promise<void>
  disconnect(userId: string): Promise<string[]>
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

  async begin(userId: string, stateHash: string, codeVerifier: string) {
    await this.rows('gmail_oauth_begin', { p_user_id: userId, p_state_hash: stateHash, p_code_verifier: codeVerifier })
  }

  async consume(stateHash: string) {
    const [row] = await this.rows('gmail_oauth_consume', { p_state_hash: stateHash })
    return {
      outcome: (row?.outcome as ConsumeOutcome) ?? 'unknown',
      userId: (row?.user_id as string | null) ?? null,
      codeVerifier: (row?.code_verifier as string | null) ?? null,
    }
  }

  async storePendingGrant(input: { userId: string; ticketHash: string; accountEmail: string; scopes: string[]; refreshTokenEnc: string }) {
    await this.rows('gmail_store_pending_grant', {
      p_user_id: input.userId,
      p_ticket_hash: input.ticketHash,
      p_account_email: input.accountEmail,
      p_scopes: input.scopes,
      p_refresh_token_enc: input.refreshTokenEnc,
    })
  }

  async takeExpiredGrants(userId: string) {
    const rows = await this.rows('gmail_take_expired_grants', { p_user_id: userId })
    return rows.map((row) => String(row.refresh_token_enc))
  }

  async completeGrant(userId: string, ticketHash: string): Promise<CompleteResult> {
    const [row] = await this.rows('gmail_complete_grant', { p_user_id: userId, p_ticket_hash: ticketHash })
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

  async markNeedsReconnect(userId: string, connectionId: string, errorCode: string) {
    await this.rows('gmail_mark_needs_reconnect', { p_user_id: userId, p_connection_id: connectionId, p_error_code: errorCode })
  }

  async recordCheck(userId: string, connectionId: string) {
    await this.rows('gmail_record_check', { p_user_id: userId, p_connection_id: connectionId })
  }

  async disconnect(userId: string) {
    const rows = await this.rows('gmail_disconnect', { p_user_id: userId })
    return rows.map((row) => String(row.refresh_token_enc))
  }
}
