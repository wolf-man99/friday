// The Gmail connection: its status is an ordinary RLS-protected read; every
// action goes through the gmail-connection Edge Function, which holds the
// Google client secret and the encrypted refresh token. Nothing secret ever
// reaches the browser — the app only sees the Google consent URL, a one-time
// ticket, and alert metadata it asked to preview.

import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { friendlyError, isOffline } from '@/lib/errors'
import type { GmailImportJobRow, SourceConnectionRow } from './database.types'

export type GmailConnection = Pick<
  SourceConnectionRow,
  'id' | 'status' | 'account_email' | 'scopes' | 'connected_at' | 'last_checked_at' | 'last_error_code'
>

/** The person's live Gmail connection (active or needing a reconnect), if any. */
export async function fetchGmailConnection(): Promise<GmailConnection | null> {
  const { data, error } = await supabase
    .from('source_connections')
    .select('id, status, account_email, scopes, connected_at, last_checked_at, last_error_code')
    .eq('provider', 'gmail')
    .neq('status', 'disconnected')
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data as GmailConnection | null
}

/** A refusal from the Gmail function, already in words for people. */
export class GmailServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'GmailServiceError'
  }
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>('gmail-connection', { body })
  if (!error) return data as T

  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response
    const payload = (await response.json().catch(() => null)) as { error?: string; message?: string; code?: string } | null
    if (payload?.error && payload.message) throw new GmailServiceError(payload.message, payload.error)
    // Supabase's gateway: the function isn't deployed on this project.
    if (response.status === 404) throw new GmailServiceError(NOT_DEPLOYED, 'not_deployed')
    throw new GmailServiceError('Friday’s Gmail service had a problem. Try again in a minute.', 'server')
  }
  if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) {
    throw new GmailServiceError(
      isOffline() ? 'You’re offline. Connect to the internet and try again.' : `Couldn’t reach Friday’s Gmail service. ${NOT_DEPLOYED}`,
      'unreachable',
    )
  }
  throw error
}

const NOT_DEPLOYED = 'If Gmail was only just set up, check that the gmail-connection function is deployed.'

// The server binds each connection attempt to the browser that started it:
// this key stays here until Google sends the person back, and completing
// needs it. A link from someone else's attempt can't be completed here.
const BROWSER_KEY = 'friday:gmail-browser-key'

function rememberBrowserKey(key: string) {
  try {
    localStorage.setItem(BROWSER_KEY, key)
  } catch {
    // No storage: completing will say it was started elsewhere.
  }
}

function takeBrowserKey(): string | null {
  try {
    const key = localStorage.getItem(BROWSER_KEY)
    localStorage.removeItem(BROWSER_KEY)
    return key
  } catch {
    return null
  }
}

/** Google's consent page for this user (the function stores the one-time state). */
export async function startGmailConnection(): Promise<{ url: string }> {
  const { url, browserKey } = await invoke<{ url: string; browserKey: string }>({ action: 'start' })
  rememberBrowserKey(browserKey)
  return { url }
}

/** Activates the grant Google's redirect parked — only for the user and browser that started it. */
export function completeGmailConnection(ticket: string): Promise<{ connection: { id: string; accountEmail: string; status: 'active' } }> {
  return invoke({ action: 'complete', ticket, browserKey: takeBrowserKey() })
}

/** Deletes Friday's stored Gmail access and revokes it with Google. */
export function disconnectGmail(): Promise<{ disconnected: true; revoked: boolean; removed: number }> {
  return invoke({ action: 'disconnect' })
}

export function gmailErrorMessage(error: unknown): string {
  return error instanceof GmailServiceError ? error.message : friendlyError(error)
}

/** What the callback's ?gmail_error=<code> means, in words. */
export const CALLBACK_ERRORS: Record<string, string> = {
  access_denied: 'You didn’t allow access on Google’s screen, so nothing was connected.',
  google_error: 'Google reported a problem, so nothing was connected. Try again.',
  invalid_request: 'That link from Google wasn’t complete. Start again from this page.',
  invalid_state: 'That link from Google wasn’t one Friday started (or it was cancelled). Start again from this page.',
  link_expired: 'That took longer than ten minutes, so it was cancelled. Start again.',
  link_used: 'That link from Google was already used. Start again if you still want to connect.',
  exchange_failed: 'Google didn’t confirm the connection. Try again.',
  scope_missing: 'Friday needs permission to read Gmail. Leave the Gmail box ticked on Google’s screen.',
  no_refresh_token:
    'Google didn’t give Friday lasting access. Try again — if it keeps happening, remove Friday at myaccount.google.com/permissions first.',
  profile_failed: 'Friday couldn’t read your Gmail address, so nothing was connected. Try again.',
  server_error: 'Something went wrong on Friday’s server, so nothing was connected. Try again.',
}

export function callbackErrorMessage(code: string): string {
  // Own keys only: the code comes from the address bar (e.g. ?gmail_error=__proto__).
  return Object.prototype.hasOwnProperty.call(CALLBACK_ERRORS, code) ? CALLBACK_ERRORS[code] : CALLBACK_ERRORS.google_error
}

// --- Importing past months -----------------------------------------------------------

/** The latest import, whatever its state (null if there has never been one). */
export async function fetchLatestImport(): Promise<GmailImportJobRow | null> {
  const { data, error } = await supabase
    .from('gmail_import_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data as GmailImportJobRow | null
}

export interface DiscoveredAccount {
  institutionKey: string
  institutionName: string
  instrument: 'bank' | 'credit_card' | 'debit_card' | 'wallet' | 'unknown'
  accountMask: string
  messages: number
  firstAt: string | null
  lastAt: string | null
  linkedAccountId: string | null
  linkedIgnored: boolean
  suggestedAccountId: string | null
  suggestedName: string
  suggestedType: 'bank' | 'credit_card' | 'wallet' | null
}

export type AccountChoice =
  | { action: 'link'; accountId: string }
  | { action: 'create'; name: string; type: 'bank' | 'credit_card' | 'wallet'; openingBalanceMinor?: number }
  | { action: 'ignore' }
  | { action: 'review' }

export type AccountDecision = Pick<DiscoveredAccount, 'institutionKey' | 'instrument' | 'accountMask'> & AccountChoice

export interface ImportProgress {
  status: GmailImportJobRow['status']
  scanned?: number
  total?: number
  remaining?: number
}

export function startImport(months: string[]): Promise<{ jobId: string; total: number; truncated: boolean }> {
  return invoke({ action: 'import-start', months })
}

export function scanImport(jobId: string): Promise<ImportProgress> {
  return invoke({ action: 'import-scan', jobId })
}

export async function importAccounts(jobId: string): Promise<DiscoveredAccount[]> {
  return (await invoke<{ accounts: DiscoveredAccount[] }>({ action: 'import-accounts', jobId })).accounts
}

export function confirmImportAccounts(jobId: string, decisions: AccountDecision[]): Promise<{ created: number; linked: number; kept: number }> {
  return invoke({ action: 'import-confirm', jobId, decisions })
}

export function runImport(jobId: string): Promise<ImportProgress> {
  return invoke({ action: 'import-run', jobId })
}

export function undoImport(jobId: string): Promise<{ removed: number; kept: number }> {
  return invoke({ action: 'import-undo', jobId })
}

export function cancelImport(jobId: string): Promise<{ cancelled: true }> {
  return invoke({ action: 'import-cancel', jobId })
}
