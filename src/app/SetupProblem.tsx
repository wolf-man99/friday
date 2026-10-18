import { DatabaseZap } from 'lucide-react'
import { Wordmark } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { friendlyError } from '@/lib/errors'
import { signOut } from './auth'

/** Shown when the database can't be read — most often the migration hasn't been applied yet. */
export function SetupProblem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = (error as { code?: string } | null)?.code ?? ''
  const notMigrated = ['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)
  return (
    <main className="safe-top mx-auto flex min-h-dvh max-w-[30rem] flex-col gap-6 px-4 py-8">
      <Wordmark />
      <Card tone="yellow" shadow="md" className="flex flex-col gap-3">
        <DatabaseZap aria-hidden="true" className="size-8" strokeWidth={2.25} />
        <h1 className="display text-3xl">{notMigrated ? 'Database not set up yet' : 'Couldn’t load your data'}</h1>
        {notMigrated ? (
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
