// Building blocks: token encryption, random tokens and PKCE, the alert search
// and sender allowlist, and configuration checks.

import assert from 'node:assert/strict'
import { readConfig } from '../_shared/config.ts'
import { isToken, pkceChallenge, randomToken, refreshTokenContext, sha256Hex, TokenCipher } from '../_shared/crypto.ts'
import { buildAlertQuery, DEFAULT_ALERT_SENDERS, parseSenderRules, senderAddress, senderAllowed } from '../_shared/gmailQuery.ts'
import { SECRETS } from './fakes.ts'

// -----------------------------------------------------------------------------
// Crypto
// -----------------------------------------------------------------------------

Deno.test('cipher: round-trips, randomises, and binds each token to its owner', async () => {
  const cipher = await TokenCipher.fromBase64Key(SECRETS.encryptionKey)
  const a = refreshTokenContext('user-a')
  const sealed = await cipher.encrypt('1//refresh-token', a)
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/)
  assert.ok(!sealed.includes('refresh'))
  assert.equal(await cipher.decrypt(sealed, a), '1//refresh-token')
  assert.notEqual(await cipher.encrypt('1//refresh-token', a), sealed, 'a fresh IV every time')
  await assert.rejects(cipher.decrypt(sealed, refreshTokenContext('user-b')), 'another user’s context')
})

Deno.test('cipher: tampering and a different key are detected', async () => {
  const cipher = await TokenCipher.fromBase64Key(SECRETS.encryptionKey)
  const ctx = refreshTokenContext('u')
  const sealed = await cipher.encrypt('secret', ctx)
  const [v, iv, body] = sealed.split('.')
  const flipped = body.slice(0, -2) + (body.at(-2) === 'A' ? 'B' : 'A') + body.at(-1)
  await assert.rejects(cipher.decrypt(`${v}.${iv}.${flipped}`, ctx))
  await assert.rejects(cipher.decrypt(`v2.${iv}.${body}`, ctx), /Unknown credential format/)
  const other = await TokenCipher.fromBase64Key(btoa(String.fromCharCode(...new Uint8Array(32).fill(9))))
  await assert.rejects(other.decrypt(sealed, ctx))
})

Deno.test('cipher: the key must be exactly 32 bytes of base64', async () => {
  await assert.rejects(TokenCipher.fromBase64Key(btoa('too short')), /32 bytes/)
  await assert.rejects(TokenCipher.fromBase64Key('not base64 !!'), /base64/)
})

