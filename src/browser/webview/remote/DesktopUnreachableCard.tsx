/**
 * The ONE card a remote page shows while it cannot reach the desktop: under
 * `RemoteOfflineOverlay`, and for `RemoteConnectScreen`'s `failed`, `runtime_offline`
 * and `host_gone` states. Only the copy differs (`phase()`). The button is never
 * disabled (`RuntimeConnection.reconnectNow` handles a young or hung dial).
 * Standalone (inline styles and icons): it renders before the shell chunk loads.
 */
import { useEffect, useRef, useState } from 'react'

import { useT, type TranslateFn } from '../i18n'

export type UnreachablePhase = 'never' | 'lost' | 'connecting' | 'stuck'

/** Failed attempts in a row after which the card says it is stuck. With the
 *  live ladder (1, 2, 4, 8 s…) that is roughly half a minute of trying. */
export const STUCK_AFTER_ATTEMPTS = 5

/** Whole seconds left until `nextAttemptAt`; 0 once the attempt is due. */
export function secondsUntil(nextAttemptAt: number, now: number): number {
  return Math.max(0, Math.ceil((nextAttemptAt - now) / 1000))
}

export function unreachablePhase(input: {
  everConnected: boolean
  attempt: number
  secondsLeft: number
}): UnreachablePhase {
  if (input.secondsLeft === 0) return 'connecting'
  if (input.attempt >= STUCK_AFTER_ATTEMPTS) return 'stuck'
  return input.everConnected ? 'lost' : 'never'
}

/**
 * The countdown's text: seconds in the last minute, whole minutes (rounded up)
 * above it — the ladder climbs to an hour, and "3600 s" is not a number anyone
 * reads. Worded by whether this page ever connected: a page that never did is
 * waiting for the desktop, not RE-connecting.
 */
export function countdownText(
  seconds: number,
  everConnected: boolean,
  t: TranslateFn,
): string {
  if (everConnected) {
    return seconds < 60
      ? t('remote.unreachable.countdown', { seconds })
      : t('remote.unreachable.countdownMinutes', { minutes: Math.ceil(seconds / 60) })
  }
  return seconds < 60
    ? t('remote.unreachable.waitingCountdown', { seconds })
    : t('remote.unreachable.waitingCountdownMinutes', { minutes: Math.ceil(seconds / 60) })
}

export type DesktopUnreachableCardProps = {
  /** Did this page ever have a working connection to the desktop? */
  everConnected: boolean
  /** Failed attempts in a row (0 right after a start or a manual retry). */
  attempt: number
  /** When the next attempt is due (epoch ms); at or before now = dialing. */
  nextAttemptAt: number
  /** Try now: pressed, or the user came back to the page. */
  onRetryNow: () => void
  /** Id prefix for the title/body, for an enclosing dialog's aria refs. */
  idPrefix?: string
}

export function DesktopUnreachableCard({
  everConnected,
  attempt,
  nextAttemptAt,
  onRetryNow,
  idPrefix = 'remote-offline',
}: DesktopUnreachableCardProps) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  const onRetryNowRef = useRef(onRetryNow)
  onRetryNowRef.current = onRetryNow

  // The user coming back is the moment to try — the likeliest moment the
  // desktop has just been reopened — not the next step of the ladder.
  useEffect(() => {
    const tryNow = (): void => {
      if (document.visibilityState === 'visible') onRetryNowRef.current()
    }
    document.addEventListener('visibilitychange', tryNow)
    window.addEventListener('online', tryNow)
    return () => {
      document.removeEventListener('visibilitychange', tryNow)
      window.removeEventListener('online', tryNow)
    }
  }, [])

  // A 1 s clock for the countdown.
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [nextAttemptAt])

  const seconds = secondsUntil(nextAttemptAt, now)
  const phase = unreachablePhase({ everConnected, attempt, secondsLeft: seconds })

  const title =
    phase === 'connecting'
      ? t('remote.unreachable.connectingTitle')
      : phase === 'stuck'
        ? t('remote.unreachable.stuckTitle')
        : phase === 'lost'
          ? t('remote.unreachable.lostTitle')
          : t('remote.unreachable.neverTitle')
  // The body keeps the page's own story while a dial is out: a connecting
  // card after a drop still says what happened.
  const body =
    phase === 'stuck'
      ? t('remote.unreachable.stuckBody')
      : everConnected
        ? t('remote.unreachable.lostBody')
        : t('remote.unreachable.neverBody')
  const status =
    phase === 'connecting'
      ? t('remote.unreachable.connectingStatus')
      : countdownText(seconds, everConnected, t)
  const buttonLabel =
    phase === 'stuck'
      ? t('remote.unreachable.tryAgain')
      : everConnected
        ? t('remote.unreachable.reconnectNow')
        : t('remote.unreachable.retry')

  return (
    <section
      data-testid="remote-offline-card"
      data-phase={phase}
      style={{
        width: '100%',
        maxWidth: 448,
        display: 'grid',
        gap: 12,
        padding: 24,
        borderRadius: 16,
        border: '1px solid var(--border)',
        background: 'var(--card)',
        color: 'var(--card-foreground)',
        boxShadow: '0 16px 48px oklch(0 0 0 / 8%)',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <PhaseIcon phase={phase} />
        <h2
          id={`${idPrefix}-title`}
          style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600, lineHeight: 1.3 }}
        >
          {title}
        </h2>
      </div>
      <p
        id={`${idPrefix}-body`}
        style={{
          margin: 0,
          color: 'var(--muted-foreground)',
          fontSize: '0.875rem',
          lineHeight: 1.6,
        }}
      >
        {body}
      </p>
      <div
        style={{
          marginTop: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span
          data-testid="remote-offline-countdown"
          role="status"
          aria-live="polite"
          style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem' }}
        >
          {status}
        </span>
        <button
          type="button"
          onClick={onRetryNow}
          autoFocus
          style={{
            flexShrink: 0,
            padding: '6px 14px',
            borderRadius: 8,
            border: '1px solid transparent',
            background: 'var(--primary)',
            color: 'var(--primary-foreground)',
            font: 'inherit',
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {buttonLabel}
        </button>
      </div>
    </section>
  )
}

/** ↻ lost · ◌ never · spinner connecting · ! stuck — inline, 20 px. */
function PhaseIcon({ phase }: { phase: UnreachablePhase }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    style: { flexShrink: 0, color: 'var(--muted-foreground)' },
  }
  if (phase === 'connecting') {
    return (
      <svg {...common} className="animate-spin" data-icon="connecting">
        <path d="M21 12a9 9 0 1 1-6.22-8.56" />
      </svg>
    )
  }
  if (phase === 'stuck') {
    return (
      <svg {...common} data-icon="stuck">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
    )
  }
  if (phase === 'lost') {
    return (
      <svg {...common} data-icon="lost">
        <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
    )
  }
  return (
    <svg {...common} data-icon="never">
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
    </svg>
  )
}
