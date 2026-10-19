import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from './cn'
import { TONE_BG, type SurfaceTone } from './tones'

type Shadow = 'none' | 'sm' | 'md' | 'lg' | 'orange'

const SHADOWS: Record<Shadow, string> = {
  none: '',
  sm: 'shadow-brutal-sm',
  md: 'shadow-brutal',
  lg: 'shadow-brutal-lg',
  orange: 'shadow-brutal-orange',
}

export interface CardProps extends HTMLAttributes<HTMLElement> {
  tone?: SurfaceTone
  shadow?: Shadow
  as?: 'div' | 'section' | 'article' | 'li'
  padded?: boolean
}

/** Thick-outline surface (OutlinedCard / OffsetShadowSurface in the TRD). */
export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { tone = 'paper', shadow = 'none', as: Tag = 'div', padded = true, className, ...rest },
  ref,
) {
  return (
    <Tag
      ref={ref as never}
      className={cn('rounded-card outline-strong', TONE_BG[tone], SHADOWS[shadow], padded && 'p-4', className)}
      {...rest}
    />
  )
})
