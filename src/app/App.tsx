import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router'
import { AppShell, FocusedShell } from '@/components/layout/AppShell'
import { OfflineBanner } from '@/components/layout/OfflineBanner'
import { ToastProvider } from '@/components/ui/Toast'
import { AccountEditor, Accounts } from '@/pages/Accounts'
import { Activity } from '@/pages/Activity'
import { Categories } from '@/pages/Categories'
import { EntryEditor } from '@/pages/EntryEditor'
import { Home } from '@/pages/Home'
import { Insights } from '@/pages/Insights'
import { NotFound } from '@/pages/NotFound'
import { Onboarding } from '@/pages/Onboarding'
import { Profile } from '@/pages/Profile'
import { Recurring, RecurringEditor } from '@/pages/Recurring'
import { ResetPassword } from '@/pages/ResetPassword'
import { SignIn } from '@/pages/SignIn'
import { AuthProvider, RequireAuth } from './auth'
import { SettingsGate } from './settings'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) => count < 2 && !(error as { code?: string })?.code?.startsWith('PGRST'),
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <OfflineBanner />
            <Routes>
              <Route path="/login" element={<SignIn />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route
                element={
                  <RequireAuth>
                    <SettingsGate>
                      <FocusedShell />
                    </SettingsGate>
                  </RequireAuth>
                }
              >
                <Route path="/onboarding" element={<Onboarding />} />
                <Route path="/add" element={<EntryEditor />} />
                <Route path="/entry/:kind/:id" element={<EntryEditor />} />
              </Route>
              <Route
                element={
                  <RequireAuth>
                    <SettingsGate>
                      <AppShell />
                    </SettingsGate>
                  </RequireAuth>
                }
              >
                <Route index element={<Home />} />
                <Route path="/activity" element={<Activity />} />
                <Route path="/insights" element={<Insights />} />
                <Route path="/profile" element={<Profile />} />
                <Route path="/accounts" element={<Accounts />} />
                <Route path="/accounts/new" element={<AccountEditor />} />
                <Route path="/accounts/:id" element={<AccountEditor />} />
                <Route path="/categories" element={<Categories />} />
                <Route path="/recurring" element={<Recurring />} />
                <Route path="/recurring/new" element={<RecurringEditor />} />
                <Route path="/recurring/:id" element={<RecurringEditor />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
