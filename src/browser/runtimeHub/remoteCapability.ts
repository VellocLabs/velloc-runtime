/**
 * Security: the `remote` capability (F-24). Every action is `manager` except `connectRelay` (`full`).
 * State is published on `remote/state`, also `manager`. The caller assembles the remote URL from
 * `pairStart`'s `fragment`.
 */
import type { ClientKind, ScopeMode, TopicId } from '../runtimeProtocol'
import { wireError } from '../runtimeProtocol'
import type { RemoteAccessStatus } from '../bridge/protocol/remoteAccess'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { Pairing, PairingTable } from './pairingTable'
import type { RelayDialer, RelayDialerState } from './relayDialer'
import type { RemoteAccessDriver, RemoteAccessState } from './remoteAccessDriver'
import { SHARING_PAIRING_LABEL, isSharingPairing, type SharingPairing } from './sharingPairing'
import type { TopicProvider, SnapshotPage } from './types'

/** `remote/state`: the dialer's relay state, the (secret-less) pairing list, and
 *  the remote-access `access` object (token-free). */
export const REMOTE_STATE_TOPIC: TopicId = 'remote/state'

export type RemoteState = {
  relay: RelayDialerState
  relayError?: string
  pairings: Array<Omit<Pairing, 'secret'>>
  access: RemoteAccessState
  /**
   * Live websocket connections, one row each (F-24). `userAgent` is the client's claim, not trusted;
   * no peer IP. Absent from older runtimes: default `[]`.
   */
  connections?: RemoteConnectionRow[]
}

/** One connected device on `remote/state`. See `RemoteState.connections`. */
export type RemoteConnectionRow = {
  connectionId: string
  clientId: string
  kind: ClientKind
  /** The scope the hub granted this connection, after every clamp. */
  scope: ScopeMode
  /** Epoch ms of the completed handshake. */
  connectedAt: number
  /** The client's `navigator.userAgent`, when it sent one. */
  userAgent?: string
}

