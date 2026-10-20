// Test doubles for the Gmail functions: an in-memory store with the same rules
// as the SQL functions in migration 20261021000000_gmail_connection.sql, and a
// fake Google (OAuth + Gmail API) behind an injectable fetch. Nothing here
// talks to a network.

import type { GmailConfig } from '../_shared/config.ts'
import { pkceChallenge, toBase64Url, TokenCipher } from '../_shared/crypto.ts'
import { DEFAULT_ALERT_SENDERS } from '../_shared/gmailQuery.ts'
import { GMAIL_READONLY_SCOPE } from '../_shared/google.ts'
import type { LogFields, Logger } from '../_shared/http.ts'
import {
  StoreError,
  type AccountDecision,
  type CompleteResult,
  type ConsumedState,
  type Credentials,
  type DeletedToken,
  type DiscoveredAccount,
  type GmailStore,
  type PendingGrant,
  type ScannedItem,
  type StoredAlert,
} from '../_shared/store.ts'

// Distinctive values, so a leak anywhere is easy to spot.
export const SECRETS = {
  clientSecret: 'GOCSPX-client-secret-SENTINEL',
  serviceRoleKey: 'service-role-key-SENTINEL',
  encryptionKey: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7 + 3))),
}

export const APP = 'https://friday.example'

export const CONFIG: GmailConfig = {
  supabaseUrl: 'https://project.supabase.co',
  serviceRoleKey: SECRETS.serviceRoleKey,
  clientId: 'friday-test.apps.googleusercontent.com',
  clientSecret: SECRETS.clientSecret,
  redirectUri: 'https://project.supabase.co/functions/v1/gmail-oauth-callback',
  appUrl: APP,
  allowedOrigins: [APP],
  encryptionKey: SECRETS.encryptionKey,
  alertSenders: [...DEFAULT_ALERT_SENDERS],
  googleTestOrigin: null,
}

export const USERS = { a: 'aaaaaaaa-0000-4000-8000-000000000001', b: 'bbbbbbbb-0000-4000-8000-000000000002' }
export const SESSIONS: Record<string, string> = { 'session-a': USERS.a, 'session-b': USERS.b }

