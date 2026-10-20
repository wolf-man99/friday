// gmail-connection: starting the flow, completing it (only as the same user),
// cross-user isolation, disconnecting, and the bounded test fetch.

import assert from 'node:assert/strict'
import { pkceChallenge, refreshTokenContext, sha256Hex } from '../_shared/crypto.ts'
import { GMAIL_READONLY_SCOPE } from '../_shared/google.ts'
import { TEST_FETCH_MAX } from '../_shared/connection.ts'
import { APP, CONFIG, type Mail, USERS } from './fakes.ts'
import { setup, type Harness } from './harness.ts'

const day = 86_400_000

function alerts(count: number, from = 'HDFC Bank InstaAlerts <alerts@hdfcbank.net>'): Mail[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `18c${i.toString(16).padStart(4, '0')}abc`,
    from,
    subject: `Rs.${100 + i}.00 debited from a/c **1234`,
    snippet: `Dear Customer, Rs.${100 + i}.00 has been debited from account **1234 to VPA shop@upi`,
    body: `FULL BODY ${i} with account statement details`,
    internalDate: String(Date.UTC(2026, 9, 1) + i * day),
  }))
}

async function connected(email = 'asha@gmail.com', session = 'session-a'): Promise<Harness> {
  const h = await setup()
  const { completed } = await h.connect(session, { email })
  assert.equal(completed.status, 200)
  return h
}

// -----------------------------------------------------------------------------
// Who may call
// -----------------------------------------------------------------------------

Deno.test('requires a signed-in Friday user', async () => {
  const h = await setup()
  assert.equal((await h.call(null, { action: 'start' })).status, 401)
  assert.equal((await h.call('forged-or-expired', { action: 'start' })).status, 401)
  assert.equal(h.store.states.size, 0)
})

