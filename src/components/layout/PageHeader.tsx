import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { IconButton } from '@/components/ui/IconButton'

export function Wordmark({ className = 'text-[2rem]' }: { className?: string }) {
  return (
    <span className={`display ${className}`}>
      friday<span className="text-orange">.</span>
    </span>
  )
}

interface PageHeaderProps {
  title: string
  /** Small handwritten aside next to the title. */
  scribble?: string
  back?: string | true
  actions?: ReactNode
}

export function PageHeader({ title, scribble, back, actions }: PageHeaderProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from
  return (
    <header className="flex items-center gap-3 pb-4 pt-2">
      {back && (
        <IconButton
          label="Back"
          icon={<ArrowLeft className="size-5" strokeWidth={2.75} />}
          onClick={() => {
            if (from) navigate(from)
            else if (typeof back === 'string') navigate(back)
            else navigate(-1)
          }}
        />
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="display truncate text-[2.15rem]">{title}</h1>
        {scribble && (
          <span aria-hidden="true" className="scribble -rotate-3 whitespace-nowrap text-xl text-orange-press">
            {scribble}
          </span>
        )}
      </div>
      {actions}
    </header>
  )
}