export function cipher(): Promise<TokenCipher> {
  return TokenCipher.fromBase64Key(SECRETS.encryptionKey)
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

interface StateRow { userId: string; verifier: string; browserHash: string; expiresAt: number; usedAt: number | null }
interface GrantRow { userId: string; email: string; scopes: string[]; enc: string; browserHash: string; expiresAt: number }
export interface FakeImportJob {
  userId: string
  months: string[]
  status: string
  truncated: boolean
  items: Map<string, ScannedItem | null>
  decisions: AccountDecision[]
}

export interface ConnectionRow {
  id: string
  userId: string
  email: string
  status: 'active' | 'needs_reconnect' | 'disconnected'
  lastErrorCode: string | null
  lastCheckedAt: number | null
}

export class MemoryStore implements GmailStore {
  now = Date.now()
  failNext: string | null = null
  readonly states = new Map<string, StateRow>()
  readonly grants = new Map<string, GrantRow>()
  readonly connections: ConnectionRow[] = []
  readonly credentials = new Map<string, { userId: string; enc: string }>()
  private nextId = 1

  private check(fn: string) {
    if (this.failNext === fn) {
      this.failNext = null
      throw new StoreError('database unavailable', '08006')
    }
  }

  advance(seconds: number) {
    this.now += seconds * 1000
  }

  /** As friday_private.gmail_account_live: any user's active connection with a credential. */
  accountLive(email: string): boolean {
    return this.connections.some((c) => c.email === email.toLowerCase() && c.status === 'active' && this.credentials.has(c.id))
  }

  begin(userId: string, stateHash: string, codeVerifier: string, browserHash: string) {
    this.check('begin')
    if (!/^[0-9a-f]{64}$/.test(stateHash)) throw new StoreError('bad hash', '23514')
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new StoreError('bad verifier', '23514')
    const open = [...this.states.values()].filter((s) => s.userId === userId && s.usedAt === null && s.expiresAt > this.now)
    if (open.length >= 5) {
      return Promise.reject(new StoreError('Too many Gmail connection attempts in progress. Try again in a few minutes.', 'P0001'))
    }
    this.states.set(stateHash, { userId, verifier: codeVerifier, browserHash, expiresAt: this.now + 600_000, usedAt: null })
    return Promise.resolve()
  }

  consume(stateHash: string) {
    this.check('consume')
    const state = this.states.get(stateHash)
    let result: ConsumedState
    if (!state) result = { outcome: 'unknown', userId: null, codeVerifier: null, browserHash: null }
    else if (state.usedAt !== null) result = { outcome: 'used', userId: null, codeVerifier: null, browserHash: null }
    else {
      state.usedAt = this.now
      result = state.expiresAt <= this.now
        ? { outcome: 'expired', userId: state.userId, codeVerifier: null, browserHash: null }
        : { outcome: 'ok', userId: state.userId, codeVerifier: state.verifier, browserHash: state.browserHash }
    }
    return Promise.resolve(result)
  }

  storePendingGrant(input: PendingGrant) {
    this.check('storePendingGrant')
    if (!input.refreshTokenEnc.startsWith('v1.')) throw new StoreError('raw token', '23514')
    this.grants.set(input.ticketHash, {
      userId: input.userId,
      email: input.accountEmail.toLowerCase(),
      scopes: input.scopes,
      enc: input.refreshTokenEnc,
      browserHash: input.browserHash,
      expiresAt: this.now + 600_000,
    })
    return Promise.resolve()
  }

  takeExpiredGrants(userId: string) {
    this.check('takeExpiredGrants')
    const out: string[] = []
    for (const [hash, grant] of this.grants) {
      if (grant.userId === userId && grant.expiresAt <= this.now) {
        if (!this.accountLive(grant.email)) out.push(grant.enc)
        this.grants.delete(hash)
      }
    }
    return Promise.resolve(out)
  }

  completeGrant(userId: string, ticketHash: string, browserHash: string): Promise<CompleteResult> {
    this.check('completeGrant')
    const none = { connectionId: null, accountEmail: null, refreshTokenEnc: null, replacedTokenEnc: null, ownerId: null }
    const grant = this.grants.get(ticketHash)
    if (!grant) return Promise.resolve({ outcome: 'unknown', ...none })
    this.grants.delete(ticketHash)
    const rejected = { ...none, refreshTokenEnc: this.accountLive(grant.email) ? null : grant.enc, ownerId: grant.userId }
    if (grant.userId !== userId) return Promise.resolve({ outcome: 'wrong_user', ...rejected })
    if (grant.expiresAt <= this.now) return Promise.resolve({ outcome: 'expired', ...rejected })
    if (grant.browserHash !== browserHash) return Promise.resolve({ outcome: 'wrong_browser', ...rejected })
    let replaced: string | null = null
    let live = this.connections.find((c) => c.userId === userId && c.status !== 'disconnected')
    if (live && live.email !== grant.email) {
      replaced = this.credentials.get(live.id)?.enc ?? null
      this.credentials.delete(live.id)
      live.status = 'disconnected'
      if (this.accountLive(live.email)) replaced = null
      live = undefined
    }
    if (live) {
      // Same Gmail account: overwrite, never hand back the old token.
      live.status = 'active'
      live.lastErrorCode = null
    } else {
      live = { id: `conn-${this.nextId++}`, userId, email: grant.email, status: 'active', lastErrorCode: null, lastCheckedAt: null }
      this.connections.push(live)
    }
    this.credentials.set(live.id, { userId, enc: grant.enc })
    return Promise.resolve({
      outcome: 'ok',
      connectionId: live.id,
      accountEmail: grant.email,
      refreshTokenEnc: null,
      replacedTokenEnc: replaced,
      ownerId: userId,
    })
  }

  getCredentials(userId: string): Promise<Credentials | null> {
    this.check('getCredentials')
    const live = this.connections.find((c) => c.userId === userId && c.status === 'active')
    const credential = live && this.credentials.get(live.id)
    return Promise.resolve(
      live && credential && credential.userId === userId
        ? { connectionId: live.id, accountEmail: live.email, refreshTokenEnc: credential.enc }
        : null,
    )
  }

  markNeedsReconnect(userId: string, connectionId: string, refreshTokenEnc: string, errorCode: string) {
    this.check('markNeedsReconnect')
    const credential = this.credentials.get(connectionId)
    if (!credential || credential.userId !== userId || credential.enc !== refreshTokenEnc) return Promise.resolve()
    this.credentials.delete(connectionId)
    const connection = this.connections.find((c) => c.id === connectionId && c.userId === userId && c.status !== 'disconnected')
    if (connection) {
      connection.status = 'needs_reconnect'
      connection.lastErrorCode = errorCode
    }
    return Promise.resolve()
  }

  recordCheck(userId: string, connectionId: string) {
    this.check('recordCheck')
    const connection = this.connections.find((c) => c.id === connectionId && c.userId === userId)
    if (connection) {
      connection.lastCheckedAt = this.now
      connection.lastErrorCode = null
    }
    return Promise.resolve()
  }

  disconnect(userId: string) {
    this.check('disconnect')
    const gone: { enc: string; email: string }[] = []
    for (const connection of this.connections) {
      if (connection.userId === userId && connection.status !== 'disconnected') connection.status = 'disconnected'
    }
    for (const [id, credential] of this.credentials) {
      if (credential.userId === userId) {
        gone.push({ enc: credential.enc, email: this.connections.find((c) => c.id === id)!.email })
        this.credentials.delete(id)
      }
    }
    for (const [hash, grant] of this.grants) {
      if (grant.userId === userId) {
        gone.push({ enc: grant.enc, email: grant.email })
        this.grants.delete(hash)
      }
    }
    const out: DeletedToken[] = gone.map(({ enc, email }) => ({ refreshTokenEnc: enc, revocable: !this.accountLive(email) }))
    for (const [hash, state] of this.states) if (state.userId === userId) this.states.delete(hash)
    return Promise.resolve(out)
  }

  // --- Importing (a simple model; the real rules are tested in SQL) ---------------

  readonly jobs = new Map<string, FakeImportJob>()

  private job(userId: string, jobId: string, states: string[]): FakeImportJob {
    const job = this.jobs.get(jobId)
    if (!job || job.userId !== userId) throw new StoreError('That import no longer exists', 'P0002')
    if (!states.includes(job.status)) throw new StoreError(`That import is ${job.status}, so it can't do that now`, '55000')
    return job
  }

  private alerts(job: FakeImportJob): StoredAlert[] {
    return [...job.items.values()].flatMap((item) => (item && 'alert' in item ? [item.alert] : []))
  }

  importBegin(userId: string, months: string[]) {
    this.check('importBegin')
    if (!this.connections.some((c) => c.userId === userId && c.status === 'active')) {
      return Promise.reject(new StoreError('Connect Gmail first', '55000'))
    }
    if ([...this.jobs.values()].some((j) => j.userId === userId && ['listing', 'scanning', 'confirm_accounts', 'importing'].includes(j.status))) {
      return Promise.reject(new StoreError('An import is already in progress', '55000'))
    }
    const jobId = crypto.randomUUID()
    const sorted = [...new Set(months)].sort()
    this.jobs.set(jobId, { userId, months: sorted, status: 'listing', truncated: false, items: new Map(), decisions: [] })
    return Promise.resolve({
      jobId,
      ranges: sorted.map((month) => {
        const [y, m] = month.split('-').map(Number)
        return { month, start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Math.min(Date.UTC(y, m, 1), this.now)) }
      }),
    })
  }

  importAddMessages(userId: string, jobId: string, messageIds: string[], truncated: boolean) {
    const job = this.job(userId, jobId, ['listing'])
    for (const id of messageIds) job.items.set(id, null)
    job.truncated = truncated
    job.status = job.items.size === 0 ? 'done' : 'scanning'
    return Promise.resolve(job.items.size)
  }

  importPending(userId: string, jobId: string, limit: number) {
    const job = this.job(userId, jobId, ['scanning'])
    const messageIds = [...job.items.entries()].filter(([, v]) => v === null).map(([k]) => k).slice(0, limit)
    return Promise.resolve({ messageIds, timeZone: 'Asia/Kolkata' })
  }

  importSave(userId: string, jobId: string, items: ScannedItem[]) {
    const job = this.job(userId, jobId, ['scanning'])
    for (const item of items) if (job.items.get(item.messageId) === null) job.items.set(item.messageId, item)
    const pending = [...job.items.values()].filter((v) => v === null).length
    if (pending === 0) job.status = this.alerts(job).length > 0 ? 'confirm_accounts' : 'done'
    return Promise.resolve({ scanned: job.items.size - pending, total: job.items.size, status: job.status })
  }

  importAccounts(userId: string, jobId: string): Promise<DiscoveredAccount[]> {
    const job = this.job(userId, jobId, ['confirm_accounts', 'importing', 'done'])
    const groups = new Map<string, DiscoveredAccount>()
    for (const alert of this.alerts(job)) {
      const key = `${alert.institutionKey}/${alert.instrument}/${alert.accountMask ?? ''}`
      const group = groups.get(key) ?? {
        institutionKey: alert.institutionKey,
        institutionName: alert.institutionName,
        instrument: alert.instrument,
        accountMask: alert.accountMask ?? '',
        messages: 0,
        firstAt: alert.occurredAt,
        lastAt: alert.occurredAt,
        linkedAccountId: null,
        linkedIgnored: false,
        suggestedAccountId: null,
        suggestedName: `${alert.institutionName}${alert.accountMask ? ` ••${alert.accountMask}` : ''}`,
        suggestedType: alert.instrument === 'credit_card' ? 'credit_card' : alert.instrument === 'wallet' ? 'wallet' : alert.instrument === 'unknown' ? null : 'bank',
      }
      group.messages++
      groups.set(key, group)
    }
    return Promise.resolve([...groups.values()])
  }

  async importApplyAccounts(userId: string, jobId: string, decisions: AccountDecision[]) {
    const job = this.job(userId, jobId, ['confirm_accounts'])
    for (const group of await this.importAccounts(userId, jobId)) {
      const found = decisions.find((d) => d.institutionKey === group.institutionKey && d.instrument === group.instrument && d.accountMask === group.accountMask)
      if (!found) throw new StoreError(`Choose what to do with ${group.institutionName}`, '22023')
    }
    job.decisions = decisions
    job.status = 'importing'
    return { created: decisions.filter((d) => d.action === 'create').length, linked: decisions.filter((d) => d.action === 'link').length, kept: 0 }
  }

  importRun(userId: string, jobId: string, _limit: number) {
    const job = this.job(userId, jobId, ['importing'])
    job.status = 'done'
    return Promise.resolve({ processed: this.alerts(job).length, remaining: 0, status: 'done' })
  }

  importUndo(userId: string, jobId: string) {
    const job = this.job(userId, jobId, ['done'])
    job.status = 'undone'
    return Promise.resolve({ removed: this.alerts(job).length, kept: 0 })
  }

  importCancel(userId: string, jobId: string) {
    const job = this.job(userId, jobId, ['listing', 'scanning', 'confirm_accounts'])
    job.status = 'cancelled'
    job.items.clear()
    return Promise.resolve()
  }

  importFail(userId: string, jobId: string, _errorCode: string) {
    const job = this.job(userId, jobId, ['listing', 'scanning'])
    job.status = 'failed'
    return Promise.resolve()
  }

  /** Every value stored anywhere, for secrecy checks. */
  dump(): string {
    return JSON.stringify({
      states: [...this.states.entries()],
      grants: [...this.grants.entries()],
      connections: this.connections,
      credentials: [...this.credentials.entries()],
      jobs: [...this.jobs.entries()].map(([id, job]) => [id, { ...job, items: [...job.items.entries()] }]),
    })
  }
}

