import type { EntryKind, TransactionType } from '@/data/database.types'
import { cn } from '@/components/ui/cn'
import { directionOf } from '@/lib/ledger'
import { formatMoney } from '@/lib/money'

interface AmountProps {
  minor: number
  /**
   * When given, the sign comes from the kind: expense −, income +, refund +,
   * reversal opposite to what it reverses, transfer none.
   */
  kind?: EntryKind
  /** For reversals: the side reversed (a reversed purchase is money back). */
  baseType?: TransactionType | null
  className?: string
  /** Colour money coming in green (always paired with the + sign). */
  colored?: boolean
}

const SPOKEN: Record<EntryKind, string> = {
  expense: 'spent',
  income: 'received',
  refund: 'refunded',
  reversal: 'reversed',
  transfer: 'moved',
}

/** Money with an explicit sign so direction never relies on colour (AmountDisplay). */
export function Amount({ minor, kind, baseType, className, colored = true }: AmountProps) {
  let text: string
  let label: string
  const direction = kind ? directionOf({ kind, base_type: baseType ?? (kind === 'refund' ? 'expense' : null) }) : null
  if (kind && direction === 'out') {
    text = formatMoney(-Math.abs(minor))
    label = `${formatMoney(Math.abs(minor))} ${SPOKEN[kind]}`
  } else if (kind && direction === 'in') {
    text = formatMoney(Math.abs(minor), { sign: 'always' })
    label = `${formatMoney(Math.abs(minor))} ${SPOKEN[kind]}`
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
      className={cn('tabular whitespace-nowrap', colored && direction === 'in' && 'text-positive', className)}
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
