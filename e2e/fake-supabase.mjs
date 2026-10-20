// A tiny stand-in for Supabase's API gateway, for local end-to-end tests:
//   /rest/v1/*  → proxied to a local PostgREST (real SQL, real RLS)
//   /auth/v1/*  → minimal email/password auth that mints JWTs PostgREST trusts
//   /functions/v1/* → proxied to a local Edge Functions server (FUNCTIONS_URL), if set
// Users are created in the test database's auth.users table, so the sign-up
// trigger, profile and default categories run exactly as in production.
//
// Env: PORT (54321), POSTGREST_URL (http://localhost:3000), JWT_SECRET,
//      DATABASE_URL (postgres superuser URL of the test database), FUNCTIONS_URL

import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 54321)
const POSTGREST_URL = process.env.POSTGREST_URL ?? 'http://localhost:3000'
const JWT_SECRET = process.env.JWT_SECRET ?? 'local-dev-jwt-secret-at-least-32-characters-long'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/friday_e2e'
const FUNCTIONS_URL = process.env.FUNCTIONS_URL ?? ''

const passwords = new Map() // email → { id, password, metadata }

function sql(query, ...params) {
  const args = [DATABASE_URL, '-tAq', '-v', 'ON_ERROR_STOP=1']
  params.forEach((value, i) => args.push('-v', `p${i + 1}=${value}`))
  // Variables are only interpolated when the SQL arrives on stdin, not via -c.
  return execFileSync('psql', args, { input: query, encoding: 'utf8' }).trim()
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

function sign(user) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64({ alg: 'HS256', typ: 'JWT' })
  const payload = b64({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 })
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

function decode(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  } catch {
    return null
  }
}

function userJson(user) {
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: user.metadata ?? {},
    created_at: new Date().toISOString(),
  }
}

function session(user) {
  return {
    access_token: sign(user),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `refresh-${user.id}`,
    user: userJson(user),
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-allow-headers':
    'authorization,apikey,content-type,prefer,x-client-info,accept-profile,content-profile,range,x-supabase-api-version',
  'access-control-expose-headers': 'content-range,content-location',
}

function send(res, status, body) {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function handleAuth(req, res, url) {
  const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') : {}
  const path = url.pathname.replace('/auth/v1', '')

  if (path === '/signup') {
    const email = String(body.email).toLowerCase()
    if (passwords.has(email)) return send(res, 422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' })
    const id = randomUUID()
    const metadata = body.data ?? {}
    // As GoTrue does: the non-superuser auth role inserts, and the trigger runs.
    sql(
      `set role supabase_auth_admin; insert into auth.users (id, email, raw_user_meta_data) values (:'p1', :'p2', :'p3'::jsonb)`,
      id,
      email,
      JSON.stringify(metadata),
    )
    const user = { id, email, password: body.password, metadata }
    passwords.set(email, user)
    return send(res, 200, session(user))
  }

  if (path === '/token') {
    const grant = url.searchParams.get('grant_type')
    if (grant === 'password') {
      const user = passwords.get(String(body.email).toLowerCase())
      if (!user || user.password !== body.password) {
        return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
      }
      return send(res, 200, session(user))
    }
    if (grant === 'refresh_token') {
      const id = String(body.refresh_token).replace('refresh-', '')
      const user = [...passwords.values()].find((u) => u.id === id)
      return user ? send(res, 200, session(user)) : send(res, 400, { msg: 'Invalid Refresh Token' })
    }
  }

  if (path === '/user') {
    const claims = decode((req.headers.authorization ?? '').replace('Bearer ', ''))
    const user = claims && [...passwords.values()].find((u) => u.id === claims.sub)
    return user ? send(res, 200, userJson(user)) : send(res, 401, { msg: 'invalid JWT' })
  }

  if (path === '/logout') return send(res, 204)
  if (path === '/recover') return send(res, 200, {})
  return send(res, 404, { msg: `fake auth: ${path} not implemented` })
}

async function proxyRest(req, res, url) {
  const target = POSTGREST_URL + url.pathname.replace('/rest/v1', '') + url.search
  const headers = { ...req.headers }
  delete headers.host
  delete headers.apikey
  // PostgREST rejects the publishable key; only forward real JWTs (a user's, or the service role's).
  if (headers.authorization && !decode(headers.authorization.replace('Bearer ', ''))?.role) delete headers.authorization
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req)
  const response = await fetch(target, { method: req.method, headers, body })
  const out = Buffer.from(await response.arrayBuffer())
  const passHeaders = {}
  for (const name of ['content-type', 'content-range', 'content-location', 'preference-applied']) {
    const value = response.headers.get(name)
    if (value) passHeaders[name] = value
  }
  res.writeHead(response.status, { ...CORS, ...passHeaders })
  res.end(out)
}

// Like Supabase's gateway: passes requests (preflights included) straight to
// the function and its response straight back, redirects unfollowed.
async function proxyFunction(req, res, url) {
  if (!FUNCTIONS_URL) return send(res, 404, { code: 'NOT_FOUND', message: 'Requested function was not found' })
  const target = FUNCTIONS_URL + url.pathname.replace('/functions/v1', '') + url.search
  const headers = { ...req.headers }
  delete headers.host
  const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : await readBody(req)
  const response = await fetch(target, { method: req.method, headers, body, redirect: 'manual' })
  const out = Buffer.from(await response.arrayBuffer())
  // fetch already decoded the body, so its encoding and length no longer apply.
  const passHeaders = Object.fromEntries(response.headers)
  for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) delete passHeaders[name]
  res.writeHead(response.status, passHeaders)
  res.end(out)
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    if (url.pathname.startsWith('/functions/v1/')) return await proxyFunction(req, res, url)
    if (req.method === 'OPTIONS') return send(res, 204)
    if (url.pathname.startsWith('/auth/v1')) return await handleAuth(req, res, url)
    if (url.pathname.startsWith('/rest/v1')) return await proxyRest(req, res, url)
    if (url.pathname === '/health') return send(res, 200, { ok: true })
    send(res, 404, { msg: 'not found' })
  } catch (error) {
    console.error(error)
    send(res, 500, { msg: String(error) })
  }
}).listen(PORT, () => console.log(`fake supabase on http://localhost:${PORT}`))