Deno.test('browsers may only call from Friday’s own origin; CORS names only that origin', async () => {
  const h = await setup()
  const foreign = await h.call('session-a', { action: 'start' }, { origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
  assert.equal(foreign.headers.get('access-control-allow-origin'), null)

  const ok = await h.call('session-a', { action: 'start' })
  assert.equal(ok.headers.get('access-control-allow-origin'), APP)
  assert.equal(ok.headers.get('cache-control'), 'no-store')
})

Deno.test('rejects other methods, bad JSON and unknown actions', async () => {
  const h = await setup()
  assert.equal((await h.call('session-a', '{not json')).status, 400)
  assert.equal((await h.call('session-a', { action: 'export-tokens' })).status, 400)
})

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

Deno.test('start: authorization-code flow for Gmail read-only, offline, with PKCE and a random state', async () => {
  const h = await setup()
  const response = await h.call('session-a', { action: 'start' })
  assert.equal(response.status, 200)
  const { url, browserKey } = await response.json()
  const auth = new URL(url)
  const p = auth.searchParams

  assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(p.get('response_type'), 'code', 'authorization code, not implicit')
  assert.equal(p.get('scope'), GMAIL_READONLY_SCOPE, 'exactly one scope: gmail.readonly')
  assert.equal(p.get('access_type'), 'offline')
  assert.equal(p.get('prompt'), 'consent')
  assert.equal(p.get('include_granted_scopes'), 'false')
  assert.equal(p.get('client_id'), CONFIG.clientId)
  assert.equal(p.get('redirect_uri'), CONFIG.redirectUri)
  assert.equal(p.get('code_challenge_method'), 'S256')
  assert.equal(p.has('client_secret'), false, 'the client secret is never in a browser URL')

  const state = p.get('state')!
  assert.match(state, /^[A-Za-z0-9_-]{43}$/, '256 bits of randomness')
  const stored = h.store.states.get(await sha256Hex(state))
  assert.ok(stored, 'stored by hash only')
  assert.equal(stored.userId, USERS.a, 'bound to the signed-in user')
  assert.match(browserKey, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(stored.browserHash, await sha256Hex(browserKey), 'and to this browser, by a key only it holds')
  assert.equal(await pkceChallenge(stored.verifier), p.get('code_challenge'))
  assert.ok(!url.includes(stored.verifier), 'the PKCE verifier stays on the server')
})

Deno.test('start: every attempt gets a fresh state', async () => {
  const h = await setup()
  const states = new Set<string>()
  for (let i = 0; i < 3; i++) {
    const { url } = await (await h.call('session-a', { action: 'start' })).json()
    states.add(new URL(url).searchParams.get('state')!)
  }
  assert.equal(states.size, 3)
})

Deno.test('start: too many open attempts is a polite 429', async () => {
  const h = await setup()
  for (let i = 0; i < 5; i++) assert.equal((await h.call('session-a', { action: 'start' })).status, 200)
  const response = await h.call('session-a', { action: 'start' })
  assert.equal(response.status, 429)
  assert.match((await response.json()).message, /Too many/)
  assert.equal((await h.call('session-b', { action: 'start' })).status, 200, 'per user')
})

Deno.test('start: grants nobody came back to confirm are revoked with Google', async () => {
  const h = await setup()
  const { ticket } = await h.authorize('session-a')
  assert.ok(ticket)
  const [grant] = [...h.store.grants.values()]
  const refresh = await h.cipher.decrypt(grant.enc, refreshTokenContext(USERS.a))
  h.store.advance(601)
  await h.call('session-a', { action: 'start' })
  assert.equal(h.store.grants.size, 0)
  assert.ok(h.google.revoked.has(refresh))
})

// -----------------------------------------------------------------------------
// Complete, and cross-user isolation
// -----------------------------------------------------------------------------

Deno.test('complete: the same signed-in user activates the connection', async () => {
  const h = await setup()
  const { completed, body } = await h.connect('session-a', { email: 'asha@gmail.com' })
  assert.equal(completed.status, 200)
  assert.deepEqual(body.connection, { id: 'conn-1', accountEmail: 'asha@gmail.com', status: 'active' })
  assert.equal(h.store.grants.size, 0)
  assert.equal(h.store.credentials.get('conn-1')?.userId, USERS.a)
})

Deno.test('cross-user: a ticket can’t be completed by a different Friday user (login CSRF)', async () => {
  // Bea starts a flow and tricks Asha into approving it: Google sends Asha's
  // browser back with a ticket parked for Bea, holding Asha's Gmail.
  const h = await setup()
  const { ticket } = await h.authorize('session-b', { email: 'asha@gmail.com' })
  const [grant] = [...h.store.grants.values()]
  const refresh = await h.cipher.decrypt(grant.enc, refreshTokenContext(USERS.b))

  // Asha's app, signed in as Asha, completes it: refused, destroyed and
  // (as Asha has no Friday connection to that Gmail) revoked.
  const response = await h.call('session-a', { action: 'complete', ticket })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'wrong_user')
  assert.equal(h.store.connections.length, 0, 'nobody got connected')
  assert.equal(h.store.grants.size, 0)
  assert.ok(h.google.revoked.has(refresh), 'the token is revoked with Google')

  // And Bea, who started it, can't use it afterwards either.
  assert.equal((await h.call('session-b', { action: 'complete', ticket })).status, 404)
})

Deno.test('cross-user: a lure approved by someone already connected doesn’t break their connection', async () => {
  // Asha has her Gmail connected. Bea's lure gets Asha to approve again: the
  // refusal must not revoke (Google would end Asha's working access too).
  const h = await connected('asha@gmail.com', 'session-a')
  h.google.mailboxes.set('asha@gmail.com', alerts(1))
  const { ticket, browserKey } = await h.authorize('session-b', { email: 'asha@gmail.com' })
  const response = await h.call('session-a', { action: 'complete', ticket, browserKey })
  assert.equal((await response.json()).error, 'wrong_user')
  assert.equal(h.google.revoked.size, 0)
  assert.equal((await h.call('session-a', { action: 'test-fetch' })).status, 200, 'Asha is still connected')
})

Deno.test('same user, different browser: refused (a link someone sent you can’t be attached)', async () => {
  const h = await setup()
  const { ticket } = await h.authorize('session-a')
  const other = await h.call('session-a', { action: 'complete', ticket, browserKey: 'k'.repeat(43) })
  assert.equal(other.status, 403)
  assert.equal((await other.json()).error, 'wrong_browser')
  assert.equal(h.store.connections.length, 0)
  assert.equal(h.store.grants.size, 0, 'the grant is gone')
  assert.ok(h.google.revoked.size > 0, 'and revoked (no connection depends on that Gmail)')
})

Deno.test('a ticket without the browser key is used up as a mismatch', async () => {
  const h = await setup()
  const { ticket } = await h.authorize('session-a')
  assert.equal((await h.call('session-a', { action: 'complete', ticket })).status, 403)
  assert.equal(h.store.grants.size, 0)
})

Deno.test('complete: a ticket works once', async () => {
  const h = await setup()
  const { ticket, browserKey } = await h.connect('session-a')
  assert.equal((await h.call('session-a', { action: 'complete', ticket, browserKey })).status, 404)
})

Deno.test('complete: an expired ticket is refused and its token revoked', async () => {
  const h = await setup()
  const { ticket, browserKey } = await h.authorize('session-a')
  h.store.advance(601)
  const response = await h.call('session-a', { action: 'complete', ticket, browserKey })
  assert.equal(response.status, 410)
  assert.equal(h.store.connections.length, 0)
  assert.equal(h.google.revoked.size, 2)
})

Deno.test('complete: malformed tickets are refused before any lookup', async () => {
  const h = await setup()
  for (const ticket of [null, 42, 'short', `${'a'.repeat(42)}'`, 'a'.repeat(44)]) {
    assert.equal((await h.call('session-a', { action: 'complete', ticket })).status, 400)
  }
})

Deno.test('reconnecting the same Gmail replaces the credential and keeps working', async () => {
  const h = await connected()
  const old = await h.cipher.decrypt(h.store.credentials.get('conn-1')!.enc, refreshTokenContext(USERS.a))
  const { body } = await h.connect('session-a', { email: 'asha@gmail.com' })
  assert.equal(body.connection.id, 'conn-1')
  const current = await h.cipher.decrypt(h.store.credentials.get('conn-1')!.enc, refreshTokenContext(USERS.a))
  assert.notEqual(current, old, 'only the new token is stored')
  // Revoking the old one would end the new one too (Google revokes per account).
  assert.equal(h.google.revoked.size, 0)
  assert.equal((await h.call('session-a', { action: 'test-fetch' })).status, 200)
})

Deno.test('switching to a different Gmail account revokes the old account’s access', async () => {
  const h = await connected('asha@gmail.com')
  const old = await h.cipher.decrypt(h.store.credentials.get('conn-1')!.enc, refreshTokenContext(USERS.a))
  const { body } = await h.connect('session-a', { email: 'asha.work@gmail.com' })
  assert.equal(body.connection.accountEmail, 'asha.work@gmail.com')
  assert.ok(h.google.revoked.has(old))
  assert.equal((await h.call('session-a', { action: 'test-fetch' })).status, 200, 'the new account works')
})

Deno.test('two Friday accounts sharing one Gmail: one disconnecting leaves the other working', async () => {
  const h = await connected('family@gmail.com', 'session-a')
  await h.connect('session-b', { email: 'family@gmail.com' })
  const body = await (await h.call('session-a', { action: 'disconnect' })).json()
  assert.deepEqual(body, { disconnected: true, revoked: false, removed: 1 }, 'deleted, but not revoked with Google')
  assert.equal(h.google.revoked.size, 0)
  assert.equal((await h.call('session-b', { action: 'test-fetch' })).status, 200)
})

Deno.test('cross-user: each user’s actions touch only their own connection', async () => {
  const h = await connected('asha@gmail.com', 'session-a')
  await h.connect('session-b', { email: 'bea@gmail.com' })
  h.google.mailboxes.set('asha@gmail.com', alerts(2))
  h.google.mailboxes.set('bea@gmail.com', alerts(3, 'ICICI <credit_cards@icicibank.com>'))

  const a = await (await h.call('session-a', { action: 'test-fetch' })).json()
  const b = await (await h.call('session-b', { action: 'test-fetch' })).json()
  assert.equal(a.messages.length, 2, 'A reads A’s mailbox')
  assert.equal(b.messages.length, 3, 'B reads B’s mailbox')
  assert.ok(b.messages.every((m: { from: string }) => m.from.includes('icicibank.com')))

  await h.call('session-b', { action: 'disconnect' })
  assert.equal(h.store.connections.find((c) => c.userId === USERS.a)?.status, 'active', 'B’s disconnect leaves A connected')
  assert.equal((await h.call('session-a', { action: 'test-fetch' })).status, 200)
  assert.equal((await h.call('session-b', { action: 'test-fetch' })).status, 409)
})

Deno.test('cross-user: a stored credential copied to another user won’t decrypt', async () => {
  const h = await connected('asha@gmail.com', 'session-a')
  await h.connect('session-b', { email: 'bea@gmail.com' })
  // Simulate a database mix-up: B's connection row now holds A's sealed token.
  const aSealed = h.store.credentials.get('conn-1')!.enc
  h.store.credentials.set('conn-2', { userId: USERS.b, enc: aSealed })
  const before = h.google.requests.length
  const response = await h.call('session-b', { action: 'test-fetch' })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'credential_unreadable')
  assert.equal(h.google.requests.length, before, 'A’s token was never used: no call to Google at all')
  // Unreadable isn't the same as revoked: nothing is deleted on a hunch.
  assert.equal(h.store.credentials.size, 2)
  assert.equal(h.store.connections[1].status, 'active')
})

Deno.test('a wrong client secret on the server never deletes anyone’s access', async () => {
  const h = await connected()
  h.google.failures.set('/token', { status: 401, body: { error: 'invalid_client', error_description: 'The OAuth client was not found.' } })
  const response = await h.call('session-a', { action: 'test-fetch' })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error, 'not_configured')
  assert.equal(h.store.connections[0].status, 'active')
  assert.equal(h.store.credentials.size, 1)
})

