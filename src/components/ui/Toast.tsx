import { CircleAlert, Check } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from './cn'

interface ToastAction {
  label: string
  onClick: () => void | Promise<void>
}

interface ToastInput {
  message: string
  tone?: 'success' | 'error' | 'info'
  action?: ToastAction
  /** Milliseconds; undo toasts default to a longer window. */
  duration?: number
}

interface ToastItem extends ToastInput {
  id: number
}

const ToastContext = createContext<(toast: ToastInput) => void>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), [])

  const show = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++
      // One at a time keeps Undo unambiguous.
      setToasts([{ ...toast, id }])
      window.setTimeout(() => dismiss(id), toast.duration ?? (toast.action ? 7000 : 3500))
    },
    [dismiss],
  )

  const value = useMemo(() => show, [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 z-50 mx-auto flex w-[min(100%-1.5rem,28rem)] flex-col gap-2"
        style={{ bottom: 'calc(var(--toast-offset, 6.75rem) + env(safe-area-inset-bottom))' }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex items-center gap-3 rounded-[1.25rem] px-4 py-3 outline-strong shadow-[4px_4px_0_0_var(--color-orange)] animate-rise',
              toast.tone === 'error' ? 'bg-paper text-ink' : 'bg-ink text-paper',
            )}
          >
            {toast.tone === 'error' ? (
              <CircleAlert aria-hidden="true" className="size-5 shrink-0 text-negative" strokeWidth={2.5} />
            ) : (
              <Check aria-hidden="true" className="size-5 shrink-0 text-lime" strokeWidth={3} />
            )}
            <p className="flex-1 text-sm font-semibold">{toast.message}</p>
            {toast.action && (
              <button
                type="button"
                className="min-h-11 rounded-pill bg-orange px-4 font-display text-sm font-extrabold text-ink outline-regular"
                onClick={async () => {
                  dismiss(toast.id)
                  await toast.action!.onClick()
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
