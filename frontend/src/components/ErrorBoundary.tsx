import { Component, type ErrorInfo, type ReactNode } from 'react'
import Icon from './Icons'
import { buttonBase, cx } from '../styles'

interface Props {
  children: ReactNode
  /** What replaces the children after a render error. Defaults to nothing. */
  fallback?: (error: Error, reset: () => void) => ReactNode
  /** Runs once per caught error, e.g. to close the dialog that failed and say so. */
  onError?: (error: Error) => void
  /** Changing this value clears a caught error, so reopening a dialog tries again. */
  resetKey?: unknown
}

interface State {
  error: Error | null
  resetKey: unknown
}

/**
 * Contains a render error to the part of the page that failed, so one bad response cannot
 * blank the whole app.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { error: null, resetKey: props.resetKey }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('SeaDex Companion render error', error, info.componentStack)
    this.props.onError?.(error)
  }

  reset = () => this.setState({ error: null })

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return this.props.fallback ? this.props.fallback(this.state.error, this.reset) : null
  }
}

/** Fallback for a whole page: says what broke and offers a retry without losing the rest of the app. */
export function PageErrorFallback({ error, reset, what }: { error: Error; reset: () => void; what: string }) {
  return (
    <div
      className="rounded-2xl border border-bad/30 bg-bad/8 px-6 py-12 text-center"
      role="alert"
      aria-labelledby="page-error-title"
    >
      <Icon name="alert" size={26} className="mx-auto mb-3 text-bad" />
      <h2 id="page-error-title" className="mb-1 text-lg font-bold text-ink">
        {what} could not be shown
      </h2>
      <p className="mx-auto mb-1 max-w-md text-sm text-muted">
        This page ran into an unexpected display error. Nothing in your library, settings, or downloads was changed.
      </p>
      <p className="mx-auto mb-5 max-w-md text-xs wrap-anywhere text-muted-dim">{error.message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          className={cx(buttonBase, 'border-line bg-panel text-ink hover:bg-panel-raised')}
          onClick={reset}
        >
          <Icon name="refresh" size={16} />
          Try again
        </button>
        <button
          type="button"
          className={cx(buttonBase, 'border-transparent text-muted hover:text-ink')}
          onClick={() => window.location.reload()}
        >
          Reload page
        </button>
      </div>
    </div>
  )
}
