import { Archive, ArchiveRestore, Check, ChevronRight, Inbox, ListOrdered, Plus, Star, Trash2 } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useSettings } from '@/app/settings'
import { AccountCard, describeBalance } from '@/components/finance/AccountCard'
import { ACCOUNT_TYPE_LABEL, AccountGlyph } from '@/components/finance/icons'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button, LinkButton } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { cn } from '@/components/ui/cn'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { TextField } from '@/components/ui/Field'
import { EmptyState, InlineError } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { TONE_BG, TONE_LABEL, TONES, toneOf, type AccentTone } from '@/components/ui/tones'
import type { AccountBalanceRow, AccountType } from '@/data/database.types'
import { useDeleteAccount, useSaveAccount, useUpdateProfile } from '@/data/hooks'
import { breakdownRows, describeCredit } from '@/features/accounts/figures'
import { accountFormText, accountValues, INSTITUTION_MAX_LENGTH, type AccountFormErrors } from '@/features/accounts/form'
import { formatDate } from '@/lib/dates'
import { friendlyError } from '@/lib/errors'
import { balanceSummary, groupAccounts, isLiability } from '@/lib/ledger'
import { fitAmountClass, formatAmountInput, formatMoney } from '@/lib/money'
import { goBack } from '@/lib/navigation'
import { activityHref } from './activityParams'