Deno.test('disconnect: deletes credentials and revokes them with Google', async () => {
  const h = await connected()
  const refresh = await h.cipher.decrypt(h.store.credentials.get('conn-1')!.enc, refreshTokenContext(USERS.a))
  const response = await h.call('session-a', { action: 'disconnect' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { disconnected: true, revoked: true, removed: 1 })
  assert.equal(h.store.credentials.size, 0)
  assert.equal(h.store.connections[0].status, 'disconnected')
  assert.ok(h.google.revoked.has(refresh))
})

Deno.test('disconnect: also deletes (and revokes) a grant waiting for confirmation', async () => {
  const h = await setup()
  await h.authorize('session-a')
  const response = await h.call('session-a', { action: 'disconnect' })
  assert.deepEqual(await response.json(), { disconnected: true, revoked: true, removed: 1 })
  assert.equal(h.store.grants.size, 0)
})

Deno.test('disconnect: still removes credentials when Google can’t be reached, and says so', async () => {
  const h = await connected()
  h.google.failures.set('/revoke', { status: 503 })
  const body = await (await h.call('session-a', { action: 'disconnect' })).json()
  assert.deepEqual(body, { disconnected: true, revoked: false, removed: 1 })
  assert.equal(h.store.credentials.size, 0)
})

Deno.test('disconnect: harmless when nothing is connected', async () => {
  const h = await setup()
  assert.deepEqual(await (await h.call('session-a', { action: 'disconnect' })).json(), { disconnected: true, revoked: true, removed: 0 })
})

Deno.test('a disconnected account can’t fetch, and Google is never called', async () => {
  const h = await connected()
  await h.call('session-a', { action: 'disconnect' })
  const before = h.google.requests.length
  const response = await h.call('session-a', { action: 'test-fetch' })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'not_connected')
  assert.equal(h.google.requests.length, before)
})

