/**
 * The remote client's connect / error screen (F-24); every state says what went
 * wrong and what to do. Standalone — no shell imports, contexts or stores — because
 * it renders before (or instead of) the shell chunk.
 */
import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { DesktopUnreachableCard } from './DesktopUnreachableCard'
import { UNREACHABLE_STATES } from './unreachableStates'

/**
 * The states the screen can be in. One per way a remote boot can stop or
 * stall: waiting, retryable transport failure, and the named
 * wire/server answers the user can act on.
 */
export type RemoteConnectState =
  | 'connecting'
  | 'failed'
  | 'unauthorized'
  | 'expired'
  | 'invalid'
  | 'runtime_offline'
  | 'listener_disabled'
  | 'too_many_clients'
  | 'protocol_too_old'
  | 'protocol_too_new'
  | 'build_mismatch'
  /**
   * The `replaced` bye: another tab or window of this browser holds this client's
   * connection now. No automatic retry (two pages would evict each other); the
   * manual retry stays.
   */
  | 'replaced'
  /**
   * The desktop went away under a LIVE connection and the connection CLOSED
   * (`screenForLiveClose`); a connection still retrying keeps the shell under
   * `RemoteOfflineOverlay`.
   */
  | 'host_gone'

/** Where an unreachable screen stands on the retry ladder. */
export type UnreachableProgress = {
  /** Did this page ever have a working connection? Picks "not detected" vs
   *  "connection lost". */
  everConnected: boolean
  /** Failed attempts in a row. */
  attempt: number
  /** When the screen retries on its own (epoch ms). */
  nextAttemptAt: number
}

export type RemoteConnectScreenProps = {
  state: RemoteConnectState
  /**
   * Retries the connection from scratch (a fresh socket + handshake). Shown
   * for the retryable states; absent for the terminal ones, where the fix is
   * not here.
   */
  onRetry?: (manual?: boolean) => void
  /** `build_mismatch` only: jump to the build the desktop is actually running. */
  onOpenMatchingBuild?: () => void
  /**
   * Auto-retry cadence (ms) for the states that reconnect on their own
   * (`failed`, `runtime_offline`, `too_many_clients`): the desktop coming back
   * is the expected fix, so the screen retries quietly instead of making the
   * user babysit it. `0`/undefined = no auto-retry — which is what `replaced`
   * is passed, since a timer there would fight the other tab.
   */
  autoRetryMs?: number
  /**
   * `listener_disabled` only: reload the page (defaults to `location.reload()`;
   * injectable for tests). That state neither auto-retries nor shows "Try again".
   */
  onReload?: () => void
  /**
   * For the `UNREACHABLE_STATES`, and for `connecting` while a retry of one
   * is on the wire: the card's ladder position. The screen calls
   * `onRetry(false)` at `nextAttemptAt`, and `onRetry(true)` when the user
   * asks — the boot restarts the ladder on a manual retry. Absent, the state
   * is derived: `host_gone` has connected, the rest have not, and the next try
   * is `autoRetryMs` away.
   */
  unreachable?: UnreachableProgress
}

type CopyState = Exclude<RemoteConnectState, 'failed' | 'runtime_offline' | 'host_gone'>

const TITLE_KEY: Record<CopyState, Parameters<ReturnType<typeof useT>>[0]> = {
  connecting: 'remote.connectingTitle',
  unauthorized: 'remote.unauthorizedTitle',
  expired: 'remote.expiredTitle',
  invalid: 'remote.invalidTitle',
  listener_disabled: 'remote.disabledTitle',
  too_many_clients: 'remote.tooManyTitle',
  protocol_too_old: 'remote.protocolTitle',
  protocol_too_new: 'remote.protocolTitle',
  build_mismatch: 'remote.buildMismatchTitle',
  replaced: 'remote.replacedTitle',
}

const BODY_KEY: Record<CopyState, Parameters<ReturnType<typeof useT>>[0]> = {
  connecting: 'remote.connectingBody',
  unauthorized: 'remote.unauthorizedBody',
  expired: 'remote.expiredBody',
  invalid: 'remote.invalidBody',
  listener_disabled: 'remote.disabledBody',
  too_many_clients: 'remote.tooManyBody',
  protocol_too_old: 'remote.protocolBody',
  protocol_too_new: 'remote.protocolBody',
  build_mismatch: 'remote.buildMismatchBody',
  replaced: 'remote.replacedBody',
}

