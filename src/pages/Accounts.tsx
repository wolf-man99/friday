import { Archive, ArchiveRestore, ListOrdered, Plus, Star } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useSettings } from '@/app/settings'
import { AccountCard, describeBalance } from '@/components/finance/AccountCard'
import { ACCOUNT_TYPE_LABEL, AccountGlyph } from '@/components/finance/icons'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button, LinkButton } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { cn } from '@/components/ui/cn'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { TextField } from '@/components/ui/Field'
import { PillSwitch } from '@/components/ui/PillSwitch'
import { EmptyState, InlineError } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { TONE_BG, TONE_LABEL, TONES, type AccentTone } from '@/components/ui/tones'
import type { AccountBalanceRow, AccountType } from '@/data/database.types'
import { useSaveAccount, useUpdateProfile } from '@/data/hooks'
import { formatDate } from '@/lib/dates'
import { friendlyError } from '@/lib/errors'
import { formatAmountInput, formatMoney, minorToDecimalString, parseAmountToMinor, MAX_AMOUNT_MINOR } from '@/lib/money'
import { goBack } from '@/lib/navigation'
import { activityHref } from './activityParams'

export function Accounts() {
  const { accounts } = useSettings()
  const [showArchived, setShowArchived] = useState(false)
  const active = accounts.filter((a) => a.status === 'active')
  const archived = accounts.filter((a) => a.status === 'archived')
  const assets = active.filter((a) => a.type !== 'credit_card')
  const cards = active.filter((a) => a.type === 'credit_card')

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Accounts"
        back="/profile"
        actions={
          <LinkButton to="/accounts/new" size="sm" variant="primary" icon={<Plus aria-hidden="true" className="size-4" strokeWidth={3} />}>
            Add<span className="sr-only"> account</span>
          </LinkButton>
        }
      />

      <div className="grid grid-cols-2 gap-3">
        <Card tone="peach" shadow="md">
          <p className="label-mono">Tracked balances</p>
          <p className="display tabular truncate text-2xl">{formatMoney(assets.reduce((s, a) => s + a.balance_minor, 0))}</p>
          <p className="text-sm text-muted">Cash, bank & other</p>
        </Card>
        <Card tone="paper" shadow="md">
          <p className="label-mono">Card dues</p>
          <p className="display tabular truncate text-2xl">
            {formatMoney(cards.reduce((s, a) => s + Math.max(0, -a.balance_minor), 0))}
          </p>
          <p className="text-sm text-muted">Owed on {cards.length} {cards.length === 1 ? 'card' : 'cards'}</p>
        </Card>
      </div>

      {active.length === 0 ? (
        <EmptyState icon={<Plus className="size-9" strokeWidth={3} />} title="No active accounts" action={<LinkButton to="/accounts/new" variant="primary">Add an account</LinkButton>} />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {active.map((account) => (
            <AccountCard key={account.id} account={account} />
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <section className="flex flex-col gap-3">
          <Button variant="ghost" onClick={() => setShowArchived((s) => !s)} aria-expanded={showArchived}>
            {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
          </Button>
          {showArchived && (
            <div className="grid grid-cols-2 gap-3">
              {archived.map((account) => (
                <AccountCard key={account.id} account={account} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

const TYPE_OPTIONS: { value: AccountType; label: string }[] = [
  { value: 'bank', label: 'Bank' },
  { value: 'cash', label: 'Cash' },
  { value: 'credit_card', label: 'Card' },
  { value: 'other', label: 'Other' },
]

const DEFAULT_TONE: Record<AccountType, AccentTone> = { bank: 'sky', cash: 'lime', credit_card: 'purple', other: 'yellow' }

interface AccountFormProps {
  account?: AccountBalanceRow
  /** Called after a successful create (onboarding uses this). */
  onSaved?: (id: string) => void
  submitLabel?: string
}

/** Create or edit an account. Credit cards ask for the amount owed. */
export function AccountForm({ account, onSaved, submitLabel }: AccountFormProps) {
  const { todayDate } = useSettings()
  const save = useSaveAccount()
  const [type, setType] = useState<AccountType>(account?.type ?? 'bank')
  const [name, setName] = useState(account?.name ?? '')
  const [color, setColor] = useState<AccentTone>((account?.color as AccentTone) ?? DEFAULT_TONE[account?.type ?? 'bank'])
  const [colorTouched, setColorTouched] = useState(Boolean(account))
  const isCard = type === 'credit_card'
  const openingDisplay = account ? (account.type === 'credit_card' ? -account.opening_balance_minor : account.opening_balance_minor) : 0
  const [openingText, setOpeningText] = useState(
    account ? formatAmountInput(minorToDecimalString(Math.abs(openingDisplay))) : '',
  )
  const [negative, setNegative] = useState(openingDisplay < 0)
  const [openingDate, setOpeningDate] = useState(account?.opening_date ?? todayDate)
  const [errors, setErrors] = useState<{ name?: string; opening?: string }>({})
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const nextErrors: typeof errors = {}
    if (!name.trim()) nextErrors.name = 'Give this account a name'
    const opening = openingText.trim() === '' ? 0 : parseAmountToMinor(openingText)
    if (opening === null) nextErrors.opening = 'Use numbers only, with up to 2 decimals'
    else if (opening > MAX_AMOUNT_MINOR) nextErrors.opening = 'That amount is too large'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return

    const magnitude = (negative ? -1 : 1) * opening!
    // Cards store what is owed as a negative position (see docs/financial-rules.md).
    const openingMinor = isCard ? -magnitude : magnitude
    try {
      const saved = await save.mutateAsync({
        id: account?.id,
        values: { name: name.trim(), type, color, opening_balance_minor: openingMinor, opening_date: openingDate },
      })
      onSaved?.(saved.id)
    } catch (error) {
      setSubmitError(friendlyError(error))
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="label-mono" id="account-type-label">
          Type
        </span>
        <PillSwitch
          label="Account type"
          options={TYPE_OPTIONS}
          value={type}
          onChange={(next) => {
            setType(next)
            if (!colorTouched) setColor(DEFAULT_TONE[next])
          }}
        />
      </div>
      <TextField
        label="Name"
        placeholder={isCard ? 'e.g. HDFC Millennia' : type === 'cash' ? 'e.g. Wallet' : 'e.g. SBI Savings'}
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
        autoComplete="off"
      />
      <div className="flex flex-col gap-2">
        <TextField
          label={isCard ? 'Amount owed when you start tracking' : 'Starting balance'}
          prefix={negative ? '−₹' : '₹'}
          inputMode="decimal"
          placeholder="0"
          value={openingText}
          onChange={(e) => setOpeningText(formatAmountInput(e.target.value))}
          error={errors.opening}
          hint={
            isCard
              ? 'What you owed on the card when you started. Purchases on the card add to it; payments from your bank are transfers that reduce it.'
              : 'The balance before your first entry in Friday.'
          }
        />
        <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-5 accent-ink" checked={negative} onChange={(e) => setNegative(e.target.checked)} />
          {isCard ? 'The card was in credit (you’d overpaid)' : 'This balance is negative (overdrawn)'}
        </label>
      </div>
      <TextField label="Tracking since" type="date" value={openingDate} onChange={(e) => e.target.value && setOpeningDate(e.target.value)} />

      <fieldset className="flex flex-col gap-2">
        <legend className="label-mono mb-2">Colour</legend>
        <div className="flex flex-wrap gap-2.5">
          {TONES.map((tone) => (
            <label key={tone} className="relative">
              <input
                type="radio"
                name="account-colour"
                value={tone}
                checked={color === tone}
                onChange={() => {
                  setColor(tone)
                  setColorTouched(true)
                }}
                className="peer sr-only"
              />
              <span
                className={cn(
                  'grid size-11 cursor-pointer place-items-center rounded-full outline-regular peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink',
                  TONE_BG[tone],
                  color === tone && 'outline-strong shadow-brutal-sm',
                )}
              >
                {color === tone && <span aria-hidden="true" className="size-3 rounded-full bg-ink" />}
              </span>
              <span className="sr-only">{TONE_LABEL[tone]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {submitError && <InlineError message={submitError} />}
      <Button type="submit" variant="primary" size="lg" block loading={save.isPending}>
        {submitLabel ?? (account ? 'Save account' : 'Add account')}
      </Button>
    </form>
  )
}

export function AccountEditor() {
  const { id } = useParams()
  const { accountsById, profile } = useSettings()
  const navigate = useNavigate()
  const toast = useToast()
  const save = useSaveAccount()
  const updateProfile = useUpdateProfile()
  const [confirmArchive, setConfirmArchive] = useState(false)
  const account = id ? accountsById.get(id) : undefined

  if (id && !account) {
    return (
      <div>
        <PageHeader title="Account" back="/accounts" />
        <InlineError message="That account doesn’t exist." />
      </div>
    )
  }

  async function toggleArchive() {
    if (!account) return
    const archiving = account.status === 'active'
    try {
      // An archived account can't take new entries, so it can't stay the default.
      if (archiving && profile.default_account_id === account.id) {
        await updateProfile.mutateAsync({ id: profile.id, patch: { default_account_id: null } })
      }
      await save.mutateAsync({ id: account.id, values: { status: archiving ? 'archived' : 'active' } })
      setConfirmArchive(false)
      toast({ message: archiving ? `${account.name} archived` : `${account.name} is active again` })
    } catch (error) {
      setConfirmArchive(false)
      toast({ message: friendlyError(error), tone: 'error' })
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={account ? account.name : 'New account'} back="/accounts" />

      {account && <BalanceBreakdown account={account} />}

      {account && account.status === 'active' && (
        <QuickAddDefault
          accountId={account.id}
          isDefault={profile.default_account_id === account.id}
          busy={updateProfile.isPending}
          onToggle={async (makeDefault) => {
            try {
              await updateProfile.mutateAsync({ id: profile.id, patch: { default_account_id: makeDefault ? account.id : null } })
              toast({ message: makeDefault ? `New entries will start in ${account.name}` : 'No default account — Quick Add uses your recent choice' })
            } catch (error) {
              toast({ message: friendlyError(error), tone: 'error' })
            }
          }}
        />
      )}

      <Card shadow="md">
        <AccountForm
          account={account}
          onSaved={() => {
            toast({ message: account ? 'Account saved' : 'Account added' })
            goBack(navigate, '/accounts')
          }}
        />
      </Card>

      {account && (
        <Button
          icon={account.status === 'active' ? <Archive className="size-5" strokeWidth={2.5} /> : <ArchiveRestore className="size-5" strokeWidth={2.5} />}
          onClick={() => (account.status === 'active' ? setConfirmArchive(true) : void toggleArchive())}
          loading={save.isPending && !confirmArchive}
        >
          {account.status === 'active' ? 'Archive account' : 'Restore account'}
        </Button>
      )}

      <ConfirmDialog
        open={confirmArchive}
        title="Archive this account?"
        body="Its history stays in your reports and its balance stays visible under archived accounts. You won’t be able to add new entries to it until you restore it."
        confirmLabel="Archive"
        busy={save.isPending}
        onCancel={() => setConfirmArchive(false)}
        onConfirm={() => void toggleArchive()}
      />
    </div>
  )
}

/** Shows exactly how the balance is derived from the ledger. */
function BalanceBreakdown({ account }: { account: AccountBalanceRow }) {
  const { label, amount } = describeBalance(account)
  const rows = [
    { label: `Opening (${formatDate(account.opening_date, { withYear: true })})`, value: account.opening_balance_minor, sign: '' },
    { label: 'Income', value: account.income_minor, sign: '+' },
    { label: 'Expenses', value: account.expense_minor, sign: '−' },
    { label: 'Transfers in', value: account.transfers_in_minor, sign: '+' },
    { label: 'Transfers out', value: account.transfers_out_minor, sign: '−' },
  ]
  return (
    <Card tone="paper" shadow="lg" padded={false} className="overflow-hidden">
      <div className={cn('flex items-center gap-3 p-4', TONE_BG[(account.color as AccentTone) ?? 'peach'])}>
        <span aria-hidden="true" className="grid size-12 place-items-center rounded-full bg-paper outline-regular">
          <AccountGlyph type={account.type} />
        </span>
        <div className="min-w-0">
          <p className="label-mono">
            {ACCOUNT_TYPE_LABEL[account.type]} · {label}
          </p>
          <p className="display tabular truncate text-4xl">{amount}</p>
        </div>
      </div>
      <dl className="flex flex-col gap-1.5 border-t-[3px] border-ink p-4 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-3">
            <dt className="text-muted">{row.label}</dt>
            <dd className="tabular font-semibold">
              {row.sign && row.value !== 0 ? row.sign : ''}
              {row.sign ? formatMoney(row.value) : formatMoney(row.value)}
            </dd>
          </div>
        ))}
        <div className="mt-1 flex justify-between gap-3 border-t-2 border-ink pt-2">
          <dt className="font-bold">Balance</dt>
          <dd className="tabular font-display text-base font-extrabold">{formatMoney(account.balance_minor)}</dd>
        </div>
        {account.type === 'credit_card' && (
          <p className="pt-1 text-xs text-muted">For cards, a negative balance is what you owe.</p>
        )}
      </dl>
      <div className="px-4 pb-4">
        <LinkButton
          to={activityHref({ period: 'all', account: account.id })}
          size="sm"
          icon={<ListOrdered aria-hidden="true" className="size-4" strokeWidth={2.5} />}
        >
          See its transactions
        </LinkButton>
      </div>
    </Card>
  )
}

function QuickAddDefault({
  accountId,
  isDefault,
  busy,
  onToggle,
}: {
  accountId: string
  isDefault: boolean
  busy: boolean
  onToggle: (makeDefault: boolean) => void
}) {
  return (
    <Card tone={isDefault ? 'lime' : 'paper'} className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Star aria-hidden="true" className="mt-0.5 size-5 shrink-0" strokeWidth={2.5} fill={isDefault ? 'currentColor' : 'none'} />
        <div>
          <h2 className="font-display text-lg font-extrabold tracking-tight">Quick Add default</h2>
          <p className="text-sm">
            {isDefault
              ? 'New expenses and income start in this account. You can still switch before saving.'
              : 'Make new entries start in this account instead of your most recent choice.'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={isDefault ? 'secondary' : 'primary'} loading={busy} onClick={() => onToggle(!isDefault)}>
          {isDefault ? 'Stop using as default' : 'Make default'}
        </Button>
        <LinkButton
          size="sm"
          to={`/add?account=${accountId}`}
          state={{ from: `/accounts/${accountId}` }}
          icon={<Plus aria-hidden="true" className="size-4" strokeWidth={3} />}
        >
          Add entry here
        </LinkButton>
      </div>
    </Card>
  )
}
