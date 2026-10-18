import type { NavigateFunction } from 'react-router'

/** Goes back within the app, or to a fallback when the page was opened directly. */
export function goBack(navigate: NavigateFunction, fallback = '/') {
  const index = (window.history.state as { idx?: number } | null)?.idx ?? 0
  if (index > 0) navigate(-1)
  else navigate(fallback, { replace: true })
}
