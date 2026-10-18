import { ChevronLeft, ChevronRight } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'

interface PeriodSelectorProps {
  label: string
  onPrevious: () => void
  onNext: () => void
  nextDisabled?: boolean
  /** e.g. "month" — used in the button names. */
  unit: string
}

export function PeriodSelector({ label, onPrevious, onNext, nextDisabled, unit }: PeriodSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <IconButton label={`Previous ${unit}`} icon={<ChevronLeft className="size-5" strokeWidth={2.75} />} onClick={onPrevious} />
      <p aria-live="polite" className="min-w-0 flex-1 truncate text-center font-display text-lg font-extrabold tracking-tight">
        {label}
      </p>
      <IconButton
        label={`Next ${unit}`}
        icon={<ChevronRight className="size-5" strokeWidth={2.75} />}
        onClick={onNext}
        disabled={nextDisabled}
      />
    </div>
  )
}