Deno.test('random tokens: right length, URL-safe, unique; isToken accepts only that shape', () => {
  const tokens = new Set(Array.from({ length: 200 }, () => randomToken(32)))
  assert.equal(tokens.size, 200)
  for (const token of tokens) assert.ok(isToken(token))
  assert.equal(randomToken(48).length, 64)
  for (const bad of [undefined, null, 1, '', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}/`]) {
    assert.equal(isToken(bad), false, String(bad))
  }
})

Deno.test('PKCE S256 matches RFC 7636 appendix B', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

// -----------------------------------------------------------------------------
// Alert search and sender allowlist
// -----------------------------------------------------------------------------

Deno.test('sender rules: domains or addresses only — search operators can’t be smuggled in', () => {
  assert.deepEqual(parseSenderRules(' Alerts@HDFCBank.net , icicibank.com,icicibank.com '), ['alerts@hdfcbank.net', 'icicibank.com'])
  assert.deepEqual(
    parseSenderRules('x.com OR in:anywhere, from:evil.com, {a b}, "q".com, -label:x, bank.com) OR (in:sent'),
    [...DEFAULT_ALERT_SENDERS],
    'nothing valid → the defaults',
  )
  assert.deepEqual(parseSenderRules(''), [...DEFAULT_ALERT_SENDERS])
  assert.deepEqual(parseSenderRules('mybank.example, in:trash'), ['mybank.example'])
})

Deno.test('alert query: senders, alert words, a bounded window, no promotions', () => {
  assert.equal(
    buildAlertQuery(['hdfcbank.net', 'alerts@icicibank.com'], 30),
    'from:(hdfcbank.net OR alerts@icicibank.com) (debited OR credited OR spent OR transaction OR txn OR upi OR purchase OR withdrawn OR refund OR reversed) newer_than:30d -category:promotions -category:social',
  )
  assert.match(buildAlertQuery(['a.com'], 0), /newer_than:30d/)
  assert.match(buildAlertQuery(['a.com'], -5), /newer_than:1d/)
  assert.match(buildAlertQuery(['a.com'], 9999), /newer_than:90d/)
  assert.throws(() => buildAlertQuery(['in:anywhere'], 30))
})

Deno.test('sender check: exact address, the domain or its subdomains — nothing else', () => {
  const rules = ['hdfcbank.net', 'alerts@icicibank.com']
  assert.equal(senderAddress('"HDFC Bank" <Alerts@HDFCBank.net>'), 'alerts@hdfcbank.net')
  assert.equal(senderAllowed('HDFC <alerts@hdfcbank.net>', rules), true)
  assert.equal(senderAllowed('alerts@mail.hdfcbank.net', rules), true)
  assert.equal(senderAllowed('ICICI <alerts@icicibank.com>', rules), true)
  assert.equal(senderAllowed('ICICI <offers@icicibank.com>', rules), false, 'an address rule is exact')
  assert.equal(senderAllowed('x <alerts@hdfcbank.net.evil.com>', rules), false)
  assert.equal(senderAllowed('x <alerts@nothdfcbank.net>', rules), false)
  assert.equal(senderAllowed('alerts@hdfcbank.net <phish@evil.com>', rules), false, 'the address in <> wins over the display name')
  assert.equal(senderAllowed('', rules), false)
})

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: SECRETS.serviceRoleKey,
  GOOGLE_OAUTH_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: SECRETS.clientSecret,
  GMAIL_OAUTH_REDIRECT_URI: 'https://project.supabase.co/functions/v1/gmail-oauth-callback',
  GMAIL_TOKEN_ENCRYPTION_KEY: SECRETS.encryptionKey,
  FRIDAY_APP_URL: 'https://friday.example/some/path',
}
const read = (overrides: Record<string, string | undefined> = {}) => readConfig((name) => ({ ...ENV, ...overrides })[name])

Deno.test('config: reads everything; app origin normalised; extra origins validated', () => {
  const result = read({ FRIDAY_ALLOWED_ORIGINS: 'http://localhost:5173, ftp://x.example, https://preview.friday.example/' })
  assert.ok(result.ok)
  assert.equal(result.config.appUrl, 'https://friday.example')
  assert.deepEqual(result.config.allowedOrigins, ['https://friday.example', 'http://localhost:5173', 'https://preview.friday.example'])
  assert.deepEqual(result.config.alertSenders, [...DEFAULT_ALERT_SENDERS])
  assert.equal(result.config.googleTestOrigin, null)
})

Deno.test('config: missing or unsafe settings are reported by name, never by value', () => {
  const result = read({ GOOGLE_OAUTH_CLIENT_SECRET: '', FRIDAY_APP_URL: 'http://friday.example' })
  assert.ok(!result.ok)
  assert.deepEqual(result.missing, ['GOOGLE_OAUTH_CLIENT_SECRET', 'FRIDAY_APP_URL (must be an https URL)'])
  assert.ok(!JSON.stringify(result).includes(SECRETS.serviceRoleKey))
})

Deno.test('config: the Google test override only ever points at localhost', () => {
  const local = read({ FRIDAY_GOOGLE_TEST_ORIGIN: 'http://localhost:54400' })
  assert.ok(local.ok && local.config.googleTestOrigin === 'http://localhost:54400')
  const remote = read({ FRIDAY_GOOGLE_TEST_ORIGIN: 'https://attacker.example' })
  assert.ok(!remote.ok && remote.missing[0].startsWith('FRIDAY_GOOGLE_TEST_ORIGIN'))
})
