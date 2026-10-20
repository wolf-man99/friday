// Token secrecy: run every flow with the real logger, then look for any
// secret — client secret, service-role key, authorization codes, access and
// refresh tokens, OAuth state, PKCE verifier, ticket, email bodies — in what
// the browser receives, in the logs and in what's stored.

import assert from 'node:assert/strict'
import { defaultLogger } from '../_shared/http.ts'
import { exchangeCode, GoogleError, googleEndpoints, refreshAccessToken } from '../_shared/google.ts'
import { CONFIG, SECRETS } from './fakes.ts'
import { setup } from './harness.ts'

/** Captures console output while `run` executes, through the production logger. */
async function withConsole(run: () => Promise<void>): Promise<string> {
  const out: string[] = []
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info }
  const sink = (...args: unknown[]) => void out.push(args.map(String).join(' '))
  Object.assign(console, { log: sink, error: sink, warn: sink, info: sink })
  try {
    await run()
  } finally {
    Object.assign(console, original)
  }
  return out.join('\n')
}

Deno.test('no secret reaches the browser, the logs or the database in plain text', async () => {
  const browser: string[] = []
  const record = async (response: Response) => {
    browser.push(JSON.stringify([...response.headers.entries()]))
    browser.push(await response.clone().text())
    return response
  }

  let h!: Awaited<ReturnType<typeof setup>>
  const transientSecrets: string[] = []
  const logs = await withConsole(async () => {
    h = await setup({ log: defaultLogger })
    h.google.mailboxes.set('asha@gmail.com', [
      {
        id: '18c0001',
        from: 'HDFC Bank <alerts@hdfcbank.net>',
        subject: 'Rs.250.00 debited',
        snippet: 'Rs.250.00 debited from a/c **1234',
        body: 'EMAIL-BODY-SENTINEL full statement',
        internalDate: '1790000000000',
      },
    ])

    // Connect: start (browser gets the Google URL), Google redirect, complete.
    const started = await record(await h.call('session-a', { action: 'start' }))
    const { url, browserKey } = await started.json()
    const state = new URL(url).searchParams.get('state')!
    transientSecrets.push(state)
    const back = await h.google.consent(url, { email: 'asha@gmail.com' })
    const redirected = await record(await h.callback(back))
    const ticket = new URLSearchParams(new URL(redirected.headers.get('location')!).hash.slice(1)).get('ticket')!
    await record(await h.call('session-a', { action: 'complete', ticket, browserKey }))
    // The browser legitimately holds state, ticket and its key; they must not be logged or stored.

    // Use it, fail it, reconnect, disconnect; plus every refusal path.
    await record(await h.call('session-a', { action: 'test-fetch' }))
    await record(await h.call('session-b', { action: 'complete', ticket, browserKey }))
    await record(await h.call('session-a', { action: 'complete', ticket: 'x'.repeat(43) }))
    h.google.failures.set('/messages', { status: 500, body: { error: { message: 'boom ya29.leaky' } } })
    await record(await h.call('session-a', { action: 'test-fetch' }))
    await h.connect('session-a', { email: 'asha@gmail.com' })
    h.google.failures.set('/token', { status: 400, body: { error: 'invalid_grant', error_description: 'Bad 1//refresh' } })
    await record(await h.call('session-a', { action: 'test-fetch' }))
    await h.connect('session-a', { email: 'asha@gmail.com' })
    await record(await h.call('session-a', { action: 'disconnect' }))
    await record(await h.callback(back))
    transientSecrets.push(ticket, browserKey)
  })

  const issued = h.google.issued // every code, access token and refresh token Google handed out
  assert.ok(issued.some((t) => t.startsWith('1//refresh')) && issued.some((t) => t.startsWith('4/auth-code')))
  const verifiers = h.google.requests.map((r) => r.body?.get('code_verifier')).filter((v): v is string => Boolean(v))
  assert.ok(verifiers.length > 0)

  const neverAnywhere = [SECRETS.clientSecret, SECRETS.serviceRoleKey, SECRETS.encryptionKey, ...issued, ...verifiers, 'EMAIL-BODY-SENTINEL']
  const browserText = browser.join('\n')
  const storeText = h.store.dump()
  for (const secret of neverAnywhere) {
    assert.ok(!browserText.includes(secret), `browser saw ${secret.slice(0, 12)}…`)
    assert.ok(!logs.includes(secret), `logs contain ${secret.slice(0, 12)}…`)
    assert.ok(!storeText.includes(secret), `stored in plain text: ${secret.slice(0, 12)}…`)
  }
  for (const secret of transientSecrets) {
    assert.ok(!logs.includes(secret), 'state/ticket logged')
    assert.ok(!storeText.includes(secret), 'state/ticket stored unhashed')
  }
  assert.ok(!logs.includes('asha@gmail.com'), 'email addresses aren’t logged')
  assert.ok(!logs.includes('debited'), 'message content isn’t logged')
  assert.ok(!logs.includes('leaky') && !browserText.includes('leaky'), 'Google error bodies are not echoed')
  assert.ok(logs.length > 0, 'events were logged')
  for (const line of logs.split('\n')) assert.doesNotThrow(() => JSON.parse(line), 'structured log lines')
})

Deno.test('the logger drops every field outside its allowlist', async () => {
  const logs = await withConsole(() => {
    defaultLogger('evt', { action: 'start', token: 'ya29.secret', code: '4/abc', email: 'a@b.c', count: 2 })
    return Promise.resolve()
  })
  assert.deepEqual(JSON.parse(logs), { event: 'evt', action: 'start', count: 2 })
})

Deno.test('Google errors carry a failure code, never the token or body', async () => {
  const leaky = () => Promise.resolve(Response.json({ error: 'invalid_grant', error_description: 'token 1//SECRET is bad' }, { status: 400 }))
  const endpoints = googleEndpoints()
  try {
    await refreshAccessToken(leaky as typeof fetch, endpoints, { clientId: 'id', clientSecret: 'CS', refreshToken: '1//SECRET' })
    assert.fail('should throw')
  } catch (error) {
    assert.ok(error instanceof GoogleError)
    assert.equal(error.failure, 'invalid_grant')
    assert.ok(!String(error.message).includes('SECRET') && !String(error.stack).includes('1//SECRET'))
  }
  await assert.rejects(
    exchangeCode((() => Promise.reject(new Error('network down: code=4/abc'))) as typeof fetch, endpoints, {
      clientId: 'id', clientSecret: CONFIG.clientSecret, redirectUri: CONFIG.redirectUri, code: '4/abc', codeVerifier: 'v',
    }),
    (error: unknown) => error instanceof GoogleError && error.failure === 'unavailable' && !error.message.includes('4/abc'),
  )
})

Deno.test('the client secret is only ever sent to Google’s token endpoint', async () => {
  const h = await setup()
  await h.connect('session-a', { email: 'asha@gmail.com' })
  await h.call('session-a', { action: 'test-fetch' })
  await h.call('session-a', { action: 'disconnect' })
  for (const request of h.google.requests) {
    const carries = request.body?.get('client_secret') === CONFIG.clientSecret || request.url.href.includes(CONFIG.clientSecret)
    assert.equal(carries, request.url.href === 'https://oauth2.googleapis.com/token', request.url.href)
  }
})
