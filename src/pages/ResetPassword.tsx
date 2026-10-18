import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/app/auth'
import { Wordmark } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { TextField } from '@/components/ui/Field'
import { InlineError } from '@/components/ui/States'
import { friendlyError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'

/** Landing page for the password-reset email link. */
export function ResetPassword() {
  const { session, loading } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (password.length < 8) return setError('Passwords need at least 8 characters')
    setBusy(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (updateError) return setError(friendlyError(updateError))
    navigate('/', { replace: true })
  }

  return (
    <main className="safe-top mx-auto flex min-h-dvh w-full max-w-[30rem] flex-col justify-center gap-6 px-4 py-10">
      <Wordmark className="text-6xl" />
      <Card shadow="lg" className="flex flex-col gap-4">
        <h1 className="display text-3xl">Choose a new password</h1>
        {!loading && !session ? (
          <InlineError message="This reset link has expired or was already used. Request a new one from the sign-in screen." />
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <TextField label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && <InlineError message={error} />}
            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              Save password
            </Button>
          </form>
        )}
      </Card>
    </main>
  )
}
