import type { EntryKind } from '@/data/database.types'
import { cn } from '@/components/ui/cn'
import { formatMoney } from '@/lib/money'

interface AmountProps {
  minor: number
  /** When given, the sign comes from the kind: expense −, income +, transfer none. */
  kind?: EntryKind
  className?: string
  /** Colour income green (always paired with the + sign). */
  colored?: boolean
}

/** Money with an explicit sign so direction never relies on colour (AmountDisplay). */
export function Amount({ minor, kind, className, colored = true }: AmountProps) {
  let text: string
  let label: string
  if (kind === 'expense') {
    text = formatMoney(-Math.abs(minor))
    label = `${formatMoney(Math.abs(minor))} spent`
  } else if (kind === 'income') {
    text = formatMoney(Math.abs(minor), { sign: 'always' })
    label = `${formatMoney(Math.abs(minor))} received`
  } else if (kind === 'transfer') {
    text = formatMoney(Math.abs(minor))
    label = `${text} moved`
  } else {
    text = formatMoney(minor)
    label = text.replace('−', 'minus ')
  }
  return (
    <span
      aria-label={label}
      className={cn('tabular whitespace-nowrap', colored && kind === 'income' && 'text-positive', className)}
    >
      {text}
    </span>
  )
}

/** Big display figure: rupees large, paise small. */
export function HeroAmount({ minor, className }: { minor: number; className?: string }) {
  const text = formatMoney(minor)
  const [whole, fraction] = text.split('.')
  return (
    <span className={cn('display tabular break-all', className)} aria-label={text.replace('−', 'minus ')}>
      <span aria-hidden="true">
        {whole}
        {fraction && <span className="text-[0.45em] tracking-normal">.{fraction}</span>}
      </span>
    </span>
  )
}
