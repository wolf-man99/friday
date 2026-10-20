import { Link } from 'react-router'
import type { AccountBalanceRow } from '@/data/database.types'
import { cn } from '@/components/ui/cn'
import { TONE_BG, toneOf } from '@/components/ui/tones'
import { describeBalance, describeCredit } from '@/features/accounts/figures'
import { ACCOUNT_TYPE_LABEL, AccountGlyph } from './icons'

export { describeBalance }

/** The sentence a screen reader hears for an account tile. */
export function accountCardLabel(account: AccountBalanceRow, { withCredit = false } = {}) {
  const credit = withCredit ? describeCredit(account) : null
  const parts = [
    `${account.name}${account.institution_name ? `, ${account.institution_name}` : ''}, ${ACCOUNT_TYPE_LABEL[account.type]}${
      account.status === 'archived' ? ', archived' : ''
    }.`,
    `${describeBalance(account).spoken}.`,
  ]
  if (credit) parts.push(`${credit.spoken}.`)
  return parts.join(' ')
}

interface AccountCardProps {
  account: AccountBalanceRow
  compact?: boolean
  /** Full width, with room for a card's limit and available credit. */
  wide?: boolean
}

export function AccountCard({ account, compact, wide }: AccountCardProps) {
  const { label, amount } = describeBalance(account)
  const credit = wide ? describeCredit(account) : null
  const archived = account.status === 'archived'
  return (
    <Link
      to={`/accounts/${account.id}`}
      className={cn(
        'pressable flex flex-col justify-between gap-3 rounded-card p-4 outline-strong shadow-brutal',
        TONE_BG[toneOf(account.color)],
        compact ? 'min-h-32 w-44 shrink-0' : !wide && 'min-h-36',
        archived && 'opacity-70',
      )}
      aria-label={accountCardLabel(account, { withCredit: wide })}
    >
      <div aria-hidden="true" className="flex items-start justify-between gap-2">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-paper outline-regular">
          <AccountGlyph type={account.type} />
        </span>
        {wide && <AccountName account={account} className="flex-1" />}
        <span className="label-mono rounded-pill bg-paper px-2 py-1 outline-regular">
          {archived ? 'Archived' : ACCOUNT_TYPE_LABEL[account.type]}
        </span>
      </div>
      <div aria-hidden="true" className="min-w-0">
        {!wide && <AccountName account={account} />}
        <p className="label-mono">{label}</p>
        <p className="display tabular truncate text-2xl">{amount}</p>
      </div>
      {credit && (
        <dl aria-hidden="true" className="grid grid-cols-2 gap-3 border-t-2 border-ink pt-3">
          <div className="min-w-0">
            <dt className="label-mono">Limit</dt>
            <dd className="tabular truncate font-display text-lg font-extrabold tracking-tight">{credit.limit}</dd>
          </div>
          <div className="min-w-0">
            <dt className="label-mono">{credit.remaining.overLimit ? 'Over limit by' : 'Available · estimate'}</dt>
            <dd className="tabular truncate font-display text-lg font-extrabold tracking-tight">{credit.remaining.amount}</dd>
          </div>
        </dl>
      )}
    </Link>
  )
}

function AccountName({ account, className }: { account: AccountBalanceRow; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="truncate font-semibold">{account.name}</p>
      {account.institution_name && <p className="truncate text-sm">{account.institution_name}</p>}
    </div>
  )
}
