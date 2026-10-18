import { describe, expect, it } from 'vitest'
import { describeSchedule, nextAfter, upcomingDates, type Schedule } from './recurrence'

const monthlyEnd: Schedule = { startDate: '2026-01-31', cadence: 'monthly', intervalCount: 1 }

// These cases mirror tests/db/ledger_test.sql so the UI preview and the
// database agree on every due date.
describe('nextAfter', () => {
  it.each<[Schedule, string, string]>([
    [monthlyEnd, '2026-01-31', '2026-02-28'],
    [monthlyEnd, '2026-02-28', '2026-03-31'],
    [{ ...monthlyEnd, intervalCount: 3 }, '2026-01-31', '2026-04-30'],
    [{ startDate: '2026-01-05', cadence: 'weekly', intervalCount: 2 }, '2026-01-05', '2026-01-19'],
    [{ startDate: '2026-01-05', cadence: 'daily', intervalCount: 1 }, '2026-03-01', '2026-03-02'],
    [{ startDate: '2024-02-29', cadence: 'yearly', intervalCount: 1 }, '2024-02-29', '2025-02-28'],
    [{ startDate: '2024-02-29', cadence: 'yearly', intervalCount: 1 }, '2027-03-01', '2028-02-29'],
    [{ startDate: '2026-05-10', cadence: 'monthly', intervalCount: 1 }, '2026-01-01', '2026-05-10'],
  ])('%o after %s → %s', (schedule, after, expected) => {
    expect(nextAfter(schedule, after)).toBe(expected)
  })
})

describe('upcomingDates', () => {
  it('includes the from date when it is due', () => {
    expect(upcomingDates(monthlyEnd, '2026-01-31', 4)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  })

  it('stops at the end date', () => {
    expect(upcomingDates(monthlyEnd, '2026-01-01', 10, '2026-03-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
  })
})

describe('describeSchedule', () => {
  it('reads naturally', () => {
    expect(describeSchedule({ cadence: 'monthly', intervalCount: 1 })).toBe('Every month')
    expect(describeSchedule({ cadence: 'weekly', intervalCount: 2 })).toBe('Every 2 weeks')
    expect(describeSchedule({ cadence: 'monthly', intervalCount: 3 })).toBe('Every quarter')
    expect(describeSchedule({ cadence: 'daily', intervalCount: 10 })).toBe('Every 10 days')
  })
})
