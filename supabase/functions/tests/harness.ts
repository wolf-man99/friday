// Wires the real handlers to the fakes, the way the deployed functions wire
// them to Supabase and Google.

import { handleCallback } from '../_shared/callback.ts'
import { handleConnection } from '../_shared/connection.ts'
import type { GmailConfig } from '../_shared/config.ts'
import type { Logger } from '../_shared/http.ts'
import { APP, captureLog, cipher, CONFIG, type ConsentOptions, FakeGoogle, MemoryStore, SESSIONS } from './fakes.ts'

export const FUNCTION_URL = 'https://project.supabase.co/functions/v1/gmail-connection'

export async function setup(options: { log?: Logger; config?: Partial<GmailConfig> } = {}) {
  const config: GmailConfig = { ...CONFIG, ...options.config }
  const store = new MemoryStore()
  const google = new FakeGoogle()
  const captured = captureLog()
  const log = options.log ?? captured.log
  const tokenCipher = await cipher()
  const authenticate = (token: string) => Promise.resolve(SESSIONS[token] ?? null)

  /** POST to gmail-connection as the app would (supabase.functions.invoke). */
  const call = (session: string | null, body: unknown, headers: Record<string, string> = {}) =>
    handleConnection(
      new Request(FUNCTION_URL, {
        method: 'POST',
        headers: {
          origin: APP,
          'content-type': 'application/json',
          ...(session ? { authorization: `Bearer ${session}` } : {}),
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      { config, store, cipher: tokenCipher, authenticate, fetch: google.fetch, log },
    )

  /** Google redirects the browser to gmail-oauth-callback. */
  const callback = (url: string, method = 'GET') =>
    handleCallback(new Request(url, { method }), { config, store, cipher: tokenCipher, fetch: google.fetch, log })

  /** start → Google consent → callback. Returns where the browser ends up. */
  async function authorize(session: string, consent: ConsentOptions = {}) {
    const started = await call(session, { action: 'start' })
    const { url, browserKey } = await started.json()
    const back = await google.consent(url, consent)
    const redirected = await callback(back)
    const location = new URL(redirected.headers.get('location')!)
    return {
      authorizationUrl: url as string,
      /** What the app keeps in this browser between start and complete. */
      browserKey: browserKey as string,
      callbackUrl: back,
      redirected,
      location,
      ticket: new URLSearchParams(location.hash.slice(1)).get('ticket'),
      error: location.searchParams.get('gmail_error'),
    }
  }

  /** The whole connection flow for a signed-in user, in one browser. */
  async function connect(session: string, consent: ConsentOptions = {}) {
    const { ticket, browserKey } = await authorize(session, consent)
    const completed = await call(session, { action: 'complete', ticket, browserKey })
    return { ticket, browserKey, completed, body: await completed.json() }
  }

  return { store, google, cipher: tokenCipher, lines: captured.lines, call, callback, authorize, connect }
}

export type Harness = Awaited<ReturnType<typeof setup>>
