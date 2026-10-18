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

/**
 * Income vs expense bars per period. Each group is a link to its transactions
 * and carries the exact figures as its accessible name.
 */
export function TrendChart({ rows, labelFor, longLabelFor, hrefFor, activeBucket }: TrendChartProps) {
  const max = Math.max(1, ...rows.flatMap((row) => [row.income_minor, row.expense_minor]))
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
                aria-label={`${longLabelFor(row.bucket_start)}: received ${formatMoney(row.income_minor)}, spent ${formatMoney(row.expense_minor)}`}
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
    </div>
  )
}

function Bar({ value, max, className }: { value: number; max: number; className: string }) {
  const height = value === 0 ? 0 : Math.max(4, (value / max) * 100)
  return (
    <span
      className={`w-full max-w-4 rounded-t-[5px] ${value === 0 ? '' : 'border-2 border-b-0 border-ink'} ${className}`}
      style={{ height: `${height}%` }}
    />
  )
}
