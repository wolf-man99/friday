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
// dd-mm-yy as Indian banks write it (in IST).
function ddmmyy(ms) {
  const d = new Date(ms + 5.5 * 3_600_000)
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCFullYear()).slice(2)}`
}
// Typical alert wordings (written for the tests, not anyone's real mail),
// spread over this month and the two before it.
function mailbox() {
  const now = Date.now()
  const ist = new Date(now + 5.5 * 3_600_000)
  const monthStart = (back) => Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - back, 1) - 5.5 * 3_600_000
  const ago = (days) => now - days * day
  const mail = (id, at, from, subject, body, extra = {}) => ({ id, internalDate: String(Math.round(at)), from, subject, body, snippet: body.slice(0, 120), ...extra })
  const HDFC = 'HDFC Bank InstaAlerts <alerts@hdfcbank.net>'
  const ICICI = 'ICICI Bank <credit_cards@icicibank.com>'
  const prev = monthStart(1)
  const older = monthStart(2)
  return [
    mail('a1', ago(1), HDFC, 'Rs.250.00 debited from a/c **1234',
      `Dear Customer, Rs.250.00 has been debited from account **1234 to VPA bluetokai@okaxis BLUE TOKAI on ${ddmmyy(ago(1))}. Your UPI transaction reference number is 429182736451. EMAIL-TEXT-SENTINEL Never share your OTP.`),
    mail('a2', ago(2), ICICI, 'Transaction alert for your ICICI Bank Credit Card',
      `<p>Dear Customer, Your ICICI Bank Credit Card XX9001 has been used for a transaction of INR 1,499.00 on ${ddmmyy(ago(2))}. Info: AMAZON.</p><p>The Available Credit Limit on your card is INR 98,501.00.</p>`, { html: true }),
    mail('f1', ago(3), 'A friend <friend@gmail.com>', 'Dinner money — debited?', 'I transferred the money, check if it was credited'),
    mail('p1', ago(4), 'HDFC Bank <offers@hdfcbank.net.promo-example.com>', 'Your transaction reward', 'Rs.500 cashback credited! Click here'),
    mail('b1', prev + 1 * day + 3_600_000, HDFC, 'Account update for your HDFC Bank A/c',
      `Dear Customer, INR 85,000.00 deposited to A/c No XX1234 towards NEFT Cr-ICIC0000001-ACME PAYROLL SALARY on ${ddmmyy(prev + 1 * day + 3_600_000)}. Avl Bal: INR 1,23,456.78`),
    mail('b2', prev + 5 * day, ICICI, 'Transaction alert for your ICICI Bank Credit Card',
      `Dear Customer, Your ICICI Bank Credit Card XX9001 has been used for a transaction of INR 999.00 on ${ddmmyy(prev + 5 * day)}. Info: SWIGGY.`),
    mail('b3', prev + 7 * day, 'Paytm <no-reply@paytm.com>', 'Payment successful', 'Paid Rs.120 to Chai Point from Paytm Wallet. Order ID 23456789012. Updated Wallet Balance Rs.880'),
    mail('b4', prev + 8 * day, HDFC, 'OTP for your transaction', '482913 is the OTP for your transaction of Rs.1,499.00 at AMAZON. Do not share.'),
    mail('b5', prev + 9 * day, 'YES BANK <alerts@yesbank.in>', 'Debit Alert',
      `Dear Customer, INR 500.00 has been debited from your account XXXX5678 on ${ddmmyy(prev + 9 * day)} for UPI/429100000001/SOMEONE.`),
    mail('b6', prev + 12 * day, HDFC, 'Account debited',
      `Dear Customer, Rs.15,000.00 has been debited from account **1234 towards your ICICI Credit Card bill payment on ${ddmmyy(prev + 12 * day)}. Ref No 427600000003.`),
    mail('c1', older + 10 * day, HDFC, 'Rs.450.00 debited from a/c **1234',
      `Dear Customer, Rs.450.00 has been debited from account **1234 to VPA dmart@okhdfc DMART on ${ddmmyy(older + 10 * day)}. Your UPI transaction reference number is 427100000004.`),
  ].sort((x, y) => Number(y.internalDate) - Number(x.internalDate))
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
      // ?email= limits it to one Google account's tokens.
      const email = url.searchParams.get('email')
      const mine = [...refreshTokens].filter(([, owner]) => !email || owner === email).map(([t]) => t)
      return json(res, 200, { refreshTokens: mine, revoked: [...revoked].filter((t) => mine.includes(t)) })
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
      const email = refreshTokens.get(value) ?? accessTokens.get(value)
      if (!email) return json(res, 400, { error: 'invalid_token' })
      // Like Google: the app's whole grant for that account ends — every token.
      for (const [token, owner] of [...refreshTokens, ...accessTokens]) if (owner === email) revoked.add(token)
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
        const q = url.searchParams.get('q') ?? ''
        if (!q.startsWith('from:(')) return json(res, 400, { error: 'expected a from: query' })
        // Like Gmail: after:/before: in epoch seconds; from: matching is loose
        // (Friday checks senders itself).
        const after = Number(q.match(/\bafter:(\d+)/)?.[1] ?? 0) * 1000
        const before = Number(q.match(/\bbefore:(\d+)/)?.[1] ?? Infinity) * 1000
        const matching = mail.filter((m) => Number(m.internalDate) >= after && Number(m.internalDate) < before)
        const offset = Number(url.searchParams.get('pageToken') ?? 0)
        const page = matching.slice(offset, offset + max)
        return json(res, 200, {
          messages: page.map((m) => ({ id: m.id })),
          resultSizeEstimate: matching.length,
          ...(offset + max < matching.length ? { nextPageToken: String(offset + max) } : {}),
        })
      }
      const message = mail.find((m) => rest === `/messages/${m.id}`)
      if (!message) return json(res, 404, { error: { code: 404 } })
      const domain = message.from.match(/@([^>\s]+)/)?.[1] ?? ''
      const headers = [
        { name: 'From', value: message.from },
        { name: 'Subject', value: message.subject },
        { name: 'Date', value: new Date(Number(message.internalDate)).toUTCString() },
        { name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.i=@${domain}; spf=pass; dmarc=pass header.from=${domain}` },
      ]
      if (url.searchParams.get('format') === 'full') {
        return json(res, 200, {
          id: message.id,
          internalDate: message.internalDate,
          payload: {
            mimeType: 'multipart/alternative',
            headers,
            parts: [{ mimeType: message.html ? 'text/html' : 'text/plain', body: { data: Buffer.from(message.body).toString('base64url') } }],
          },
        })
      }
      if (url.searchParams.get('format') !== 'metadata') return json(res, 400, { error: 'expected format=metadata or full' })
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
