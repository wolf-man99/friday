// Category suggestions from the user's own history. Rule-based and local: no
// model, no network. A suggestion is only offered when the history clearly
// supports it; otherwise the entry stays uncategorised until the user picks.
// Corrections teach it automatically, because history holds final choices.

import type { TransactionType } from '@/data/database.types'

export interface HistoryItem {
  kind: TransactionType
  categoryId: string | null
  merchant: string | null
  accountId: string
  amountMinor: number
}

export interface CategorySuggestion {
  categoryId: string
  /** 'merchant': this merchant is usually filed here. 'frequent': your most common category lately. */
  reason: 'merchant' | 'frequent'
  /** How many past entries back it up. */
  basis: number
}

export const SUGGESTION_RULES = {
  /** Same merchant: at least this many past entries… */
  merchantMinCount: 2,
  /** …and this share of them in one category. */
  merchantMinShare: 0.6,
  /** No merchant match: look at this many recent entries of the same kind… */
  recentWindow: 40,
  /** …needing this many categorised ones… */
  frequentMinCount: 5,
  /** …with one category holding this share. */
  frequentMinShare: 0.45,
}

export function normaliseMerchant(merchant: string | null | undefined) {
  return (merchant ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function dominant(items: HistoryItem[]) {
  const counts = new Map<string, number>()
  for (const item of items) if (item.categoryId) counts.set(item.categoryId, (counts.get(item.categoryId) ?? 0) + 1)
  let best: { categoryId: string; count: number } | null = null
  for (const [categoryId, count] of counts) if (!best || count > best.count) best = { categoryId, count }
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  return best ? { ...best, share: best.count / total, total } : null
}

/**
 * @param history newest first, income and expenses only
 * @param usableCategoryIds categories that can be chosen right now (right type, not archived)
 */
export function suggestCategory(
  history: HistoryItem[],
  { kind, merchant, usableCategoryIds }: { kind: TransactionType; merchant?: string | null; usableCategoryIds: Set<string> },
): CategorySuggestion | null {
  const sameKind = history.filter((h) => h.kind === kind && h.categoryId && usableCategoryIds.has(h.categoryId))
  const key = normaliseMerchant(merchant)

  if (key) {
    const match = dominant(sameKind.filter((h) => normaliseMerchant(h.merchant) === key))
    if (match && match.total >= SUGGESTION_RULES.merchantMinCount && match.share >= SUGGESTION_RULES.merchantMinShare) {
      return { categoryId: match.categoryId, reason: 'merchant', basis: match.count }
    }
  }

  const recent = dominant(sameKind.slice(0, SUGGESTION_RULES.recentWindow))
  if (recent && recent.total >= SUGGESTION_RULES.frequentMinCount && recent.share >= SUGGESTION_RULES.frequentMinShare) {
    return { categoryId: recent.categoryId, reason: 'frequent', basis: recent.count }
  }
  return null
}

export interface RecentShortcut {
  kind: TransactionType
  categoryId: string | null
  merchant: string | null
  accountId: string
  amountMinor: number
}

/** Up to `limit` distinct recent entries to repeat with one tap (prefill only). */
export function recentShortcuts(history: HistoryItem[], limit = 4): RecentShortcut[] {
  const seen = new Set<string>()
  const shortcuts: RecentShortcut[] = []
  for (const h of history) {
    if (!h.merchant && !h.categoryId) continue
    const key = [h.kind, h.categoryId, normaliseMerchant(h.merchant), h.amountMinor].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    shortcuts.push({ kind: h.kind, categoryId: h.categoryId, merchant: h.merchant, accountId: h.accountId, amountMinor: h.amountMinor })
    if (shortcuts.length === limit) break
  }
  return shortcuts
}

/** Distinct merchant names, most recent first, for autocomplete. */
export function knownMerchants(history: HistoryItem[], limit = 30): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const h of history) {
    const key = normaliseMerchant(h.merchant)
    if (!key || seen.has(key)) continue
    seen.add(key)
    names.push(h.merchant!.trim())
    if (names.length === limit) break
  }
  return names
}
