import type { Session } from '@supabase/supabase-js'
import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { supabase } from '@/lib/supabase'
import { isRecoveryPending, RESET_PATH } from './recovery'
import { Splash } from './Splash'

interface AuthState {
  session: Session | null
  loading: boolean
}

const AuthContext = createContext<AuthState>({ session: null, loading: true })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, loading: true })
  const queryClient = useQueryClient()

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) setState({ session: data.session, loading: false })
    })
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      setState({ session, loading: false })
      // Never let one person's cached finances survive a sign-out.
      if (event === 'SIGNED_OUT') queryClient.clear()
    })
    return () => {
      mounted = false
      data.subscription.unsubscribe()
    }
  }, [queryClient])

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  const location = useLocation()
  if (loading) return <Splash />
  // The hash too: Gmail's connection page receives its one-time ticket there.
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} />
  // Signed in by a reset link: nothing but choosing a new password until it's saved.
  if (isRecoveryPending()) return <Navigate to={RESET_PATH} replace />
  return children
}

export async function signOut() {
  await supabase.auth.signOut()
}
