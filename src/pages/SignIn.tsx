import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useAuth } from '@/app/auth'
import { Wordmark } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { PasswordField, TextField } from '@/components/ui/Field'
import { PillSwitch } from '@/components/ui/PillSwitch'
import { InlineError } from '@/components/ui/States'
import { friendlyError } from '@/lib/errors'
import { isSupabaseConfigured, supabase } from '@/lib/supabase'

type Mode = 'sign-in' | 'sign-up' | 'reset'

export function SignIn() {
  const { session } = useAuth()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/'
  const [mode, setMode] = useState<Mode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  if (session) return <Navigate to={from} replace />

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setNotice(null)
    const errors = validate(mode, { name, email, password })
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    setBusy(true)
    try {
      if (mode === 'sign-in') {
        const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (authError) throw authError
      } else if (mode === 'sign-up') {
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { display_name: name.trim() }, emailRedirectTo: window.location.origin },
        })
        if (authError) throw authError
        if (!data.session) setNotice('Check your inbox — confirm your email, then sign in.')
      } else {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/reset-password`,
        })
        if (authError) throw authError
        setNotice('If that email has a Friday account, a reset link is on its way.')
      }
    } catch (err) {
      const message = (err as { message?: string }).message ?? ''
      setError(/invalid login/i.test(message) ? 'That email and password don’t match.' : /not confirmed/i.test(message) ? 'Confirm your email first — check your inbox.' : friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="safe-top mx-auto flex min-h-dvh w-full max-w-[30rem] flex-col justify-center gap-7 px-4 py-10">
      <div className="flex flex-col gap-2">
        <Wordmark className="text-[4.5rem]" />
        <p className="display text-[1.75rem]">Know where your money stands.</p>
        <p aria-hidden="true" className="scribble -rotate-2 text-2xl text-orange-press">
          without making it a second job ✌︎
        </p>
      </div>

      {!isSupabaseConfigured && (
        <InlineError message="Supabase isn’t configured. Copy .env.example to .env.local and add your project URL and publishable key." />
      )}

      <Card shadow="lg" className="flex flex-col gap-5">
        {mode !== 'reset' ? (
          <PillSwitch
            label="Account"
            options={[
              { value: 'sign-in', label: 'Sign in' },
              { value: 'sign-up', label: 'Create account' },
            ]}
            value={mode}
            onChange={(next) => {
              setMode(next)
              setError(null)
              setNotice(null)
              setFieldErrors({})
            }}
          />
        ) : (
          <h1 className="display text-2xl">Reset your password</h1>
        )}
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          {mode === 'sign-up' && (
            <TextField
              label="Your name"
              required
              autoComplete="given-name"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={fieldErrors.name}
            />
          )}
          <TextField
            label="Email"
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fieldErrors.email}
          />
          {mode !== 'reset' && (
            <PasswordField
              label="Password"
              required
              error={fieldErrors.password}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint={mode === 'sign-up' ? 'At least 8 characters.' : undefined}
            />
          )}
          {error && <InlineError message={error} />}
          {notice && (
            <p role="status" className="rounded-2xl bg-lime px-4 py-3 font-semibold outline-regular">
              {notice}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            {mode === 'sign-in' ? 'Sign in' : mode === 'sign-up' ? 'Create account' : 'Send reset link'}
          </Button>
        </form>
        <button
          type="button"
          className="min-h-11 text-sm font-semibold underline underline-offset-4"
          onClick={() => {
            setMode(mode === 'reset' ? 'sign-in' : 'reset')
            setFieldErrors({})
            setError(null)
            setNotice(null)
          }}
        >
          {mode === 'reset' ? 'Back to sign in' : 'Forgot your password?'}
        </button>
      </Card>
      <p className="text-center text-sm text-muted">Private by default. Your records are visible only to you.</p>
    </main>
  )
}

type FieldErrors = Partial<Record<'name' | 'email' | 'password', string>>

/** Name (sign-up), email and password are all required; each gets its own message. */
export function validate(mode: Mode, values: { name: string; email: string; password: string }): FieldErrors {
  const errors: FieldErrors = {}
  const email = values.email.trim()
  if (mode === 'sign-up' && !values.name.trim()) errors.name = 'Enter your name'
  if (!email) errors.email = 'Enter your email address'
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'That doesn’t look like an email address'
  if (mode !== 'reset') {
    if (!values.password) errors.password = 'Enter your password'
    else if (mode === 'sign-up' && values.password.length < 8) errors.password = 'Passwords need at least 8 characters'
  }
  return errors
}
