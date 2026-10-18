// Money is always an integer number of minor units (paise for INR).
// Floats never touch persisted amounts: parsing and formatting work on strings
// and integers only.

export type CurrencyCode = 'INR'

export const DEFAULT_CURRENCY: CurrencyCode = 'INR'
const MINOR_PER_MAJOR = 100

/** Largest amount the app accepts for a single entry: ₹1,00,00,00,000 (100 crore). */
export const MAX_AMOUNT_MINOR = 1_000_000_000 * MINOR_PER_MAJOR

const SYMBOLS: Record<CurrencyCode, string> = { INR: '₹' }

const groupFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

/**
 * Parses user input such as "1,250.5" or "₹ 80,000" into minor units.
 * Returns null when the text is not a valid non-negative amount with at most
 * two decimal places.
 */
export function parseAmountToMinor(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, '')
  if (cleaned === '' || !/^\d*\.?\d{0,2}$/.test(cleaned) || cleaned === '.') return null
  const [whole = '', fraction = ''] = cleaned.split('.')
  const major = whole === '' ? 0 : Number.parseInt(whole, 10)
  const minor = Number.parseInt((fraction + '00').slice(0, 2), 10)
  const total = major * MINOR_PER_MAJOR + minor
  return Number.isSafeInteger(total) ? total : null
}

/** Minor units → plain decimal string for inputs and CSV ("1250.50", "80000"). */
export function minorToDecimalString(minor: number, { alwaysFraction = false } = {}): string {
  assertInteger(minor)
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  const major = Math.trunc(abs / MINOR_PER_MAJOR)
  const fraction = abs % MINOR_PER_MAJOR
  if (fraction === 0 && !alwaysFraction) return `${sign}${major}`
  return `${sign}${major}.${String(fraction).padStart(2, '0')}`
}

export type SignDisplay = 'auto' | 'always' | 'never'

export interface FormatOptions {
  currency?: CurrencyCode
  /** 'always' shows + for positives; 'never' drops the minus too. */
  sign?: SignDisplay
  /** Show paise even when zero. Defaults to only when non-zero. */
  alwaysFraction?: boolean
}

/** Formats minor units with Indian digit grouping: 12345678 → "₹1,23,456.78". */
export function formatMoney(minor: number, options: FormatOptions = {}): string {
  assertInteger(minor)
  const { currency = DEFAULT_CURRENCY, sign = 'auto', alwaysFraction = false } = options
  const abs = Math.abs(minor)
  const major = Math.trunc(abs / MINOR_PER_MAJOR)
  const fraction = abs % MINOR_PER_MAJOR
  const body =
    groupFormatter.format(major) +
    (fraction !== 0 || alwaysFraction ? `.${String(fraction).padStart(2, '0')}` : '')
  let prefix = ''
  if (minor < 0 && sign !== 'never') prefix = '−'
  else if (minor > 0 && sign === 'always') prefix = '+'
  return `${prefix}${SYMBOLS[currency]}${body}`
}

/** Short form for chart axes and tight spaces: ₹950, ₹12.5k, ₹3.4L, ₹1.2Cr. */
export function formatMoneyCompact(minor: number, currency: CurrencyCode = DEFAULT_CURRENCY): string {
  assertInteger(minor)
  const sign = minor < 0 ? '−' : ''
  const major = Math.abs(minor) / MINOR_PER_MAJOR
  const symbol = SYMBOLS[currency]
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, '')
  if (major >= 1_00_00_000) return `${sign}${symbol}${trim(major / 1_00_00_000)}Cr`
  if (major >= 1_00_000) return `${sign}${symbol}${trim(major / 1_00_000)}L`
  if (major >= 1_000) return `${sign}${symbol}${trim(major / 1_000)}k`
  return `${sign}${symbol}${Math.round(major)}`
}

/**
 * Formats raw amount-field text with Indian grouping while the user types,
 * preserving a trailing decimal point and partial paise ("1234." → "1,234.").
 */
export function formatAmountInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '')
  const firstDot = cleaned.indexOf('.')
  const whole = (firstDot === -1 ? cleaned : cleaned.slice(0, firstDot)).replace(/^0+(?=\d)/, '')
  const fraction = firstDot === -1 ? null : cleaned.slice(firstDot + 1).replace(/\./g, '').slice(0, 2)
  const groupedWhole = whole === '' ? (fraction !== null ? '0' : '') : groupFormatter.format(Number(whole))
  return fraction === null ? groupedWhole : `${groupedWhole}.${fraction}`
}

/** Tailwind text size that keeps a formatted amount on one line in a half-width card. */
export function fitAmountClass(text: string, sizes: [string, string, string] = ['text-[1.6rem]', 'text-[1.3rem]', 'text-[1.05rem]']) {
  if (text.length <= 9) return sizes[0]
  if (text.length <= 12) return sizes[1]
  return sizes[2]
}

/** Share of a total as a whole-number percentage, safe for a zero total. */
export function percentOf(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((part / total) * 100)
}

function assertInteger(minor: number) {
  if (!Number.isSafeInteger(minor)) {
    throw new TypeError(`Money amounts must be safe integers of minor units, got ${minor}`)
  }
}
