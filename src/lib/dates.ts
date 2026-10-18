// Calendar dates are plain "YYYY-MM-DD" strings in the user's timezone
// (profile.timezone). Instants are ISO strings in UTC. Reporting periods are
// inclusive local dates, converted to a half-open UTC range [from, to).

export type ISODate = string

export interface DateRange {
  /** First local day, inclusive. */
  from: ISODate
  /** Last local day, inclusive. */
  to: ISODate
}

export interface UtcRange {
  /** Inclusive start instant (ISO, UTC). */
  from: string
  /** Exclusive end instant (ISO, UTC). */
  to: string
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string) {
  let formatter = partsFormatterCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsFormatterCache.set(timeZone, formatter)
  }
  return formatter
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = Object.fromEntries(
    partsFormatter(timeZone)
      .formatToParts(instant)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  )
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

/** Offset (ms) of the timezone from UTC at the given instant. */
function offsetAt(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

// Browsers still report some legacy IANA names; prefer the current ones.
const ZONE_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
}

export function canonicalTimeZone(zone: string): string {
  return ZONE_ALIASES[zone] ?? zone
}

export function browserTimeZone(): string {
  return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata')
}

/** The local calendar date of an instant in a timezone. */
export function localDate(instant: Date | string, timeZone: string): ISODate {
  const w = wallClock(typeof instant === 'string' ? new Date(instant) : instant, timeZone)
  return toISODate(w.year, w.month, w.day)
}

/** Local wall-clock time "HH:MM" of an instant. */
export function localTime(instant: Date | string, timeZone: string): string {
  const w = wallClock(typeof instant === 'string' ? new Date(instant) : instant, timeZone)
  return `${pad(w.hour)}:${pad(w.minute)}`
}

export function today(timeZone: string, now: Date = new Date()): ISODate {
  return localDate(now, timeZone)
}

/**
 * The UTC instant at which a local wall-clock time occurs in a timezone.
 * Handles DST gaps/overlaps by re-checking the offset at the candidate.
 */
export function zonedTimeToUtc(date: ISODate, time: string, timeZone: string): Date {
  const { year, month, day } = parseISODate(date)
  const [hour = 0, minute = 0] = time.split(':').map(Number)
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const first = guess - offsetAt(new Date(guess), timeZone)
  const second = guess - offsetAt(new Date(first), timeZone)
  return new Date(second)
}

/** Start of a local day as a UTC instant. */
export function startOfLocalDay(date: ISODate, timeZone: string): Date {
  return zonedTimeToUtc(date, '00:00', timeZone)
}

/** Inclusive local date range → half-open UTC instant range. */
export function rangeToUtc(range: DateRange, timeZone: string): UtcRange {
  return {
    from: startOfLocalDay(range.from, timeZone).toISOString(),
    to: startOfLocalDay(addDays(range.to, 1), timeZone).toISOString(),
  }
}

// --- Pure calendar arithmetic on ISO dates (timezone-free) ------------------

export function parseISODate(date: ISODate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) throw new RangeError(`Not an ISO date: ${date}`)
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

export function toISODate(year: number, month: number, day: number): ISODate {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function toUtcDate(date: ISODate) {
  const { year, month, day } = parseISODate(date)
  return new Date(Date.UTC(year, month - 1, day))
}

function fromUtcDate(d: Date): ISODate {
  return toISODate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = toUtcDate(date)
  d.setUTCDate(d.getUTCDate() + days)
  return fromUtcDate(d)
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Adds calendar months, clamping to the last day (Jan 31 + 1 → Feb 28). */
export function addMonths(date: ISODate, months: number): ISODate {
  const { year, month, day } = parseISODate(date)
  const index = year * 12 + (month - 1) + months
  const y = Math.floor(index / 12)
  const m = (index % 12) + 1
  return toISODate(y, m, Math.min(day, daysInMonth(y, m)))
}

export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUtcDate(a).getTime() - toUtcDate(b).getTime()) / 86_400_000)
}

/** 0 = Monday … 6 = Sunday */
export function weekdayIndex(date: ISODate): number {
  return (toUtcDate(date).getUTCDay() + 6) % 7
}

export function monthRange(date: ISODate): DateRange {
  const { year, month } = parseISODate(date)
  return { from: toISODate(year, month, 1), to: toISODate(year, month, daysInMonth(year, month)) }
}

export function weekRange(date: ISODate): DateRange {
  const from = addDays(date, -weekdayIndex(date))
  return { from, to: addDays(from, 6) }
}

/** The period of equal length immediately before a range. */
export function previousRange(range: DateRange): DateRange {
  const { from, to } = range
  const first = parseISODate(from)
  const last = parseISODate(to)
  // Whole calendar month(s) → compare with the previous calendar month(s).
  if (first.day === 1 && last.day === daysInMonth(last.year, last.month)) {
    const months = (last.year - first.year) * 12 + (last.month - first.month) + 1
    const prevFrom = addMonths(from, -months)
    const prevLast = addMonths(prevFrom, months - 1)
    const { year, month } = parseISODate(prevLast)
    return { from: prevFrom, to: toISODate(year, month, daysInMonth(year, month)) }
  }
  const length = diffDays(to, from) + 1
  return { from: addDays(from, -length), to: addDays(from, -1) }
}

// --- Display ------------------------------------------------------------------

const monthYear = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const shortMonth = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' })
const dayMonth = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayMonthYear = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})
const weekdayDayMonth = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

export function formatMonthYear(date: ISODate) {
  return monthYear.format(toUtcDate(date))
}

export function formatShortMonth(date: ISODate) {
  return shortMonth.format(toUtcDate(date))
}

export function formatDate(date: ISODate, { withYear = false } = {}) {
  return (withYear ? dayMonthYear : dayMonth).format(toUtcDate(date))
}

/** "Today", "Yesterday", "Tomorrow" or "Mon, 12 Oct". */
export function formatRelativeDay(date: ISODate, todayDate: ISODate) {
  const delta = diffDays(date, todayDate)
  if (delta === 0) return 'Today'
  if (delta === -1) return 'Yesterday'
  if (delta === 1) return 'Tomorrow'
  const { year } = parseISODate(date)
  return year === parseISODate(todayDate).year
    ? weekdayDayMonth.format(toUtcDate(date))
    : dayMonthYear.format(toUtcDate(date))
}

export function formatRange(range: DateRange) {
  const a = parseISODate(range.from)
  const b = parseISODate(range.to)
  const fullMonth = a.day === 1 && b.day === daysInMonth(b.year, b.month)
  if (fullMonth && a.year === b.year && a.month === b.month) return formatMonthYear(range.from)
  if (range.from === range.to) return formatDate(range.from, { withYear: true })
  return `${formatDate(range.from, { withYear: a.year !== b.year })} – ${formatDate(range.to, { withYear: true })}`
}
