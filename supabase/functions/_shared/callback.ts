// gmail-oauth-callback: where Google sends the browser after consent.
// GET ?code&state (or ?error&state). Validates the one-time state, exchanges
// the code server-side with the client secret and PKCE verifier, checks the
// granted scope, encrypts the refresh token and parks it until the same
// signed-in user, in the same browser, confirms it in Friday.
//
// Tokens it can't keep (wrong scope, no refresh token, a failure) are dropped,
// not revoked: they never left this function, so nobody holds them, and
// revoking with Google would end every Friday connection to that Gmail
// account — possibly one that's working. Always ends with a redirect to
// FRIDAY_APP_URL/connections/gmail (#ticket=… or ?gmail_error=<code>) — never a
// page that shows a code or token.

import type { GmailConfig } from './config.ts'
import { isToken, randomToken, refreshTokenContext, sha256Hex, type TokenCipher } from './crypto.ts'
import { exchangeCode, getGmailAddress, GMAIL_READONLY_SCOPE, GoogleError, googleEndpoints, type Fetch } from './google.ts'
import { json, redirect, type Logger } from './http.ts'
import type { GmailStore } from './store.ts'

export interface CallbackDeps {
  config: GmailConfig
  store: GmailStore
  cipher: TokenCipher
  fetch: Fetch
  log: Logger
}

export const CONNECTIONS_PATH = '/connections/gmail'

/** Error codes the app turns into words (src/pages/GmailConnection.tsx). */
export type CallbackError =
  | 'access_denied'
  | 'google_error'
  | 'invalid_request'
  | 'invalid_state'
  | 'link_expired'
  | 'link_used'
  | 'exchange_failed'
  | 'scope_missing'
  | 'no_refresh_token'
  | 'profile_failed'
  | 'server_error'

export async function handleCallback(req: Request, deps: CallbackDeps): Promise<Response> {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' })
  const url = new URL(req.url)
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  const googleError = url.searchParams.get('error')
  const endpoints = googleEndpoints(deps.config.googleTestOrigin)

  const back = (params: Record<string, string>, { inFragment = false } = {}) => {
    const target = new URL(CONNECTIONS_PATH, deps.config.appUrl)
    const query = new URLSearchParams(params).toString()
    if (inFragment) target.hash = query
    else target.search = query
    return redirect(target.toString())
  }
  const fail = (reason: CallbackError) => {
    deps.log('gmail_callback_failed', { reason })
    return back({ gmail_error: reason })
  }

  if (!isToken(state)) return fail(state ? 'invalid_state' : 'invalid_request')

  try {
    // Used up even when Google reports an error, so it can never be replayed.
    const consumed = await deps.store.consume(await sha256Hex(state))
    if (consumed.outcome === 'expired') return fail('link_expired')
    if (consumed.outcome === 'used') return fail('link_used')
    if (consumed.outcome !== 'ok' || !consumed.userId || !consumed.codeVerifier || !consumed.browserHash) return fail('invalid_state')
    const userId = consumed.userId

    if (googleError) return fail(googleError === 'access_denied' ? 'access_denied' : 'google_error')
    if (!code || code.length > 2048) return fail('invalid_request')

    let grant
    try {
      grant = await exchangeCode(deps.fetch, endpoints, {
        clientId: deps.config.clientId,
        clientSecret: deps.config.clientSecret,
        redirectUri: deps.config.redirectUri,
        code,
        codeVerifier: consumed.codeVerifier,
      })
    } catch (error) {
      if (error instanceof GoogleError) deps.log('gmail_token_exchange_failed', { failure: error.failure, status: error.status })
      return fail('exchange_failed')
    }

    // Granular consent lets people untick the Gmail box: then there's nothing to connect.
    if (!grant.scopes.includes(GMAIL_READONLY_SCOPE)) return fail('scope_missing')
    if (!grant.refreshToken) return fail('no_refresh_token')

    let accountEmail: string
    try {
      accountEmail = await getGmailAddress(deps.fetch, endpoints, grant.accessToken)
    } catch {
      return fail('profile_failed')
    }

    const ticket = randomToken(32)
    await deps.store.storePendingGrant({
      userId,
      ticketHash: await sha256Hex(ticket),
      accountEmail,
      // Friday keeps exactly the scope it asked for.
      scopes: [GMAIL_READONLY_SCOPE],
      refreshTokenEnc: await deps.cipher.encrypt(grant.refreshToken, refreshTokenContext(userId)),
      browserHash: consumed.browserHash,
    })
    deps.log('gmail_callback_ok', { outcome: 'pending_confirmation' })
    // In the fragment: browsers never send it to a server, a log or a Referer.
    return back({ ticket }, { inFragment: true })
  } catch {
    return fail('server_error')
  }
}
