// gmail-connection: everything a signed-in Friday user does with their Gmail
// connection. POST { action } with the user's Supabase access token.
//   start       → { url, browserKey }: Google's consent page (authorization
//                 code + PKCE), and a key this browser keeps for `complete`
//   complete    → { connection }: activates a grant the callback parked, only
//                 for the same signed-in user, in the same browser, who started it
//   disconnect  → { disconnected, revoked }: deletes credentials, revokes them
//   test-fetch  → { query, messages }: a few recent alert emails' metadata;
//                 nothing is stored and no transaction is created

import type { GmailConfig } from './config.ts'
import { isToken, pkceChallenge, randomToken, refreshTokenContext, sha256Hex, type TokenCipher } from './crypto.ts'
import { buildAlertQuery, headerValue, senderAllowed } from './gmailQuery.ts'
import {
  buildAuthorizationUrl,
  getMessageMetadata,
  GoogleError,
  googleEndpoints,
  listMessageIds,
  refreshAccessToken,
  revokeToken,
  type Fetch,
} from './google.ts'
import { corsHeaders, json, type Logger } from './http.ts'
import { StoreError, type GmailStore } from './store.ts'

export interface ConnectionDeps {
  config: GmailConfig
  store: GmailStore
  cipher: TokenCipher
  /** Resolves a Supabase access token to its user id, or null when invalid. */
  authenticate: (accessToken: string) => Promise<string | null>
  fetch: Fetch
  log: Logger
}

export const TEST_FETCH_DEFAULT = 5
export const TEST_FETCH_MAX = 20

type Action = 'start' | 'complete' | 'disconnect' | 'test-fetch'
const ACTIONS: readonly Action[] = ['start', 'complete', 'disconnect', 'test-fetch']

export async function handleConnection(req: Request, deps: ConnectionDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get('origin'), deps.config.allowedOrigins)
  const reply = (status: number, body: unknown) => json(status, body, cors)

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' })
  // Browsers must come from Friday itself (server-to-server calls send no Origin).
  const origin = req.headers.get('origin')
  if (origin && !deps.config.allowedOrigins.includes(origin)) return reply(403, { error: 'origin_not_allowed' })

  const token = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  const userId = token ? await deps.authenticate(token).catch(() => null) : null
  if (!userId) return reply(401, { error: 'not_signed_in', message: 'Sign in to Friday first.' })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return reply(400, { error: 'bad_request', message: 'Expected a JSON body.' })
  }
  const action = body?.action as Action
  if (!ACTIONS.includes(action)) return reply(400, { error: 'unknown_action', message: 'Unknown action.' })

  try {
    switch (action) {
      case 'start':
        return reply(200, await start(userId, deps))
      case 'complete':
        return await complete(userId, body.ticket, body.browserKey, deps, reply)
      case 'disconnect':
        return reply(200, await disconnect(userId, deps))
      case 'test-fetch':
        return await testFetch(userId, body, deps, reply)
    }
  } catch (error) {
    if (error instanceof StoreError && error.code === 'P0001') {
      deps.log('gmail_connection_failed', { action, reason: 'rate_limited' })
      return reply(429, { error: 'too_many_attempts', message: error.message })
    }
    if (error instanceof GoogleError && error.failure === 'invalid_client') {
      // Friday's own Google settings are wrong; nobody's connection is touched.
      deps.log('gmail_connection_failed', { action, failure: error.failure, status: error.status })
      return reply(503, { error: 'not_configured', message: 'Friday’s Google settings need fixing on the server. Nothing was changed.' })
    }
    if (error instanceof GoogleError) {
      deps.log('gmail_connection_failed', { action, failure: error.failure, status: error.status })
      return reply(502, { error: 'google_unavailable', message: 'Gmail didn’t respond properly. Try again in a minute.' })
    }
    deps.log('gmail_connection_failed', { action, reason: 'internal' })
    return reply(500, { error: 'internal', message: 'Something went wrong on Friday’s server.' })
  }
}

/**
 * Revokes tokens with Google. Only ever pass tokens the database said are safe
 * to revoke: Google ends the whole grant for that Gmail account.
 */
async function revokeSealed(sealedTokens: (string | null)[], ownerId: string, deps: ConnectionDeps): Promise<boolean> {
  const endpoints = googleEndpoints(deps.config.googleTestOrigin)
  let all = true
  for (const sealed of sealedTokens) {
    if (!sealed) continue
    try {
      const token = await deps.cipher.decrypt(sealed, refreshTokenContext(ownerId))
      if (!(await revokeToken(deps.fetch, endpoints, token))) all = false
    } catch {
      all = false
    }
  }
  return all
}

async function start(userId: string, deps: ConnectionDeps) {
  // Grants nobody came back to confirm still hold live tokens: revoke them.
  const abandoned = await deps.store.takeExpiredGrants(userId)
  if (abandoned.length > 0) await revokeSealed(abandoned, userId, deps)

  const state = randomToken(32)
  const verifier = randomToken(48)
  // Kept by the app in this browser and required to complete: an approval
  // that comes back to a different browser (e.g. a link someone sent you)
  // can't be attached, even if it's signed in to the same Friday account.
  const browserKey = randomToken(32)
  await deps.store.begin(userId, await sha256Hex(state), verifier, await sha256Hex(browserKey))
  const url = buildAuthorizationUrl(googleEndpoints(deps.config.googleTestOrigin), {
    clientId: deps.config.clientId,
    redirectUri: deps.config.redirectUri,
    state,
    codeChallenge: await pkceChallenge(verifier),
  })
  deps.log('gmail_oauth_started', { action: 'start' })
  return { url, browserKey }
}

