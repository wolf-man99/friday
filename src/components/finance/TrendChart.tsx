import { Link } from 'react-router'
import type { CashflowTrendRow } from '@/data/database.types'
import { formatMoney, formatMoneyCompact } from '@/lib/money'

interface TrendChartProps {
  rows: CashflowTrendRow[]
  /** Short label under each bar group. */
  labelFor: (bucketStart: string) => string
  /** Long label for screen readers. */
  longLabelFor: (bucketStart: string) => string
  hrefFor: (bucketStart: string) => string
  /** Highlights the bucket being viewed elsewhere on the page. */
  activeBucket?: string
}

/** How a bucket's net figure reads aloud; below zero, more came back than went out. */
function spoken(minor: number, verb: 'received' | 'spent') {
  if (minor >= 0) return `${verb} ${formatMoney(minor)}`
  return verb === 'spent'
    ? `spent nothing net, ${formatMoney(-minor)} more refunded than spent`
    : `received nothing net, ${formatMoney(-minor)} more reversed than received`
}

/**
 * Income vs expense bars per period. Each group is a link to its transactions
 * and carries the exact figures as its accessible name. Figures are net of
 * refunds and reversals, so a bucket can dip below zero; its bar stays at zero
 * (a bar can't honestly show "negative spending") and the words say why.
 */
export function TrendChart({ rows, labelFor, longLabelFor, hrefFor, activeBucket }: TrendChartProps) {
  const max = Math.max(1, ...rows.flatMap((row) => [row.income_minor, row.expense_minor]))
  const anyBelowZero = rows.some((row) => row.income_minor < 0 || row.expense_minor < 0)
  return (
    <div>
      <div className="mb-3 flex items-center gap-4" aria-hidden="true">
        <span className="flex items-center gap-1.5">
          <span className="size-3.5 rounded-[4px] bg-lime outline-regular" />
          <span className="label-mono">Money in</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3.5 rounded-[4px] bg-orange outline-regular" />
          <span className="label-mono">Money out</span>
        </span>
        <span className="label-mono ml-auto text-muted">Peak {formatMoneyCompact(max)}</span>
      </div>
      <ol className="flex h-44 items-end gap-1.5">
        {rows.map((row) => {
          const active = row.bucket_start === activeBucket
          return (
            <li key={row.bucket_start} className="flex h-full min-w-0 flex-1 flex-col">
              <Link
                to={hrefFor(row.bucket_start)}
                aria-label={`${longLabelFor(row.bucket_start)}: ${spoken(row.income_minor, 'received')}, ${spoken(row.expense_minor, 'spent')}`}
                aria-current={active ? 'true' : undefined}
                className={`flex h-full flex-col justify-end rounded-xl px-0.5 pt-1 ${active ? 'bg-peach outline-regular' : 'hover:bg-peach/60'}`}
              >
                <span aria-hidden="true" className="flex flex-1 items-end justify-center gap-[3px]">
                  <Bar value={row.income_minor} max={max} className="bg-lime" />
                  <Bar value={row.expense_minor} max={max} className="bg-orange" />
                </span>
                <span aria-hidden="true" className={`label-mono mt-1.5 truncate text-center ${active ? '' : 'text-muted'}`}>
                  {labelFor(row.bucket_start)}
                </span>
              </Link>
            </li>
          )
        })}
      </ol>
      <p className="mt-3 text-sm text-muted">
        Money out is spending net of refunds; transfers between your accounts aren’t included.
        {anyBelowZero && ' Where more came back than went out, there’s no bar.'}
      </p>
    </div>
  )
}

function Bar({ value, max, className }: { value: number; max: number; className: string }) {
  // Net figures below zero are clamped: no bar, never a negative one.
  const height = value <= 0 ? 0 : Math.max(4, (value / max) * 100)
  return (
    <span
      className={`w-full max-w-4 rounded-t-[5px] ${height === 0 ? '' : 'border-2 border-b-0 border-ink'} ${className}`}
      style={{ height: `${height}%` }}
    />
  )
}
