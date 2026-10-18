import { describe, expect, it } from 'vitest'
import {
  addMonths,
  canonicalTimeZone,
  formatRange,
  formatRelativeDay,
  localDate,
  monthRange,
  previousRange,
  rangeToUtc,
  today,
  weekRange,
  zonedTimeToUtc,
} from './dates'

describe('timezone boundaries', () => {
  it('converts an IST month to a half-open UTC range', () => {
    expect(rangeToUtc({ from: '2026-10-01', to: '2026-10-31' }, 'Asia/Kolkata')).toEqual({
      from: '2026-09-30T18:30:00.000Z',
      to: '2026-10-31T18:30:00.000Z',
    })
  })

  it('uses the local date, not the UTC date', () => {
    // 20:00 UTC on 18 Oct is already 19 Oct in India.
    const instant = new Date('2026-10-18T20:00:00Z')
    expect(today('Asia/Kolkata', instant)).toBe('2026-10-19')
    expect(today('UTC', instant)).toBe('2026-10-18')
    expect(localDate('2026-10-18T20:00:00Z', 'America/New_York')).toBe('2026-10-18')
  })

  it('handles DST transitions', () => {
    // New York springs forward on 8 Mar 2026: midnight is still EST (UTC−5).
    expect(zonedTimeToUtc('2026-03-08', '00:00', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z')
    // …and the next midnight is EDT (UTC−4), so that local day is 23 hours long.
    expect(zonedTimeToUtc('2026-03-09', '00:00', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z')
    expect(rangeToUtc({ from: '2026-03-08', to: '2026-03-08' }, 'America/New_York')).toEqual({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    })
  })

  it('round-trips a local time through UTC', () => {
    const instant = zonedTimeToUtc('2026-01-15', '12:00', 'Asia/Kolkata')
    expect(instant.toISOString()).toBe('2026-01-15T06:30:00.000Z')
    expect(localDate(instant, 'Asia/Kolkata')).toBe('2026-01-15')
  })
})

describe('calendar arithmetic', () => {
  it('clamps month ends', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
  })

  it('builds month and week ranges', () => {
    expect(monthRange('2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    // 18 Oct 2026 is a Sunday; weeks start on Monday.
    expect(weekRange('2026-10-18')).toEqual({ from: '2026-10-12', to: '2026-10-18' })
  })

  it('finds the comparable previous period', () => {
    expect(previousRange({ from: '2026-03-01', to: '2026-03-31' })).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(previousRange({ from: '2026-10-12', to: '2026-10-18' })).toEqual({ from: '2026-10-05', to: '2026-10-11' })
    expect(previousRange({ from: '2026-01-01', to: '2026-03-31' })).toEqual({ from: '2025-10-01', to: '2025-12-31' })
  })
})

describe('display', () => {
  it('labels nearby days', () => {
    expect(formatRelativeDay('2026-10-18', '2026-10-18')).toBe('Today')
    expect(formatRelativeDay('2026-10-17', '2026-10-18')).toBe('Yesterday')
    expect(formatRelativeDay('2026-10-12', '2026-10-18')).toMatch(/12 Oct/)
    expect(formatRelativeDay('2025-10-12', '2026-10-18')).toMatch(/2025/)
  })

  it('names ranges', () => {
    expect(formatRange({ from: '2026-10-01', to: '2026-10-31' })).toBe('October 2026')
    expect(formatRange({ from: '2026-10-12', to: '2026-10-18' })).toMatch(/12 Oct – 18 Oct 2026/)
  })
})

describe('canonicalTimeZone', () => {
  it('maps legacy names browsers still report', () => {
    expect(canonicalTimeZone('Asia/Calcutta')).toBe('Asia/Kolkata')
    expect(canonicalTimeZone('Europe/Kiev')).toBe('Europe/Kyiv')
    expect(canonicalTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata')
  })

  it('keeps every browser zone valid', () => {
    const zones = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone')
    for (const zone of zones) expect(() => today(canonicalTimeZone(zone))).not.toThrow()
  })
})
