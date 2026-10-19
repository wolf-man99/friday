import { describe, expect, it } from 'vitest'
import { addAnalyticsSink, sanitise, track, type TrackedEvent } from './analytics'

describe('analytics', () => {
  it('delivers typed events to sinks', () => {
    const seen: TrackedEvent[] = []
    const stop = addAnalyticsSink((e) => seen.push(e))
    track('quick_add_opened', { context: '/', draft_restored: false })
    stop()
    track('quick_add_opened', { context: '/', draft_restored: false })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ name: 'quick_add_opened', props: { context: '/', draft_restored: false } })
  })

  it('strips sensitive or free-text properties even if they slip through', () => {
    expect(
      sanitise({
        note: 'Rent for flat 4B',
        merchant: 'Swiggy',
        amount_minor: 125000,
        account_id: 'abc',
        category_name: 'Health',
        has_note: true,
        has_merchant: false,
        account_source: 'default',
        context: '/activity',
        long: 'x'.repeat(41),
        nested: { a: 1 },
        elapsed_ms: 1234.6,
      }),
    ).toEqual({ has_note: true, has_merchant: false, account_source: 'default', context: '/activity', elapsed_ms: 1235 })
  })

  it('keeps capture working when a sink throws', () => {
    const stop = addAnalyticsSink(() => {
      throw new Error('boom')
    })
    expect(() => track('draft_recovered', { type: 'expense', age_s: 3 })).not.toThrow()
    stop()
  })
})
