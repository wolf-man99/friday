// Turns database / network failures into specific, human messages.
// Never surfaces raw SQL, and never says just "Something went wrong" when a
// more useful message exists.

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
  recurring_rules_category_fk: 'That category doesn’t match this type of entry',
  categories_active_name_unique: 'You already have a category with that name',
  recurring_rules_end_after_start: 'The end date must be after the start date',
}

export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

export function friendlyError(error: unknown): string {
  if (isOffline()) return 'You’re offline — nothing was saved. Try again once you’re connected.'

  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return 'Couldn’t reach Friday’s server. Check your connection and try again.'
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
