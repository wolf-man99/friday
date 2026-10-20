// Reads one bank, card or wallet alert email into the facts of a transaction
// (or says why it isn't one). Used to import past months from Gmail.
//
// Recording money wrongly is much worse than asking: anything not clearly
// understood gets a low confidence, and the import boundary sends it to the
// review queue instead of the ledger. Only parsed facts leave this module —
// never the email.

import { senderAddress } from './gmailQuery.ts'

export interface RawEmail {
  id: string
  /** Gmail internalDate, ms since epoch (when Gmail received it). */
  internalDate: number
  from: string
  subject: string
  /** Body as plain text (see htmlToText). */
  text: string
  /** Raw values of every Authentication-Results header. */
  authResults: string[]
}

export interface Institution {
  key: string
  name: string
}

export type Instrument = 'bank' | 'credit_card' | 'debit_card' | 'wallet' | 'unknown'

export interface ParsedAlert {
  institution: Institution
  instrument: Instrument
  /** Last digits of the account or card as shown (up to 4); null if none. */
  accountMask: string | null
  kind: 'expense' | 'income' | 'refund' | 'transfer'
  transferHint: 'card_payment' | 'cash_withdrawal' | 'self' | null
  amountMinor: number
  currency: string
  occurredAt: string
  dateSource: 'text' | 'email'
  merchant: string | null
  reference: string | null
  entryStatus: 'posted' | 'pending' | 'declined'
  /** One of Friday's default category names, or null. */
  categoryHint: string | null
  confidence: number
  senderVerified: boolean
}

export type SkipReason = 'unknown_sender' | 'otp' | 'statement' | 'promotion' | 'not_a_transaction' | 'no_amount'

export type ParseResult = { ok: true; alert: ParsedAlert } | { ok: false; skip: SkipReason }

// -----------------------------------------------------------------------------
// Who sent it
// -----------------------------------------------------------------------------

type Kind = 'bank' | 'card' | 'wallet'

const INSTITUTIONS: { key: string; name: string; kind: Kind; domains: string[] }[] = [
  { key: 'hdfc', name: 'HDFC Bank', kind: 'bank', domains: ['hdfcbank.net', 'hdfcbank.com'] },
  { key: 'icici', name: 'ICICI Bank', kind: 'bank', domains: ['icicibank.com'] },
  { key: 'axis', name: 'Axis Bank', kind: 'bank', domains: ['axisbank.com'] },
  { key: 'sbi', name: 'State Bank of India', kind: 'bank', domains: ['sbi.co.in'] },
  { key: 'sbicard', name: 'SBI Card', kind: 'card', domains: ['sbicard.com'] },
  { key: 'kotak', name: 'Kotak Mahindra Bank', kind: 'bank', domains: ['kotak.com'] },
  { key: 'yes', name: 'Yes Bank', kind: 'bank', domains: ['yesbank.in'] },
  { key: 'indusind', name: 'IndusInd Bank', kind: 'bank', domains: ['indusind.com'] },
  { key: 'idfcfirst', name: 'IDFC FIRST Bank', kind: 'bank', domains: ['idfcfirstbank.com'] },
  { key: 'federal', name: 'Federal Bank', kind: 'bank', domains: ['federalbank.co.in'] },
  { key: 'au', name: 'AU Small Finance Bank', kind: 'bank', domains: ['aubank.in'] },
  { key: 'sc', name: 'Standard Chartered', kind: 'bank', domains: ['sc.com'] },
  { key: 'hsbc', name: 'HSBC', kind: 'bank', domains: ['hsbc.co.in'] },
  { key: 'amex', name: 'American Express', kind: 'card', domains: ['americanexpress.com', 'aexp.com'] },
  { key: 'bob', name: 'Bank of Baroda', kind: 'bank', domains: ['bankofbaroda.co.in', 'bobcard.co.in'] },
  { key: 'pnb', name: 'Punjab National Bank', kind: 'bank', domains: ['pnb.co.in'] },
  { key: 'canara', name: 'Canara Bank', kind: 'bank', domains: ['canarabank.com'] },
  { key: 'union', name: 'Union Bank of India', kind: 'bank', domains: ['unionbankofindia.co.in'] },
  { key: 'rbl', name: 'RBL Bank', kind: 'bank', domains: ['rblbank.com'] },
  { key: 'dbs', name: 'DBS Bank', kind: 'bank', domains: ['dbs.com'] },
  { key: 'onecard', name: 'OneCard', kind: 'card', domains: ['getonecard.app'] },
  { key: 'paytm', name: 'Paytm', kind: 'wallet', domains: ['paytm.com'] },
  { key: 'phonepe', name: 'PhonePe', kind: 'wallet', domains: ['phonepe.com'] },
  { key: 'amazonpay', name: 'Amazon Pay', kind: 'wallet', domains: ['amazonpay.in'] },
  { key: 'mobikwik', name: 'MobiKwik', kind: 'wallet', domains: ['mobikwik.com'] },
  { key: 'jupiter', name: 'Jupiter', kind: 'bank', domains: ['jupiter.money'] },
  { key: 'fi', name: 'Fi', kind: 'bank', domains: ['fi.money'] },
]

