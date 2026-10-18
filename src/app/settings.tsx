import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import type { AccountBalanceRow, CategoryRow, ProfileRow } from '@/data/database.types'
import { useAccounts, useCategories, useProfile, useRecurringSync } from '@/data/hooks'
import { today } from '@/lib/dates'
import { SetupProblem } from './SetupProblem'
import { Splash } from './Splash'

interface SettingsValue {
  profile: ProfileRow
  timeZone: string
  todayDate: string
  accounts: AccountBalanceRow[]
  activeAccounts: AccountBalanceRow[]
  accountsById: Map<string, AccountBalanceRow>
  categories: CategoryRow[]
  categoriesById: Map<string, CategoryRow>
}

const SettingsContext = createContext<SettingsValue | null>(null)

type LoadedSettings = Omit<SettingsValue, 'todayDate'>

/** Profile, timezone and lookup tables every screen needs. */
export function useSettings() {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('useSettings must be used inside <SettingsGate>')
  return value
}

/**
 * Loads the profile, accounts and categories before showing the app, and
 * sends first-time users (no accounts yet) to onboarding.
 */
export function SettingsGate({ children }: { children: ReactNode }) {
  const profile = useProfile()
  const accounts = useAccounts()
  const categories = useCategories()
  const location = useLocation()
  useRecurringSync(profile.isSuccess)

  const loaded = useMemo<LoadedSettings | null>(() => {
    if (!profile.data || !accounts.data || !categories.data) return null
    return {
      profile: profile.data,
      timeZone: profile.data.timezone,
      accounts: accounts.data,
      activeAccounts: accounts.data.filter((a) => a.status === 'active'),
      accountsById: new Map(accounts.data.map((a) => [a.id, a])),
      categories: categories.data,
      categoriesById: new Map(categories.data.map((c) => [c.id, c])),
    }
  }, [profile.data, accounts.data, categories.data])

  const error = profile.error ?? accounts.error ?? categories.error
  if (error && !loaded) {
    return (
      <SetupProblem
        error={error}
        onRetry={() => {
          void profile.refetch()
          void accounts.refetch()
          void categories.refetch()
        }}
      />
    )
  }
  if (!loaded) return <Splash />
  // Recomputed every render so a session left open past midnight moves on.
  const value: SettingsValue = { ...loaded, todayDate: today(loaded.timeZone) }

  const onboarding = location.pathname.startsWith('/onboarding')
  if (value.accounts.length === 0 && !onboarding) return <Navigate to="/onboarding" replace />

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
