import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/Toast'
import type { GmailConnection as Connection, GmailTestFetch } from '@/data/gmail'
import { GmailServiceError } from '@/data/gmail'
import { GmailConnection } from './GmailConnection'

let connection: Connection | null = null
let connectionError: unknown = null
const start = vi.fn()
const complete = vi.fn()
const disconnect = vi.fn()
const testFetch = vi.fn()

vi.mock('@/app/settings', () => ({ useSettings: () => ({ timeZone: 'Asia/Kolkata' }) }))
// Importing past months has its own tests (src/features/gmailImport).
vi.mock('@/features/gmailImport/PastTransactions', () => ({
  PastTransactions: ({ prompt }: { prompt?: boolean }) => <p>past transactions{prompt ? ': offered' : ''}</p>,
}))

// Minimal stand-ins for TanStack mutations: track pending/error/data like the real thing.
vi.mock('@/data/hooks', async () => {
  const { useState } = await import('react')
  function useFakeMutation<A, R>(fn: (arg: A) => Promise<R>) {
    const [state, setState] = useState<{ isPending: boolean; error: unknown; data: R | undefined }>({
      isPending: false,
      error: null,
      data: undefined,
    })
    const mutateAsync = async (arg: A) => {
      setState((s) => ({ ...s, isPending: true, error: null }))
      try {
        const data = await fn(arg)
        setState({ isPending: false, error: null, data })
        return data
      } catch (error) {
        setState({ isPending: false, error, data: undefined })
        throw error
      }
    }
    return {
      ...state,
      isError: state.error !== null,
      isSuccess: state.data !== undefined,
      mutateAsync,
      mutate: (arg: A, options?: { onSuccess?: (data: R) => void }) => {
        mutateAsync(arg).then((data) => options?.onSuccess?.(data), () => undefined)
      },
    }
  }
  return {
    useGmailConnection: () =>
      connectionError
        ? { isPending: false, isError: true, error: connectionError, data: undefined, refetch: vi.fn() }
        : { isPending: false, isError: false, error: null, data: connection, refetch: vi.fn() },
    useStartGmail: () => useFakeMutation(() => start()),
    useCompleteGmail: () => useFakeMutation((ticket: string) => complete(ticket)),
    useDisconnectGmail: () => useFakeMutation(() => disconnect()),
    useGmailTestFetch: () => useFakeMutation((limit?: number) => testFetch(limit)),
  }
})

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname + location.search + location.hash}</p>
}

function renderPage(path = '/connections/gmail') {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <Routes>
            <Route
              path="/connections/gmail"
              element={
                <>
                  <GmailConnection />
                  <Where />
                </>
              }
            />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  )
}

const active: Connection = {
  id: 'c1',
  status: 'active',
  account_email: 'asha@gmail.com',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  connected_at: '2026-10-19T04:30:00Z',
  last_checked_at: null,
  last_error_code: null,
}

const assign = vi.fn()

beforeEach(() => {
  connection = null
  connectionError = null
  for (const fn of [start, complete, disconnect, testFetch, assign]) fn.mockReset()
  vi.stubGlobal('location', { ...window.location, assign })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Gmail connection — not connected', () => {
  it('explains what Friday reads and sends the person to Google to approve', async () => {
    start.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?scope=gmail.readonly' })
    renderPage()
    expect(screen.getByRole('heading', { name: 'Not connected' })).toBeInTheDocument()
    expect(screen.getByText(/Read-only\./)).toBeInTheDocument()
    expect(screen.getByText(/doesn’t record anything from email yet/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?scope=gmail.readonly'))
  })

  it('says so when the Gmail service isn’t set up, and stays put', async () => {
    start.mockRejectedValue(new GmailServiceError('Gmail isn’t set up on this Friday server yet.', 'not_configured'))
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }))
    expect(await screen.findByText('Gmail isn’t set up on this Friday server yet.')).toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
  })

  it('tells the person to run the migration when the database is behind', () => {
    connectionError = { code: '42703', message: 'column source_connections.provider does not exist' }
    renderPage()
    expect(screen.getByRole('alert')).toHaveTextContent('run the newest file in supabase/migrations')
  })
})

