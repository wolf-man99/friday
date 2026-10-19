// Turns database / network failures into specific, human messages.
// Never surfaces raw SQL, and never says just "Something went wrong" when a
// more useful message exists.

import type { ErrorClass } from './analytics'

interface PostgrestLikeError {
  code?: string
  message?: string
  details?: string | null
  hint?: string | null
}

const CONSTRAINT_MESSAGES: Record<string, string> = {
  transfers_distinct_accounts: 'Pick two different accounts',
  accounts_currency_supported: 'Friday only supports INR for now',
  transactions_category_fk: 'That category doesn’t match this type of entry',
  transactions_merchant_length: 'Keep merchant names under 120 characters',
  recurring_rules_category_fk: 'That category doesn’t match this type of entry',
  categories_active_name_unique: 'You already have a category with that name',
  recurring_rules_end_after_start: 'The end date must be after the start date',
}

export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

const NETWORK_MESSAGE = /failed to fetch|networkerror|network request failed|load failed|fetch failed|timed? ?out|aborted/i

/** The request may never have reached the server, or its reply was lost. */
export function isNetworkError(error: unknown): boolean {
  if (isOffline()) return true
  const e = (error ?? {}) as PostgrestLikeError & { name?: string }
  if (e.name === 'AbortError') return true
  return NETWORK_MESSAGE.test(`${e.message ?? ''} ${e.details ?? ''}`) && !e.code
}

const OUTDATED_SCHEMA_CODES = ['PGRST202', 'PGRST205', '42883', '42P01', '42703']

/** The database is missing an RPC/table/column the app expects: a migration wasn't applied. */
export function isOutdatedSchema(error: unknown): boolean {
  return OUTDATED_SCHEMA_CODES.includes((error as PostgrestLikeError | null)?.code ?? '')
}

export function classifyError(error: unknown): ErrorClass {
  if (isOffline()) return 'offline'
  if (isNetworkError(error)) return 'network'
  if (isOutdatedSchema(error)) return 'outdated_schema'
  const code = (error as PostgrestLikeError | null)?.code ?? ''
  if (code === 'PT409' || code === '40001') return 'conflict'
  if (['22023', '23503', '23505', '23514', 'P0001', 'P0002', '22P02'].includes(code)) return 'validation'
  if (['28000', '42501', 'PGRST301', 'PGRST303'].includes(code)) return 'auth'
  if (code) return 'server'
  return 'unknown'
}

export function friendlyError(error: unknown): string {
  if (isOffline()) return 'You’re offline — nothing was saved. Try again once you’re connected.'

  if ((error instanceof TypeError && /fetch|network/i.test(error.message)) || isNetworkError(error)) {
    return 'Couldn’t reach Friday’s server. Check your connection and try again.'
  }
  if (isOutdatedSchema(error)) {
    return 'Friday’s database needs an update: run the newest file in supabase/migrations in the Supabase SQL editor.'
  }

  const e = (error ?? {}) as PostgrestLikeError
  const text = `${e.message ?? ''} ${e.details ?? ''}`

  for (const [constraint, message] of Object.entries(CONSTRAINT_MESSAGES)) {
    if (text.includes(constraint)) return message
  }

  switch (e.code) {
    // Messages raised deliberately by our triggers / functions are user-ready.
    case 'P0001':
    case 'P0002':
    case '22023':
    case 'PT409':
      return e.message ?? 'That change isn’t allowed'
    case '23503':
      return e.message && !e.message.includes('violates') ? e.message : 'That item no longer exists'
    case '23505':
      return 'That already exists'
    case '23514':
      return 'Amounts must be more than zero'
    case '42501':
      return 'You don’t have access to that'
    case 'PGRST301':
    case 'PGRST303':
      return 'Your session expired. Please sign in again.'
  }

  if (e.message && e.message.length < 140 && !/violates|syntax|relation|column/i.test(e.message)) {
    return e.message
  }
  return 'Friday couldn’t save that. Please try again.'
}
