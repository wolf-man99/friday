import { cn } from './cn'

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'inline-block size-5 animate-spin rounded-full border-[3px] border-current border-r-transparent motion-reduce:animate-none',
        className,
      )}
    />
  )
}
