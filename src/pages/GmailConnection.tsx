import { CircleCheck, Eye, KeyRound, Lock, Mail, MailSearch, RefreshCw, TriangleAlert, Unplug } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useSettings } from '@/app/settings'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { InlineError, LoadingBlock } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { callbackErrorMessage, gmailErrorMessage, type GmailConnection as Connection, type GmailTestFetch } from '@/data/gmail'
import { useCompleteGmail, useDisconnectGmail, useGmailConnection, useGmailTestFetch, useStartGmail } from '@/data/hooks'
import { formatDateTime } from '@/features/detail/describe'
import { PastTransactions } from '@/features/gmailImport/PastTransactions'
import { friendlyError } from '@/lib/errors'

export const GMAIL_PATH = '/connections/gmail'

/**
 * Connect Gmail (read-only) so Friday can later read bank alert emails. This
 * screen also finishes the OAuth round trip: Google → gmail-oauth-callback →
 * here with #ticket=… (or ?gmail_error=…), which only the user who started it
 * can complete. Nothing here records a transaction.
 */
export function GmailConnection() {
  const location = useLocation()
  const navigate = useNavigate()
  const toast = useToast()
  const connection = useGmailConnection()
  const complete = useCompleteGmail()
  // Read once, then cleared from the address bar and history.
  const [ticket] = useState(() => new URLSearchParams(location.hash.slice(1)).get('ticket'))
  const [callbackError, setCallbackError] = useState(() => new URLSearchParams(location.search).get('gmail_error'))
  const completing = useRef(false)

  // On arrival only: the ticket and error code leave the address bar and history.
  const arrival = useRef({ cleanUp: Boolean(location.hash || location.search), state: location.state })
  useEffect(() => {
    if (arrival.current.cleanUp) navigate(GMAIL_PATH, { replace: true, state: arrival.current.state })
  }, [navigate])

  useEffect(() => {
    if (!ticket || completing.current) return
    completing.current = true
    complete.mutate(ticket, {
      onSuccess: ({ connection: connected }) => toast({ message: `Gmail connected · ${connected.accountEmail}` }),
    })
  }, [ticket, complete, toast])

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Gmail" scribble="bank alerts" back="/profile" />

      {callbackError && (
        <Notice tone="error" onDismiss={() => setCallbackError(null)}>
          {callbackErrorMessage(callbackError)}
        </Notice>
      )}
      {complete.isError && <Notice tone="error">{gmailErrorMessage(complete.error)}</Notice>}

      {complete.isPending ? (
        <Card shadow="md" className="flex flex-col gap-3">
          <p className="display text-xl">Finishing the connection…</p>
          <LoadingBlock rows={1} label="Connecting Gmail" />
        </Card>
      ) : connection.isPending ? (
        <LoadingBlock rows={3} label="Loading your Gmail connection" />
      ) : connection.isError ? (
        <InlineError message={friendlyError(connection.error)} onRetry={() => void connection.refetch()} />
      ) : connection.data ? (
        <Connected connection={connection.data} justConnected={complete.isSuccess} />
      ) : (
        <NotConnected />
      )}

      <WhatFridayReads />
    </div>
  )
}