Deno.test('a flow started before disconnecting can’t be finished after it', async () => {
  const h = await setup()
  const started = await h.call('session-a', { action: 'start' })
  const back = await h.google.consent((await started.json()).url)
  await h.call('session-a', { action: 'disconnect' })
  const redirected = await h.callback(back)
  assert.equal(new URL(redirected.headers.get('location')!).searchParams.get('gmail_error'), 'invalid_state')
  assert.equal(h.store.grants.size, 0)
})

Deno.test('access revoked at Google: the connection asks to reconnect and the credential is deleted', async () => {
  const h = await connected()
  const refresh = await h.cipher.decrypt(h.store.credentials.get('conn-1')!.enc, refreshTokenContext(USERS.a))
  h.google.revoked.add(refresh) // the person removed Friday at myaccount.google.com
  const response = await h.call('session-a', { action: 'test-fetch' })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'needs_reconnect')
  assert.equal(h.store.connections[0].status, 'needs_reconnect')
  assert.equal(h.store.connections[0].lastErrorCode, 'invalid_grant')
  assert.equal(h.store.credentials.size, 0)
  // Reconnecting brings it back.
  const { body } = await h.connect('session-a', { email: 'asha@gmail.com' })
  assert.equal(body.connection.status, 'active')
  assert.equal((await h.call('session-a', { action: 'test-fetch' })).status, 200)
})

// -----------------------------------------------------------------------------
// Test fetch
// -----------------------------------------------------------------------------

