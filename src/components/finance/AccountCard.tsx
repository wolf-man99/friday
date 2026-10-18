import { Link } from 'react-router'
import type { AccountBalanceRow } from '@/data/database.types'
import { cn } from '@/components/ui/cn'
import { TONE_BG, toneOf } from '@/components/ui/tones'
import { formatMoney } from '@/lib/money'
import { ACCOUNT_TYPE_LABEL, AccountGlyph } from './icons'

/** How to read an account's balance; credit cards show what is owed. */
export function describeBalance(account: Pick<AccountBalanceRow, 'type' | 'balance_minor'>) {
  const { type, balance_minor: balance } = account
  if (type === 'credit_card') {
    if (balance < 0) return { label: 'Owed', amount: formatMoney(-balance) }
    if (balance > 0) return { label: 'In credit', amount: formatMoney(balance) }
    return { label: 'Nothing owed', amount: formatMoney(0) }
  }
  if (balance < 0) return { label: 'Overdrawn', amount: formatMoney(balance) }
  return { label: 'Balance', amount: formatMoney(balance) }
}

export function AccountCard({ account, compact }: { account: AccountBalanceRow; compact?: boolean }) {
  const { label, amount } = describeBalance(account)
  const archived = account.status === 'archived'
  return (
    <Link
      to={`/accounts/${account.id}`}
      className={cn(
        'pressable flex flex-col justify-between gap-3 rounded-card p-4 outline-strong shadow-brutal',
        TONE_BG[toneOf(account.color)],
        compact ? 'min-h-32 w-44 shrink-0' : 'min-h-36',
        archived && 'opacity-70',
      )}
      aria-label={`${account.name}, ${ACCOUNT_TYPE_LABEL[account.type]}${archived ? ', archived' : ''}. ${label} ${amount}`}
    >
      <div aria-hidden="true" className="flex items-start justify-between gap-2">
        <span className="grid size-10 place-items-center rounded-full bg-paper outline-regular">
          <AccountGlyph type={account.type} />
        </span>
        <span className="label-mono rounded-pill bg-paper px-2 py-1 outline-regular">
          {archived ? 'Archived' : ACCOUNT_TYPE_LABEL[account.type]}
        </span>
      </div>
      <div aria-hidden="true" className="min-w-0">
        <p className="truncate font-semibold">{account.name}</p>
        <p className="label-mono">{label}</p>
        <p className="display tabular truncate text-2xl">{amount}</p>
      </div>
    </Link>
  )
}
