import { ChartPie, House, ListOrdered, Plus, User } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'
import { cn } from '@/components/ui/cn'

interface ItemProps {
  to: string
  label: string
  icon: ReactNode
  end?: boolean
}

function Item({ to, label, icon, end }: ItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className="group flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-pill"
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={cn(
              'grid h-8 w-12 place-items-center rounded-pill transition-colors',
              isActive ? 'bg-ink text-paper' : 'text-ink group-hover:bg-peach',
            )}
          >
            {icon}
          </span>
          <span className={cn('label-mono text-[0.625rem]', isActive ? 'font-bold' : 'font-normal text-muted')}>{label}</span>
        </>
      )}
    </NavLink>
  )
}

/** Floating capsule navigation with the dominant central add action. */
export function BottomNav() {
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 z-40 mx-auto w-[min(100%-1.5rem,28rem)]"
      style={{ bottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}
    >
      <div className="grid h-[4.5rem] grid-cols-5 items-center rounded-pill bg-paper px-1 outline-strong shadow-brutal">
        <Item to="/" end label="Home" icon={<House className="size-5" strokeWidth={2.25} />} />
        <Item to="/activity" label="Activity" icon={<ListOrdered className="size-5" strokeWidth={2.25} />} />
        <div className="flex justify-center">
          <button
            type="button"
            aria-label="Add transaction"
            onClick={() => navigate('/add', { state: { from: location.pathname + location.search } })}
            className="pressable -mt-9 grid size-[4.5rem] place-items-center rounded-full bg-orange outline-strong shadow-brutal"
          >
            <Plus aria-hidden="true" className="size-9" strokeWidth={3.25} />
          </button>
        </div>
        <Item to="/insights" label="Insights" icon={<ChartPie className="size-5" strokeWidth={2.25} />} />
        <Item to="/profile" label="Profile" icon={<User className="size-5" strokeWidth={2.25} />} />
      </div>
    </nav>
  )
}
