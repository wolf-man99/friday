import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/Toast'
import type { GmailImportJobRow } from '@/data/database.types'
import { PastTransactions } from './PastTransactions'

let latest: GmailImportJobRow | null = null
const gmail = vi.hoisted(() => ({
  fetchLatestImport: vi.fn(),
  startImport: vi.fn(),
  scanImport: vi.fn(),
  runImport: vi.fn(),
  cancelImport: vi.fn(),
  importAccounts: vi.fn(),
  confirmImportAccounts: vi.fn(),
  undoImport: vi.fn(),
}))

vi.mock('@/app/settings', () => ({ useSettings: () => ({ todayDate: '2026-10-20', timeZone: 'Asia/Kolkata', accounts: [] }) }))
vi.mock('@/data/gmail', async (original) => ({ ...(await original<typeof import('@/data/gmail')>()), ...gmail }))

const job = (patch: Partial<GmailImportJobRow>): GmailImportJobRow =>
  ({
    id: '6f1c2a7e-1111-4a4a-8b8b-000000000001',
    months: ['2026-10'],
    status: 'listing',
    total_messages: 0,
    scanned: 0,
    skipped: 0,
    recorded: 0,
    matched: 0,
    review: 0,
    ignored: 0,
    truncated: false,
    created_at: '2026-10-20T10:00:00Z',
    updated_at: '2026-10-20T10:00:00Z',
    ...patch,
  }) as GmailImportJobRow

function renderIt(prompt = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <PastTransactions prompt={prompt} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  for (const fn of Object.values(gmail)) fn.mockReset()
  latest = null
  gmail.fetchLatestImport.mockImplementation(async () => latest)
})

describe('past transactions', () => {
  it('offers the three months to an account connected before, not only right after connecting', async () => {
    renderIt(false)
    expect(await screen.findByRole('heading', { name: 'Track your past transactions?' })).toBeInTheDocument()
    for (const name of ['October 2026 (to today)', 'September 2026', 'August 2026']) {
      expect(screen.getByRole('button', { name, pressed: true })).toBeInTheDocument()
    }
    await userEvent.click(screen.getByRole('button', { name: 'September 2026' }))
    gmail.startImport.mockResolvedValue({ jobId: 'j', total: 0, truncated: false })
    await userEvent.click(screen.getByRole('button', { name: 'Find transactions in August, October' }))
    expect(gmail.startImport.mock.calls[0][0]).toEqual(['2026-10', '2026-08'])
  })

  it('a search that never finished can be cancelled, and the months come back', async () => {
    latest = job({ status: 'listing' })
    gmail.cancelImport.mockImplementation(async () => {
      latest = job({ status: 'cancelled' })
      return { cancelled: true }
    })
    renderIt()
    expect(await screen.findByText('Finding alert emails…')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel import' }))
    expect(gmail.cancelImport.mock.calls[0][0]).toBe(job({}).id)
    expect(await screen.findByText('The last import was cancelled. Nothing was recorded.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Import past transactions' }))
    expect(screen.getByRole('button', { name: 'Find transactions in all 3 months' })).toBeInTheDocument()
  })

  it('a failed step says so and carries on when retried', async () => {
    latest = job({ status: 'scanning', total_messages: 30 })
    gmail.scanImport.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    gmail.scanImport.mockImplementationOnce(async () => {
      latest = job({ status: 'confirm_accounts', total_messages: 30, scanned: 30 })
      return { status: 'confirm_accounts', scanned: 30, total: 30 }
    })
    gmail.importAccounts.mockResolvedValue([])
    renderIt()
    const retry = await screen.findByRole('button', { name: /Try again/ })
    expect(gmail.scanImport).toHaveBeenCalledTimes(1)
    await userEvent.click(retry)
    await waitFor(() => expect(gmail.scanImport).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'Import transactions' })).toBeInTheDocument()
  })
})