/** Every sender domain recognised here (the Gmail search allowlist includes them). */
export const INSTITUTION_DOMAINS: readonly string[] = INSTITUTIONS.flatMap((i) => i.domains)

function domainMatches(domain: string, rule: string): boolean {
  return domain === rule || domain.endsWith(`.${rule}`)
}

function institutionEntry(fromHeader: string) {
  const domain = senderAddress(fromHeader).split('@')[1] ?? ''
  if (!domain) return null
  return INSTITUTIONS.find((i) => i.domains.some((rule) => domainMatches(domain, rule))) ?? null
}

export function institutionFor(fromHeader: string): Institution | null {
  const entry = institutionEntry(fromHeader)
  return entry ? { key: entry.key, name: entry.name } : null
}

/**
 * Did the sender's domain sign this email (DKIM) or pass DMARC? Anyone can
 * write "From: alerts@hdfcbank.net"; only HDFC can sign for hdfcbank.net.
 */
export function senderVerified(authResults: string[], fromHeader: string): boolean {
  const domain = senderAddress(fromHeader).split('@')[1] ?? ''
  if (!domain) return false
  const aligned = (other: string) => domainMatches(domain, other) || domainMatches(other, domain)
  for (const value of authResults) {
    const lower = value.toLowerCase()
    for (const clause of lower.split(';')) {
      const dkim = clause.match(/\bdkim=pass\b.*?\bheader\.(?:i=@?|d=)([a-z0-9.-]+)/)
      if (dkim && aligned(dkim[1])) return true
      const dmarc = clause.match(/\bdmarc=pass\b.*?\bheader\.from=([a-z0-9.-]+)/)
      if (dmarc && aligned(dmarc[1])) return true
    }
  }
  return false
}

// -----------------------------------------------------------------------------
// HTML → text
// -----------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rupee: '₹', inr: '₹' }

export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)\s*>/gi, '\n')
    .replace(/<\/(td|th|span)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim()
}

// -----------------------------------------------------------------------------
// Amounts, directions, dates
// -----------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'

// "Rs.250.00", "INR 1,499", "₹ 250", "USD 12.00", "250.00 INR"
const AMOUNT_RE = /(?:\b(INR|Rs|USD|EUR|GBP|AED|SGD)\.?|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(INR)\b/gi

// Amounts that describe the account, not the transaction.
const NOT_TRANSACTION_AMOUNT = /(bal(?:ance)?|avl|available|limit|outstanding|o\/s|due|total due|min(?:imum)?)\b[^0-9₹]{0,20}$/i

interface Amount {
  index: number
  minor: number
  currency: string
}

function toMinor(text: string): number | null {
  const [rupees, paise = ''] = text.replace(/,/g, '').split('.')
  if (!/^\d+$/.test(rupees) || !/^\d{0,2}$/.test(paise)) return null
  const minor = Number(rupees) * 100 + Number(paise.padEnd(2, '0'))
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null
}

function amountsIn(text: string): Amount[] {
  const found: Amount[] = []
  for (const match of text.matchAll(AMOUNT_RE)) {
    const before = text.slice(Math.max(0, match.index! - 30), match.index!)
    if (NOT_TRANSACTION_AMOUNT.test(before)) continue
    const code = (match[1] ?? match[4] ?? 'INR').toUpperCase()
    const minor = toMinor(match[2] ?? match[3])
    if (minor === null) continue
    found.push({ index: match.index!, minor, currency: code === 'RS' ? 'INR' : code })
  }
  return found
}

type Direction = 'debit' | 'credit'

// Earliest of these, with an amount close by, is what the email is about.
const DIRECTIONS: { re: RegExp; direction: Direction }[] = [
  { re: /\b(debited|is debited|spent|sent|paid|withdrawn|withdrawal|purchase|used for|used at|thank you for using|charged|deducted|transferred to|transaction of)\b/gi, direction: 'debit' },
  { re: /\b(credited|received|deposited|added to|refunded|refund|reversed|cashback)\b/gi, direction: 'credit' },
]

interface Anchor {
  index: number
  direction: Direction
  amount: Amount
}

function findAnchor(text: string): Anchor | null {
  const amounts = amountsIn(text)
  if (amounts.length === 0) return null
  const hits: { index: number; direction: Direction }[] = []
  for (const { re, direction } of DIRECTIONS) {
    for (const match of text.matchAll(re)) hits.push({ index: match.index!, direction })
  }
  hits.sort((a, b) => a.index - b.index)
  for (const hit of hits) {
    const near = amounts
      .map((amount) => ({ amount, distance: Math.abs(amount.index - hit.index) }))
      .filter((candidate) => candidate.distance <= 140)
      .sort((a, b) => a.distance - b.distance)[0]
    if (near) return { index: hit.index, direction: hit.direction, amount: near.amount }
  }
  return null
}

/** Local wall-clock time in a time zone → UTC milliseconds. */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(new Date(instant))
        .map((part) => [part.type, part.value]),
    )
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
    return asUtc - instant
  }
  const first = guess - offsetAt(guess)
  return guess - offsetAt(first)
}

