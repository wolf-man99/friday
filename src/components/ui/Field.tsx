import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from './cn'

interface FieldShellProps {
  label: string
  hint?: ReactNode
  error?: string | null
  children: (ids: { id: string; describedBy?: string }) => ReactNode
  className?: string
}

export function FieldShell({ label, hint, error, children, className }: FieldShellProps) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="label-mono">
        {label}
      </label>
      {children({ id, describedBy })}
      {hint && !error && (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm font-semibold text-negative">
          {error}
        </p>
      )}
    </div>
  )
}

const control =
  'w-full rounded-control bg-paper px-4 outline-regular text-base placeholder:text-muted/80 aria-[invalid=true]:border-negative'

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label: string
  hint?: ReactNode
  error?: string | null
  prefix?: ReactNode
}

export function TextField({ label, hint, error, prefix, className, ...rest }: TextFieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} className={className}>
      {({ id, describedBy }) =>
        prefix ? (
          <div className={cn(control, 'flex min-h-12 items-center gap-2 focus-within:outline-3 focus-within:outline-ink')}>
            <span aria-hidden="true" className="font-display font-extrabold">
              {prefix}
            </span>
            <input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={error ? true : undefined}
              className="min-h-11 w-full bg-transparent focus:outline-none"
              {...rest}
            />
          </div>
        ) : (
          <input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            className={cn(control, 'min-h-12')}
            {...rest}
          />
        )
      }
    </FieldShell>
  )
}

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string
  hint?: ReactNode
  error?: string | null
}

export function TextAreaField({ label, hint, error, className, ...rest }: TextAreaFieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} className={className}>
      {({ id, describedBy }) => (
        <textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          rows={2}
          className={cn(control, 'min-h-12 resize-none py-3')}
          {...rest}
        />
      )}
    </FieldShell>
  )
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string
  hint?: ReactNode
  error?: string | null
}

export function SelectField({ label, hint, error, className, children, ...rest }: SelectFieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} className={className}>
      {({ id, describedBy }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={cn(control, 'min-h-12 appearance-none bg-[length:16px] bg-[right_1rem_center] bg-no-repeat pr-10')}
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23111' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
          }}
          {...rest}
        >
          {children}
        </select>
      )}
    </FieldShell>
  )
}
