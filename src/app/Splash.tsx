import { Wordmark } from '@/components/layout/PageHeader'
import { Spinner } from '@/components/ui/Spinner'

export function Splash() {
  return (
    <div className="grid min-h-dvh place-content-center justify-items-center gap-4">
      <Wordmark className="text-5xl" />
      <Spinner label="Loading Friday" className="size-7" />
    </div>
  )
}