// -----------------------------------------------------------------------------
// Google
// -----------------------------------------------------------------------------

export interface Mail {
  id: string
  from: string
  subject: string
  snippet: string
  body: string
  internalDate: string
  /** Send the body as HTML (else plain text). */
  html?: boolean
  /** Authentication-Results header; default: DKIM pass for the sender's domain. */
  auth?: string
}

function utf8Base64Url(text: string): string {
  return toBase64Url(new TextEncoder().encode(text))
}

interface IssuedCode {
  challenge: string
  redirectUri: string
  scope: string
  email: string
  used: boolean
}

export interface ConsentOptions {
  email?: string
  /** What the person left ticked on Google's granular consent screen. */
  scope?: string
  deny?: boolean
}

export interface RecordedRequest {
  method: string
  url: URL
  body: URLSearchParams | null
  authorization: string | null
}

let counter = 0
const unique = (prefix: string) => `${prefix}-${++counter}-${crypto.randomUUID().slice(0, 8)}`

export class FakeGoogle {
  readonly requests: RecordedRequest[] = []
  readonly codes = new Map<string, IssuedCode>()
  /** refresh token → owner mailbox */
  readonly refreshTokens = new Map<string, string>()
  readonly accessTokens = new Map<string, string>()
  readonly revoked = new Set<string>()
  /** Every token value Google ever issued (for secrecy checks). */
  readonly issued: string[] = []
  readonly mailboxes = new Map<string, Mail[]>()
  omitRefreshToken = false
  /** Path fragment → canned response for the next matching request. */
  readonly failures = new Map<string, { status: number; body?: unknown }>()

