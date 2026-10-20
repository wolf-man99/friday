// Wiring for the two Gmail functions: configuration from function secrets, the
// service-role database client, the token cipher. Built once per isolate. The
// service-role key and the encryption key stay in this process; neither is
// ever sent to a browser.

import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { handleCallback } from './callback.ts'
import { readConfig, type GmailConfig } from './config.ts'
import { handleConnection } from './connection.ts'
import { TokenCipher } from './crypto.ts'
import { defaultLogger, json, redirect } from './http.ts'
import { SupabaseGmailStore } from './store.ts'

type Env = (name: string) => string | undefined
type Handler = (req: Request) => Promise<Response>

interface Runtime {
  config: GmailConfig
  store: SupabaseGmailStore
  cipher: TokenCipher
  authenticate: (accessToken: string) => Promise<string | null>
}

type Loaded = { ok: true; runtime: Runtime } | { ok: false; missing: string[]; appUrl: string | null }

async function load(env: Env): Promise<Loaded> {
  const result = readConfig(env)
  if (!result.ok) return { ok: false, missing: result.missing, appUrl: null }
  const { config } = result

  let cipher: TokenCipher
  try {
    cipher = await TokenCipher.fromBase64Key(config.encryptionKey)
  } catch {
    return { ok: false, missing: ['GMAIL_TOKEN_ENCRYPTION_KEY (must be 32 random bytes, base64)'], appUrl: config.appUrl }
  }

  const db = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return {
    ok: true,
    runtime: {
      config,
      store: new SupabaseGmailStore(db),
      cipher,
      // Supabase Auth checks the token's signature and expiry and returns its user.
      authenticate: async (accessToken) => {
        const { data, error } = await db.auth.getUser(accessToken)
        return error ? null : (data.user?.id ?? null)
      },
    },
  }
}

function lazy(env: Env): () => Promise<Loaded> {
  let loading: Promise<Loaded> | null = null
  return () => {
    loading ??= load(env).then((loaded) => {
      // Names of missing settings only; never values.
      if (!loaded.ok) console.error(JSON.stringify({ event: 'gmail_not_configured', missing: loaded.missing }))
      return loaded
    })
    return loading
  }
}

const NOT_CONFIGURED = { error: 'not_configured', message: 'Gmail isn’t set up on this Friday server yet.' }

/** gmail-connection: POST { action } from the signed-in app. */
export function connectionServer(env: Env = (name) => Deno.env.get(name), fetchFn: typeof fetch = fetch): Handler {
  const runtime = lazy(env)
  return async (req) => {
    const loaded = await runtime()
    if (!loaded.ok) {
      // Says only "not set up"; CORS so the app can show it.
      const origin = req.headers.get('origin')
      const cors: Record<string, string> = origin
        ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', vary: 'Origin' }
        : {}
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
      return json(503, NOT_CONFIGURED, cors)
    }
    return handleConnection(req, { ...loaded.runtime, fetch: fetchFn, log: defaultLogger })
  }
}

/** gmail-oauth-callback: where Google sends the browser back. */
export function callbackServer(env: Env = (name) => Deno.env.get(name), fetchFn: typeof fetch = fetch): Handler {
  const runtime = lazy(env)
  return async (req) => {
    const loaded = await runtime()
    if (!loaded.ok) {
      if (loaded.appUrl) return redirect(`${loaded.appUrl}/connections/gmail?gmail_error=server_error`)
      return json(503, NOT_CONFIGURED)
    }
    const { config, store, cipher } = loaded.runtime
    return handleCallback(req, { config, store, cipher, fetch: fetchFn, log: defaultLogger })
  }
}
