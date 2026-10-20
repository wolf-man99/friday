import { useEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router'

/** Opening a screen starts at its top; Back keeps the browser's own scroll position. */
export function ScrollToTop() {
  const { pathname } = useLocation()
  const navigationType = useNavigationType()
  useEffect(() => {
    if (navigationType !== 'POP') window.scrollTo(0, 0)
  }, [pathname, navigationType])
  return null
}
