import { Check, ChevronDown } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

interface ToggleChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected: boolean
  icon?: ReactNode
}

/** Filter pill that toggles. Selected = ink fill + check mark. */
export function ToggleChip({ selected, icon, className, children, ...rest }: ToggleChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill px-4 font-display text-sm tracking-tight outline-regular',
        selected ? 'bg-ink font-extrabold text-paper' : 'bg-paper font-semibold text-ink',
        className,
      )}
      {...rest}
    >
      {selected ? <Check aria-hidden="true" className="size-4" strokeWidth={3} /> : icon}
      {children}
    </button>
  )
}

export interface ChipOption {
  value: string
  label: string
}

interface SelectChipProps {
  /** Accessible name, and the text shown when nothing specific is chosen. */
  label: string
  value: string
  options: ChipOption[]
  onChange: (value: string) => void
  /** Filled style when the chip is filtering something. */
  active?: boolean
  className?: string
}

/** A pill that wraps a native <select> — great pickers on phones, fully accessible. */
export function SelectChip({ label, value, options, onChange, active, className }: SelectChipProps) {
  const current = options.find((option) => option.value === value)?.label ?? label
  return (
    <label
      className={cn(
        'relative inline-flex min-h-11 shrink-0 items-center rounded-pill pl-4 pr-9 font-display text-sm tracking-tight outline-regular focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-ink',
        active ? 'bg-ink font-extrabold text-paper' : 'bg-paper font-semibold text-ink',
        className,
      )}
    >
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="absolute inset-0 cursor-pointer appearance-none rounded-pill opacity-0"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className="pointer-events-none max-w-40 truncate">
        {current}
      </span>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 size-4" strokeWidth={2.5} />
    </label>
  )
}