export type RemoteCapabilityOptions = {
  pairings: PairingTable
  /** Revoke + drop that pairing's live connections (ConnectionHub.revokePairing). */
  revokePairing(pairId: string): boolean
  dialer: RelayDialer
  /** The dialer's last error string, when state is 'error' (RuntimeHub tracks it). */
  relayError(): string | undefined
  /** Republish `remote/state` after a state-changing action (RuntimeHub.publishRemoteState). */
  publishState(): void
  /** The remote-access driver (host remoteAccess calls + dialer steering). */
  remoteAccess: RemoteAccessDriver
  /** The runtime's immutable entry path, for pairStart.url. */
  entryPath(): string | null
  /**
   * Write the full pairing table back to the host's pref
   * store after every mutation. Absent = in-memory only (tests, or a host
   * without the `remoteAccess` capability).
   */
  persistPairings?(): void
  /**
   * The sharing-pairing coordinator (`sharingPairing.ts`) — the ONE owner of
   * "is there a long-lived manager pairing, and should there be one". This
   * capability never mints or expiry-checks one itself: `setAccess` tells it
   * the user enabled sharing, `currentPairing` asks it for the live row, and
   * the boot landings it is gated on live in RuntimeHub.
   */
  sharing: SharingPairing
  /** Injected clock for expiry checks (stopSharing's live set). */
  now?(): number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSessions(value: unknown): value is 'all' | string[] {
  return value === 'all' || (Array.isArray(value) && value.every(v => typeof v === 'string'))
}

/** The URL fragment for a live pairing — the secret inside, exactly once per read. */
function fragmentOf(pairing: Pairing): string {
  return 'rt=' + base64urlJson({
    v: 1, pairId: pairing.pairId, pairSecret: pairing.secret, exp: pairing.expiresAt,
  })
}

/** base64url (no padding) of a JSON.stringify'd object — the URL fragment's payload. */
function base64urlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function registerRemoteCapability(
  registry: CapabilityRegistry,
  options: RemoteCapabilityOptions,
): void {
  const { pairings, dialer, publishState } = options

  /** Revoke every live sharing pairing; how many were. Persisted when any. */
  const revokeLiveSharing = (): number => {
    const now = options.now?.() ?? Date.now()
    const live = pairings
      .entries()
      .filter(p => !p.revoked && isSharingPairing(p) && p.expiresAt > now)
    let revoked = 0
    for (const p of live) {
      if (options.revokePairing(p.pairId)) revoked += 1
    }
    if (revoked > 0) options.persistPairings?.()
    return revoked
  }

  registry.registerCapability({
    cap: 'remote',
    actions: {
      // A control remote may NOT mint a pairing — the pairing table has no
      // provenance for "granted by a control connection", so minting stays
      // with the desktop and its managers.
      pairStart: { scope: 'manager' },
      // A control remote may NOT see the pairing list — labels and connection
      // counts are the management view.
      pairList: { scope: 'manager' },
      // A control remote may NOT revoke — least of all out from under the
      // desktop. A manager manages pairing like the desktop does.
      pairRevoke: { scope: 'manager' },
      // Security: no remote may steer where the runtime dials; a relay's legs become hub
      // connections. Only the desktop's own `?rtDevRelay=` dial uses this.
      connectRelay: { scope: 'full' },
      disconnectRelay: { scope: 'manager' },
      // A control remote may NOT read or set the desktop's remote-access
      // listener — a remote managing the very access it connects through
      // would be a privilege escalation. Manager-level, like every other
      // remote.* action.
      getAccess: { scope: 'manager' },
      setAccess: { scope: 'manager' },
      // The one live sharing pairing's fragment: how the settings
      // page builds per-address links without ever minting one itself. The
      // secret rides the fragment — manager-gated, and never on remote/state.
      currentPairing: { scope: 'manager' },
      // Revoke the sharing pairing — every outstanding link dies — without
      // touching the listener. Re-enabling mints a fresh one.
      stopSharing: { scope: 'manager' },
      // The settings page's "Reset link": revoke the sharing pairing (every
      // copied link and every device that remembers it stops working) and
      // mint its replacement in the same step, so the page never shows an
      // enabled listener with no link. A manager remote resetting the link
      // it connected through drops itself — the same thing pairRevoke does.
      resetSharing: { scope: 'manager' },
    },
    handle: async request => {
      const act = request.route.act
      const payload = isObject(request.payload) ? request.payload : {}
      switch (act) {
        case 'pairStart': {
          // 'full' is NOT offered: a paired link can never reach the desktop's
          // own local surface (pickers, the desktop's own config).
          const mode =
            payload.mode === 'observe' || payload.mode === 'control' || payload.mode === 'manager'
              ? payload.mode
              : null
          if (!mode) throw wireError('bad_payload', "remote.pairStart: mode must be 'observe' | 'control' | 'manager'")
          const sessions = payload.sessions === undefined ? 'all' : payload.sessions
          if (!isSessions(sessions)) throw wireError('bad_payload', "remote.pairStart: sessions must be 'all' | string[]")
          // The label is how the sharing coordinator recognises ITS pairing;
          // a hand-minted one may not pass itself off as it.
          if (payload.label === SHARING_PAIRING_LABEL) {
            throw wireError('bad_payload', `remote.pairStart: label '${SHARING_PAIRING_LABEL}' is reserved`)
          }
          const pairing = pairings.start({
            mode,
            sessions,
            ...(typeof payload.ttlMs === 'number' ? { ttlMs: payload.ttlMs } : {}),
            ...(typeof payload.label === 'string' ? { label: payload.label } : {}),
          })
          options.persistPairings?.()
          publishState()
          // The secret surfaces exactly once, here, inside the fragment.
          const fragment = 'rt=' + base64urlJson({
            v: 1, pairId: pairing.pairId, pairSecret: pairing.secret, exp: pairing.expiresAt,
          })
          // The full URL a remote opens: the listener address + the
          // entry path + the fragment. Null when not listening — the
          // caller (Settings) then shows the fragment-less state.
          const access = options.remoteAccess.access()
          const entryPath = options.entryPath()
          // The wildcard is a bind, not a destination: `http://0.0.0.0:…` opens
          // nowhere. This device is the one address certain to reach it; the
          // caller that wants a NIC address swaps the host (as Settings does).
          const linkHost = access.bindAddress === '0.0.0.0' ? '127.0.0.1' : access.bindAddress
          const url = access.state === 'listening'
            ? `http://${linkHost}:${access.port}${entryPath ?? '/'}#${fragment}`
            : null
          return { pairId: pairing.pairId, fragment, url }
        }
        case 'pairList':
          return { pairings: pairings.list() }
        case 'pairRevoke': {
          if (typeof payload.pairId !== 'string') throw wireError('bad_payload', 'remote.pairRevoke: pairId must be a string')
          const revoked = options.revokePairing(payload.pairId)
          if (revoked) options.persistPairings?.()
          publishState()
          return { revoked }
        }
        case 'connectRelay': {
          if (typeof payload.controlUrl !== 'string' || typeof payload.token !== 'string') {
            throw wireError('bad_payload', 'remote.connectRelay: controlUrl and token must be strings')
          }
          dialer.connect(payload.controlUrl, payload.token)
          // A MANUAL dial (?rtDevRelay= dev/e2e): the driver's reconcile
          // must not tear it down when the listener's status says 'off'.
          options.remoteAccess.noteManualDial()
          return {}
        }
        case 'disconnectRelay':
          dialer.disconnect()
          return {}
        case 'getAccess': {
          // → host remoteAccess.getStatus, token stripped by the driver.
          return options.remoteAccess.getAccess()
        }
        case 'setAccess': {
          const input: { enabled?: boolean; bindAddress?: string; port?: number } = {}
          if (payload.enabled !== undefined) {
            if (typeof payload.enabled !== 'boolean') throw wireError('bad_payload', 'remote.setAccess: enabled must be a boolean')
            input.enabled = payload.enabled
          }
          if (payload.bindAddress !== undefined) {
            if (typeof payload.bindAddress !== 'string') throw wireError('bad_payload', 'remote.setAccess: bindAddress must be a string')
            input.bindAddress = payload.bindAddress
          }
          if (payload.port !== undefined) {
            if (typeof payload.port !== 'number') throw wireError('bad_payload', 'remote.setAccess: port must be a number')
            input.port = payload.port
          }
          const status = await options.remoteAccess.setAccess(input)
          // One long-lived manager pairing while enabled: minted on
          // enable, reused across restarts, so the page can offer per-address
          // links with no create step. Done AFTER configure so a failed enable
          // never leaves a dangling pairing. Only an explicit enable mints: a
          // port- or bind-only configure while enabled must not undo Stop sharing.
          if (input.enabled === true && status.enabled) {
            // An explicit "share again": it outranks an earlier stop-sharing,
            // and it is deferred (not dropped) if boot has not settled yet.
            options.sharing.mintForEnable()
            publishState()
          }
          return status
        }
        case 'currentPairing': {
          // Read-and-renew: the page asking for the link is also the moment a
          // pairing that ran out its 30 days gets replaced (#3). `ensure`
          // renews an EXPIRED pairing only — a revoked one means the user
          // pressed Stop sharing, and this read must not undo that.
          const live = options.sharing.ensure(options.remoteAccess.access().enabled)
          if (!live) return null
          return { pairId: live.pairId, fragment: fragmentOf(live) }
        }
        case 'stopSharing': {
          const revoked = revokeLiveSharing()
          publishState()
          return { revoked }
        }
        case 'resetSharing': {
          const revoked = revokeLiveSharing()
          // An explicit "share again", like an enable: it outranks the stop
          // record the revoke just wrote. While the listener is off there is
          // nothing to share, so the next enable mints instead.
          const fresh = options.remoteAccess.access().enabled
            ? options.sharing.mintForEnable()
            : null
          publishState()
          return { revoked, pairId: fresh?.pairId ?? null }
        }
        default:
          throw wireError('unknown_route', `remote has no action '${act}'`)
      }
    },
  })
}

/** `remote/state`: snapshot-only, manager scope. */
export function remoteStateTopicProvider(getState: () => RemoteState): TopicProvider {
  return {
    matches: (id: TopicId) => id === REMOTE_STATE_TOPIC,
    // Only a scope that can act on remote access may read its management
    // plane. (Same rule as the cap.)
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'manager'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { payload: getState(), type: 'state' }
    },
  }
}

