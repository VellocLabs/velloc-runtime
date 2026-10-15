/**
 * `remoteAccess` bridge capability — status + configure for the desktop's
 * default-OFF embedded relay (F-24); remote browsers join with scope <= control.
 * Manifest-gated: called ONLY when the host manifest advertises `remoteAccess`,
 * and only by the runtime, never a client (P-3).
 */

/** One network interface offered as a bind candidate. */
export type RemoteAccessBindAddress = {
  /** The IPv4 literal the listener would bind (127.0.0.1 included for local
   *  debugging; 0.0.0.0 is never offered). */
  address: string
  /** `net::NetworkInterface::friendly_name` for the Settings dropdown. */
  interfaceName: string
}

/**
 * One persisted access-link pairing, persisted opaquely by the host. Security: the
 * `secret` rides ONLY this full-trust surface — never a topic, log, or
 * localStorage. Kept in lockstep with the runtime's pairingTable.
 */
export type RemoteAccessPairing = {
  pairId: string
  /** base64url, 32 bytes. */
  secret: string
  scope: { mode: 'observe' | 'control' | 'manager'; sessions: 'all' | readonly string[] }
  label: string
  createdAt: number
  expiresAt: number
  revoked: boolean
  lastSeenAt: number | null
}

/**
 * The listener's status snapshot — the result of `remoteAccess.getStatus`
 * AND (minus `controlToken`) the payload of the `remoteAccess.onStatusChanged`
 * event. Mirrors the C++ `RemoteAccessStatus` struct rendered by
 * `StatusToDict` in the adapter.
 */
export type RemoteAccessStatus = {
  /** The master pref. */
  enabled: boolean
  /** The bound IPv4 literal (empty when unset). */
  bindAddress: string
  port: number
  /**
   * The host binds asynchronously: a `configure` that begins a bind answers
   * 'starting', and the outcome ('listening' | 'error') follows as an
   * `onStatusChanged`. Only 'listening' carries controlUrl/controlToken.
   */
  state: 'off' | 'starting' | 'listening' | 'error'
  /** Why state is 'error': 'port_in_use' | 'no_address' | 'bad_port' | 'start_failed'. */
  error?: string
  /** `ws://<bind>:<port>/host/control` — present only when listening. */
  controlUrl?: string
  /**
   * The memory-only 32-byte control token the runtime dials back with.
   * Present ONLY in the full-trust `getStatus` result — stripped from
   * `onStatusChanged` and never enters a topic/log.
   */
  controlToken?: string
  /** Bind candidates from `net::GetNetworkList`. */
  addresses: RemoteAccessBindAddress[]
  /** Live `/rt` client count. */
  clients: number
}

export type RemoteAccessBridgeActionMap = {
  /** Snapshot the listener. Full-trust: the result carries `controlToken`. */
  getStatus: {
    payload: Record<string, never>
    result: RemoteAccessStatus
  }
  /** Apply a partial configure; absent keys unchanged. Same result shape. */
  configure: {
    payload: {
      enabled?: boolean
      bindAddress?: string
      port?: number
    }
    result: RemoteAccessStatus
  }
  /** Read the persisted pairings (WP-4 task #14). Full-trust: carries every
   *  pairSecret. The runtime seeds its pairingTable from this on boot. */
  getPairings: {
    payload: Record<string, never>
    result: { pairings: RemoteAccessPairing[] }
  }
  /** Replace the persisted pairings wholesale (the runtime writes the FULL
   *  table after every mutation, never a delta). */
  setPairings: {
    payload: { pairings: RemoteAccessPairing[] }
    result: { ok: true }
  }
  /**
   * Host-pushed status-change EVENT (not a request/response). Fired by
   * `NexusRemoteAccessBridgeAdapter::PushStatusChangedEvent` on every
   * listener transition. Payload = `RemoteAccessStatus` MINUS `controlToken`.
   * `result: never` marks it un-invokable via `request`; listed so the route
   * `remoteAccess.onStatusChanged` is a valid, type-checked
   * `BrowserBridgeAction<'remoteAccess'>` for the event-subscription filter.
   */
  onStatusChanged: {
    payload: RemoteAccessStatus
    result: never
  }
}