/** States where a manual retry button makes sense — the fix may be transient.
 *  `replaced` is here too, and is the one where the button is the WHOLE fix:
 *  nothing reconnects it on a timer, so pressing it is how the user moves the
 *  connection back to this page. */
const RETRYABLE: ReadonlySet<RemoteConnectState> = new Set([
  'too_many_clients',
  'replaced',
])

export function RemoteConnectScreen({
  state,
  onRetry,
  onOpenMatchingBuild,
  autoRetryMs,
  onReload,
  unreachable,
}: RemoteConnectScreenProps) {
  const t = useT()
  const isUnreachable = UNREACHABLE_STATES.has(state)
  // Derived once per state when the boot passed no progress (a state rendered
  // on its own): `host_gone` has connected, the rest have not.
  const [derivedAt] = useState(() => Date.now())
  const cardProgress: UnreachableProgress | null = isUnreachable
    ? (unreachable ?? {
        everConnected: state === 'host_gone',
        attempt: 0,
        nextAttemptAt: autoRetryMs && autoRetryMs > 0 ? derivedAt + autoRetryMs : 0,
      })
    : state === 'connecting' && unreachable
      ? unreachable
      : null
  const nextAttemptAt = cardProgress?.nextAttemptAt ?? 0

  // When to retry on our own: the card's scheduled attempt; nothing while a
  // retry is already on the wire (`connecting`); else the plain cadence.
  useEffect(() => {
    if (!onRetry) return
    let delay: number | undefined
    if (isUnreachable) {
      if (nextAttemptAt > 0) delay = Math.max(0, nextAttemptAt - Date.now())
    } else if (!cardProgress && autoRetryMs && autoRetryMs > 0) {
      delay = autoRetryMs
    }
    if (delay === undefined) return
    const timer = setTimeout(() => onRetry(false), delay)
    return () => clearTimeout(timer)
    // Re-armed per state and per scheduled attempt, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, onRetry, autoRetryMs, nextAttemptAt])

  if (cardProgress) {
    return (
      <main
        data-testid="remote-connect-screen"
        data-state={state}
        role="alertdialog"
        aria-labelledby="remote-offline-title"
        aria-describedby="remote-offline-body"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 16,
          background: 'var(--background)',
          color: 'var(--foreground)',
        }}
      >
        <DesktopUnreachableCard
          everConnected={cardProgress.everConnected}
          attempt={cardProgress.attempt}
          // `connecting` is a retry on the wire: due now.
          nextAttemptAt={state === 'connecting' ? 0 : cardProgress.nextAttemptAt}
          onRetryNow={() => onRetry?.(true)}
        />
      </main>
    )
  }

  return (
    <main
      data-testid="remote-connect-screen"
      data-state={state}
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'var(--background)',
        color: 'var(--foreground)',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <section
        style={{
          maxWidth: 560,
          width: '100%',
          padding: '24px 28px',
          borderRadius: 24,
          background: 'var(--card)',
          border: '1px solid var(--border)',
          boxShadow: '0 16px 48px oklch(0 0 0 / 8%)',
          display: 'grid',
          gap: 12,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 'clamp(1.5rem, 4vw, 2.25rem)',
            lineHeight: 1.1,
          }}
        >
          {t(TITLE_KEY[state as CopyState])}
        </h1>
        <div style={{ color: 'var(--muted-foreground)', lineHeight: 1.6 }}>
          {t(BODY_KEY[state as CopyState])}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {onRetry && RETRYABLE.has(state) ? (
            <button type="button" onClick={() => onRetry(true)} style={buttonStyle}>
              {t('remote.retry')}
            </button>
          ) : null}
          {state === 'listener_disabled' ? (
            <button
              type="button"
              onClick={onReload ?? (() => window.location.reload())}
              style={buttonStyle}
            >
              {t('remote.reconnect')}
            </button>
          ) : null}
          {state === 'build_mismatch' && onOpenMatchingBuild ? (
            <button
              type="button"
              onClick={onOpenMatchingBuild}
              style={buttonStyle}
            >
              {t('remote.openMatchingBuild')}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  )
}

const buttonStyle: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 10,
  border: '1px solid var(--border)',
  background: 'var(--primary)',
  color: 'var(--primary-foreground)',
  font: 'inherit',
  cursor: 'pointer',
}
