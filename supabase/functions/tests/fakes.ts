// Test doubles for the Gmail functions: an in-memory store with the same rules
// as the SQL functions in migration 20261021000000_gmail_connection.sql, and a
// fake Google (OAuth + Gmail API) behind an injectable fetch. Nothing here
// talks to a network.

import type { GmailConfig } from '../_shared/config.ts'
import { pkceChallenge, TokenCipher } from '../_shared/crypto.ts'
import { DEFAULT_ALERT_SENDERS } from '../_shared/gmailQuery.ts'
import { GMAIL_READONLY_SCOPE } from '../_shared/google.ts'
import type { LogFields, Logger } from '../_shared/http.ts'
import { StoreError, type CompleteResult, type ConsumeOutcome, type Credentials, type GmailStore } from '../_shared/store.ts'

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

interface StateRow { userId: string; verifier: string; expiresAt: number; usedAt: number | null }
interface GrantRow { userId: string; email: string; scopes: string[]; enc: string; expiresAt: number }
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

  begin(userId: string, stateHash: string, codeVerifier: string) {
    this.check('begin')
    if (!/^[0-9a-f]{64}$/.test(stateHash)) throw new StoreError('bad hash', '23514')
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new StoreError('bad verifier', '23514')
    const open = [...this.states.values()].filter((s) => s.userId === userId && s.usedAt === null && s.expiresAt > this.now)
    if (open.length >= 5) {
      return Promise.reject(new StoreError('Too many Gmail connection attempts in progress. Try again in a few minutes.', 'P0001'))
    }
    this.states.set(stateHash, { userId, verifier: codeVerifier, expiresAt: this.now + 600_000, usedAt: null })
    return Promise.resolve()
  }

  consume(stateHash: string) {
    this.check('consume')
    const state = this.states.get(stateHash)
    let result: { outcome: ConsumeOutcome; userId: string | null; codeVerifier: string | null }
    if (!state) result = { outcome: 'unknown', userId: null, codeVerifier: null }
    else if (state.usedAt !== null) result = { outcome: 'used', userId: null, codeVerifier: null }
    else {
      state.usedAt = this.now
      result = state.expiresAt <= this.now
        ? { outcome: 'expired', userId: state.userId, codeVerifier: null }
        : { outcome: 'ok', userId: state.userId, codeVerifier: state.verifier }
    }
    return Promise.resolve(result)
  }

  storePendingGrant(input: { userId: string; ticketHash: string; accountEmail: string; scopes: string[]; refreshTokenEnc: string }) {
    this.check('storePendingGrant')
    if (!input.refreshTokenEnc.startsWith('v1.')) throw new StoreError('raw token', '23514')
    this.grants.set(input.ticketHash, {
      userId: input.userId,
      email: input.accountEmail.toLowerCase(),
      scopes: input.scopes,
      enc: input.refreshTokenEnc,
      expiresAt: this.now + 600_000,
    })
    return Promise.resolve()
  }

  takeExpiredGrants(userId: string) {
    this.check('takeExpiredGrants')
    const out: string[] = []
    for (const [hash, grant] of this.grants) {
      if (grant.userId === userId && grant.expiresAt <= this.now) {
        out.push(grant.enc)
        this.grants.delete(hash)
      }
    }
    return Promise.resolve(out)
  }

  completeGrant(userId: string, ticketHash: string): Promise<CompleteResult> {
    this.check('completeGrant')
    const none = { connectionId: null, accountEmail: null, refreshTokenEnc: null, replacedTokenEnc: null, ownerId: null }
    const grant = this.grants.get(ticketHash)
    if (!grant) return Promise.resolve({ outcome: 'unknown', ...none })
    this.grants.delete(ticketHash)
    if (grant.userId !== userId) {
      return Promise.resolve({ outcome: 'wrong_user', ...none, refreshTokenEnc: grant.enc, ownerId: grant.userId })
    }
    if (grant.expiresAt <= this.now) {
      return Promise.resolve({ outcome: 'expired', ...none, refreshTokenEnc: grant.enc, ownerId: grant.userId })
    }
    let replaced: string | null = null
    let live = this.connections.find((c) => c.userId === userId && c.status !== 'disconnected')
    if (live && live.email !== grant.email) {
      replaced = this.credentials.get(live.id)?.enc ?? null
      this.credentials.delete(live.id)
      live.status = 'disconnected'
      live = undefined
    }
    if (live) {
      replaced = this.credentials.get(live.id)?.enc ?? null
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

  markNeedsReconnect(userId: string, connectionId: string, errorCode: string) {
    this.check('markNeedsReconnect')
    const connection = this.connections.find((c) => c.id === connectionId && c.userId === userId && c.status !== 'disconnected')
    if (this.credentials.get(connectionId)?.userId === userId) this.credentials.delete(connectionId)
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
    const out: string[] = []
    for (const connection of this.connections) {
      if (connection.userId === userId && connection.status !== 'disconnected') connection.status = 'disconnected'
    }
    for (const [id, credential] of this.credentials) {
      if (credential.userId === userId) {
        out.push(credential.enc)
        this.credentials.delete(id)
      }
    }
    for (const [hash, grant] of this.grants) {
      if (grant.userId === userId) {
        out.push(grant.enc)
        this.grants.delete(hash)
      }
    }
    for (const [hash, state] of this.states) if (state.userId === userId) this.states.delete(hash)
    return Promise.resolve(out)
  }

  /** Every value stored anywhere, for secrecy checks. */
  dump(): string {
    return JSON.stringify({
      states: [...this.states.entries()],
      grants: [...this.grants.entries()],
      connections: this.connections,
      credentials: [...this.credentials.entries()],
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
      this.revoked.add(token)
      // Revoking a refresh token also ends the access tokens issued from it.
      const owner = this.refreshTokens.get(token)
      for (const [access, mailbox] of this.accessTokens) if (mailbox === owner) this.revoked.add(access)
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
      // Like Gmail, from: matching is loose: return everything and let Friday filter.
      return Response.json({ messages: mail.slice(0, max).map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: mail.length })
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
        headers: [
          { name: 'From', value: message.from },
          { name: 'Subject', value: message.subject },
          { name: 'Date', value: new Date(Number(message.internalDate)).toUTCString() },
        ],
        body: { data: btoa(message.body) },
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
