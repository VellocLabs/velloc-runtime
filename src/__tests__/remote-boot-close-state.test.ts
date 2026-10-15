import { describe, expect, it } from 'vitest'

import {
  autoRetryMsForState,
  LIVE_RECONNECT_LADDER_MS,
  nextUnreachableProgress,
  screenForLiveClose,
  stateForFailure,
  watchForFreshRuntime,
} from '@/browser/boot/remoteBoot'
import {
  connectRuntime,
  RuntimeConnectionClosedError,
} from '@/browser/runtimeClient'
import type { Frame } from '@/browser/runtimeProtocol'
import {
  ListenerSet,
  type FrameTransport,
} from '@/browser/runtimeTransport'

/**
 * Which connect-screen state a dead connection lands on (F-24). Two callers feed this one mapping: a connect that never
 * succeeded (an Error), and a LIVE connection's terminal close code — the
 * revoke path, where the hub says `bye unauthorized` to a running shell and
 * the page must fall to the `unauthorized` screen rather than keep a
 * live-looking shell over a dead wire.
 */
describe('remote boot: close → connect-screen state', () => {
  it("maps a live connection's terminal close codes", () => {
    expect(stateForFailure('unauthorized')).toBe('unauthorized')
    expect(stateForFailure('protocol_too_old')).toBe('protocol_too_old')
    expect(stateForFailure('protocol_too_new')).toBe('protocol_too_new')
    // A wire that dropped and never came back names no cause.
    expect(stateForFailure('transport')).toBe('failed')
  })

  it('maps a failed connect by its error', () => {
    expect(stateForFailure(new RuntimeConnectionClosedError('unauthorized'))).toBe(
      'unauthorized',
    )
    expect(stateForFailure(new Error('transport closed: ws-4001'))).toBe(
      'runtime_offline',
    )
    expect(stateForFailure(new Error('transport closed: ws-4003'))).toBe(
      'listener_disabled',
    )
    expect(stateForFailure(new Error('transport closed: ws-4004'))).toBe(
      'too_many_clients',
    )
    expect(stateForFailure(new Error('boom'))).toBe('failed')
  })

  it('an initial connect whose wire closes with a reason keeps it (ws-4001 → runtime_offline)', async () => {
    // A first /rt dial answered 4001 (runtime control socket down) must render 'runtime_offline', not 'failed': the
    // close reason reaches stateForFailure. Drives a real connectRuntime.
    const transport = droppingTransport()
    const promise = connectRuntime({
      transport,
      client: { clientId: 'c1', kind: 'browser' },
      auth: { mode: 'pair', pairId: 'p' },
      pairSecret: 'c2VjcmV0',
      handshakeTimeoutMs: 5_000,
    })
    // The listener accepts then closes 4001 before any welcome.
    transport.drop('ws-4001', true)
    const error = await promise.then(
      () => {
        throw new Error('expected the handshake to reject')
      },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(RuntimeConnectionClosedError)
    expect(stateForFailure(error)).toBe('runtime_offline')
  })

  it('arms auto-retry on the transient states, failed included', () => {
    // A first /rt dial that is TCP-refused or dropped lands on the generic
    // 'failed' screen (no close code names it) — exactly the transient cause
    // (desktop asleep, listener down, network blip) the auto-retry exists for.
    // Pinning the set: without 'failed' here the user was stranded on a
    // manual-retry screen for a cause that resolves itself.
    expect(autoRetryMsForState('failed')).toBeGreaterThan(0)
    expect(autoRetryMsForState('runtime_offline')).toBeGreaterThan(0)
    expect(autoRetryMsForState('too_many_clients')).toBeGreaterThan(0)
    // The desktop coming back is the fix, and the page can see it happen.
    expect(autoRetryMsForState('host_gone')).toBeGreaterThan(0)
    // Terminal states never retry on their own — the fix is not here.
    expect(autoRetryMsForState('unauthorized')).toBeUndefined()
    expect(autoRetryMsForState('expired')).toBeUndefined()
    expect(autoRetryMsForState('invalid')).toBeUndefined()
    expect(autoRetryMsForState('listener_disabled')).toBeUndefined()
    expect(autoRetryMsForState('protocol_too_old')).toBeUndefined()
    expect(autoRetryMsForState('protocol_too_new')).toBeUndefined()
    expect(autoRetryMsForState('build_mismatch')).toBeUndefined()
    expect(autoRetryMsForState('connecting')).toBeUndefined()
    // The other tab holds it; a timer here would fight that tab, not fix it.
    expect(autoRetryMsForState('replaced')).toBeUndefined()
  })

  it('a LIVE connection that closes for good retries on its own like a first dial — except replaced', () => {
    // The 'failed' copy says the page keeps retrying; the post-ready close
    // rendered it without the auto-retry, so nothing ever retried.
    const retry = autoRetryMsForState('failed')
    // A live connection dropped without a code (1006) or told to go away
    // (1001, what the listener sends while the desktop is shutting down) is
    // the desktop LEAVING, not a link that never worked: the 'failed' copy
    // ("the desktop did not answer … it may be asleep") reads as a setup
    // problem to someone whose page was working a second ago.
    expect(screenForLiveClose('transport', 'ws-1006')).toEqual({ state: 'host_gone', autoRetryMs: retry })
    expect(screenForLiveClose('transport', 'ws-1001')).toEqual({ state: 'host_gone', autoRetryMs: retry })
    expect(screenForLiveClose('transport', 'ws-closed')).toEqual({ state: 'host_gone', autoRetryMs: retry })
    expect(screenForLiveClose('transport', 'ws-4001')).toEqual({ state: 'runtime_offline', autoRetryMs: retry })
    expect(screenForLiveClose('transport', 'ws-4003')).toEqual({ state: 'listener_disabled' })
    expect(screenForLiveClose('unauthorized')).toEqual({ state: 'unauthorized' })
  })

  it('a replaced connection gets its own screen, not the generic failed one', () => {
    // `replaced` never auto-retries (another tab of this browser holds the
    // client id; two pages retrying evict each other for as long as both stay
    // open) — but it used to land on 'failed', whose copy says the desktop did
    // not answer AND that the page keeps retrying on its own. Both false here,
    // to a user who cannot see this machine's console. Without the fix this is
    // `{ state: 'failed' }`.
    expect(screenForLiveClose('replaced')).toEqual({ state: 'replaced' })
  })

  it('reads the EXACT bye code, so a failure that merely says "replaced" is not it', () => {
    // stateForFailure parses free text (an Error message, a close reason), so
    // the `replaced` screen — which is about a second tab of THIS browser —
    // must not be reachable from a message that happens to contain the word.
    expect(screenForLiveClose('transport', 'ws-1006 connection replaced upstream'))
      .toEqual({ state: 'failed', autoRetryMs: autoRetryMsForState('failed') })
    expect(stateForFailure(new Error('relay replaced the socket'))).toBe('failed')
  })
})

/**
 * The desktop going away under a live shell: the shell stays under `RemoteOfflineOverlay` while the connection
 * retries, and the boot path leaves it only for a restarted runtime (`watchForFreshRuntime`).
 */
describe('remote boot: the unreachable card walks the live ladder', () => {
  it('a page that cannot reach the desktop counts down the same steps as a live reconnect', () => {
    // A first dial used to retry on a flat, silent 5 s; now it is
    // the overlay's ladder, so both surfaces count down alike.
    let state = { everConnected: false, attempt: 0 }
    const delays: number[] = []
    for (let i = 0; i < LIVE_RECONNECT_LADDER_MS.length + 2; i++) {
      const next = nextUnreachableProgress(state, 1_000)
      delays.push(next.nextAttemptAt - 1_000)
      expect(next.attempt).toBe(state.attempt + 1)
      expect(next.everConnected).toBe(false)
      state = next
    }
    expect(delays.slice(0, LIVE_RECONNECT_LADDER_MS.length)).toEqual([...LIVE_RECONNECT_LADDER_MS])
    // The last step repeats.
    expect(delays.slice(-2)).toEqual([3_600_000, 3_600_000])
  })

  it('keeps whether the page ever connected', () => {
    expect(nextUnreachableProgress({ everConnected: true, attempt: 0 }, 0)).toEqual({
      everConnected: true,
      attempt: 1,
      nextAttemptAt: 1_000,
    })
  })
})

describe('remote boot: the desktop going away under a live shell', () => {
  const flush = () => new Promise<void>(resolve => queueMicrotask(resolve))

  it('an outage the runtime resumes keeps the shell, however long it lasts', async () => {
    const conn = fakeStateSource()
    let fresh = 0
    watchForFreshRuntime(conn, () => { fresh += 1 })
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      conn.emit({ status: 'reconnecting', attempt, lastWelcome: WELCOME, nextAttemptAt: 0 })
    }
    conn.emit({ status: 'ready', welcome: { ...(WELCOME as object), resumed: true } })
    await flush()
    expect(fresh).toBe(0)
  })

  it('coming back to a runtime that did not resume boots again', async () => {
    // A quit-and-relaunched desktop: new runtime, `resumed:false`.
    const conn = fakeStateSource()
    let fresh = 0
    watchForFreshRuntime(conn, () => { fresh += 1 })
    conn.emit({ status: 'reconnecting', attempt: 1, lastWelcome: WELCOME, nextAttemptAt: 0 })
    conn.emit({ status: 'ready', welcome: { ...(WELCOME as object), resumed: false } })
    // Deferred past the publish — the connection is mid-resume when it
    // publishes `ready`, and the callback closes it.
    expect(fresh).toBe(0)
    await flush()
    expect(fresh).toBe(1)
  })

  it('ignores the first ready (the boot’s own) and never fires after unwatch', async () => {
    const conn = fakeStateSource()
    let fresh = 0
    const unwatch = watchForFreshRuntime(conn, () => { fresh += 1 })
    conn.emit({ status: 'ready', welcome: { ...(WELCOME as object), resumed: false } })
    await flush()
    expect(fresh).toBe(0)

    unwatch()
    conn.emit({ status: 'reconnecting', attempt: 1, lastWelcome: WELCOME, nextAttemptAt: 0 })
    conn.emit({ status: 'ready', welcome: { ...(WELCOME as object), resumed: false } })
    await flush()
    expect(fresh).toBe(0)
  })

  it('retries on the ladder the overlay counts down: 1 s doubling to 32 s, 1 min doubling to 16 min, then hourly', () => {
    expect(LIVE_RECONNECT_LADDER_MS).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000,
      60_000, 120_000, 240_000, 480_000, 960_000,
      3_600_000,
    ])
  })

  it('a reconnecting connection is NOT a terminal close — no connect screen for it', () => {
    // The close watcher only reacts to `closed`; a desktop that quit leaves
    // the connection `reconnecting` (1001 / 1006 are retryable), so nothing
    // maps it to a screen any more.
    expect(screenForLiveClose('transport', 'ws-4003').state).toBe('listener_disabled')
  })
})

