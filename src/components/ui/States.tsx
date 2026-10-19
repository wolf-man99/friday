import { CircleAlert, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from './Button'
import { cn } from './cn'
import { TONE_BG, type AccentTone } from './tones'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  scribble?: string
  body?: ReactNode
  action?: ReactNode
  tone?: AccentTone
  className?: string
}

export function EmptyState({ icon, title, scribble, body, action, tone = 'peach', className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-4 py-8 text-center', className)}>
      <div
        aria-hidden="true"
        className={cn('grid size-20 -rotate-6 place-items-center rounded-[1.5rem] outline-strong shadow-brutal', TONE_BG[tone])}
      >
        {icon}
      </div>
      {scribble && (
        <p aria-hidden="true" className="scribble -rotate-2 text-2xl text-orange-press">
          {scribble}
        </p>
      )}
      <h3 className="display text-2xl">{title}</h3>
      {body && <div className="max-w-xs text-base text-muted">{body}</div>}
      {action}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-2xl bg-ink/10 motion-reduce:animate-none', className)} />
}

/** Placeholder while a block loads; announces once for screen readers. */
export function LoadingBlock({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  )
}

interface InlineErrorProps {
  message: string
  onRetry?: () => void
  className?: string
}

export function InlineError({ message, onRetry, className }: InlineErrorProps) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-start gap-3 rounded-[1.25rem] bg-paper p-4 outline-regular', className)}
    >
      <div className="flex items-start gap-2">
        {offline ? (
          <WifiOff aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-negative" strokeWidth={2.5} />
        ) : (
          <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-negative" strokeWidth={2.5} />
        )}
        <p className="font-semibold">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}
