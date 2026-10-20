import { describe, expect, it } from 'vitest'
import type { CategoryBreakdownRow } from '@/data/database.types'
import { buildObservations, type ObservationInput } from './observations'

const row = (category_id: string | null, total_minor: number, refund_minor = 0): CategoryBreakdownRow => ({
  category_id,
  total_minor,
  gross_minor: total_minor + refund_minor,
  refund_minor,
  transaction_count: 1,
})

const NAMES: Record<string, string> = { food: 'Food', shop: 'Shopping', bills: 'Bills' }

function build(patch: Partial<ObservationInput>) {
  return buildObservations({
    current: [],
    previous: [],
    categoryName: (id) => (id ? NAMES[id] : 'Uncategorised'),
    previousLabel: 'September 2026',
    income: 0,
    spending: 0,
    ...patch,
  })
}

describe('buildObservations', () => {
  it('names the biggest category as a share of categories with net spending', () => {
    const notes = build({ current: [row('food', 60_000), row('bills', 40_000), row('shop', -30_000, 50_000)], spending: 70_000 })
    expect(notes).toContain('Food was your biggest spend: ₹600, 60% of the total.')
  })

  it('compares only categories with real net spending on both sides', () => {
    const notes = build({
      current: [row('food', 90_000), row('shop', -10_000, 80_000), row('bills', 60_000)],
      previous: [row('food', 60_000), row('shop', 80_000), row('bills', 60_000)],
      spending: 140_000,
    })
    expect(notes).toContain('Food spending is 50% higher than September 2026.')
    expect(notes.join(' ')).not.toMatch(/Shopping spending/)
    expect(notes.join(' ')).not.toMatch(/Bills spending/)
  })

  it('never claims more than 100% kept when refunds outweighed spending', () => {
    const notes = build({ current: [row('shop', -20_000, 20_000)], income: 100_000, spending: -20_000 })
    expect(notes).toEqual(['Refunds outweighed spending: ₹200 more came back than went out.'])
    expect(notes.join(' ')).not.toMatch(/kept/)
  })

  it('reports what was kept or overspent against income', () => {
    expect(build({ income: 100_000, spending: 25_000 })).toEqual(['You kept 75% of what came in (₹750).'])
    expect(build({ income: 100_000, spending: 130_000 })).toEqual(['Spending was ₹300 more than what came in.'])
    expect(build({ income: 0, spending: 0 })).toEqual([])
  })
})