/** Just enough welcome for a `reconnecting` state to be well-formed. */
const WELCOME = {
  kind: 'welcome',
  v: 1,
  connectionId: 'c1',
  resumed: false,
  server: { capabilities: [] },
} as never

/** A connection stub that is nothing but `watchLinkState` — all the watcher reads. */
function fakeStateSource() {
  const listeners = new Set<(state: never) => void>()
  return {
    watchLinkState(listener: (state: never) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(state: unknown) {
      for (const listener of Array.from(listeners)) listener(state as never)
    },
  }
}

/**
 * A one-ended websocket-kind transport that can be killed reporting a close
 * reason, shaped like runtime-connection-reconnect.test.ts's loopback end. No
 * server half: the test only needs the wire to die mid-handshake.
 */
function droppingTransport(): FrameTransport & { drop(reason: string, retryable: boolean): void } {
  const frames = new ListenerSet<[Frame]>()
  const closed = new ListenerSet<[string, boolean]>()
  let isClosed = false
  const transport: FrameTransport & { drop(reason: string, retryable: boolean): void } = {
    kind: 'websocket',
    limits: { chunkBytes: 1024, windowChunks: 8 },
    bufferedBytes: () => 0,
    send() {},
    sendBlobChunk() {},
    onFrame: l => frames.add(l),
    onBlobChunk: () => () => {},
    onClosed: l => closed.add(l),
    drop(reason: string, retryable: boolean) {
      if (isClosed) return
      isClosed = true
      closed.emit(reason, retryable)
    },
    close() {
      transport.drop('closed', false)
    },
  }
  return transport
}
