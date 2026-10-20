// A stand-in for Google's OAuth and Gmail endpoints, for local end-to-end
// tests of the Gmail connection only. It checks what real Google checks that
// matters here (client id and secret, redirect URI, PKCE, one-time codes,
// revoked tokens) and keeps a seeded mailbox per address. The Gmail functions
// talk to it only when FRIDAY_GOOGLE_TEST_ORIGIN points here (localhost only).
//
//   GET  /o/oauth2/v2/auth       consent page (Allow / Cancel)
//   POST /token                  authorization_code + PKCE, refresh_token
//   POST /revoke
//   GET  /gmail/v1/users/me/...  profile, messages (list), messages/:id
//   GET  /__inspect              what was issued and revoked (tests only)
//
// Env: PORT (54400), CLIENT_ID, CLIENT_SECRET

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 54400)
const CLIENT_ID = process.env.CLIENT_ID ?? 'local-client-id'
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? 'local-client-secret'
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly'

const codes = new Map() // code → { challenge, redirectUri, scope, email, used }
const refreshTokens = new Map() // token → email
const accessTokens = new Map() // token → email
const revoked = new Set()

const day = 86_400_000
function mailbox() {
  const now = Date.now()
  const at = (days) => String(now - days * day)
  return [
    { id: 'a1', from: 'HDFC Bank InstaAlerts <alerts@hdfcbank.net>', subject: 'Rs.250.00 debited from a/c **1234', snippet: 'Dear Customer, Rs.250.00 has been debited from account **1234 to VPA bluetokai@upi on 18-10-26.', internalDate: at(1) },
    { id: 'a2', from: 'ICICI Bank <credit_cards@icicibank.com>', subject: 'Transaction alert for your ICICI Bank Credit Card', snippet: 'INR 1,499.00 spent on ICICI Bank Card XX9001 at AMAZON on 17-Oct-26.', internalDate: at(2) },
    { id: 'f1', from: 'A friend <friend@gmail.com>', subject: 'Dinner money — debited?', snippet: 'I transferred the money, check if it was credited', internalDate: at(3) },
    { id: 'p1', from: 'HDFC Bank <offers@hdfcbank.net.promo-example.com>', subject: 'Your transaction reward', snippet: 'Click here', internalDate: at(4) },
  ]
}

