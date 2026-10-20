// The few Google endpoints Friday uses, behind an injectable fetch so tests
// never talk to Google. Requests carry timeouts; responses are read for the
// fields Friday needs and nothing else. Errors never include token values.

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export type Fetch = typeof fetch

export interface GoogleEndpoints {
  authorize: string
  token: string
  revoke: string
  gmail: string
}

export function googleEndpoints(testOrigin: string | null = null): GoogleEndpoints {
  if (testOrigin) {
    return {
      authorize: `${testOrigin}/o/oauth2/v2/auth`,
      token: `${testOrigin}/token`,
      revoke: `${testOrigin}/revoke`,
      gmail: `${testOrigin}/gmail/v1`,
    }
  }
  return {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    revoke: 'https://oauth2.googleapis.com/revoke',
    gmail: 'https://gmail.googleapis.com/gmail/v1',
  }
}

export type GoogleFailure =
  | 'invalid_grant' // refresh token revoked/expired, or the code was already used
  | 'invalid_client' // Friday's client ID/secret is wrong: a server problem, not the person's
  | 'unauthorized' // an access token was refused
  | 'access_denied'
  | 'insufficient_scope'
  | 'rate_limited'
  | 'unavailable'
  | 'bad_response'

export class GoogleError extends Error {
  constructor(
    readonly failure: GoogleFailure,
    readonly status: number | null = null,
  ) {
    super(`Google request failed: ${failure}${status ? ` (${status})` : ''}`)
  }
}

const TIMEOUT_MS = 10_000

async function call(fetchFn: Fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new GoogleError('unavailable')
  }
}

async function failureFrom(response: Response): Promise<GoogleError> {
  let code = ''
  try {
    const body = await response.json()
    code = String(body?.error?.status ?? body?.error ?? '').toLowerCase()
  } catch {
    // The body isn't needed beyond its error code.
  }
  // Only Google's own invalid_grant means the person's access is gone; a wrong
  // client secret (401 invalid_client) must never be mistaken for it.
  if (code === 'invalid_grant') return new GoogleError('invalid_grant', response.status)
  if (code === 'invalid_client' || code === 'unauthorized_client') return new GoogleError('invalid_client', response.status)
  if (code === 'access_denied') return new GoogleError('access_denied', response.status)
  if (response.status === 403 && (code.includes('permission') || code.includes('scope'))) {
    return new GoogleError('insufficient_scope', response.status)
  }
  if (response.status === 401) return new GoogleError('unauthorized', response.status)
  if (response.status === 429) return new GoogleError('rate_limited', response.status)
  if (response.status >= 500) return new GoogleError('unavailable', response.status)
  return new GoogleError('bad_response', response.status)
}

export interface AuthorizationRequest {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}

/** Authorization-code flow with PKCE, offline access, Gmail read-only and nothing else. */
export function buildAuthorizationUrl(endpoints: GoogleEndpoints, request: AuthorizationRequest): string {
  const url = new URL(endpoints.authorize)
  url.search = new URLSearchParams({
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    response_type: 'code',
    scope: GMAIL_READONLY_SCOPE,
    access_type: 'offline',
    // Always show consent, so Google always returns a refresh token.
    prompt: 'consent',
    // Don't fold in scopes granted earlier: Friday holds exactly gmail.readonly.
    include_granted_scopes: 'false',
    state: request.state,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

export interface TokenGrant {
  accessToken: string
  refreshToken: string | null
  scopes: string[]
}

export async function exchangeCode(
  fetchFn: Fetch,
  endpoints: GoogleEndpoints,
  input: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string },
): Promise<TokenGrant> {
  const response = await call(fetchFn, endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  })
  if (!response.ok) throw await failureFrom(response)
  const body = await response.json().catch(() => null)
  if (!body || typeof body.access_token !== 'string') throw new GoogleError('bad_response', response.status)
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
  }
}

export async function refreshAccessToken(
  fetchFn: Fetch,
  endpoints: GoogleEndpoints,
  input: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<string> {
  const response = await call(fetchFn, endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }),
  })
  if (!response.ok) throw await failureFrom(response)
  const body = await response.json().catch(() => null)
  if (!body || typeof body.access_token !== 'string') throw new GoogleError('bad_response', response.status)
  return body.access_token
}

/**
 * Revokes a refresh (or access) token. Resolves true when Google confirmed it.
 * Google then ends Friday's whole grant for that Gmail account — every token,
 * not just this one — so callers only revoke what nothing else depends on.
 */
