// "Worth knowing" notes on the Insights screen: plain sentences from net
// totals, with guards so a period where refunds outweighed spending never
// yields nonsense like "you kept 120% of what came in".

import type { CategoryBreakdownRow } from '@/data/database.types'
import { formatMoney, percentOf } from '@/lib/money'
import { splitBreakdown } from './figures'

/** ₹500 — below this, swings between periods are noise. */
export const MIN_COMPARABLE = 500_00

export interface ObservationInput {
  /** Net spending by category for the period. */
  current: CategoryBreakdownRow[]
  /** The same for the previous period. */
  previous: CategoryBreakdownRow[]
  categoryName: (categoryId: string | null) => string
  previousLabel: string
  /** Net income (income minus reversed income). */
  income: number
  /** Net spending (expenses minus refunds); can be below zero. */
  spending: number
}

export function buildObservations({ current, previous, categoryName, previousLabel, income, spending }: ObservationInput): string[] {
  const notes: string[] = []
  const { drawn, drawnTotalMinor } = splitBreakdown(current)

  if (drawn.length > 1 && drawnTotalMinor > 0) {
    const top = drawn[0]
    notes.push(
      `${categoryName(top.category_id)} was your biggest spend: ${formatMoney(top.total_minor)}, ${percentOf(top.total_minor, drawnTotalMinor)}% of the total.`,
    )
  }

  // Only categories with real net spending on both sides are compared.
  const prevById = new Map(previous.map((row) => [row.category_id, row.total_minor]))
  const changes = drawn
    .map((row) => ({ row, before: prevById.get(row.category_id) ?? 0 }))
    .filter(({ row, before }) => before >= MIN_COMPARABLE && row.total_minor >= MIN_COMPARABLE)
    .map(({ row, before }) => ({ row, pct: Math.round(((row.total_minor - before) / before) * 100) }))
    .filter(({ pct }) => Math.abs(pct) >= 20)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 3)
  for (const { row, pct } of changes) {
    notes.push(`${categoryName(row.category_id)} spending is ${Math.abs(pct)}% ${pct > 0 ? 'higher' : 'lower'} than ${previousLabel}.`)
  }

  if (spending < 0) {
    notes.push(`Refunds outweighed spending: ${formatMoney(-spending)} more came back than went out.`)
  } else if (income > 0) {
    const net = income - spending
    if (net > 0) notes.push(`You kept ${percentOf(net, income)}% of what came in (${formatMoney(net)}).`)
    else if (net < 0) notes.push(`Spending was ${formatMoney(-net)} more than what came in.`)
  }
  return notes
}
