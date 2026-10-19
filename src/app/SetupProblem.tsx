import { DatabaseZap } from 'lucide-react'
import { Wordmark } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { friendlyError, isOutdatedSchema } from '@/lib/errors'
import { signOut } from './auth'

/** Shown when the database can't be read — most often a migration hasn't been applied yet. */
export function SetupProblem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = (error as { code?: string } | null)?.code ?? ''
  // A missing column means the tables exist but the newest migration is missing.
  const state = code === '42703' ? 'outdated' : isOutdatedSchema(error) ? 'empty' : 'failed'
  return (
    <main className="safe-top mx-auto flex min-h-dvh max-w-[30rem] flex-col gap-6 px-4 py-8">
      <Wordmark />
      <Card tone="yellow" shadow="md" className="flex flex-col gap-3">
        <DatabaseZap aria-hidden="true" className="size-8" strokeWidth={2.25} />
        <h1 className="display text-3xl">
          {state === 'outdated'
            ? 'Database needs an update'
            : state === 'empty'
              ? 'Database not set up yet'
              : 'Couldn’t load your data'}
        </h1>
        {state === 'outdated' ? (
          <p>
            This version of Friday needs newer database changes. Run the files in{' '}
            <code className="font-mono text-sm">supabase/migrations/</code> you haven’t run yet (oldest first) in the
            Supabase SQL editor, then try again. Your existing data is kept.
          </p>
        ) : state === 'empty' ? (
          <p>
            Friday connected to Supabase, but its tables don’t exist yet. Run the SQL in{' '}
            <code className="font-mono text-sm">supabase/migrations/</code> in the Supabase SQL editor, then try again.
          </p>
        ) : (
          <p>{friendlyError(error)}</p>
        )}
        <div className="flex flex-wrap gap-3 pt-2">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
          <Button onClick={() => void signOut()}>Sign out</Button>
        </div>
      </Card>
    </main>
  )
}