export async function revokeToken(fetchFn: Fetch, endpoints: GoogleEndpoints, token: string): Promise<boolean> {
  try {
    const response = await call(fetchFn, endpoints.revoke, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    })
    // 400 invalid_token means it was already revoked or expired: also fine.
    return response.ok || response.status === 400
  } catch {
    return false
  }
}

async function gmailGet(fetchFn: Fetch, url: string, accessToken: string) {
  const response = await call(fetchFn, url, { headers: { authorization: `Bearer ${accessToken}` } })
  if (!response.ok) throw await failureFrom(response)
  const body = await response.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new GoogleError('bad_response', response.status)
  return body
}

/** The connected mailbox's address (gmail.readonly allows users.getProfile). */
export async function getGmailAddress(fetchFn: Fetch, endpoints: GoogleEndpoints, accessToken: string): Promise<string> {
  const body = await gmailGet(fetchFn, `${endpoints.gmail}/users/me/profile?fields=emailAddress`, accessToken)
  if (typeof body.emailAddress !== 'string' || !body.emailAddress.includes('@')) {
    throw new GoogleError('bad_response')
  }
  return body.emailAddress.toLowerCase()
}

export async function listMessageIds(
  fetchFn: Fetch,
  endpoints: GoogleEndpoints,
  accessToken: string,
  query: string,
  maxResults: number,
): Promise<{ ids: string[]; estimate: number }> {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults), fields: 'messages/id,resultSizeEstimate' })
  const body = await gmailGet(fetchFn, `${endpoints.gmail}/users/me/messages?${params}`, accessToken)
  const ids = Array.isArray(body.messages)
    ? body.messages.map((message: { id?: unknown }) => message.id).filter((id: unknown): id is string => typeof id === 'string')
    : []
  return { ids: ids.slice(0, maxResults), estimate: Number(body.resultSizeEstimate) || ids.length }
}

export interface MessageMetadata {
  id: string
  internalDate: string | null
  snippet: string
  headers: { name?: string; value?: string }[]
}

/** Headers needed to recognise an alert, plus Gmail's short snippet. No body, no attachments. */
export async function getMessageMetadata(
  fetchFn: Fetch,
  endpoints: GoogleEndpoints,
  accessToken: string,
  id: string,
): Promise<MessageMetadata> {
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new GoogleError('bad_response')
  const params = new URLSearchParams({ format: 'metadata', fields: 'id,internalDate,snippet,payload/headers' })
  for (const name of ['From', 'Subject', 'Date']) params.append('metadataHeaders', name)
  const body = await gmailGet(fetchFn, `${endpoints.gmail}/users/me/messages/${id}?${params}`, accessToken)
  return {
    id: String(body.id ?? id),
    internalDate: typeof body.internalDate === 'string' ? body.internalDate : null,
    snippet: typeof body.snippet === 'string' ? body.snippet : '',
    headers: Array.isArray(body.payload?.headers) ? body.payload.headers : [],
  }
}

/** Every message id matching a search, newest first, up to `cap`. */
export async function listAllMessageIds(
  fetchFn: Fetch,
  endpoints: GoogleEndpoints,
  accessToken: string,
  query: string,
  cap: number,
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = []
  let pageToken: string | null = null
  do {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(500, cap - ids.length + 1)), fields: 'messages/id,nextPageToken' })
    if (pageToken) params.set('pageToken', pageToken)
    const body = await gmailGet(fetchFn, `${endpoints.gmail}/users/me/messages?${params}`, accessToken)
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      if (typeof message?.id === 'string') ids.push(message.id)
    }
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : null
  } while (pageToken && ids.length <= cap)
  return { ids: ids.slice(0, cap), truncated: ids.length > cap || pageToken !== null }
}

export interface MessagePart {
  mimeType?: string
  headers?: { name?: string; value?: string }[]
  body?: { data?: string; size?: number }
  parts?: MessagePart[]
}

export interface FullMessage {
  id: string
  internalDate: number
  payload: MessagePart
}

/** One message with its text parts, read in memory only (to parse an alert). */
export async function getFullMessage(fetchFn: Fetch, endpoints: GoogleEndpoints, accessToken: string, id: string): Promise<FullMessage> {
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new GoogleError('bad_response')
  const params = new URLSearchParams({ format: 'full', fields: 'id,internalDate,payload' })
  const body = await gmailGet(fetchFn, `${endpoints.gmail}/users/me/messages/${id}?${params}`, accessToken)
  return {
    id: String(body.id ?? id),
    internalDate: Number(body.internalDate) || Date.now(),
    payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
  }
}