Deno.test('test-fetch: searches alert senders and words, metadata only, bounded', async () => {
  const h = await connected()
  h.google.mailboxes.set('asha@gmail.com', alerts(30))
  const response = await h.call('session-a', { action: 'test-fetch' })
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.messages.length, 5, 'five by default')
  assert.equal(body.recorded, false, 'nothing is recorded')
  assert.match(body.query, /^from:\(bank\.in OR fin\.in OR hdfcbank\.net OR .*\) \(debited OR .*\) newer_than:30d -category:promotions -category:social$/)
  assert.deepEqual(Object.keys(body.messages[0]).sort(), ['from', 'id', 'receivedAt', 'snippet', 'subject'])
  assert.equal(body.messages[0].subject, 'Rs.129.00 debited from a/c **1234', 'newest first')
  assert.equal(body.messages[0].receivedAt, '2026-10-30T00:00:00.000Z')
  assert.ok(!JSON.stringify(body).includes('FULL BODY'), 'never the message body')

  const list = h.google.requests.find((r) => r.url.pathname.endsWith('/messages'))!
  assert.equal(list.url.searchParams.get('maxResults'), '5')
  assert.equal(list.url.searchParams.get('fields'), 'messages/id,resultSizeEstimate')
  const gets = h.google.requests.filter((r) => /\/messages\/\w+$/.test(r.url.pathname))
  assert.equal(gets.length, 5)
  for (const get of gets) {
    assert.equal(get.url.searchParams.get('format'), 'metadata')
    assert.deepEqual(get.url.searchParams.getAll('metadataHeaders'), ['From', 'Subject', 'Date'])
    assert.equal(get.url.searchParams.get('fields'), 'id,internalDate,snippet,payload/headers')
  }
  assert.ok(h.store.connections[0].lastCheckedAt, 'the check is recorded on the connection')
})

Deno.test('test-fetch: the limit is capped and the look-back bounded', async () => {
  const h = await connected()
  h.google.mailboxes.set('asha@gmail.com', alerts(50))
  const body = await (await h.call('session-a', { action: 'test-fetch', limit: 500, lookbackDays: 10_000 })).json()
  assert.equal(body.messages.length, TEST_FETCH_MAX)
  assert.match(body.query, /newer_than:90d/)
  const small = await (await h.call('session-a', { action: 'test-fetch', limit: 2, lookbackDays: 7 })).json()
  assert.equal(small.messages.length, 2)
  assert.match(small.query, /newer_than:7d/)
})

Deno.test('test-fetch: only allowlisted senders are returned, whatever Gmail’s search matched', async () => {
  const h = await connected()
  h.google.mailboxes.set('asha@gmail.com', [
    ...alerts(1),
    ...alerts(1, 'Phish <alerts@hdfcbank.net.evil.example>').map((m) => ({ ...m, id: 'evil1' })),
    ...alerts(1, 'Lookalike <alerts@nothdfcbank.net>').map((m) => ({ ...m, id: 'evil2' })),
    ...alerts(1, 'A friend <friend@gmail.com>').map((m) => ({ ...m, id: 'friend1' })),
    ...alerts(1, 'Card alerts <cc.alerts@mail.icicibank.com>').map((m) => ({ ...m, id: 'sub1' })),
  ])
  const body = await (await h.call('session-a', { action: 'test-fetch', limit: 10 })).json()
  assert.deepEqual(body.messages.map((m: { id: string }) => m.id).sort(), ['18c0000abc', 'sub1'])
})

Deno.test('test-fetch: configurable senders replace the defaults', async () => {
  const h = await setup({ config: { alertSenders: ['alerts@mybank.example'] } })
  await h.connect('session-a', { email: 'asha@gmail.com' })
  h.google.mailboxes.set('asha@gmail.com', [
    ...alerts(1, 'My Bank <alerts@mybank.example>'),
    ...alerts(1).map((m) => ({ ...m, id: 'hdfc1' })),
  ])
  const body = await (await h.call('session-a', { action: 'test-fetch' })).json()
  assert.match(body.query, /^from:\(alerts@mybank\.example\) /)
  assert.deepEqual(body.messages.map((m: { id: string }) => m.id), ['18c0000abc'])
})

Deno.test('test-fetch: Gmail failing is a 502 with nothing stored', async () => {
  const h = await connected()
  h.google.failures.set('/messages', { status: 500 })
  const response = await h.call('session-a', { action: 'test-fetch' })
  assert.equal(response.status, 502)
  assert.equal(h.store.connections[0].status, 'active', 'a Gmail outage doesn’t disconnect anyone')
  assert.equal(h.store.credentials.size, 1)
})
