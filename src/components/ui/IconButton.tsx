import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

type Variant = 'paper' | 'orange' | 'ink' | 'plain'

const VARIANTS: Record<Variant, string> = {
  paper: 'bg-paper outline-regular shadow-brutal-sm',
  orange: 'bg-orange outline-strong shadow-brutal',
  ink: 'bg-ink text-paper outline-regular',
  plain: 'bg-transparent border-2 border-transparent',
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required accessible name — icon-only actions must say what they do. */
  label: string
  icon: ReactNode
  variant?: Variant
  size?: 'md' | 'lg'
}

export function IconButton({ label, icon, variant = 'paper', size = 'md', className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'pressable inline-flex shrink-0 items-center justify-center rounded-full text-ink disabled:opacity-40',
        size === 'md' ? 'size-11' : 'size-14',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true" className="contents">
        {icon}
      </span>
    </button>
  )
}