describe('Gmail connection — coming back from Google', () => {
  it('completes the ticket exactly once and clears it from the address bar', async () => {
    complete.mockImplementation(async () => {
      connection = active
      return { connection: { id: 'c1', accountEmail: 'asha@gmail.com', status: 'active' } }
    })
    renderPage('/connections/gmail#ticket=abcDEF123')
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/connections\/gmail$/))
    expect(await screen.findByText('Gmail connected · asha@gmail.com')).toBeInTheDocument()
    expect(await screen.findByText('past transactions: offered')).toBeInTheDocument()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith('abcDEF123')
  })

  it('shows why a ticket was refused (e.g. started from another Friday account)', async () => {
    complete.mockRejectedValue(
      new GmailServiceError('This Gmail approval was started from a different Friday account, so it wasn’t connected.', 'wrong_user'),
    )
    renderPage('/connections/gmail#ticket=abcDEF123')
    expect(await screen.findByText(/started from a different Friday account/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument()
  })

  it('explains callback errors in words and clears the code from the address', async () => {
    renderPage('/connections/gmail?gmail_error=access_denied')
    expect(screen.getByRole('alert')).toHaveTextContent('You didn’t allow access on Google’s screen, so nothing was connected.')
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/connections\/gmail$/))
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('never shows raw codes it doesn’t know', () => {
    renderPage('/connections/gmail?gmail_error=%3Cscript%3E')
    expect(screen.getByRole('alert')).toHaveTextContent('Google reported a problem, so nothing was connected. Try again.')
  })

  it.each(['__proto__', 'constructor', 'toString'])('isn’t broken by a crafted code (%s)', (code) => {
    renderPage(`/connections/gmail?gmail_error=${code}`)
    expect(screen.getByRole('alert')).toHaveTextContent('Google reported a problem, so nothing was connected. Try again.')
  })
})

describe('Gmail connection — connected', () => {
  it('shows the account and previews alert metadata without recording anything', async () => {
    connection = active
    const result: GmailTestFetch = {
      query: 'from:(hdfcbank.net) …',
      estimate: 1,
      recorded: false,
      messages: [
        {
          id: 'm1',
          receivedAt: '2026-10-18T05:00:00Z',
          from: 'HDFC Bank <alerts@hdfcbank.net>',
          subject: 'Rs.250.00 debited',
          snippet: 'Rs.250.00 debited from a/c **1234 to Blue Tokai &amp; Co',
        },
      ],
    }
    testFetch.mockResolvedValue(result)
    renderPage()
    expect(screen.getByRole('heading', { name: 'asha@gmail.com' })).toBeInTheDocument()
    expect(screen.getByText('Connected · read-only')).toBeInTheDocument()
    expect(screen.getByText('past transactions')).toBeInTheDocument()
    expect(screen.getByText('Not yet')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Preview recent alerts' }))
    const preview = await screen.findByRole('region', { name: 'Recent alerts' })
    expect(within(preview).getByText(/nothing was recorded/)).toBeInTheDocument()
    expect(within(preview).getByText('Rs.250.00 debited')).toBeInTheDocument()
    expect(within(preview).getByText(/Blue Tokai & Co/)).toBeInTheDocument()
    expect(testFetch).toHaveBeenCalledWith(5)
  })

  it('disconnects after confirming, and says whether Google confirmed the revoke', async () => {
    connection = active
    disconnect.mockResolvedValue({ disconnected: true, revoked: true, removed: 1 })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect Gmail' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect Gmail?' })
    expect(within(dialog).getByText(/asks Google to revoke it/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByText('Gmail disconnected. Friday’s access was removed.')).toBeInTheDocument()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('asks to reconnect when Google stopped accepting the access', () => {
    connection = { ...active, status: 'needs_reconnect', last_error_code: 'invalid_grant' }
    renderPage()
    expect(screen.getByText('Needs reconnecting')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconnect Gmail' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Preview recent alerts' })).not.toBeInTheDocument()
  })
})
