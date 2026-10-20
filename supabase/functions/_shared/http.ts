// Response helpers shared by the Gmail functions.

const BASE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

/** CORS for the Friday app's own origins only. */
export function corsHeaders(origin: string | null, allowedOrigins: readonly string[]): Record<string, string> {
  if (!origin || !allowedOrigins.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra },
  })
}

export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { ...BASE_HEADERS, location } })
}

/**
 * Logs an event with an allowlist of fields. Values are short codes chosen by
 * Friday's code — never codes, tokens, email addresses or message content.
 */
export type LogFields = Record<string, string | number | boolean | null>
export type Logger = (event: string, fields?: LogFields) => void

const LOGGABLE = new Set(['action', 'outcome', 'status', 'failure', 'count', 'revoked', 'reason'])

export const defaultLogger: Logger = (event, fields = {}) => {
  const safe: LogFields = {}
  for (const [key, value] of Object.entries(fields)) if (LOGGABLE.has(key)) safe[key] = value
  console.log(JSON.stringify({ event, ...safe }))
}