  issue(prefix: string) {
    const token = unique(prefix)
    this.issued.push(token)
    return token
  }

  /** The person approves (or denies) on Google's consent page; returns the callback URL Google redirects to. */
  async consent(authorizationUrl: string, options: ConsentOptions = {}): Promise<string> {
    const url = new URL(authorizationUrl)
    const params = url.searchParams
    const back = new URL(params.get('redirect_uri')!)
    back.searchParams.set('state', params.get('state')!)
    if (options.deny) {
      back.searchParams.set('error', 'access_denied')
      return back.toString()
    }
    const code = this.issue('4/auth-code')
    this.codes.set(code, {
      challenge: params.get('code_challenge')!,
      redirectUri: params.get('redirect_uri')!,
      scope: options.scope ?? params.get('scope')!,
      email: options.email ?? 'person@gmail.com',
      used: false,
    })
    back.searchParams.set('code', code)
    back.searchParams.set('scope', options.scope ?? params.get('scope')!)
    return await Promise.resolve(back.toString())
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    const body = init?.body instanceof URLSearchParams ? init.body : init?.body ? new URLSearchParams(String(init.body)) : null
    const headers = new Headers(init?.headers)
    this.requests.push({ method, url, body, authorization: headers.get('authorization') })

    for (const [fragment, failure] of this.failures) {
      if (url.pathname.includes(fragment)) {
        this.failures.delete(fragment)
        return Response.json(failure.body ?? { error: 'backend_error' }, { status: failure.status })
      }
    }

    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') return await this.token(body!)
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/revoke') {
      const token = body?.get('token') ?? ''
      if (!this.refreshTokens.has(token) && !this.accessTokens.has(token)) return Response.json({ error: 'invalid_token' }, { status: 400 })
      // Like Google: revoking any token ends the app's whole grant for that
      // account — every refresh and access token issued so far.
      const owner = this.refreshTokens.get(token) ?? this.accessTokens.get(token)
      for (const [issued, mailbox] of [...this.refreshTokens, ...this.accessTokens]) if (mailbox === owner) this.revoked.add(issued)
      return new Response(null, { status: 200 })
    }
    if (url.origin === 'https://gmail.googleapis.com') return this.gmail(url, headers.get('authorization'))
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  private async token(body: URLSearchParams): Promise<Response> {
    if (body.get('client_id') !== CONFIG.clientId || body.get('client_secret') !== CONFIG.clientSecret) {
      return Response.json({ error: 'invalid_client' }, { status: 401 })
    }
    if (body.get('grant_type') === 'authorization_code') {
      const issued = this.codes.get(body.get('code') ?? '')
      if (!issued || issued.used) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      issued.used = true
      if (issued.redirectUri !== body.get('redirect_uri')) return Response.json({ error: 'redirect_uri_mismatch' }, { status: 400 })
      if ((await pkceChallenge(body.get('code_verifier') ?? '')) !== issued.challenge) {
        return Response.json({ error: 'invalid_grant', error_description: 'PKCE' }, { status: 400 })
      }
      const accessToken = this.issue('ya29.access')
      this.accessTokens.set(accessToken, issued.email)
      const response: Record<string, unknown> = { access_token: accessToken, expires_in: 3599, scope: issued.scope, token_type: 'Bearer' }
      if (!this.omitRefreshToken) {
        const refreshToken = this.issue('1//refresh')
        this.refreshTokens.set(refreshToken, issued.email)
        response.refresh_token = refreshToken
      }
      return Response.json(response)
    }
    if (body.get('grant_type') === 'refresh_token') {
      const token = body.get('refresh_token') ?? ''
      const mailbox = this.refreshTokens.get(token)
      if (!mailbox || this.revoked.has(token)) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      const accessToken = this.issue('ya29.access')
      this.accessTokens.set(accessToken, mailbox)
      return Response.json({ access_token: accessToken, expires_in: 3599, scope: GMAIL_READONLY_SCOPE })
    }
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
  }

