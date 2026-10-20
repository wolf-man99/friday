// A fresh Gmail access token for the signed-in user's connection, used by the
// preview and by imports. Only Google's own invalid_grant marks the connection
// for reconnecting; server problems never delete anyone's access.

import type { GmailConfig } from './config.ts'
import { refreshTokenContext, type TokenCipher } from './crypto.ts'
import { GoogleError, googleEndpoints, refreshAccessToken, type Fetch, type GoogleEndpoints } from './google.ts'
import type { Logger } from './http.ts'
import type { Credentials, GmailStore } from './store.ts'

export interface AccessDeps {
  config: GmailConfig
  store: GmailStore
  cipher: TokenCipher
  fetch: Fetch
  log: Logger
}

export type Access =
  | { ok: true; accessToken: string; credentials: Credentials; endpoints: GoogleEndpoints }
  | { ok: false; status: number; body: { error: string; message: string } }

export async function gmailAccess(userId: string, deps: AccessDeps, action: string): Promise<Access> {
  const credentials = await deps.store.getCredentials(userId)
  if (!credentials) return { ok: false, status: 409, body: { error: 'not_connected', message: 'Gmail isn’t connected.' } }
  const endpoints = googleEndpoints(deps.config.googleTestOrigin)

  let refreshToken: string
  try {
    refreshToken = await deps.cipher.decrypt(credentials.refreshTokenEnc, refreshTokenContext(userId))
  } catch {
    // A wrong encryption key (a server setting) or a damaged row: keep the
    // credential — deleting it would lose access that may still be valid.
    deps.log('gmail_connection_failed', { action, reason: 'decrypt_failed' })
    return {
      ok: false,
      status: 409,
      body: { error: 'credential_unreadable', message: 'Friday can’t read its stored Gmail access. Connect Gmail again to replace it.' },
    }
  }

  try {
    const accessToken = await refreshAccessToken(deps.fetch, endpoints, {
      clientId: deps.config.clientId,
      clientSecret: deps.config.clientSecret,
      refreshToken,
    })
    return { ok: true, accessToken, credentials, endpoints }
  } catch (error) {
    if (!(error instanceof GoogleError && error.failure === 'invalid_grant')) throw error
    // Revoked at Google or expired: this credential is useless.
    await deps.store.markNeedsReconnect(userId, credentials.connectionId, credentials.refreshTokenEnc, 'invalid_grant')
    deps.log('gmail_needs_reconnect', { action, reason: 'invalid_grant' })
    return { ok: false, status: 409, body: { error: 'needs_reconnect', message: 'Google no longer accepts Friday’s access. Connect Gmail again.' } }
  }
}
