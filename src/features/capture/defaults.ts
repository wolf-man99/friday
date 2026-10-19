// Which account Quick Add preselects. Order: an account the screen asked for
// (e.g. "add to this account"), the user's configured default, their most
// recent choice for this kind of entry, then money they hold rather than a card.

import type { AccountBalanceRow } from '@/data/database.types'

export type AccountSource = 'context' | 'default' | 'recent' | 'fallback'

export interface AccountPick {
  id: string | null
  source: AccountSource | null
}

export function pickAccount(
  active: Pick<AccountBalanceRow, 'id' | 'type'>[],
  {
    contextId,
    defaultId,
    recentId,
    excludeId,
  }: { contextId?: string | null; defaultId?: string | null; recentId?: string | null; excludeId?: string | null },
): AccountPick {
  const usable = active.filter((a) => a.id !== excludeId)
  const has = (id: string | null | undefined) => Boolean(id && usable.some((a) => a.id === id))
  if (has(contextId)) return { id: contextId!, source: 'context' }
  if (has(defaultId)) return { id: defaultId!, source: 'default' }
  if (has(recentId)) return { id: recentId!, source: 'recent' }
  const fallback = usable.find((a) => a.type !== 'credit_card') ?? usable[0]
  return fallback ? { id: fallback.id, source: 'fallback' } : { id: null, source: null }
}