export function Accounts() {
  const { accounts } = useSettings()
  const [showArchived, setShowArchived] = useState(false)
  const active = accounts.filter((a) => a.status === 'active')
  const archived = accounts.filter((a) => a.status === 'archived')

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Accounts"
        actions={
          <LinkButton to="/accounts/new" size="sm" variant="primary" icon={<Plus aria-hidden="true" className="size-4" strokeWidth={3} />}>
            Add<span className="sr-only"> account</span>
          </LinkButton>
        }
      />

      {active.length === 0 ? (
        <Card tone="canvas" className="border-dashed">
          <EmptyState
            icon={<Plus className="size-9" strokeWidth={3} />}
            title="No active accounts"
            body={
              archived.length > 0
                ? 'Your archived accounts are below. Restore one, or add a new account to start tracking again.'
                : 'Add a bank account, card, wallet or cash to start tracking.'
            }
            action={
              <LinkButton to="/accounts/new" variant="primary">
                Add an account
              </LinkButton>
            }
          />
        </Card>
      ) : (
        <>
          <MoneySummary accounts={active} />
          {groupAccounts(active).map((group) => (
            <section key={group.type} aria-labelledby={`group-${group.type}`} className="flex flex-col gap-3">
              <h2 id={`group-${group.type}`} className="display text-2xl">
                {group.title}
              </h2>
              {isLiability(group.type) ? (
                <div className="flex flex-col gap-3">
                  {group.accounts.map((account) => (
                    <AccountCard key={account.id} account={account} wide />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {group.accounts.map((account) => (
                    <AccountCard key={account.id} account={account} />
                  ))}
                </div>
              )}
            </section>
          ))}
        </>
      )}

      {archived.length > 0 && (
        <section className="flex flex-col gap-3">
          <Button variant="ghost" onClick={() => setShowArchived((s) => !s)} aria-expanded={showArchived}>
            {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
          </Button>
          {showArchived && (
            <>
              <p className="text-sm text-muted">Archived accounts keep their history and balance. They aren’t in the totals above.</p>
              <div className="grid grid-cols-2 gap-3">
                {archived.map((account) => (
                  <AccountCard key={account.id} account={account} />
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  )
}

/** Available money and card dues, side by side but never added together. */
function MoneySummary({ accounts }: { accounts: AccountBalanceRow[] }) {
  const summary = balanceSummary(accounts)
  const hasCards = summary.cardAccounts > 0
  return (
    <section aria-label="Summary" className="flex flex-col gap-3">
      <div className={cn('grid gap-3', hasCards && 'grid-cols-2')}>
        <Card tone="peach" shadow="md" className="flex flex-col gap-1">
          <p className="label-mono">Available money</p>
          <Figure minor={summary.availableMinor} large={!hasCards} />
          <p className="mt-auto text-sm text-muted">Bank, wallet, cash &amp; other</p>
        </Card>
        {hasCards && (
          <Card tone="paper" shadow="md" className="flex flex-col gap-1">
            <p className="label-mono">Card dues</p>
            <Figure minor={summary.cardDuesMinor} />
            <p className="mt-auto text-sm text-muted">
              Owed on {summary.cardAccounts} {summary.cardAccounts === 1 ? 'card' : 'cards'}
            </p>
          </Card>
        )}
      </div>
      <p className="text-sm text-muted">
        {hasCards
          ? 'Available money is the total in your active bank, wallet, cash and other accounts. Card dues are what you owe on cards, kept separate.'
          : 'Available money is the total in your active bank, wallet, cash and other accounts.'}
      </p>
      {summary.reviewCount > 0 && <ReviewNote count={summary.reviewCount} />}
    </section>
  )
}

function Figure({ minor, large }: { minor: number; large?: boolean }) {
  const text = formatMoney(minor)
  return (
    <p className={cn('display tabular', large ? fitAmountClass(text, ['text-4xl', 'text-3xl', 'text-2xl']) : fitAmountClass(text))}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{text.replace('−', 'minus ')}</span>
    </p>
  )
}

/** Entries in needs_review don't count anywhere yet; say so and link to the queue. */
function ReviewNote({ count, onAccount }: { count: number; onAccount?: boolean }) {
  const entries = count === 1 ? '1 entry' : `${count} entries`
  const notIncluded = count === 1 ? 'isn’t included' : 'aren’t included'
  return (
    <Link
      to="/review"
      aria-label={`${entries}${onAccount ? ' on this account' : ''} waiting for review ${notIncluded} in ${
        onAccount ? 'this balance' : 'these totals'
      }. Open the review queue`}
      className="pressable flex min-h-11 items-center gap-3 rounded-[1.25rem] bg-yellow px-4 py-2 outline-regular"
    >
      <Inbox aria-hidden="true" className="size-5 shrink-0" strokeWidth={2.5} />
      <span aria-hidden="true" className="flex-1 text-sm font-semibold">
        {entries} waiting for review {notIncluded}
      </span>
      <ChevronRight aria-hidden="true" className="size-5 shrink-0" strokeWidth={2.5} />
    </Link>
  )
}

const TYPE_OPTIONS: { value: AccountType; label: string }[] = [
  { value: 'bank', label: 'Bank' },
  { value: 'credit_card', label: 'Card' },
  { value: 'wallet', label: 'Wallet' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
]

const DEFAULT_TONE: Record<AccountType, AccentTone> = { bank: 'sky', credit_card: 'purple', wallet: 'mint', cash: 'lime', other: 'yellow' }

const NAME_PLACEHOLDER: Record<AccountType, string> = {
  bank: 'e.g. SBI Savings',
  credit_card: 'e.g. HDFC Millennia',
  wallet: 'e.g. Paytm',
  cash: 'e.g. Pocket cash',
  other: 'e.g. Savings jar',
}

const INSTITUTION_PLACEHOLDER: Record<AccountType, string> = {
  bank: 'e.g. State Bank of India',
  credit_card: 'e.g. HDFC Bank',
  wallet: 'e.g. Paytm Payments Bank',
  cash: 'Optional',
  other: 'Optional',
}

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
  const formId = useId()
  const [initial] = useState(() => accountFormText(account))
  const [type, setType] = useState<AccountType>(account?.type ?? 'bank')
  const [name, setName] = useState(account?.name ?? '')
  const [institution, setInstitution] = useState(initial.institution)
  const [creditLimitText, setCreditLimitText] = useState(initial.creditLimitText)
  const [color, setColor] = useState<AccentTone>((account?.color as AccentTone) ?? DEFAULT_TONE[account?.type ?? 'bank'])
  const [colorTouched, setColorTouched] = useState(Boolean(account))
  const isCard = isLiability(type)
  const [openingText, setOpeningText] = useState(initial.openingText)
  const [negative, setNegative] = useState(initial.openingNegative)
  const [openingDate, setOpeningDate] = useState(account?.opening_date ?? todayDate)
  const [errors, setErrors] = useState<AccountFormErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)

  function changeType(next: AccountType) {
    setType(next)
    if (!colorTouched) setColor(DEFAULT_TONE[next])
    // Only cards have a limit; switching away drops it rather than saving it hidden.
    if (!isLiability(next)) {
      setCreditLimitText('')
      setErrors((current) => ({ ...current, creditLimit: undefined }))
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitError(null)
    const result = accountValues({
      type,
      name,
      color,
      institution,
      openingText,
      openingNegative: negative,
      openingDate,
      creditLimitText,
    })
    setErrors(result.errors ?? {})
    if (!result.values) return
    try {
      const saved = await save.mutateAsync({ id: account?.id, values: result.values })
      onSaved?.(saved.id)
    } catch (error) {
      setSubmitError(friendlyError(error))
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <fieldset className="flex flex-col">
        <legend className="label-mono mb-2">Type</legend>
        <div className="flex flex-wrap gap-2">
          {TYPE_OPTIONS.map((option) => {
            const selected = option.value === type
            return (
              <label key={option.value} className="relative">
                <input
                  type="radio"
                  name={`${formId}-type`}
                  value={option.value}
                  checked={selected}
                  onChange={() => changeType(option.value)}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    'pressable flex min-h-12 cursor-pointer items-center gap-2 rounded-pill pl-2 pr-4 font-display text-sm tracking-tight peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink',
                    selected
                      ? 'bg-ink font-extrabold text-paper outline-strong shadow-[3px_3px_0_0_var(--color-orange)]'
                      : 'bg-paper font-semibold outline-regular hover:bg-peach',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn('grid size-8 place-items-center rounded-full', selected ? 'bg-orange text-ink' : 'bg-peach')}
                  >
                    {selected ? <Check className="size-4" strokeWidth={3.5} /> : <AccountGlyph type={option.value} className="size-4" />}
                  </span>
                  {option.label}
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>
      <TextField
        label="Name"
        placeholder={NAME_PLACEHOLDER[type]}
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
        autoComplete="off"
      />
      <TextField
        label="Bank or provider (optional)"
        placeholder={INSTITUTION_PLACEHOLDER[type]}
        value={institution}
        maxLength={INSTITUTION_MAX_LENGTH}
        onChange={(e) => setInstitution(e.target.value)}
        error={errors.institution}
        autoComplete="off"
      />
      {isCard && (
        <TextField
          label="Credit limit (optional)"
          prefix="₹"
          inputMode="decimal"
          placeholder="e.g. 1,00,000"
          value={creditLimitText}
          onChange={(e) => setCreditLimitText(formatAmountInput(e.target.value))}
          error={errors.creditLimit}
          hint="Used to estimate your available credit. Leave it blank if you don’t know it."
          autoComplete="off"
        />
      )}
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
      <TextField
        label="Tracking since"
        type="date"
        value={openingDate}
        onChange={(e) => e.target.value && setOpeningDate(e.target.value)}
        hint={`${
          isCard ? 'The amount owed is what the card owed' : 'The starting balance is what the account held'
        } before the entries you record in Friday. Every entry moves it from there — even ones dated before this day.`}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="label-mono mb-2">Colour</legend>
        <div className="flex flex-wrap gap-2.5">
          {TONES.map((tone) => (
            <label key={tone} className="relative">
              <input
                type="radio"
                name={`${formId}-colour`}
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
  const [confirmDelete, setConfirmDelete] = useState(false)
  const remove = useDeleteAccount()
  const account = id ? accountsById.get(id) : undefined

  if (id && !account && !remove.isSuccess) {
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

  async function deleteForGood() {
    if (!account) return
    try {
      const { removed_entries, removed_transfers } = await remove.mutateAsync(account.id)
      const removed = removed_entries + removed_transfers
      setConfirmDelete(false)
      toast({ message: `${account.name} deleted${removed > 0 ? ` with ${removed} ${removed === 1 ? 'entry' : 'entries'}` : ''}` })
      navigate('/accounts', { replace: true })
    } catch (error) {
      setConfirmDelete(false)
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
        <div className="flex flex-col gap-2">
          <Button
            icon={account.status === 'active' ? <Archive className="size-5" strokeWidth={2.5} /> : <ArchiveRestore className="size-5" strokeWidth={2.5} />}
            onClick={() => (account.status === 'active' ? setConfirmArchive(true) : void toggleArchive())}
            loading={save.isPending && !confirmArchive}
          >
            {account.status === 'active' ? 'Archive account' : 'Restore account'}
          </Button>
          <p className="text-center text-sm text-muted">
            {account.status === 'active'
              ? 'Archiving keeps every entry and its history.'
              : 'Archived: kept with its history, not in your totals, and closed to new entries.'}
          </p>
          <Button variant="danger" icon={<Trash2 className="size-5" strokeWidth={2.5} />} onClick={() => setConfirmDelete(true)}>
            Delete account
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this account?"
        body="This deletes the account for good, with every income, expense and transfer recorded on it — transfers also leave the other account’s balance. It can’t be undone. To keep its history instead, archive it."
        confirmLabel="Delete for good"
        danger
        busy={remove.isPending}
        onCancel={() => {
          if (!remove.isPending) setConfirmDelete(false)
        }}
        onConfirm={() => void deleteForGood()}
      />

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
  const card = isLiability(account.type)
  const rows = breakdownRows(
    account,
    account.balance_from
      ? `Balance on ${formatDate(account.balance_from, { withYear: true })}`
      : `Opening (${formatDate(account.opening_date, { withYear: true })})`,
  )
  return (
    <Card tone="paper" shadow="lg" padded={false} className="overflow-hidden">
      <div className={cn('flex items-center gap-3 p-4', TONE_BG[toneOf(account.color)])}>
        <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-full bg-paper outline-regular">
          <AccountGlyph type={account.type} />
        </span>
        <div className="min-w-0">
          <p className="label-mono">
            {ACCOUNT_TYPE_LABEL[account.type]} · {label}
          </p>
          <p className="display tabular truncate text-4xl">{amount}</p>
          {account.institution_name && <p className="truncate text-sm font-semibold">{account.institution_name}</p>}
        </div>
      </div>
      {card && <CreditFigures account={account} />}
      <div className="flex flex-col gap-1.5 border-t-[3px] border-ink p-4 text-sm">
        <dl className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <div key={row.key} className="flex justify-between gap-3">
              <dt className="flex text-muted">
                <span className="w-4 shrink-0 font-semibold text-ink">{row.sign}</span>
                {row.label}
              </dt>
              {/* The operator is in the label; the opening balance keeps its own sign. */}
              <dd className="tabular font-semibold">{formatMoney(row.minor)}</dd>
            </div>
          ))}
          <div className="mt-1 flex justify-between gap-3 border-t-2 border-ink pt-2">
            <dt className="flex font-bold">
              <span className="w-4 shrink-0">=</span>
              Balance
            </dt>
            <dd className="tabular font-display text-base font-extrabold">{formatMoney(account.balance_minor)}</dd>
          </div>
        </dl>
        {card && <p className="pt-1 text-xs text-muted">For cards, a negative balance is what you owe.</p>}
        {account.balance_from && (
          <p className="pt-1 text-xs text-muted">
            Entries from {formatDate(account.opening_date, { withYear: true })} to{' '}
            {formatDate(account.balance_from, { withYear: true })} were imported as history: they count in your spending, not in
            this balance.
          </p>
        )}
        {account.pending_minor !== 0 && (
          <p className="pt-1 text-sm">
            Includes <span className="tabular font-semibold">{formatMoney(account.pending_minor, { sign: 'always' })}</span> still pending.
          </p>
        )}
      </div>
      <div className="flex flex-col items-start gap-3 px-4 pb-4">
        {account.review_count > 0 && (
          <div className="self-stretch">
            <ReviewNote count={account.review_count} onAccount />
          </div>
        )}
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

/** A card's limit and an estimate of what's left, or a nudge to add the limit. */
function CreditFigures({ account }: { account: AccountBalanceRow }) {
  const credit = describeCredit(account)
  if (!credit) {
    return (
      <p className="border-t-[3px] border-ink p-4 text-sm text-muted">
        No credit limit set. Add one below to see an estimate of your available credit.
      </p>
    )
  }
  const { remaining } = credit
  return (
    <div className="flex flex-col gap-2 border-t-[3px] border-ink p-4">
      <dl className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <dt className="label-mono text-muted">Limit</dt>
          <dd className="tabular font-display text-xl font-extrabold tracking-tight [overflow-wrap:anywhere]">{credit.limit}</dd>
        </div>
        <div className="min-w-0">
          <dt className="label-mono text-muted">{remaining.overLimit ? 'Over limit by' : 'Available · estimate'}</dt>
          <dd className="tabular font-display text-xl font-extrabold tracking-tight [overflow-wrap:anywhere]">{remaining.amount}</dd>
        </div>
      </dl>
      <p className="text-sm text-muted">
        {remaining.overLimit
          ? `You owe ${remaining.amount} more than your ${credit.limit} limit, based on what Friday knows.`
          : 'Your limit minus what you owe, based on what Friday knows. Your bank’s figure may differ (holds, fees or interest Friday hasn’t seen).'}
      </p>
    </div>
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