const token = (prefix) => `${prefix}${randomBytes(18).toString('base64url')}`
const s256 = (verifier) => createHash('sha256').update(verifier).digest('base64url')

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function form(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return new URLSearchParams(Buffer.concat(chunks).toString())
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function consentPage(params) {
  const hidden = [...params].map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('')
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Fake Google — sign in</title></head>
<body style="font-family:sans-serif;padding:16px">
<h1>Fake Google</h1>
<p>Friday wants to <strong>read your Gmail</strong> (scope: ${escapeHtml(params.get('scope'))}).</p>
<form method="get" action="/o/oauth2/v2/decide">${hidden}
<label>Account <input name="login_email" value="asha@gmail.com"></label>
<p><label><input type="checkbox" name="grant_gmail" value="yes" checked> Read your Gmail</label></p>
<button name="decision" value="allow">Allow</button>
<button name="decision" value="cancel">Cancel</button>
</form></body></html>`
}

function authUser(req) {
  const value = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const email = accessTokens.get(value)
  return email && !revoked.has(value) ? email : null
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const path = url.pathname

    if (path === '/health') return json(res, 200, { ok: true })
    if (path === '/__inspect') {
      return json(res, 200, { refreshTokens: [...refreshTokens.keys()], revoked: [...revoked] })
    }

    if (path === '/o/oauth2/v2/auth') {
      const p = url.searchParams
      const problems = []
      if (p.get('client_id') !== CLIENT_ID) problems.push('client_id')
      if (p.get('response_type') !== 'code') problems.push('response_type')
      if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) problems.push('pkce')
      if (!p.get('state')) problems.push('state')
      if (problems.length) return json(res, 400, { error: 'invalid_request', problems })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(consentPage(p))
    }

    if (path === '/o/oauth2/v2/decide') {
      const p = url.searchParams
      const back = new URL(p.get('redirect_uri'))
      back.searchParams.set('state', p.get('state'))
      if (p.get('decision') !== 'allow') {
        back.searchParams.set('error', 'access_denied')
      } else {
        const code = token('4/fake-code-')
        const scope = p.get('grant_gmail') === 'yes' ? p.get('scope') : 'openid'
        codes.set(code, { challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), scope, email: p.get('login_email'), used: false })
        back.searchParams.set('code', code)
        back.searchParams.set('scope', scope)
      }
      res.writeHead(302, { location: back.toString() })
      return res.end()
    }

    if (path === '/token' && req.method === 'POST') {
      const body = await form(req)
      if (body.get('client_id') !== CLIENT_ID || body.get('client_secret') !== CLIENT_SECRET) {
        return json(res, 401, { error: 'invalid_client' })
      }
      if (body.get('grant_type') === 'authorization_code') {
        const issued = codes.get(body.get('code'))
        if (!issued || issued.used) return json(res, 400, { error: 'invalid_grant' })
        issued.used = true
        if (issued.redirectUri !== body.get('redirect_uri')) return json(res, 400, { error: 'redirect_uri_mismatch' })
        if (s256(body.get('code_verifier') ?? '') !== issued.challenge) return json(res, 400, { error: 'invalid_grant' })
        const access = token('ya29.fake-')
        const refresh = token('1//fake-refresh-')
        accessTokens.set(access, issued.email)
        refreshTokens.set(refresh, issued.email)
        return json(res, 200, { access_token: access, refresh_token: refresh, expires_in: 3599, scope: issued.scope, token_type: 'Bearer' })
      }
      if (body.get('grant_type') === 'refresh_token') {
        const refresh = body.get('refresh_token')
        const email = refreshTokens.get(refresh)
        if (!email || revoked.has(refresh)) return json(res, 400, { error: 'invalid_grant' })
        const access = token('ya29.fake-')
        accessTokens.set(access, email)
        return json(res, 200, { access_token: access, expires_in: 3599, scope: READONLY, token_type: 'Bearer' })
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }

    if (path === '/revoke' && req.method === 'POST') {
      const value = (await form(req)).get('token')
      if (!refreshTokens.has(value) && !accessTokens.has(value)) return json(res, 400, { error: 'invalid_token' })
      revoked.add(value)
      return json(res, 200, {})
    }

    if (path.startsWith('/gmail/v1/users/me/')) {
      const email = authUser(req)
      if (!email) return json(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED' } })
      const rest = path.slice('/gmail/v1/users/me'.length)
      if (rest === '/profile') return json(res, 200, { emailAddress: email })
      const mail = mailbox()
      if (rest === '/messages') {
        const max = Number(url.searchParams.get('maxResults') ?? 100)
        if (!url.searchParams.get('q')?.startsWith('from:(')) return json(res, 400, { error: 'expected a from: query' })
        return json(res, 200, { messages: mail.slice(0, max).map((m) => ({ id: m.id })), resultSizeEstimate: mail.length })
      }
      const message = mail.find((m) => rest === `/messages/${m.id}`)
      if (!message) return json(res, 404, { error: { code: 404 } })
      if (url.searchParams.get('format') !== 'metadata') return json(res, 400, { error: 'expected format=metadata' })
      return json(res, 200, {
        id: message.id,
        internalDate: message.internalDate,
        snippet: message.snippet,
        payload: {
          headers: [
            { name: 'From', value: message.from },
            { name: 'Subject', value: message.subject },
            { name: 'Date', value: new Date(Number(message.internalDate)).toUTCString() },
          ],
        },
      })
    }

    json(res, 404, { error: 'not_found' })
  } catch (error) {
    console.error(error)
    json(res, 500, { error: String(error) })
  }
}).listen(PORT, () => console.log(`fake google on http://localhost:${PORT}`))
