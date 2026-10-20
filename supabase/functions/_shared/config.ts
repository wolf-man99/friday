// Function configuration, read once from secrets. Missing values are reported
// by name only — never by value.

import { parseSenderRules } from './gmailQuery.ts'

export interface GmailConfig {
  supabaseUrl: string
  serviceRoleKey: string
  clientId: string
  clientSecret: string
  /** Must exactly match an authorised redirect URI in Google Cloud. */
  redirectUri: string
  /** Where people are sent back to, e.g. https://friday.example.com */
  appUrl: string
  /** Browser origins allowed to call gmail-connection (the app, plus any extras). */
  allowedOrigins: string[]
  encryptionKey: string
  alertSenders: string[]
  /** Local tests only: send every Google call to this origin instead. */
  googleTestOrigin: string | null
}

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GMAIL_OAUTH_REDIRECT_URI',
  'GMAIL_TOKEN_ENCRYPTION_KEY',
  'FRIDAY_APP_URL',
] as const

export type ConfigResult = { ok: true; config: GmailConfig } | { ok: false; missing: string[] }

function isLocal(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function origin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || isLocal(parsed.hostname) ? parsed.origin : null
  } catch {
    return null
  }
}

export function readConfig(get: (name: string) => string | undefined): ConfigResult {
  const value = (name: string) => get(name)?.trim() || ''
  const missing: string[] = REQUIRED.filter((name) => !value(name))

  const appOrigin = origin(value('FRIDAY_APP_URL'))
  if (value('FRIDAY_APP_URL') && !appOrigin) missing.push('FRIDAY_APP_URL (must be an https URL)')
  if (value('GMAIL_OAUTH_REDIRECT_URI') && !origin(value('GMAIL_OAUTH_REDIRECT_URI'))) {
    missing.push('GMAIL_OAUTH_REDIRECT_URI (must be an https URL)')
  }
  // Sends every Google call (with the client secret) elsewhere, so only ever a local fake.
  const testOrigin = value('FRIDAY_GOOGLE_TEST_ORIGIN')
  let googleTestOrigin: string | null = null
  if (testOrigin) {
    try {
      const parsed = new URL(testOrigin)
      if (isLocal(parsed.hostname)) googleTestOrigin = parsed.origin
    } catch {
      // Reported below.
    }
    if (!googleTestOrigin) missing.push('FRIDAY_GOOGLE_TEST_ORIGIN (local tests only: http://localhost:<port>)')
  }
  if (missing.length > 0) return { ok: false, missing }

  const extraOrigins = value('FRIDAY_ALLOWED_ORIGINS')
    .split(',')
    .map((entry) => origin(entry.trim()))
    .filter((entry): entry is string => Boolean(entry))

  return {
    ok: true,
    config: {
      supabaseUrl: value('SUPABASE_URL'),
      serviceRoleKey: value('SUPABASE_SERVICE_ROLE_KEY'),
      clientId: value('GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: value('GOOGLE_OAUTH_CLIENT_SECRET'),
      redirectUri: value('GMAIL_OAUTH_REDIRECT_URI'),
      appUrl: appOrigin!,
      allowedOrigins: [...new Set([appOrigin!, ...extraOrigins])],
      encryptionKey: value('GMAIL_TOKEN_ENCRYPTION_KEY'),
      alertSenders: parseSenderRules(value('GMAIL_ALERT_SENDERS')),
      googleTestOrigin,
    },
  }
}