function Notice({ tone, children, onDismiss }: { tone: 'error' | 'info'; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className="flex items-start gap-2 rounded-[1.25rem] bg-paper p-4 outline-regular"
    >
      {tone === 'error' ? (
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-negative" strokeWidth={2.5} />
      ) : (
        <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0" strokeWidth={2.5} />
      )}
      <p className="flex-1 font-semibold">{children}</p>
      {onDismiss && (
        <button type="button" className="text-sm font-semibold underline" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  )
}

function ConnectButton({ label, variant = 'primary' }: { label: string; variant?: 'primary' | 'secondary' }) {
  const start = useStartGmail()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-3">
      <Button
        block
        size="lg"
        variant={variant}
        icon={<Mail className="size-5" strokeWidth={2.5} />}
        loading={start.isPending}
        onClick={async () => {
          setError(null)
          try {
            const { url } = await start.mutateAsync()
            // Leaves Friday for Google's consent screen; Google sends the browser back.
            window.location.assign(url)
          } catch (err) {
            setError(gmailErrorMessage(err))
          }
        }}
      >
        {label}
      </Button>
      {error && <InlineError message={error} />}
    </div>
  )
}

function NotConnected() {
  return (
    <Card tone="peach" shadow="md" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="display text-2xl">Not connected</h2>
        <p>
          Connect the Gmail account your bank, card and wallet alerts go to. For now Friday only connects and lets you
          preview what it would see — it doesn’t record anything from email yet.
        </p>
      </div>
      <ConnectButton label="Connect Gmail" />
      <p className="text-sm text-muted">
        You’ll go to Google to choose an account and approve read-only access, then come back here.
      </p>
    </Card>
  )
}

function Connected({ connection, justConnected }: { connection: Connection; justConnected: boolean }) {
  const { timeZone } = useSettings()
  const toast = useToast()
  const disconnect = useDisconnectGmail()
  const check = useGmailTestFetch()
  const [confirming, setConfirming] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)
  const needsReconnect = connection.status === 'needs_reconnect'

  async function confirmDisconnect() {
    setDisconnectError(null)
    try {
      const result = await disconnect.mutateAsync()
      setConfirming(false)
      toast({
        message: result.revoked
          ? 'Gmail disconnected. Friday’s access was removed.'
          : 'Gmail disconnected here. Google didn’t confirm — you can also remove Friday at myaccount.google.com/permissions.',
      })
    } catch (error) {
      setDisconnectError(gmailErrorMessage(error))
    }
  }

  return (
    <>
      <Card tone={needsReconnect ? 'yellow' : 'mint'} shadow="md" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="label-mono">{needsReconnect ? 'Needs reconnecting' : 'Connected · read-only'}</p>
          <h2 className="display break-all text-2xl">{connection.account_email}</h2>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {connection.connected_at && (
            <>
              <dt className="text-muted">Connected</dt>
              <dd>{formatDateTime(connection.connected_at, timeZone)}</dd>
            </>
          )}
          <dt className="text-muted">Last checked</dt>
          <dd>{connection.last_checked_at ? formatDateTime(connection.last_checked_at, timeZone) : 'Not yet'}</dd>
        </dl>

        {needsReconnect ? (
          <>
            <p>
              Google stopped accepting Friday’s access — usually because it was removed in your Google account or the
              password changed. Friday deleted the old access; reconnect to carry on.
            </p>
            <ConnectButton label="Reconnect Gmail" />
          </>
        ) : (
          <Button
            block
            icon={<MailSearch className="size-5" strokeWidth={2.5} />}
            loading={check.isPending}
            onClick={() => check.mutate(5)}
          >
            Preview recent alerts
          </Button>
        )}
        <Button variant="danger" block icon={<Unplug className="size-5" strokeWidth={2.5} />} onClick={() => setConfirming(true)}>
          Disconnect Gmail
        </Button>
      </Card>

      {check.isError && <InlineError message={gmailErrorMessage(check.error)} />}
      {check.data && !needsReconnect && <Preview result={check.data} timeZone={timeZone} />}
      {!needsReconnect && <PastTransactions prompt={justConnected} />}

      <ConfirmDialog
        open={confirming}
        title="Disconnect Gmail?"
        body={
          <div className="flex flex-col gap-3">
            <p>
              Friday deletes the access it stored and asks Google to revoke it. Nothing you’ve recorded changes. You can
              connect again any time.
            </p>
            {disconnectError && (
              <p role="alert" className="text-sm font-semibold text-negative">
                {disconnectError}
              </p>
            )}
          </div>
        }
        confirmLabel="Disconnect"
        danger
        busy={disconnect.isPending}
        onCancel={() => {
          if (disconnect.isPending) return
          setConfirming(false)
          setDisconnectError(null)
        }}
        onConfirm={() => void confirmDisconnect()}
      />
    </>
  )
}

function Preview({ result, timeZone }: { result: GmailTestFetch; timeZone: string }) {
  return (
    <section aria-labelledby="gmail-preview-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="gmail-preview-heading" className="display text-2xl">
          Recent alerts
        </h2>
        <p className="text-sm text-muted">
          {result.messages.length === 0
            ? 'No alert emails from known bank, card or wallet senders in the last 30 days.'
            : `The ${result.messages.length} newest alert emails from known senders. Preview only — nothing was recorded.`}
        </p>
      </div>
      {result.messages.length > 0 && (
        <ul className="flex flex-col gap-2">
          {result.messages.map((message) => (
            <li key={message.id}>
              <Card className="flex flex-col gap-1">
                <p className="label-mono truncate">{message.from}</p>
                <p className="font-semibold">{message.subject || '(no subject)'}</p>
                {message.snippet && <p className="line-clamp-2 text-sm text-muted">{decodeEntities(message.snippet)}</p>}
                {message.receivedAt && <p className="text-xs text-muted">{formatDateTime(message.receivedAt, timeZone)}</p>}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Gmail snippets arrive HTML-escaped (&amp;, &#39;); show them as text, never as HTML. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function WhatFridayReads() {
  return (
    <Card tone="paper" className="flex flex-col gap-3">
      <h2 className="display text-xl">What Friday can see</h2>
      <ul className="flex flex-col gap-3 text-sm">
        <Point icon={<Eye className="size-5" strokeWidth={2.25} />}>
          <strong>Read-only.</strong> Friday asks Google for Gmail read-only access and nothing else — it can’t send,
          delete or change mail.
        </Point>
        <Point icon={<MailSearch className="size-5" strokeWidth={2.25} />}>
          <strong>Alert emails only.</strong> Friday searches only for transaction alerts from bank, card and wallet
          senders. To import them it reads each alert’s text and keeps just the transaction: amount, date, account,
          merchant and reference — never the email itself.
        </Point>
        <Point icon={<Lock className="size-5" strokeWidth={2.25} />}>
          <strong>Your access stays on Friday’s server, encrypted.</strong> This app never sees it. Disconnecting deletes
          it and revokes it with Google.
        </Point>
        <Point icon={<KeyRound className="size-5" strokeWidth={2.25} />}>
          <strong>Testing mode.</strong> Until Google verifies Friday, Google shows an “unverified app” warning and only
          approved test accounts can connect.
        </Point>
        <Point icon={<RefreshCw className="size-5" strokeWidth={2.25} />}>
          You can also remove Friday’s access any time at myaccount.google.com/permissions.
        </Point>
      </ul>
    </Card>
  )
}

function Point({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-peach outline-regular">
        {icon}
      </span>
      <p className="pt-1.5">{children}</p>
    </li>
  )
}