  private gmail(url: URL, authorization: string | null): Response {
    const token = authorization?.replace(/^Bearer /, '') ?? ''
    const mailbox = this.accessTokens.get(token)
    if (!mailbox || this.revoked.has(token)) return Response.json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, { status: 401 })
    const mail = this.mailboxes.get(mailbox) ?? []
    const path = url.pathname.replace('/gmail/v1/users/me', '')
    if (path === '/profile') return Response.json({ emailAddress: mailbox })
    if (path === '/messages') {
      const max = Number(url.searchParams.get('maxResults') ?? 100)
      // Like Gmail, from: matching is loose: return everything in the dates
      // asked for (after:/before: in epoch seconds), newest first, and let Friday filter.
      const q = url.searchParams.get('q') ?? ''
      const after = Number(q.match(/\bafter:(\d+)/)?.[1] ?? 0) * 1000
      const before = Number(q.match(/\bbefore:(\d+)/)?.[1] ?? Infinity) * 1000
      const matching = mail
        .filter((m) => Number(m.internalDate) >= after && Number(m.internalDate) < before)
        .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
      const offset = Number(url.searchParams.get('pageToken') ?? 0)
      const page = matching.slice(offset, offset + max)
      return Response.json({
        messages: page.map((m) => ({ id: m.id, threadId: m.id })),
        resultSizeEstimate: matching.length,
        ...(offset + max < matching.length ? { nextPageToken: String(offset + max) } : {}),
      })
    }
    const message = mail.find((m) => `/messages/${m.id}` === path)
    if (!message) return Response.json({ error: { code: 404 } }, { status: 404 })
    // A real Gmail response honours `fields`; this fake returns everything it
    // was asked for and the body only when no field mask restricts it.
    const full = {
      id: message.id,
      threadId: message.id,
      internalDate: message.internalDate,
      snippet: message.snippet,
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: message.from },
          { name: 'Subject', value: message.subject },
          { name: 'Date', value: new Date(Number(message.internalDate)).toUTCString() },
          {
            name: 'Authentication-Results',
            value: message.auth ?? `mx.google.com; dkim=pass header.i=@${message.from.match(/@([^>\s]+)/)?.[1] ?? ''}; spf=pass`,
          },
        ],
        parts: [{ mimeType: message.html ? 'text/html' : 'text/plain', body: { data: utf8Base64Url(message.body) } }],
      },
    }
    if (url.searchParams.get('format') === 'metadata' && url.searchParams.get('fields')) {
      return Response.json({ id: full.id, internalDate: full.internalDate, snippet: full.snippet, payload: { headers: full.payload.headers } })
    }
    return Response.json(full)
  }
}

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

export function captureLog(): { log: Logger; lines: { event: string; fields: LogFields }[] } {
  const lines: { event: string; fields: LogFields }[] = []
  return { lines, log: (event, fields = {}) => lines.push({ event, fields }) }
}
