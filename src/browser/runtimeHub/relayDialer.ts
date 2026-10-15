/**
 * Contract: the runtime's outbound leg to a relay (F-24); the runtime never listens.
 *   control  ws(s)://<relay>/host/control?token=<T>   → {"hello":1,"entryPath":…}; ← {"open"|"closed":"<legId>"}
 *   leg      ws(s)://<relay>/host/leg/<legId>?token=<T>  spliced verbatim to that client's /rt socket
 * Each `open` attaches a new hub connection. The control socket reconnects with jittered backoff
 * (1 s → 30 s); legs never reconnect.
 */
import { createWebSocketTransport, type SocketSurface } from '../runtimeTransport'
import type { FrameTransport } from '../runtimeTransport'

export type RelayDialerState = 'off' | 'connecting' | 'online' | 'error'

export type RelayDialerOptions = {
  /** Create a socket. Injected so a test supplies a fake; production passes `url => new WebSocket(url)`. */
  createSocket(url: string): SocketSurface
  /** Attach a freshly-dialed leg as a hub connection (RuntimeHub.attachTransport). */
  attachTransport(transport: FrameTransport): void
  /** The immutable entry path this runtime reports, else null. */
  getEntryPath(): string | null
  /** State changes feed the `remote/state` topic. */
  onState(state: RelayDialerState, error?: string): void
  /** Backoff schedule hook (tests drive it deterministically). Default setTimeout. */
  schedule?(fn: () => void, delayMs: number): void
}

const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000

export type RelayDialer = {
  /** Start or replace the outbound connection. A previous one is cancelled. */
  connect(controlUrl: string, token: string): void
  /** Tear down and do not reconnect. */
  disconnect(): void
  readonly state: RelayDialerState
}

export function createRelayDialer(options: RelayDialerOptions): RelayDialer {
  const schedule = options.schedule ?? ((fn, ms) => { setTimeout(fn, ms) })
  let state: RelayDialerState = 'off'
  let control: SocketSurface | null = null
  let cancelled = false
  let attempt = 0
  let current: { controlUrl: string; token: string } | null = null
  /** Bumped by every connect()/disconnect(); a scheduled redial captures it and dies if it is stale. */
  let generation = 0

  const setState = (s: RelayDialerState, error?: string): void => {
    state = s
    options.onState(s, error)
  }

  const legUrlFor = (legId: string): string => {
    const base = current!.controlUrl.replace(/\/host\/control$/, '')
    const sep = base.includes('?') ? '&' : '?'
    return `${base}/host/leg/${legId}${sep}token=${encodeURIComponent(current!.token)}`
  }

  const dialLeg = (legId: string): void => {
    const socket = options.createSocket(legUrlFor(legId))
    options.attachTransport(createWebSocketTransport(socket))
  }

  const onControlMessage = (event: MessageEvent): void => {
    const data = typeof event.data === 'string' ? event.data : ''
    if (!data.startsWith('{')) return
    let msg: { open?: unknown; closed?: unknown }
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (typeof msg.open === 'string') dialLeg(msg.open)
    // 'closed' is informational: the leg's own close event tears the connection down.
  }

  const dialControl = (myGeneration: number): void => {
    // A stale backoff timer from a previous connect()/disconnect() must not
    // dial: the generation it captured is no longer the live one.
    if (myGeneration !== generation) return
    if (cancelled || !current) return
    setState(attempt === 0 ? 'connecting' : state)
    const sep = current.controlUrl.includes('?') ? '&' : '?'
    const url = `${current.controlUrl}${sep}token=${encodeURIComponent(current.token)}`
    const socket = options.createSocket(url)
    control = socket
    socket.addEventListener('open', () => {
      attempt = 0
      setState('online')
      // First message: the hello the relay uses to mark the runtime online and
      // to redirect GET / to this runtime's entry path.
      socket.send(JSON.stringify({ hello: 1, entryPath: options.getEntryPath() }))
    })
    socket.addEventListener('message', onControlMessage)
    const onGone = (): void => {
      if (myGeneration !== generation) return
      if (control !== socket) return
      control = null
      if (cancelled || !current) return
      // Reconnect with exponential backoff + jitter. Legs are not re-dialed;
      // their clients reconnect and resume on their own. The callback carries
      // this generation so a connect()/disconnect() landing before it fires
      // makes it a no-op.
      attempt += 1
      setState('error', 'control socket closed')
      const backoff = Math.min(BACKOFF_MIN_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
      const jittered = backoff * (0.5 + Math.random() * 0.5)
      schedule(() => dialControl(myGeneration), jittered)
    }
    socket.addEventListener('close', onGone)
    socket.addEventListener('error', onGone)
  }

  return {
    get state() {
      return state
    },
    connect(controlUrl, token) {
      // Replace any existing connection without reconnecting the old one.
      // Bumping the generation is what actually disowns it: `cancelled` is
      // cleared again two lines down, so a backoff timer already scheduled by
      // the previous generation would otherwise wake up, pass the `cancelled`
      // check, and dial a SECOND control socket — overwriting `control` and
      // leaving the first one open and unowned.
      generation += 1
      cancelled = true
      control?.close()
      control = null
      cancelled = false
      attempt = 0
      current = { controlUrl, token }
      dialControl(generation)
    },
    disconnect() {
      generation += 1
      cancelled = true
      current = null
      control?.close()
      control = null
      setState('off')
    },
  }
}
