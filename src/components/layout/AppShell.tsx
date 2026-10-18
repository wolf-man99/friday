import { Outlet } from 'react-router'
import { BottomNav } from './BottomNav'

/** Main tabbed layout: content column + floating nav that never covers content. */
export function AppShell() {
  return (
    <>
      <main id="main" className="safe-top nav-clearance mx-auto w-full max-w-[30rem] px-4">
        <Outlet />
      </main>
      <BottomNav />
    </>
  )
}

/** Focused layout for flows like Quick Add — no tab bar. */
export function FocusedShell() {
  return (
    <main id="main" className="safe-top mx-auto flex min-h-dvh w-full max-w-[30rem] flex-col px-4" style={{ ['--toast-offset' as string]: '6rem' }}>
      <Outlet />
    </main>
  )
}
