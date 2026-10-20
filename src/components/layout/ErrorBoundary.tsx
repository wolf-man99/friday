import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'

interface State {
  error: Error | null
}

/**
 * Last line of defence: a screen that crashes while rendering shows this
 * instead of a blank page, with a way back. Data is never touched.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Friday crashed while rendering', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="safe-top mx-auto flex min-h-dvh max-w-[30rem] flex-col gap-6 px-4 py-8">
        <Card tone="yellow" shadow="md" className="flex flex-col gap-3">
          <h1 className="display text-3xl">Something broke on this screen</h1>
          <p>Your data is safe — nothing was changed. Reloading usually fixes it.</p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button onClick={() => window.location.assign('/')}>Go home</Button>
          </div>
        </Card>
      </main>
    )
  }
}
