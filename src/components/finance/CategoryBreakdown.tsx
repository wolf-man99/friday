import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import type { CategoryBreakdownRow, CategoryRow } from '@/data/database.types'
import { cn } from '@/components/ui/cn'
import { toneOf, type AccentTone } from '@/components/ui/tones'
import { formatMoney, percentOf } from '@/lib/money'
import { CategoryBadge } from './CategoryTile'

const TONE_HEX: Record<AccentTone, string> = {
  orange: 'var(--color-orange)',
  pink: 'var(--color-pink)',
  lime: 'var(--color-lime)',
  purple: 'var(--color-purple)',
  yellow: 'var(--color-yellow)',
  sky: 'var(--color-sky)',
  mint: 'var(--color-mint)',
  peach: 'var(--color-peach)',
}

export interface BreakdownSlice {
  categoryId: string | null
  name: string
  icon: string
  color: string
  /** Net: gross minus refunds or reversals in the period. Charts draw only slices above zero. */
  totalMinor: number
  count: number
  /** Refunds (or, for income, reversals) already taken off totalMinor. */
  refundMinor: number
}

export function toSlices(rows: CategoryBreakdownRow[], categories: Map<string, CategoryRow>): BreakdownSlice[] {
  return rows.map((row) => {
    const category = row.category_id ? categories.get(row.category_id) : undefined
    return {
      categoryId: row.category_id,
      name: category ? `${category.name}${category.is_archived ? ' (archived)' : ''}` : 'Uncategorised',
      icon: category?.icon ?? 'tag',
      color: category?.color ?? 'peach',
      totalMinor: row.total_minor,
      count: row.transaction_count,
      refundMinor: row.refund_minor ?? 0,
    }
  })
}

function arcPath(cx: number, cy: number, r: number, start: number, end: number) {
  const point = (angle: number) => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
  const [x1, y1] = point(start)
  const [x2, y2] = point(end)
  const large = end - start > Math.PI ? 1 : 0
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`
}

interface DonutProps {
  slices: BreakdownSlice[]
  total: number
  centerLabel: string
}

/**
 * Thick-outlined donut. Decorative to screen readers — the legend carries the
 * data. Only slices above zero are drawn: a category where refunds outweighed
 * spending has no meaningful share, so screens say that in words instead.
 */
export function Donut({ slices: all, total, centerLabel }: DonutProps) {
  const slices = all.filter((slice) => slice.totalMinor > 0)
  const size = 220
  const c = size / 2
  const r = c - 6
  let angle = -Math.PI / 2
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[15rem]">
      <svg viewBox={`0 0 ${size} ${size}`} className="size-full" aria-hidden="true">
        {slices.length === 0 || total <= 0 ? null : slices.length === 1 ? (
          <circle cx={c} cy={c} r={r} fill={TONE_HEX[toneOf(slices[0].color)]} stroke="var(--color-ink)" strokeWidth={4} />
        ) : (
          slices.map((slice) => {
            const sweep = (slice.totalMinor / total) * Math.PI * 2
            const path = arcPath(c, c, r, angle, angle + sweep)
            angle += sweep
            return (
              <path
                key={slice.categoryId ?? 'none'}
                d={path}
                fill={TONE_HEX[toneOf(slice.color)]}
                stroke="var(--color-ink)"
                strokeWidth={3.5}
                strokeLinejoin="round"
              />
            )
          })
        )}
        <circle cx={c} cy={c} r={r * 0.56} fill="var(--color-paper)" stroke="var(--color-ink)" strokeWidth={4} />
      </svg>
      <div aria-hidden="true" className="absolute inset-0 grid place-content-center text-center">
        <span className="label-mono">{centerLabel}</span>
        <span className="display tabular text-2xl">{formatMoney(total)}</span>
      </div>
    </div>
  )
}

interface LegendProps {
  slices: BreakdownSlice[]
  total: number
  /** Builds the drill-down link for a slice. */
  hrefFor: (slice: BreakdownSlice) => string
  limit?: number
  /** What refundMinor is called: "refunds" for spending, "reversals" for income. */
  offsetWord?: string
}

/** The textual equivalent of the donut, and the drill-down into transactions. */
export function BreakdownLegend({ slices, total, hrefFor, limit, offsetWord = 'refunds' }: LegendProps) {
  const shown = limit ? slices.slice(0, limit) : slices
  return (
    <ul className="flex flex-col gap-1">
      {shown.map((slice) => {
        const pct = percentOf(slice.totalMinor, total)
        const offset = slice.refundMinor > 0 ? `after ${formatMoney(slice.refundMinor)} in ${offsetWord}` : null
        return (
          <li key={slice.categoryId ?? 'none'}>
            <Link
              to={hrefFor(slice)}
              className="flex min-h-14 items-center gap-3 rounded-2xl px-2 py-2 hover:bg-peach/50 focus-visible:bg-peach/50"
              aria-label={`${slice.name}: ${formatMoney(slice.totalMinor)}${offset ? ` ${offset}` : ''}, ${pct}% of total, ${slice.count} ${
                slice.count === 1 ? 'entry' : 'entries'
              }. Show transactions`}
            >
              <CategoryBadge icon={slice.icon} color={slice.color} size="sm" />
              <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-semibold">{slice.name}</span>
                  <span className="tabular font-display font-extrabold">{formatMoney(slice.totalMinor)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-2.5 flex-1 overflow-hidden rounded-pill bg-ink/10">
                    <span
                      className={cn('block h-full rounded-pill border-r-2 border-ink')}
                      style={{ width: `${Math.max(pct, 2)}%`, background: TONE_HEX[toneOf(slice.color)] }}
                    />
                  </span>
                  <span className="label-mono w-10 text-right">{pct}%</span>
                </span>
                {offset && <span className="label-mono text-muted">{offset}</span>}
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0" strokeWidth={2.5} />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
