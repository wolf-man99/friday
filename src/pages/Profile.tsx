import { ChevronRight, Download, FileJson, Inbox, Landmark, LogOut, Mail, Repeat, ShieldAlert, Tags } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { signOut, useAuth } from '@/app/auth'
import { useSettings } from '@/app/settings'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Dialog } from '@/components/ui/Dialog'
import { SelectField, TextField } from '@/components/ui/Field'
import { InlineError } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { fetchAllEntries, fetchBackup } from '@/data/api'
import { useAttention, useDeleteAllData, useDisconnectGmail, useDueOccurrences, useGmailConnection, useUpdateProfile } from '@/data/hooks'
import { attentionCounts } from '@/features/insights/figures'
import { accountsCsv, transactionsCsv } from '@/features/insights/exports'
import { downloadFile, toCsv } from '@/lib/csv'
import { browserTimeZone, canonicalTimeZone, localDate } from '@/lib/dates'
import { friendlyError } from '@/lib/errors'

export const TIME_ZONES: string[] = (() => {
  try {
    const zones = (Intl as unknown as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf('timeZone')
    return [...new Set(zones.map(canonicalTimeZone))].sort()
  } catch {
    return ['Asia/Kolkata', 'UTC']
  }
})()

export function Profile() {
  const { profile, accounts, accountsById, categories, categoriesById } = useSettings()
  const { session } = useAuth()
  const due = useDueOccurrences()
  const attention = useAttention()
  const gmail = useGmailConnection()
  const updateProfile = useUpdateProfile()
  const toast = useToast()
  const [name, setName] = useState(profile.display_name ?? '')
  const [exporting, setExporting] = useState<'csv' | 'accounts' | 'json' | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const zones = TIME_ZONES.includes(profile.timezone) ? TIME_ZONES : [profile.timezone, ...TIME_ZONES]
  const deviceZone = browserTimeZone()

  async function saveProfile(patch: { display_name?: string | null; timezone?: string }) {
    try {
      await updateProfile.mutateAsync({ id: profile.id, patch })
      toast({ message: patch.timezone ? `Timezone set to ${patch.timezone}` : 'Saved' })
    } catch (error) {
      toast({ message: friendlyError(error), tone: 'error' })
    }
  }

  async function exportTransactions() {
    setExporting('csv')
    try {
      const entries = await fetchAllEntries()
      const { headers, rows } = transactionsCsv(entries, { accountsById, categoriesById, timeZone: profile.timezone })
      downloadFile(`friday-transactions-${localDate(new Date(), profile.timezone)}.csv`, toCsv(headers, rows))
      toast({ message: `Exported ${rows.length} entries` })
    } catch (error) {
      toast({ message: friendlyError(error), tone: 'error' })
    } finally {
      setExporting(null)
    }
  }

  function exportAccounts() {
    setExporting('accounts')
    const { headers, rows } = accountsCsv(accounts)
    downloadFile(`friday-accounts-${localDate(new Date(), profile.timezone)}.csv`, toCsv(headers, rows))
    setExporting(null)
    toast({ message: `Exported ${rows.length} accounts` })
  }

  async function exportBackup() {
    setExporting('json')
    try {
      const backup = await fetchBackup()
      downloadFile(
        `friday-backup-${localDate(new Date(), profile.timezone)}.json`,
        JSON.stringify(backup, null, 2),
        'application/json',
      )
      toast({ message: 'Backup downloaded' })
    } catch (error) {
      toast({ message: friendlyError(error), tone: 'error' })
    } finally {
      setExporting(null)
    }
  }

  const dueCount = due.data?.length ?? 0
  const { toReview } = attentionCounts(attention.data)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Profile" scribble="your stuff" back="/" />

      <Card tone="peach" shadow="md" className="flex flex-col gap-4">
        <div>
          <p className="label-mono">Signed in as</p>
          <p className="truncate font-semibold">{session?.user.email}</p>
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void saveProfile({ display_name: name.trim() || null })
          }}
        >
          <TextField label="What should Friday call you?" className="flex-1" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" disabled={name === (profile.display_name ?? '')} loading={updateProfile.isPending && !updateProfile.variables?.patch.timezone}>
            Save
          </Button>
        </form>
        <SelectField
          label="Timezone"
          value={profile.timezone}
          onChange={(e) => void saveProfile({ timezone: e.target.value })}
          hint={
            profile.timezone !== deviceZone ? (
              <>
                This device is on {deviceZone}.{' '}
                <button type="button" className="font-semibold underline" onClick={() => void saveProfile({ timezone: deviceZone })}>
                  Use it
                </button>
              </>
            ) : (
              'Days, weeks and months in your reports follow this timezone.'
            )
          }
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </SelectField>
      </Card>

      <Card padded={false} shadow="md" className="overflow-hidden">
        <nav aria-label="Manage">
          <ul className="divide-y-2 divide-ink/10">
            <NavRow to="/accounts" icon={<Landmark className="size-5" strokeWidth={2.25} />} label="Accounts" detail={`${accounts.filter((a) => a.status === 'active').length} active`} />
            <NavRow to="/categories" icon={<Tags className="size-5" strokeWidth={2.25} />} label="Categories" detail={`${categories.filter((c) => !c.is_archived).length} active`} />
            <NavRow to="/recurring" icon={<Repeat className="size-5" strokeWidth={2.25} />} label="Recurring" detail={dueCount > 0 ? `${dueCount} due` : 'Bills & salary'} highlight={dueCount > 0} />
            <NavRow
              to="/review"
              icon={<Inbox className="size-5" strokeWidth={2.25} />}
              label="Review"
              detail={toReview > 0 ? `${toReview} to review` : attention.data ? 'All clear' : 'Imports & checks'}
              highlight={toReview > 0}
            />
            <NavRow
              to="/connections/gmail"
              icon={<Mail className="size-5" strokeWidth={2.25} />}
              label="Gmail"
              detail={
                gmail.data?.status === 'active'
                  ? 'Connected'
                  : gmail.data?.status === 'needs_reconnect'
                    ? 'Reconnect'
                    : gmail.isSuccess
                      ? 'Not connected'
                      : 'Bank alerts'
              }
              highlight={gmail.data?.status === 'needs_reconnect'}
            />
          </ul>
        </nav>
      </Card>

      <Card shadow="md" className="flex flex-col gap-3">
        <h2 className="display text-2xl">Your data</h2>
        <p className="text-sm text-muted">Exports include only your own records. Amounts are in rupees with two decimals.</p>
        <Button block icon={<Download className="size-5" strokeWidth={2.5} />} loading={exporting === 'csv'} disabled={exporting !== null} onClick={() => void exportTransactions()}>
          Transactions (CSV)
        </Button>
        <Button block icon={<Download className="size-5" strokeWidth={2.5} />} loading={exporting === 'accounts'} disabled={exporting !== null} onClick={exportAccounts}>
          Accounts & balances (CSV)
        </Button>
        <Button block icon={<FileJson className="size-5" strokeWidth={2.5} />} loading={exporting === 'json'} disabled={exporting !== null} onClick={() => void exportBackup()}>
          Full backup (JSON)
        </Button>
      </Card>

      <Card tone="paper" className="flex flex-col gap-3">
        <h2 className="display text-xl">Privacy</h2>
        <p className="text-sm">
          Friday never asks for bank logins, card numbers or passwords to other services. Your records are visible only to
          you — the database checks it on every request.
        </p>
        <Button variant="danger" block icon={<ShieldAlert className="size-5" strokeWidth={2.5} />} onClick={() => setDeleteOpen(true)}>
          Delete all my data…
        </Button>
      </Card>

      <Button block size="lg" icon={<LogOut className="size-5" strokeWidth={2.5} />} onClick={() => void signOut()}>
        Sign out
      </Button>
      <p className="text-center text-xs text-muted">Friday v{__APP_VERSION__}</p>

      <DeleteAllDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} />
    </div>
  )
}

