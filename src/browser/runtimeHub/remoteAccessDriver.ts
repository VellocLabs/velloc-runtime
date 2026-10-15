/**
 * The runtime's side of the `remoteAccess` capability (F-24); host calls originate from the runtime.
 * Makes no host call until the manifest advertises `remoteAccess` (`setSupported(true)`); dials or
 * disconnects the relay to match the listener status (never a manual dial it does not own); and
 * publishes `access` on `remote/state`. Security: the control token is dropped after dialing.
 */
import type { RemoteAccessStatus } from '../bridge/protocol/remoteAccess'
import type { HostBridge } from './types'
import type { RelayDialer } from './relayDialer'

/** The `access` object published on `remote/state` (token-free). */
export type RemoteAccessState = {
  /** Whether the host manifest advertised `remoteAccess` (the gate). */
  supported: boolean
  enabled: boolean
  bindAddress: string
  port: number
  state: 'off' | 'starting' | 'listening' | 'error'
  error?: string
  addresses: Array<{ address: string; interfaceName: string }>
  clients: number
}

const UNSUPPORTED: RemoteAccessState = {
  supported: false,
  enabled: false,
  bindAddress: '',
  port: 0,
  state: 'off',
  addresses: [],
  clients: 0,
}

/**
 * The default bind when remote access is enabled with no user-chosen address.
 * v1 has no bind UI, so enabling sends this: every NIC, and the settings page
 * reads `access.addresses` to label each candidate. A future Advanced UI
 * overrides with a specific NIC by passing `bindAddress` in `setAccess` —
 * the JS layer owns the default so the C++ executor needs none.
 */
export const DEFAULT_BIND_ADDRESS = '0.0.0.0'

export type RemoteAccessDriverOptions = {
  /** Lazily read — the direct bridge may connect after construction. */
  host(): HostBridge | null
  /** Subscribe to host-pushed bridge events (remoteAccess.onStatusChanged).
   *  Matches DirectPortBridgeTransport.subscribeEvents: one envelope arg with
   *  `{ route: { capability, action }, payload }`. */
  subscribeEvents?(
    handler: (event: { route: { capability: string; action: string }; payload: unknown }) => void,
  ): () => void
  /** The relay dialer to steer. */
  dialer: RelayDialer
  /** Republish `remote/state` after a change. */
  publishState(): void
  /**
   * Fired once per applied getStatus — including the initial one. The
   * sharing-pairing coordinator (rework #20) gates its ONE ensure on this:
   * only after the first getStatus has landed is `access().enabled` the real
   * value rather than the pre-boot `false`, so an ensure that ran earlier
   * would mint against a state the host is about to contradict.
   */
  onStatusApplied?(): void
}

export type RemoteAccessDriver = {
  /** Arm/disarm the manifest gate. Arming triggers the one initial getStatus. */
  setSupported(supported: boolean): void
  /** Mark a dial the driver did NOT make (remote.connectRelay's manual
   *  ?rtDevRelay= dial) as externally owned: the driver's reconcile must not
   *  disconnect it. The next driver-owned dial/disconnect resumes ownership. */
  noteManualDial(): void
  /** The token-free `access` snapshot for `remote/state`. */
  access(): RemoteAccessState
  /** `remote.getAccess` → host getStatus, token stripped. */
  getAccess(): Promise<RemoteAccessState | { supported: false }>
  /** `remote.setAccess` → host configure, then dial/disconnect to match.
   *  Token stripped, like `getAccess`: the configure result carries the
   *  listener's `controlToken`, and this answer goes back to a remote. */
  setAccess(input: { enabled?: boolean; bindAddress?: string; port?: number }): Promise<RemoteAccessState>
}

/** Strip the token + control URL: `access` never carries them. */
function toAccessState(status: RemoteAccessStatus): RemoteAccessState {
  return {
    supported: true,
    enabled: status.enabled,
    bindAddress: status.bindAddress,
    port: status.port,
    state: status.state,
    ...(status.error !== undefined ? { error: status.error } : {}),
    addresses: status.addresses,
    clients: status.clients,
  }
}

