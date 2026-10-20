// The deployed entry points' wiring: what happens when secrets are missing.
// (Imports supabase-js, so this file needs npm access the first time.)

import assert from 'node:assert/strict'
import { callbackServer, connectionServer } from '../_shared/server.ts'
import { SECRETS } from './fakes.ts'

const silenced = async <T>(run: () => Promise<T>): Promise<{ result: T; logged: string }> => {
  const original = console.error
  let logged = ''
  console.error = (...args: unknown[]) => void (logged += args.join(' '))
  try {
    return { result: await run(), logged }
  } finally {
    console.error = original
  }
}

Deno.test('gmail-connection without its secrets says “not set up” and logs only the missing names', async () => {
  const handler = connectionServer(() => undefined)
  const { result, logged } = await silenced(() =>
    handler(new Request('https://x.supabase.co/functions/v1/gmail-connection', { method: 'POST', headers: { origin: 'https://friday.example' } })),
  )
  assert.equal(result.status, 503)
  assert.equal((await result.json()).error, 'not_configured')
  assert.match(logged, /GOOGLE_OAUTH_CLIENT_SECRET/)
})

Deno.test('gmail-oauth-callback with a bad encryption key sends people back with a generic error', async () => {
  const env: Record<string, string> = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: SECRETS.serviceRoleKey,
    GOOGLE_OAUTH_CLIENT_ID: 'id',
    GOOGLE_OAUTH_CLIENT_SECRET: SECRETS.clientSecret,
    GMAIL_OAUTH_REDIRECT_URI: 'https://project.supabase.co/functions/v1/gmail-oauth-callback',
    GMAIL_TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=',
    FRIDAY_APP_URL: 'https://friday.example',
  }
  const handler = callbackServer((name) => env[name])
  const { result, logged } = await silenced(() => handler(new Request('https://x/functions/v1/gmail-oauth-callback?code=c&state=s')))
  assert.equal(result.status, 303)
  assert.equal(result.headers.get('location'), 'https://friday.example/connections/gmail?gmail_error=server_error')
  assert.match(logged, /GMAIL_TOKEN_ENCRYPTION_KEY/)
  assert.ok(!logged.includes('c2hvcnQ=') && !logged.includes(SECRETS.clientSecret))
})
