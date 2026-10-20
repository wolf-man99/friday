// Which Gmail messages count as transaction alerts. Friday asks Gmail to
// search only these senders and words, then double-checks the sender of every
// result itself, so nothing outside the allowlist is ever returned.

/** Alert senders of common Indian banks, cards and wallets (domains or addresses). */
export const DEFAULT_ALERT_SENDERS: readonly string[] = [
  'hdfcbank.net',
  'hdfcbank.com',
  'icicibank.com',
  'axisbank.com',
  'sbi.co.in',
  'kotak.com',
  'yesbank.in',
  'indusind.com',
  'idfcfirstbank.com',
  'federalbank.co.in',
  'aubank.in',
  'sc.com',
  'hsbc.co.in',
  'americanexpress.com',
  'paytm.com',
  'phonepe.com',
  'amazonpay.in',
  'mobikwik.com',
]

/** Words that appear in debit/credit alerts. */
export const ALERT_KEYWORDS: readonly string[] = [
  'debited',
  'credited',
  'spent',
  'transaction',
  'txn',
  'upi',
  'purchase',
  'withdrawn',
  'refund',
  'reversed',
]

// A domain (bank.com) or a full address (alerts@bank.com) — nothing that could
// smuggle Gmail search operators into the query.
const SENDER_RULE = /^(?:[a-z0-9._%+-]+@)?(?:[a-z0-9-]+\.)+[a-z]{2,}$/

export function isSenderRule(rule: string): boolean {
  return rule.length <= 254 && SENDER_RULE.test(rule)
}

/** Comma-separated rules from a secret; invalid entries are dropped, empty means the defaults. */
export function parseSenderRules(raw: string | undefined | null): string[] {
  const rules = (raw ?? '')
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(isSenderRule)
  return rules.length > 0 ? [...new Set(rules)] : [...DEFAULT_ALERT_SENDERS]
}

export const MAX_LOOKBACK_DAYS = 90

/** e.g. from:(hdfcbank.net OR …) (debited OR …) newer_than:30d -category:promotions */
export function buildAlertQuery(senders: readonly string[], lookbackDays: number): string {
  const safeSenders = senders.filter(isSenderRule)
  if (safeSenders.length === 0) throw new Error('No valid alert senders configured')
  const days = Math.min(Math.max(Math.trunc(lookbackDays) || 30, 1), MAX_LOOKBACK_DAYS)
  return [
    `from:(${safeSenders.join(' OR ')})`,
    `(${ALERT_KEYWORDS.join(' OR ')})`,
    `newer_than:${days}d`,
    '-category:promotions',
    '-category:social',
  ].join(' ')
}

/**
 * The address in a From header: "HDFC Bank <alerts@hdfcbank.net>" → alerts@hdfcbank.net.
 * The real address is the last <…>; anything before it is display name, which
 * anyone can set (e.g. "<alerts@hdfcbank.net>" <x@evil.example>).
 */
export function senderAddress(fromHeader: string): string {
  const angles = [...fromHeader.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)]
  if (angles.length > 0) return angles[angles.length - 1][1].toLowerCase()
  const bare = fromHeader.trim().match(/^[^\s<>"]+@[^\s<>"]+$/)
  return (bare?.[0] ?? '').toLowerCase()
}

/** Does the sender match an allowlist rule (exact address, the domain, or a subdomain of it)? */
export function senderAllowed(fromHeader: string, rules: readonly string[]): boolean {
  const address = senderAddress(fromHeader)
  const domain = address.split('@')[1]
  if (!domain) return false
  return rules.some((rule) => (rule.includes('@') ? address === rule : domain === rule || domain.endsWith(`.${rule}`)))
}

export function headerValue(headers: { name?: string; value?: string }[] | undefined, name: string): string {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
}
