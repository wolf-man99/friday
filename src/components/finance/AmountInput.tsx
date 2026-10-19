import { forwardRef, useId } from 'react'
import { cn } from '@/components/ui/cn'
import { formatAmountInput } from '@/lib/money'

interface AmountInputProps {
  value: string
  onChange: (value: string) => void
  error?: string | null
  label?: string
  autoFocus?: boolean
  onEnter?: () => void
  onBlur?: () => void
}

/** The amount-first field: the largest element on the add screen, numeric keypad on phones. */
export const AmountInput = forwardRef<HTMLInputElement, AmountInputProps>(function AmountInput(
  { value, onChange, error, label = 'Amount', autoFocus, onEnter, onBlur },
  ref,
) {
  const id = useId()
  const length = value.replace(/[^\d]/g, '').length
  const size = length > 9 ? 'text-[2.6rem]' : length > 6 ? 'text-[3.4rem]' : 'text-[4.25rem]'
  return (
    <div className="flex flex-col items-center gap-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="flex w-full items-baseline justify-center gap-1">
        <span aria-hidden="true" className={cn('display text-muted', size)}>
          ₹
        </span>
        <input
          ref={ref}
          id={id}
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          placeholder="0"
          autoFocus={autoFocus}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(formatAmountInput(event.target.value))}
          onBlur={onBlur}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onEnter?.()
            }
          }}
          className={cn(
            'display tabular w-full min-w-0 bg-transparent text-center caret-orange placeholder:text-ink/25 focus:outline-none',
            size,
          )}
          style={{ maxWidth: `${Math.max(value.length, 1) + 0.6}ch` }}
        />
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm font-semibold text-negative">
          {error}
        </p>
      )}
    </div>
  )
})
