import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from './cn'

export interface PillOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

export interface PillSwitchProps<T extends string> {
  options: PillOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible name for the group. */
  label: string
  size?: 'md' | 'lg'
  className?: string
  disabled?: boolean
}

/**
 * Segmented pill control with radio semantics: arrow keys move the selection,
 * and the selected pill is filled ink with a heavier label (not colour alone).
 */
export function PillSwitch<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className,
  disabled,
}: PillSwitchProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (!delta) return
    event.preventDefault()
    const next = (index + delta + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn('flex w-full gap-1 rounded-pill bg-paper p-1 outline-strong shadow-brutal', className)}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-pill font-display tracking-tight transition-colors',
              size === 'md' ? 'min-h-10 px-3 text-sm' : 'min-h-12 px-3 text-base',
              selected ? 'bg-ink font-extrabold text-paper' : 'font-semibold text-ink hover:bg-peach',
            )}
          >
            {option.icon && (
              <span aria-hidden="true" className="contents">
                {option.icon}
              </span>
            )}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
