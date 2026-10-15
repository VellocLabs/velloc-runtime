import { Component, type ErrorInfo, type ReactNode } from 'react'
import { createTranslate, type TranslateFn } from './i18n'

/**
 * How many times the thread may re-mount itself after a render error before
 * the fallback card takes over. Small on purpose: this budget exists for the
 * TRANSIENT class of failure (see below), and a genuinely broken render
 * reaches the card after a few frames rather than looping forever.
 */
export const MAX_AUTO_RECOVERIES = 3

/**
 * How long a recovered thread has to stay mounted without erroring before its
 * recovery budget is refilled. Without this, a session that hits one transient
 * error an hour would eventually exhaust the budget and dead-end on a failure
 * that had nothing to do with the earlier ones.
 */
export const RECOVERY_STABLE_MS = 10_000

/**
 * A class component can't call `useT()`, so the fallback's strings come from a
 * `TranslateFn` prop; this default covers callers that pass none (unit tests).
 */
const DEFAULT_TRANSLATE = createTranslate('en')

type ThreadErrorBoundaryProps = {
  sessionId: string
  children: ReactNode
  t?: TranslateFn
}

type ThreadErrorBoundaryState = {
  error: Error | null
  autoRecoveries: number
}

/**
 * Catches one session's thread render errors so a crash cannot take down the shell.
 * Re-mounts on the next macrotask, up to {@link MAX_AUTO_RECOVERIES} times: the usual cause
 * is a one-frame by-index read (`tapClientLookup`) against a list that just shrank. A
 * persistent error lands on the card; recovery loses scroll position and row-local state.
 */
export class ThreadErrorBoundary extends Component<
  ThreadErrorBoundaryProps,
  ThreadErrorBoundaryState
> {
  state: ThreadErrorBoundaryState = { error: null, autoRecoveries: 0 }

  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null

  static getDerivedStateFromError(
    error: Error,
  ): Partial<ThreadErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // A recovery that was still on probation didn't survive — don't let its
    // pending timer refill the budget in the middle of an error storm.
    this.clearStableTimer()

    const willAutoRecover = this.state.autoRecoveries < MAX_AUTO_RECOVERIES
    console.error('[NexusTrace][ThreadErrorBoundary] caught', {
      sessionId: this.props.sessionId,
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
      autoRecoveries: this.state.autoRecoveries,
      willAutoRecover,
    })

    if (!willAutoRecover) {
      return
    }

    // Next macrotask, not this one: the throw happens DURING the render that
    // React is still finishing, and for the index race the state that fixes it
    // lands in that same commit. Re-mounting synchronously would replay the
    // same stale read.
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      this.setState(previous => ({
        error: null,
        autoRecoveries: previous.autoRecoveries + 1,
      }))
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null
        // Only while the thread is actually healthy — a boundary sitting on
        // its fallback card has not earned its budget back.
        this.setState(previous =>
          previous.error === null ? { ...previous, autoRecoveries: 0 } : previous,
        )
      }, RECOVERY_STABLE_MS)
    }, 0)
  }

  componentWillUnmount(): void {
    this.clearRecoveryTimer()
    this.clearStableTimer()
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      clearTimeout(this.recoveryTimer)
      this.recoveryTimer = null
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
  }

  private handleRetry = (): void => {
    this.clearRecoveryTimer()
    this.clearStableTimer()
    this.setState({ error: null, autoRecoveries: 0 })
  }

  render(): ReactNode {
    if (this.state.error) {
      const t = this.props.t ?? DEFAULT_TRANSLATE
      return (
        <div
          data-testid="thread-crashed"
          style={{
            height: '100%',
            display: 'grid',
            placeItems: 'center',
            padding: '24px',
            color: 'var(--foreground)',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          }}
        >
          <section
            style={{
              maxWidth: '560px',
              width: '100%',
              padding: '20px 24px',
              borderRadius: '16px',
              background: 'var(--card)',
              border: '1px solid color-mix(in oklab, var(--destructive) 35%, transparent)',
              boxShadow: '0 8px 28px oklch(0 0 0 / 8%)',
              display: 'grid',
              gap: '12px',
            }}
          >
            <div
              style={{
                fontSize: '12px',
                fontWeight: 700,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--destructive)',
              }}
            >
              {t('thread.crashedTitle')}
            </div>
            <div style={{ color: 'var(--muted-foreground)', lineHeight: 1.6 }}>
              {t('thread.crashedBody')}
            </div>
            <pre
              style={{
                margin: 0,
                padding: '12px',
                borderRadius: '10px',
                background: 'var(--muted)',
                color: 'var(--foreground)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: '12px',
                maxHeight: '200px',
                overflow: 'auto',
              }}
            >
              {this.state.error.message}
            </pre>
            <button
              type="button"
              onClick={this.handleRetry}
              style={{
                justifySelf: 'start',
                padding: '8px 14px',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                background: 'var(--secondary)',
                color: 'var(--secondary-foreground)',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              {t('thread.crashedRetry')}
            </button>
          </section>
        </div>
      )
    }
    return this.props.children
  }
}
