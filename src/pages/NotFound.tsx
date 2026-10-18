import { Compass } from 'lucide-react'
import { LinkButton } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/States'

export function NotFound() {
  return (
    <EmptyState
      className="pt-20"
      icon={<Compass className="size-9" strokeWidth={2.5} />}
      tone="yellow"
      scribble="huh."
      title="Nothing here"
      body="That page doesn’t exist."
      action={
        <LinkButton to="/" variant="primary">
          Go home
        </LinkButton>
      }
    />
  )
}
