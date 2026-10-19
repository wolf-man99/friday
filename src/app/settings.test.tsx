import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsGate } from './settings'

interface QueryStub {
  data: unknown
  error: unknown
  isPending: boolean
  refetch: () => void
}

const loaded = (data: unknown): QueryStub => ({ data, error: null, isPending: false, refetch: vi.fn() })
const failed = (error: unknown): QueryStub => ({ data: undefined, error, isPending: false, refetch: vi.fn() })

let schema = loaded(true)
let profile = loaded({ id: 'u1', timezone: 'Asia/Kolkata' })

vi.mock('@/data/hooks', () => ({
  useProfile: () => profile,
  useAccounts: () => loaded([{ id: 'a1', status: 'active' }]),
  useCategories: () => loaded([]),
  useRecurringSync: () => undefined,
  useSchemaCheck: () => schema,
}))
vi.mock('./auth', () => ({ signOut: vi.fn() }))

function renderGate() {
  return render(
    <MemoryRouter>
      <SettingsGate>
        <p>the app</p>
      </SettingsGate>
    </MemoryRouter>,
  )
}

describe('SettingsGate schema check', () => {
  beforeEach(() => {
    schema = loaded(true)
    profile = loaded({ id: 'u1', timezone: 'Asia/Kolkata' })
  })

  it('shows the app when the database is current', () => {
    renderGate()
    expect(screen.getByText('the app')).toBeInTheDocument()
  })

  it('asks for the update when the newest migration is missing', () => {
    schema = failed({ code: '42703', message: 'column ledger_entries.merchant does not exist' })
    renderGate()
    expect(screen.getByRole('heading', { name: 'Database needs an update' })).toBeInTheDocument()
    expect(screen.queryByText('the app')).not.toBeInTheDocument()
  })

  it('says the database is not set up when no migration has run', () => {
    profile = failed({ code: 'PGRST202', message: 'Could not find the function public.ensure_profile' })
    schema = failed({ code: 'PGRST205', message: 'Could not find the table public.ledger_entries' })
    renderGate()
    expect(screen.getByRole('heading', { name: 'Database not set up yet' })).toBeInTheDocument()
  })

  it('does not lock anyone out when the check itself fails for another reason', () => {
    schema = failed({ message: 'TypeError: Failed to fetch' })
    renderGate()
    expect(screen.getByText('the app')).toBeInTheDocument()
  })
})
