/**
 * Connecting the guest page to its SharedWorker's `RuntimeHub`.
 *
 * `bridge.attachRuntimePort` is the one message outside the protocol on this
 * path: it transfers one end of a `MessageChannel` to the
 * SharedWorker, which hands it to the hub as a `ClientConnection`. Everything
 * after that is frames on the transferred port.
 */
import type { ClientDescriptor, ClientKind, ScopeMode } from '../runtimeProtocol'
import {
  MESSAGE_PORT_TRANSPORT_LIMITS,
  createMessagePortTransport,
  type WorkerErrorSource,
} from '../runtimeTransport'
import { connectRuntime, type RuntimeConnection } from './RuntimeConnection'
import { randomUuid } from '../../utils/randomUuid'

export type SharedWorkerConnectOptions = {
  /** Same hint the legacy WebUI attach carries; often empty in production. */
  homeDir: string
  panelId?: string
  kind?: ClientKind
  displayName?: string
  /** Bundle build stamp, diagnostics only. */
  build?: string
  /** Stable install id; defaults to one kept in `localStorage`, or a fresh uuid when storage is unavailable. */
  clientId?: string
  /** `hello.scopeCeiling` — connect with less than `local` grants (the `?rtScope=` dev / e2e knob). */
  scopeCeiling?: ScopeMode
  requestTimeoutMs?: number
  /**
   * Forwarded to `connectRuntime`; `0` waits for `welcome` indefinitely —
   * which is only safe with `worker` set, since a SharedWorker whose script
   * never loads answers nothing on any port.
   */
  handshakeTimeoutMs?: number
  /**
   * The `SharedWorker` object `sharedWorkerPort` belongs to. Its `error`
   * event (script failed to fetch or parse) is the one signal a dead worker
   * gives, and it is fired at this object, never on a port: wired, it fails
   * the connection (`RuntimeConnectionClosedError` `transport` /
   * `worker-error`) instead of leaving it connecting for good.
   */
  worker?: WorkerErrorSource
}

const CLIENT_ID_STORAGE_KEY = 'nexus.runtimeClientId'

/** A per-install client id: stable across reloads where storage exists, fresh otherwise. */
export function resolveRuntimeClientId(): string {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage
    const existing = storage?.getItem(CLIENT_ID_STORAGE_KEY)
    if (existing) return existing
    const fresh = randomUuid()
    storage?.setItem(CLIENT_ID_STORAGE_KEY, fresh)
    return fresh
  } catch {
    return randomUuid()
  }
}

/**
 * Transfer a fresh port to the SharedWorker and return the page's end. Split
 * from `connectRuntimeOverSharedWorker` so a test can drive the port directly.
 */
export function attachRuntimePort(
  sharedWorkerPort: MessagePort,
  options: { homeDir: string; panelId?: string },
): MessagePort {
  const channel = new MessageChannel()
  sharedWorkerPort.postMessage(
    {
      type: 'bridge.attachRuntimePort',
      homeDir: options.homeDir,
      ...(options.panelId !== undefined ? { panelId: options.panelId } : {}),
    },
    [channel.port2],
  )
  return channel.port1
}

/** SharedWorker ports whose page-unload release is already wired. */
const disconnectWired = new WeakSet<MessagePort>()

/**
 * Tell the SharedWorker this page's port is going away; it gets no unload event,
 * so the port would otherwise stay in the hub, every `session.ports` set and the
 * diagnostics subscribers. Fires on `pagehide`, `beforeunload` as fallback; once
 * per port, idempotent, a no-op in a realm without page events.
 */
export function installPortDisconnectOnUnload(sharedWorkerPort: MessagePort): void {
  if (disconnectWired.has(sharedWorkerPort)) return
  const target = globalThis as {
    addEventListener?: (type: string, listener: () => void) => void
  }
  if (typeof target.addEventListener !== 'function') return
  disconnectWired.add(sharedWorkerPort)
  let sent = false
  const release = (): void => {
    if (sent) return
    sent = true
    try {
      sharedWorkerPort.postMessage({ type: 'port.disconnect' })
    } catch {
      // The port is already closed — nothing left to release.
    }
  }
  target.addEventListener('pagehide', release)
  target.addEventListener('beforeunload', release)
}

export function connectRuntimeOverSharedWorker(
  sharedWorkerPort: MessagePort,
  options: SharedWorkerConnectOptions,
): Promise<RuntimeConnection> {
  installPortDisconnectOnUnload(sharedWorkerPort)
  const port = attachRuntimePort(sharedWorkerPort, { homeDir: options.homeDir, panelId: options.panelId })
  const client: ClientDescriptor = {
    clientId: options.clientId ?? resolveRuntimeClientId(),
    kind: options.kind ?? 'desktop-shell',
    ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
    ...(options.build !== undefined ? { build: options.build } : {}),
    ...(options.panelId !== undefined ? { panelId: options.panelId } : {}),
  }
  return connectRuntime({
    transport: createMessagePortTransport(port, MESSAGE_PORT_TRANSPORT_LIMITS, {
      ...(options.worker !== undefined ? { worker: options.worker } : {}),
    }),
    client,
    ...(options.scopeCeiling !== undefined ? { scopeCeiling: options.scopeCeiling } : {}),
    requestTimeoutMs: options.requestTimeoutMs,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
  })
}