async function complete(
  userId: string,
  ticket: unknown,
  browserKey: unknown,
  deps: ConnectionDeps,
  reply: (status: number, body: unknown) => Response,
) {
  if (!isToken(ticket)) return reply(400, { error: 'bad_ticket', message: 'That connection link isn’t valid.' })
  // A missing key still uses up the ticket (as a browser mismatch), so the parked grant goes.
  const browserHash = await sha256Hex(isToken(browserKey) ? browserKey : '')
  const result = await deps.store.completeGrant(userId, await sha256Hex(ticket), browserHash)

  if (result.outcome === 'ok') {
    if (result.replacedTokenEnc) await revokeSealed([result.replacedTokenEnc], userId, deps)
    deps.log('gmail_connected', { action: 'complete', outcome: 'ok' })
    return reply(200, { connection: { id: result.connectionId, accountEmail: result.accountEmail, status: 'active' } })
  }

  // Anything else: the parked token is already deleted; revoke it with Google
  // unless a live connection uses that Gmail account (then it's simply dropped).
  const revoked = result.refreshTokenEnc && result.ownerId ? await revokeSealed([result.refreshTokenEnc], result.ownerId, deps) : false
  deps.log('gmail_connect_rejected', { action: 'complete', outcome: result.outcome, revoked })
  if (result.outcome === 'wrong_user') {
    return reply(403, {
      error: 'wrong_user',
      message: 'This Gmail approval was started from a different Friday account, so it wasn’t connected.',
    })
  }
  if (result.outcome === 'wrong_browser') {
    return reply(403, {
      error: 'wrong_browser',
      message: 'This Gmail approval was started in a different browser or app, so it wasn’t connected. Start again here.',
    })
  }
  if (result.outcome === 'expired') {
    return reply(410, { error: 'expired', message: 'That approval took too long. Connect Gmail again.' })
  }
  return reply(404, { error: 'unknown_ticket', message: 'That approval was already used or doesn’t exist.' })
}

async function disconnect(userId: string, deps: ConnectionDeps) {
  // Credentials are deleted first; revoking with Google is best effort after.
  // A token another live connection relies on (the same Gmail account, in
  // another Friday account) is deleted but not revoked.
  const deleted = await deps.store.disconnect(userId)
  const revocable = deleted.filter((token) => token.revocable).map((token) => token.refreshTokenEnc)
  const revoked = (await revokeSealed(revocable, userId, deps)) && revocable.length === deleted.length
  deps.log('gmail_disconnected', { action: 'disconnect', count: deleted.length, revoked })
  return { disconnected: true, revoked, removed: deleted.length }
}

async function testFetch(
  userId: string,
  body: Record<string, unknown>,
  deps: ConnectionDeps,
  reply: (status: number, body: unknown) => Response,
) {
  const credentials = await deps.store.getCredentials(userId)
  if (!credentials) {
    return reply(409, { error: 'not_connected', message: 'Gmail isn’t connected.' })
  }
  const limit = Math.min(Math.max(Math.trunc(Number(body.limit)) || TEST_FETCH_DEFAULT, 1), TEST_FETCH_MAX)
  const lookbackDays = Math.trunc(Number(body.lookbackDays)) || 30
  const endpoints = googleEndpoints(deps.config.googleTestOrigin)

  let refreshToken: string
  try {
    refreshToken = await deps.cipher.decrypt(credentials.refreshTokenEnc, refreshTokenContext(userId))
  } catch {
    // A wrong encryption key (a server setting) or a damaged row: keep the
    // credential — deleting it would lose access that may still be valid.
    deps.log('gmail_connection_failed', { action: 'test-fetch', reason: 'decrypt_failed' })
    return reply(409, {
      error: 'credential_unreadable',
      message: 'Friday can’t read its stored Gmail access. Connect Gmail again to replace it.',
    })
  }

  let accessToken: string
  try {
    accessToken = await refreshAccessToken(deps.fetch, endpoints, {
      clientId: deps.config.clientId,
      clientSecret: deps.config.clientSecret,
      refreshToken,
    })
  } catch (error) {
    if (!(error instanceof GoogleError && error.failure === 'invalid_grant')) throw error
    // Revoked at Google or expired: this credential is useless.
    await deps.store.markNeedsReconnect(userId, credentials.connectionId, credentials.refreshTokenEnc, 'invalid_grant')
    deps.log('gmail_needs_reconnect', { action: 'test-fetch', reason: 'invalid_grant' })
    return reply(409, { error: 'needs_reconnect', message: 'Google no longer accepts Friday’s access. Connect Gmail again.' })
  }

  const query = buildAlertQuery(deps.config.alertSenders, lookbackDays)
  const { ids, estimate } = await listMessageIds(deps.fetch, endpoints, accessToken, query, limit)
  const metadata = await Promise.all(ids.map((id) => getMessageMetadata(deps.fetch, endpoints, accessToken, id)))
  const messages = metadata
    .map((message) => ({
      id: message.id,
      receivedAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
      from: headerValue(message.headers, 'From'),
      subject: headerValue(message.headers, 'Subject'),
      snippet: message.snippet,
    }))
    // Gmail's from: search is broad; only allowlisted senders are returned.
    .filter((message) => senderAllowed(message.from, deps.config.alertSenders))

  await deps.store.recordCheck(userId, credentials.connectionId)
  deps.log('gmail_test_fetch', { action: 'test-fetch', count: messages.length })
  return reply(200, { query, estimate, messages, recorded: false })
}
