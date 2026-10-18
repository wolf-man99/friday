import type { HTMLAttributes } from 'react'
import { cn } from './cn'

/** Compact uppercase monospaced metadata label. */
export function MonoLabel({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('label-mono', className)} {...rest} />
}

/** Handwritten microcopy for small, friendly moments. Decorative unless given a role. */
export function Scribble({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('scribble inline-block text-2xl', className)} {...rest} />
}
