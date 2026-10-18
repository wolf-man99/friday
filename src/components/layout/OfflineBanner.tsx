import { WifiOff } from 'lucide-react'
import { useSyncExternalStore } from 'react'

function subscribe(callback: () => void) {
  window.addEventListener('online', callback)
  window.addEventListener('offline', callback)
  return () => {
    window.removeEventListener('online', callback)
    window.removeEventListener('offline', callback)
  }
}

export function useOnline() {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  )
}

/** Friday v1 doesn't queue writes offline, so say so plainly. */
export function OfflineBanner() {
  const online = useOnline()
  if (online) return null
  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex items-center justify-center gap-2 border-b-[3px] border-ink bg-yellow px-4 py-2 text-sm font-semibold"
      style={{ paddingTop: 'max(env(safe-area-inset-top), 0.5rem)' }}
    >
      <WifiOff aria-hidden="true" className="size-4" strokeWidth={2.5} />
      You’re offline — you can look around, but nothing can be saved until you reconnect.
    </div>
  )
}
