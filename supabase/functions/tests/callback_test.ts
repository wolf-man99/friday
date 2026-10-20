// gmail-oauth-callback: OAuth state validation and every way the callback can
// fail. Each failure must end on Friday's connection page with a short error
// code, store nothing, and revoke anything Google already issued.

import assert from 'node:assert/strict'
import { randomToken, refreshTokenContext, sha256Hex } from '../_shared/crypto.ts'
import { GMAIL_READONLY_SCOPE } from '../_shared/google.ts'
import { APP, CONFIG, USERS } from './fakes.ts'
import { setup } from './harness.ts'

const CALLBACK = CONFIG.redirectUri

function errorOf(response: Response): string | null {
  assert.equal(response.status, 303, 'the callback always redirects')
  const location = new URL(response.headers.get('location')!)
  assert.equal(location.origin + location.pathname, `${APP}/connections/gmail`, 'back to Friday’s connection page')
  return location.searchParams.get('gmail_error')
}

Deno.test('a valid round trip parks an encrypted grant for the user who started it', async () => {
  const h = await setup()
  const { redirected, location, ticket, callbackUrl } = await h.authorize('session-a', { email: 'Asha@Gmail.com' })

  assert.equal(redirected.status, 303)
  assert.equal(redirected.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(redirected.headers.get('cache-control'), 'no-store')
  assert.equal(location.search, '', 'no query string: the ticket travels in the fragment only')
  assert.match(ticket ?? '', /^[A-Za-z0-9_-]{43}$/)
  assert.ok(!location.href.includes(new URL(callbackUrl).searchParams.get('code')!), 'the authorization code never reaches the app')

  const [grant] = [...h.store.grants.values()]
  assert.equal(h.store.grants.size, 1)
  assert.equal(grant.userId, USERS.a)
  assert.equal(grant.email, 'asha@gmail.com')
  assert.deepEqual(grant.scopes, [GMAIL_READONLY_SCOPE])
  assert.ok(h.store.grants.has(await sha256Hex(ticket!)), 'only the ticket’s hash is stored')
  // Sealed with the owner's id: decrypts for A, not for B.
  const refresh = await h.cipher.decrypt(grant.enc, refreshTokenContext(USERS.a))
  assert.ok(h.google.refreshTokens.has(refresh))
  await assert.rejects(h.cipher.decrypt(grant.enc, refreshTokenContext(USERS.b)))

  // The code was exchanged server-side with the client secret and the PKCE verifier.
  const exchange = h.google.requests.find((r) => r.url.pathname === '/token')!
  assert.equal(exchange.body?.get('grant_type'), 'authorization_code')
  assert.equal(exchange.body?.get('client_secret'), CONFIG.clientSecret)
  assert.equal(exchange.body?.get('redirect_uri'), CONFIG.redirectUri)
  assert.match(exchange.body?.get('code_verifier') ?? '', /^[A-Za-z0-9_-]{64}$/)
})

Deno.test('state: missing, malformed or unknown is refused before anything else', async () => {
  const h = await setup()
  assert.equal(errorOf(await h.callback(`${CALLBACK}?code=abc`)), 'invalid_request')
  assert.equal(errorOf(await h.callback(`${CALLBACK}?code=abc&state=short`)), 'invalid_state')
  assert.equal(errorOf(await h.callback(`${CALLBACK}?code=abc&state=${'x'.repeat(42)}%27`)), 'invalid_state')
  assert.equal(errorOf(await h.callback(`${CALLBACK}?code=abc&state=${randomToken(32)}`)), 'invalid_state', 'a well-formed state Friday never issued')
  assert.equal(h.google.requests.length, 0, 'Google is never called for a bad state')
  assert.equal(h.store.grants.size, 0)
})

Deno.test('state: one-time — replaying the callback is refused and changes nothing', async () => {
  const h = await setup()
  const first = await h.authorize('session-a')
  assert.ok(first.ticket)
  const before = h.google.requests.length

  assert.equal(errorOf(await h.callback(first.callbackUrl)), 'link_used')
  assert.equal(h.google.requests.length, before, 'the replayed code is not exchanged again')
  assert.equal(h.store.grants.size, 1, 'still just the first grant')
})

Deno.test('state: expires after ten minutes', async () => {
  const h = await setup()
  const started = await h.call('session-a', { action: 'start' })
  const { url } = await started.json()
  const back = await h.google.consent(url)
  h.store.advance(601)
  assert.equal(errorOf(await h.callback(back)), 'link_expired')
  assert.equal(h.google.requests.filter((r) => r.url.pathname === '/token').length, 0, 'an expired state’s code is never exchanged')
  // And it can't be retried once expired either.
  assert.equal(errorOf(await h.callback(back)), 'link_used')
})

Deno.test('state: bound to the user who started — the callback can’t pick another user', async () => {
  const h = await setup()
  // B starts; the callback (which carries no Friday session at all) parks the grant for B, whoever's browser it is.
  const { ticket } = await h.authorize('session-b')
  const [grant] = [...h.store.grants.values()]
  assert.equal(grant.userId, USERS.b)
  // A completing it is refused (see connection_test for the full cross-user checks).
  const response = await h.call('session-a', { action: 'complete', ticket })
  assert.equal(response.status, 403)
})

Deno.test('the person says no on Google’s screen', async () => {
  const h = await setup()
  const { error, ticket, callbackUrl } = await h.authorize('session-a', { deny: true })
  assert.equal(error, 'access_denied')
  assert.equal(ticket, null)
  assert.equal(h.google.requests.length, 0)
  // The state is used up, so the denial can't be turned into a success later.
  const forged = new URL(callbackUrl)
  forged.searchParams.delete('error')
  forged.searchParams.set('code', 'stolen-code')
  assert.equal(errorOf(await h.callback(forged.toString())), 'link_used')
})

Deno.test('any other Google error is reported generically', async () => {
  const h = await setup()
  const started = await h.call('session-a', { action: 'start' })
  const state = new URL((await started.json()).url).searchParams.get('state')
  assert.equal(errorOf(await h.callback(`${CALLBACK}?error=server_error&state=${state}`)), 'google_error')
})

Deno.test('a valid state without a code is refused', async () => {
  const h = await setup()
  const started = await h.call('session-a', { action: 'start' })
  const state = new URL((await started.json()).url).searchParams.get('state')
  assert.equal(errorOf(await h.callback(`${CALLBACK}?state=${state}`)), 'invalid_request')
})

Deno.test('the code exchange failing stores nothing', async () => {
  const h = await setup()
  h.google.failures.set('/token', { status: 400, body: { error: 'invalid_grant' } })
  const { error } = await h.authorize('session-a')
  assert.equal(error, 'exchange_failed')
  assert.equal(h.store.grants.size, 0)
  assert.deepEqual(h.lines.find((l) => l.event === 'gmail_token_exchange_failed')?.fields, { failure: 'invalid_grant', status: 400 })
})

Deno.test('Google unreachable during the exchange', async () => {
  const h = await setup()
  h.google.failures.set('/token', { status: 503 })
  assert.equal((await h.authorize('session-a')).error, 'exchange_failed')
})

Deno.test('unticking Gmail on Google’s granular consent screen: nothing to connect, tokens revoked', async () => {
  const h = await setup()
  const { error } = await h.authorize('session-a', { scope: 'openid' })
  assert.equal(error, 'scope_missing')
  assert.equal(h.store.grants.size, 0)
  assert.equal(h.google.revoked.size, 2, 'the refresh token (and the access tokens from it) are revoked')
})

Deno.test('no refresh token from Google: refused and the access token revoked', async () => {
  const h = await setup()
  h.google.omitRefreshToken = true
  const { error } = await h.authorize('session-a')
  assert.equal(error, 'no_refresh_token')
  assert.equal(h.store.grants.size, 0)
  assert.equal(h.google.revoked.size, 1)
})

Deno.test('the Gmail profile can’t be read: refused and revoked', async () => {
  const h = await setup()
  h.google.failures.set('/profile', { status: 500 })
  const { error } = await h.authorize('session-a')
  assert.equal(error, 'profile_failed')
  assert.equal(h.store.grants.size, 0)
  assert.ok(h.google.revoked.size >= 1)
})

Deno.test('the database failing after Google issued tokens: revoked, generic error', async () => {
  const h = await setup()
  h.store.failNext = 'storePendingGrant'
  const { error } = await h.authorize('session-a')
  assert.equal(error, 'server_error')
  assert.ok(h.google.revoked.size >= 1, 'tokens Friday couldn’t store are revoked, not left live')
})

Deno.test('the database failing before Google is called', async () => {
  const h = await setup()
  const started = await h.call('session-a', { action: 'start' })
  const back = await h.google.consent((await started.json()).url)
  h.store.failNext = 'consume'
  assert.equal(errorOf(await h.callback(back)), 'server_error')
  assert.equal(h.google.requests.filter((r) => r.url.pathname === '/token').length, 0)
})

Deno.test('an oversized code is refused without calling Google', async () => {
  const h = await setup()
  const started = await h.call('session-a', { action: 'start' })
  const state = new URL((await started.json()).url).searchParams.get('state')
  assert.equal(errorOf(await h.callback(`${CALLBACK}?state=${state}&code=${'c'.repeat(3000)}`)), 'invalid_request')
  assert.equal(h.google.requests.length, 0)
})

Deno.test('only GET is accepted', async () => {
  const h = await setup()
  const response = await h.callback(`${CALLBACK}?state=x&code=y`, 'POST')
  assert.equal(response.status, 405)
})