function NavRow({ to, icon, label, detail, highlight }: { to: string; icon: ReactNode; label: string; detail: string; highlight?: boolean }) {
  return (
    <li>
      <Link to={to} className="flex min-h-16 items-center gap-3 px-4 hover:bg-peach/50">
        <span aria-hidden="true" className="grid size-10 place-items-center rounded-full bg-peach outline-regular">
          {icon}
        </span>
        <span className="flex-1 font-display text-lg font-extrabold tracking-tight">{label}</span>
        <span className={highlight ? 'label-mono rounded-pill bg-orange px-2 py-1 outline-regular' : 'label-mono text-muted'}>{detail}</span>
        <ChevronRight aria-hidden="true" className="size-5" strokeWidth={2.5} />
      </Link>
    </li>
  )
}

function DeleteAllDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const remove = useDeleteAllData()
  const disconnectGmail = useDisconnectGmail()
  const toast = useToast()
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog
      open={open}
      onClose={() => {
        setTyped('')
        setError(null)
        onClose()
      }}
      title="Delete everything?"
      footer={
        <Button
          variant="ink"
          block
          disabled={typed !== 'DELETE'}
          loading={remove.isPending || disconnectGmail.isPending}
          onClick={async () => {
            try {
              // Revoke Gmail access with Google first (harmless if none); deleting
              // the data removes it from Friday regardless.
              await disconnectGmail.mutateAsync().catch(() => undefined)
              await remove.mutateAsync()
              toast({ message: 'All your Friday data was deleted.' })
              setTyped('')
              onClose()
            } catch (err) {
              setError(friendlyError(err))
            }
          }}
        >
          Permanently delete
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p>
          This permanently removes every account, transaction, transfer and recurring item, disconnects Gmail, and resets
          your categories to the defaults. It can’t be undone — export a backup first if you might want it.
        </p>
        <p className="text-sm text-muted">Your login stays. To close your login too, delete the user in the Supabase dashboard.</p>
        <TextField label='Type "DELETE" to confirm' value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        {error && <InlineError message={error} />}
      </div>
    </Dialog>
  )
}