function localDay(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant))
}

interface FoundDate {
  year: number
  month: number
  day: number
  time: [number, number, number] | null
}

const TIME = '(?:[,\\s]+(?:at\\s+)?(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*([ap]\\.?m\\.?)?)?'

function parseTime(h?: string, m?: string, s?: string, ampm?: string): [number, number, number] | null {
  if (h === undefined || m === undefined) return null
  let hour = Number(h)
  const minute = Number(m)
  const second = Number(s ?? 0)
  const meridiem = ampm?.toLowerCase().replace(/\./g, '')
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  if (hour > 23 || minute > 59 || second > 59) return null
  return [hour, minute, second]
}

function fullYear(text: string): number {
  const year = Number(text)
  return text.length <= 2 ? 2000 + year : year
}

function findDate(text: string): FoundDate | null {
  const candidates: { index: number; date: FoundDate }[] = []
  const add = (index: number, year: number, month: number, day: number, time: [number, number, number] | null) => {
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
      candidates.push({ index, date: { year, month, day, time } })
    }
  }
  // 18-10-26, 18/10/2026, 18.10.26 (Indian order: day first)
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4}|\\d{2})\\b${TIME}`, 'gi'))) {
    add(m.index!, fullYear(m[3]), Number(m[2]), Number(m[1]), parseTime(m[4], m[5], m[6], m[7]))
  }
  // 18-Oct-26, 17 Oct 2026, 17 Oct, 2026, 17Oct26
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})[-\\s]?${MONTH}[-\\s,]*(\\d{4}|\\d{2})\\b${TIME}`, 'gi'))) {
    add(m.index!, fullYear(m[3]), MONTHS.indexOf(m[2].toLowerCase()) + 1, Number(m[1]), parseTime(m[4], m[5], m[6], m[7]))
  }
  // Oct 17, 2026
  for (const m of text.matchAll(new RegExp(`\\b${MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b${TIME}`, 'gi'))) {
    add(m.index!, Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()) + 1, Number(m[2]), parseTime(m[4], m[5], m[6], m[7]))
  }
  candidates.sort((a, b) => a.index - b.index)
  return candidates[0]?.date ?? null
}

// -----------------------------------------------------------------------------
// Accounts, merchants, references
// -----------------------------------------------------------------------------

const CARD_RE =
  /\b(credit|debit)?\s*card\b(?:\s+(?:no\.?|number|account))?(?:\s+(?:ending|ends)(?:\s+(?:with|in))?)?\s*[:-]?\s*[xX*•.]*\s*(\d{4,5})\b/i
const ACCOUNT_RE =
  /\b(?:a\/c|acct|account|ac)\b\.?(?:\s*(?:no|number|num)\b\.?)?(?:\s*(?:ending|ends)(?:\s+(?:with|in))?)?\s*[:-]?\s*[xX*•.]*\s*(\d{3,6})\b/i

interface Holder {
  instrument: Instrument
  mask: string | null
}

