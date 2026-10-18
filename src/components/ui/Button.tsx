import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router'
import { cn } from './cn'
import { Spinner } from './Spinner'

type Variant = 'primary' | 'secondary' | 'ink' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg' | 'xl'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-orange text-ink outline-strong shadow-brutal',
  secondary: 'bg-paper text-ink outline-strong shadow-brutal',
  ink: 'bg-ink text-paper outline-strong shadow-[4px_4px_0_0_var(--color-orange)]',
  ghost: 'bg-transparent text-ink border-[3px] border-transparent underline-offset-4 hover:underline',
  danger: 'bg-paper text-negative outline-strong shadow-brutal',
}

const SIZES: Record<Size, string> = {
  sm: 'min-h-11 px-4 text-sm gap-1.5',
  md: 'min-h-12 px-5 text-base gap-2',
  lg: 'min-h-14 px-6 text-lg gap-2',
  xl: 'min-h-16 px-8 text-xl gap-2.5',
}

const BASE =
  'pressable inline-flex select-none items-center justify-center rounded-pill font-display font-extrabold tracking-tight'

export function buttonClasses({ variant = 'secondary', size = 'md', block }: { variant?: Variant; size?: Size; block?: boolean }) {
  return cn(BASE, VARIANTS[variant], SIZES[size], block && 'w-full')
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  iconRight?: ReactNode
  block?: boolean
  loading?: boolean
}

/** The chunky outlined, offset-shadow button (BrutalButton in the TRD). */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  block,
  loading,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        buttonClasses({ variant, size, block }),
        'disabled:cursor-not-allowed disabled:border-ink/30 disabled:bg-line disabled:text-ink/45 disabled:shadow-none',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {iconRight}
    </button>
  )
}

interface LinkButtonProps extends LinkProps {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  block?: boolean
}

/** A navigation link that looks like a Button (never nest a button in a link). */
export function LinkButton({ variant = 'secondary', size = 'md', icon, block, className, children, ...rest }: LinkButtonProps) {
  return (
    <Link className={cn(buttonClasses({ variant, size, block }), className)} {...rest}>
      {icon}
      {children}
    </Link>
  )
}