export function createRemoteAccessDriver(
  options: RemoteAccessDriverOptions,
): RemoteAccessDriver {
  let supported = false
  let current: RemoteAccessState = UNSUPPORTED
  let unsubscribe: (() => void) | null = null
  // Serialize getStatus-driven dial decisions against event-driven ones so a
  // stale getStatus can't dial after a newer event disconnected.
  let statusGeneration = 0

  function request(route: { capability: 'remoteAccess'; action: string }, payload: unknown) {
    const host = options.host()
    if (!host) return Promise.resolve(null)
    return host.request(
      { namespace: 'nexus', capability: route.capability, action: route.action } as never,
      payload,
    )
  }

  // Which listener run the dialer was last pointed at. The host mints a fresh
  // token per run, so url+token names the run. Memory-only, like the dialer's
  // own copy; never published or logged.
  let dialedRun: string | null = null
  // True when the dialer's current connection came from remote.connectRelay —
  // a MANUAL dial (the ?rtDevRelay= dev/e2e knob), not a listener status the
  // driver reconciled. A non-listening status must not tear it down: the
  // initial getStatus answering 'off' (the listener is off by default) would
  // otherwise disconnect the control socket the manual dial JUST opened, and
  // remote/state.relay never leaves 'off' (the ?rtDevRelay= regression this
  // flag fixes). Any driver-owned dial or disconnect re-arms the reconcile.
  let externalDial = false

  /** Dial or disconnect to match a status. */
  function reconcile(status: RemoteAccessStatus): void {
    if (status.state === 'listening' && status.controlUrl && status.controlToken) {
      // connect() REPLACES the control socket, which makes the listener 4001
      // every client still waiting for its leg. A status that merely repeats
      // the run we are already dialed into (an address-list refresh, a client
      // count change, a repeated setAccess) must therefore not redial.
      const run = `${status.controlUrl}
${status.controlToken}`
      const live = options.dialer.state === 'connecting' || options.dialer.state === 'online'
      if (run === dialedRun && live) return
      dialedRun = run
      externalDial = false
      options.dialer.connect(status.controlUrl, status.controlToken)
    } else {
      // 'starting' lands here too: the previous run (if any) is already gone.
      dialedRun = null
      if (externalDial) return
      options.dialer.disconnect()
    }
  }

  function applyStatus(status: RemoteAccessStatus): void {
    current = toAccessState(status)
    reconcile(status)
    options.publishState()
    options.onStatusApplied?.()
  }

  function onEvent(payload: unknown): void {
    // The event already had its token stripped host-side. But a
    // 'listening' event with no token can't be dialed from the event alone —
    // a transition re-reads the full getStatus (full-trust) so the token is
    // available to dial.
    statusGeneration += 1
    const generation = statusGeneration
    void request({ capability: 'remoteAccess', action: 'getStatus' }, {}).then(response => {
      if (generation !== statusGeneration) return
      if (response && response.ok) applyStatus(response.result as RemoteAccessStatus)
      else if (payload && typeof payload === 'object') {
        // getStatus failed; at least reflect the event's token-free status.
        current = toAccessState(payload as RemoteAccessStatus)
        dialedRun = null
        // A manual dial is not ours to disconnect (see reconcile) — and the
        // dialer is already re-dialling with backoff on its own.
        if (!externalDial) options.dialer.disconnect()
        options.publishState()
      }
    })
  }

  return {
    noteManualDial(): void {
      externalDial = true
    },

    setSupported(next: boolean): void {
      if (next === supported) return
      supported = next
      if (!supported) {
        // Older binary: disarm entirely. No host calls, dialer off, gate false.
        if (unsubscribe) { unsubscribe(); unsubscribe = null }
        current = UNSUPPORTED
        dialedRun = null
        if (!externalDial) options.dialer.disconnect()
        externalDial = false
        options.publishState()
        return
      }
      // Armed: subscribe to status changes, then take the ONE initial
      // getStatus (the only unconditional call — and it is conditional on
      // this gate).
      if (options.subscribeEvents && !unsubscribe) {
        unsubscribe = options.subscribeEvents(event => {
          if (
            event.route.capability === 'remoteAccess' &&
            event.route.action === 'onStatusChanged'
          ) {
            onEvent(event.payload)
          }
        })
      }
      statusGeneration += 1
      const generation = statusGeneration
      void request({ capability: 'remoteAccess', action: 'getStatus' }, {}).then(response => {
        if (generation !== statusGeneration) return
        if (response && response.ok) applyStatus(response.result as RemoteAccessStatus)
      })
    },

    access(): RemoteAccessState {
      return current
    },

    async getAccess(): Promise<RemoteAccessState | { supported: false }> {
      if (!supported) return { supported: false }
      const response = await request({ capability: 'remoteAccess', action: 'getStatus' }, {})
      if (response && response.ok) {
        applyStatus(response.result as RemoteAccessStatus)
      }
      return current
    },

    async setAccess(input): Promise<RemoteAccessState> {
      if (!supported) {
        throw new Error('remote.setAccess: remoteAccess is not supported by this host')
      }
      // The JS runtime owns the default bind: an enable that names
      // no address binds every NIC. An explicit bindAddress (a future Advanced
      // UI) overrides; a disable-only configure leaves the stored bind alone.
      const effective =
        input.enabled === true && input.bindAddress === undefined
          ? { ...input, bindAddress: DEFAULT_BIND_ADDRESS }
          : input
      const response = await request({ capability: 'remoteAccess', action: 'configure' }, effective)
      if (!response || !response.ok) {
        throw new Error(
          `remote.setAccess: configure failed: ${
            response && !response.ok ? response.error.message : 'no host'
          }`,
        )
      }
      applyStatus(response.result as RemoteAccessStatus)
      return current
    },
  }
}
