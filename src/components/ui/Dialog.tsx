import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from './Button'
import { cn } from './cn'
import { IconButton } from './IconButton'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** 'sheet' docks to the bottom on phones. */
  variant?: 'center' | 'sheet'
  footer?: ReactNode
}

/** Native <dialog>: focus is trapped and Escape closes it for free. */
export function Dialog({ open, onClose, title, children, variant = 'center', footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        // Tap on the backdrop closes.
        if (event.target === ref.current) onClose()
      }}
      className={cn(
        'max-h-[90dvh] w-[min(100%-2rem,28rem)] overflow-visible bg-transparent p-0 text-ink backdrop:backdrop-blur-[1px]',
        variant === 'sheet' ? 'mx-auto mb-0 mt-auto w-full max-w-[30rem] sm:mb-auto' : 'm-auto',
      )}
    >
      {open && (
        <div
          className={cn(
            'flex max-h-[90dvh] flex-col bg-paper outline-strong shadow-brutal-lg animate-pop',
            variant === 'sheet'
              ? 'rounded-t-[1.75rem] pb-[max(env(safe-area-inset-bottom),1rem)] sm:rounded-card'
              : 'rounded-card',
          )}
        >
          <div className="flex items-center justify-between gap-3 px-5 pt-4">
            <h2 id={titleId} className="display text-2xl">
              {title}
            </h2>
            <IconButton label="Close" icon={<X className="size-5" strokeWidth={2.5} />} onClick={onClose} />
          </div>
          <div className="overflow-y-auto px-5 pb-5 pt-3">{children}</div>
          {footer && <div className="flex gap-3 border-t-2 border-ink px-5 py-4">{footer}</div>}
        </div>
      )}
    </dialog>
  )
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
  busy?: boolean
}

export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel, danger, busy }: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button block onClick={onCancel}>
            Cancel
          </Button>
          <Button block variant={danger ? 'ink' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-base leading-relaxed">{body}</div>
    </Dialog>
  )
}