function findHolder(window: string, fallback: string, kind: Kind): Holder {
  for (const text of [window, fallback]) {
    const card = text.match(CARD_RE)
    const account = text.match(ACCOUNT_RE)
    // Whichever is mentioned first in the transaction's own words.
    if (card && (!account || card.index! <= account.index!)) {
      const type = card[1]?.toLowerCase()
      const instrument: Instrument =
        type === 'credit' || kind === 'card' ? 'credit_card'
          : type === 'debit' ? 'debit_card'
          : /credit card/i.test(text) ? 'credit_card'
          : /debit card/i.test(text) ? 'debit_card'
          : 'credit_card'
      return { instrument, mask: card[2].slice(-4) }
    }
    if (account) return { instrument: 'bank', mask: account[1].slice(-4) }
  }
  // A payment app's own balance only when the email says so; otherwise the
  // money came from a bank account it doesn't name.
  if (kind === 'wallet' && /\b(wallet|balance)\b/i.test(window + fallback)) return { instrument: 'wallet', mask: null }
  return { instrument: 'unknown', mask: null }
}

const MERCHANT_PATTERNS: RegExp[] = [
  /\b(?:to|by)\s+VPA\s+[\w.-]+@[\w.-]+\s+([A-Za-z0-9][A-Za-z0-9 &.'-]{1,60}?)\s+on\b/i,
  /\bInfo:?\s*([A-Za-z0-9][^.;\n]{1,60})/i,
  /\bat\s+([A-Za-z0-9][A-Za-z0-9 &.'*/-]{1,60}?)\s+(?:on|dated)\b/i,
  /\btowards\s+([A-Za-z0-9][A-Za-z0-9 &.'*/-]{1,60}?)\s+(?:on|dated)\b/i,
  /;\s*([A-Za-z0-9][A-Za-z0-9 &.'-]{1,60}?)\s+credited\b/i,
  /\btransferred to\s+([A-Za-z0-9][A-Za-z0-9 &.'-]{1,60}?)(?:\s*[.(]|\s+on\b|\s+avl\b|$)/i,
  /\b(?:paid|sent)\s+(?:Rs\.?|INR|₹)\s*[\d,.]+\s+to\s+([A-Za-z0-9][^\n]{1,60}?)(?:\s+(?:from|on|via|using)\b|\.\s|\.$|$)/i,
  /\b(?:to|by)\s+VPA\s+([\w.-]+@[\w.-]+)/i,
  /\bto\s+([\w.-]+@[\w.-]+)/i,
  /\bfrom\s+([\w.-]+@[\w.-]+)/i,
  /\bfrom\s+([A-Za-z][A-Za-z0-9 &.'-]{1,60}?)(?:\s+on\b|\s+via\b|\s*\.\s|\s+UPI\b)/i,
]

function cleanMerchant(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').replace(/[\s.,;:-]+$/, '').trim()
  if (text.length < 2 || /^\d+$/.test(text)) return null
  // Not a merchant: the person's own account or card.
  if (/^(your|you|the|a\/c|acct|account|ac|card|self)\b/i.test(text) || /\b(xx|\*\*)\d{2,}/i.test(text)) return null
  if (/^(on|at|to|from|for|rs|inr)$/i.test(text)) return null
  return text.slice(0, 80)
}

function findMerchant(window: string): string | null {
  for (const pattern of MERCHANT_PATTERNS) {
    const match = window.match(pattern)
    const merchant = match ? cleanMerchant(match[1]) : null
    if (merchant) return merchant
  }
  return null
}

const REFERENCE_RES: RegExp[] = [
  /\bUPI\/(?:[A-Z0-9]+\/)?(\d{9,})\b/i,
  /\b(?:UPI(?:\s+transaction)?(?:\s+ref(?:erence)?)?(?:\s+(?:no|number|id)\b\.?)?(?:\s+is)?|UTR(?:\s+no\b\.?)?|RRN|Ref(?:erence)?(?:\s+(?:No|Number|ID)\b\.?)?|Txn\s+(?:ID|No\b\.?)|Transaction\s+(?:ID|Ref(?:erence)?(?:\s+No\b\.?)?))\s*[:.#-]?\s*([A-Za-z0-9]{6,30})\b/i,
]

function findReference(text: string): string | null {
  for (const pattern of REFERENCE_RES) {
    const match = text.match(pattern)
    const ref = match?.[1]
    if (ref && (ref.match(/\d/g)?.length ?? 0) >= 6) return ref
  }
  return null
}

const CATEGORY_RULES: [RegExp, string][] = [
  [/swiggy|zomato|restaurant|cafe|caf[eé]|blue ?tokai|starbucks|domino|mcdonald|kfc|pizza|chai point|eatsure/i, 'Food & dining'],
  [/bigbasket|blinkit|zepto|dmart|d-mart|grofers|instamart|jiomart|more retail|nature'?s basket/i, 'Groceries'],
  [/\buber\b|\bola\b|rapido|irctc|metro|fastag|petrol|fuel|indian oil|iocl|hpcl|bpcl|shell/i, 'Transport'],
  [/amazon|flipkart|myntra|ajio|nykaa|meesho|tata ?cliq|croma|reliance digital/i, 'Shopping'],
  [/electricity|bescom|tata power|adani|airtel|\bjio\b|vodafone|\bvi\b|broadband|act fibernet|\bgas\b|water board|bbmp/i, 'Bills & utilities'],
  [/netflix|spotify|prime video|hotstar|youtube|apple\.com|google play|google \*|icloud|zee5|sonyliv/i, 'Subscriptions'],
  [/apollo|pharmeasy|1mg|netmeds|hospital|pharmacy|clinic|diagnostic|medplus/i, 'Health'],
  [/makemytrip|goibibo|indigo|air ?india|vistara|akasa|cleartrip|booking\.com|airbnb|oyo|yatra|ixigo/i, 'Travel'],
  [/bookmyshow|pvr|inox|cinepolis|district/i, 'Fun & leisure'],
]

function categoryFor(kind: ParsedAlert['kind'], merchant: string | null, window: string): string | null {
  if (kind === 'income') {
    if (/\b(salary|payroll|sal\b)/i.test(window)) return 'Salary'
    if (/\binterest\b/i.test(window)) return 'Interest'
    return null
  }
  if (kind !== 'expense' || !merchant) return null
  return CATEGORY_RULES.find(([re]) => re.test(merchant))?.[1] ?? null
}

// -----------------------------------------------------------------------------
// Not transactions
// -----------------------------------------------------------------------------

const OTP_RE = /\b(otp|one[- ]time password|verification code)\b/i
const OTP_IN_BODY = /\b\d{4,8}\b[^.\n]{0,40}\b(?:otp|one[- ]time password)\b|\b(?:otp|one[- ]time password)\b[^.\n]{0,20}\b(?:is|:)\s*\d{4,8}\b/i
const STATEMENT_RE = /\b(e-?statement|statement (?:for|of|is ready|generated)|card statement|account statement|minimum amount due|total amount due|payment due|due date|bill (?:is )?generated|payment reminder)\b/i
const NOT_TRANSACTION_RE =
  /\b(log(?:ged)? ?in|sign[- ]?in) (?:alert|attempt|detected)|password (?:changed|reset)|beneficiary (?:added|registered)|e-?mandate|mandate (?:registered|created)|(?:has been |is )?(?:blocked|unblocked|hotlisted)\b|\bkyc\b|address (?:updated|change)|mobile number (?:updated|changed)|standing instruction (?:registered|set up)/i
const PROMOTION_RE =
  /\b(pre-?approved|apply now|exclusive offer|special offer|limited period|eligible for|upgrade your|congratulations|loan of up to|get up to|win |reward points? summary|avail now|instant loan)\b/i
const DECLINED_RE = /\b(declined|failed|unsuccessful|could not be processed|not processed|was not successful|rejected)\b/i
const PENDING_RE = /\b(pending|authori[sz]ed|authori[sz]ation|on hold|blocked amount)\b/i

// -----------------------------------------------------------------------------
// The whole email
// -----------------------------------------------------------------------------

export function parseAlert(email: RawEmail, options: { timeZone: string }): ParseResult {
  const entry = institutionEntry(email.from)
  if (!entry) return { ok: false, skip: 'unknown_sender' }
  const institution = { key: entry.key, name: entry.name }

  const normalize = (text: string) => text.replace(/[   ]/g, ' ').replace(/[ \t]+/g, ' ')
  const subject = normalize(email.subject)
  const body = normalize(email.text)
  // The transaction is stated up front; footers (disclaimers, "never share
  // your OTP") come later and must not change anything.
  const head = `${subject}\n${body}`.slice(0, 1600)
  const opening = `${subject}\n${body.slice(0, 400)}`

  if (OTP_RE.test(subject) || OTP_IN_BODY.test(body.slice(0, 400))) return { ok: false, skip: 'otp' }
  if (STATEMENT_RE.test(subject) || STATEMENT_RE.test(body.slice(0, 300))) return { ok: false, skip: 'statement' }
  if (NOT_TRANSACTION_RE.test(opening) && !/\b(debited|credited|spent)\b/i.test(opening)) {
    return { ok: false, skip: 'not_a_transaction' }
  }

  const anchor = findAnchor(head)
  if (!anchor) {
    if (PROMOTION_RE.test(opening)) return { ok: false, skip: 'promotion' }
    return { ok: false, skip: amountsIn(head).length === 0 ? 'no_amount' : 'not_a_transaction' }
  }

  // The transaction's own words: around the direction word and its amount.
  const start = Math.max(0, Math.min(anchor.index, anchor.amount.index) - 160)
  const window = head.slice(start, Math.max(anchor.index, anchor.amount.index) + 300)
  const holder = findHolder(window, head, entry.kind)

  if (PROMOTION_RE.test(opening) && holder.mask === null && holder.instrument !== 'wallet') {
    return { ok: false, skip: 'promotion' }
  }

  // Kind of transaction.
  let kind: ParsedAlert['kind'] = anchor.direction === 'debit' ? 'expense' : 'income'
  let transferHint: ParsedAlert['transferHint'] = null
  const lowerWindow = window.toLowerCase()
  if (anchor.direction === 'credit' && /\b(refund(?:ed)?|revers(?:ed|al)|cash ?back)\b/.test(lowerWindow)) {
    kind = 'refund'
  } else if (
    anchor.direction === 'debit' &&
    /\b((?:towards|to) (?:your |the )?(?:\w+ )?credit card|credit card (?:bill )?payment|cc payment|card bill|cred\b.*card)/.test(lowerWindow)
  ) {
    kind = 'transfer'
    transferHint = 'card_payment'
  } else if (anchor.direction === 'credit' && holder.instrument === 'credit_card' && /\b(payment|thank you)\b/.test(lowerWindow)) {
    kind = 'transfer'
    transferHint = 'card_payment'
  } else if (anchor.direction === 'debit' && /\b(atm|cash withdrawal|cash wdl|withdrawn at)\b/.test(lowerWindow)) {
    kind = 'transfer'
    transferHint = 'cash_withdrawal'
  } else if (/\b(to self|self transfer|own account)\b/.test(lowerWindow)) {
    kind = 'transfer'
    transferHint = 'self'
  }

  const entryStatus: ParsedAlert['entryStatus'] = DECLINED_RE.test(window) ? 'declined' : PENDING_RE.test(window) ? 'pending' : 'posted'

  // When it happened: the email's own date if plausible, else when it arrived.
  const found = findDate(window) ?? findDate(head)
  let occurredAt = email.internalDate
  let dateSource: ParsedAlert['dateSource'] = 'email'
  if (found) {
    const [hour, minute, second] = found.time ?? [12, 0, 0]
    let instant = zonedToUtc(found.year, found.month, found.day, hour, minute, second, options.timeZone)
    if (!found.time && localDay(email.internalDate, options.timeZone) === localDay(instant, options.timeZone)) {
      instant = email.internalDate
    }
    if (instant >= email.internalDate - 10 * 86_400_000 && instant <= email.internalDate + 86_400_000) {
      occurredAt = instant
      dateSource = 'text'
    }
  }

  const merchant = findMerchant(window)
  const reference = findReference(window) ?? findReference(head)
  const verified = senderVerified(email.authResults, email.from)

  // Other transaction-looking amounts close by make the reading uncertain.
  const others = new Set(amountsIn(window).map((a) => a.minor).filter((minor) => minor !== anchor.amount.minor))

  let confidence = 0.97
  if (dateSource === 'email') confidence -= 0.05
  if (holder.mask === null && holder.instrument !== 'wallet') confidence = Math.min(confidence, 0.6)
  if (!verified) confidence = Math.min(confidence, 0.6)
  if (others.size > 0) confidence = Math.min(confidence, 0.7)
  if (kind === 'refund' || kind === 'transfer') confidence = Math.min(confidence, 0.7)

  return {
    ok: true,
    alert: {
      institution,
      instrument: holder.instrument,
      accountMask: holder.mask,
      kind,
      transferHint,
      amountMinor: anchor.amount.minor,
      currency: anchor.amount.currency,
      occurredAt: new Date(occurredAt).toISOString(),
      dateSource,
      merchant,
      reference,
      entryStatus,
      categoryHint: categoryFor(kind, merchant, window),
      confidence: Math.round(confidence * 100) / 100,
      senderVerified: verified,
    },
  }
}
