import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A stand-in for supabase-js auth that can fire events like the real one.
type Listener = (event: string, session: unknown) => void
const listeners: Listener[] = []
let currentSession: unknown = null
const updateUser = vi.fn()
const authSignOut = vi.fn()

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: currentSession } }),
      onAuthStateChange: (listener: Listener) => {
        listeners.push(listener)
        return { data: { subscription: { unsubscribe: () => listeners.splice(listeners.indexOf(listener), 1) } } }
      },
      updateUser: (...args: unknown[]) => updateUser(...args),
      signOut: () => authSignOut(),
    },
  },
}))

const { isRecoveryLink, isRecoveryPending, setRecoveryPending, watchPasswordRecovery } = await import('./recovery')
const { AuthProvider, RequireAuth } = await import('./auth')
const { ResetPassword } = await import('@/pages/ResetPassword')

const session = { user: { id: 'u1', email: 'me@example.com' }, access_token: 't' }
const emit = (event: string, value: unknown) => act(() => listeners.forEach((listener) => listener(event, value)))

function renderApp(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/login" element={<p>sign-in screen</p>} />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <p>your money</p>
                </RequireAuth>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  listeners.length = 0
  currentSession = null
  localStorage.clear()
  updateUser.mockReset().mockResolvedValue({ error: null })
  authSignOut.mockReset().mockImplementation(async () => {
    currentSession = null
    listeners.forEach((listener) => listener('SIGNED_OUT', null))
    return { error: null }
  })
})

describe('password reset links', () => {
  it('recognises a reset link by its type, nothing else', () => {
    expect(isRecoveryLink('https://f.app/reset-password#access_token=a&refresh_token=b&type=recovery')).toBe(true)
    expect(isRecoveryLink('https://f.app/#access_token=a&type=recovery')).toBe(true)
    expect(isRecoveryLink('https://f.app/#access_token=a&type=signup')).toBe(false)
    expect(isRecoveryLink('https://f.app/reset-password#error=access_denied&error_code=otp_expired')).toBe(false)
    expect(isRecoveryLink('not a url')).toBe(false)
  })

  it('locks the app when Supabase reports a recovery sign-in, until a new password is saved', async () => {
    watchPasswordRecovery()
    currentSession = session
    // Supabase fell back to the site's home page (reset URL not allow-listed).
    renderApp('/')
    emit('PASSWORD_RECOVERY', session)
    expect(isRecoveryPending()).toBe(true)
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument()
    expect(screen.queryByText('your money')).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('New password'), 'a-better-password')
    await userEvent.click(screen.getByRole('button', { name: 'Save password' }))
    expect(updateUser).toHaveBeenCalledWith({ password: 'a-better-password' })
    expect(await screen.findByText('your money')).toBeInTheDocument()
    expect(isRecoveryPending()).toBe(false)
  })

  it('stays locked after a reload, and even on the home page', async () => {
    setRecoveryPending(true)
    currentSession = session
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument()
  })

  it('a failed save keeps the app locked', async () => {
    setRecoveryPending(true)
    currentSession = session
    updateUser.mockResolvedValue({ error: { message: 'New password should be different from the old password.' } })
    renderApp('/reset-password')
    await userEvent.type(await screen.findByLabelText('New password'), 'same-old-password')
    await userEvent.click(screen.getByRole('button', { name: 'Save password' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(isRecoveryPending()).toBe(true)
  })

  it('cancelling signs out and lifts the lock', async () => {
    watchPasswordRecovery()
    setRecoveryPending(true)
    currentSession = session
    renderApp('/reset-password')
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel and sign out' }))
    expect(await screen.findByText('sign-in screen')).toBeInTheDocument()
    expect(authSignOut).toHaveBeenCalled()
    expect(isRecoveryPending()).toBe(false)
  })

  it('an ordinary sign-in isn’t affected', async () => {
    currentSession = session
    renderApp('/')
    await waitFor(() => expect(screen.getByText('your money')).toBeInTheDocument())
  })
})
