/**
 * Opt-in bridge tracer for end-to-end tests: appends every request and response
 * to `globalThis.__NEXUS_BRIDGE_TRACE__`. Strictly an observer; enabled by
 * `?e2eTrace=1` or `globalThis.__NEXUS_E2E_TRACE__ === true`.
 */

import type {BrowserBridgeTransport} from './browserBridgeProtocol'

// Which path a guest → host request took. `direct` is the page's own C++
// port (boot catalog calls, the binary-registry publish); `runtime` is
// the page's host transport over the runtime connection, which reaches C++
// through the SharedWorker's host-proxy table.
// A request is recorded on exactly one of the two.
export type BridgeTransportLabel = 'direct' | 'runtime'

export interface BridgeTraceEvent {
  dir: 'request' | 'response'
  transport: BridgeTransportLabel
  id: string
  namespace: string
  capability: string
  action: string
  /** Only on 'response'. */
  ok?: boolean
  /** Only on 'response' — ms since the matching 'request'. */
  ms?: number
  /** High-resolution timestamp in ms (performance.now). */
  at: number
}

declare global {
  // eslint-disable-next-line no-var
  var __NEXUS_BRIDGE_TRACE__: BridgeTraceEvent[] | undefined
  // eslint-disable-next-line no-var
  var __NEXUS_E2E_TRACE__: boolean | undefined
}

export function isBridgeTraceEnabled(): boolean {
  if (typeof globalThis !== 'undefined' && globalThis.__NEXUS_E2E_TRACE__) {
    return true
  }
  try {
    const search = globalThis.location?.search ?? ''
    return new URLSearchParams(search).get('e2eTrace') === '1'
  } catch {
    return false
  }
}

function buffer(): BridgeTraceEvent[] {
  if (!globalThis.__NEXUS_BRIDGE_TRACE__) {
    globalThis.__NEXUS_BRIDGE_TRACE__ = []
  }
  return globalThis.__NEXUS_BRIDGE_TRACE__
}

/**
 * Wraps a transport's `request()` so every call is recorded before it leaves
 * and again when the response resolves. Returns the same transport reference
 * (mutated in-place) for call-site brevity.
 */
export function traceTransport<T extends BrowserBridgeTransport>(
  transport: T,
  label: BridgeTransportLabel,
): T {
  const original = transport.request.bind(transport)
  ;(transport as BrowserBridgeTransport).request = (async (request: any) => {
    const route = request.route ?? {}
    const at = performance.now()
    const evt: BridgeTraceEvent = {
      dir: 'request',
      transport: label,
      id: String(request.id ?? ''),
      namespace: String(route.namespace ?? ''),
      capability: String(route.capability ?? ''),
      action: String(route.action ?? ''),
      at,
    }
    buffer().push(evt)

    const response = await original(request)
    buffer().push({
      dir: 'response',
      transport: label,
      id: evt.id,
      namespace: evt.namespace,
      capability: evt.capability,
      action: evt.action,
      ok: Boolean(response?.ok),
      ms: performance.now() - at,
      at: performance.now(),
    })
    return response
  }) as typeof transport.request
  return transport
}

/**
 * Install tracing on the page's host transport over the runtime connection,
 * if enabled. Every page host request rides it (phase 4), so each is
 * recorded once, labelled `runtime`; the direct label is left to the page's
 * boot-time calls on its raw port.
 */
export function installRuntimeHostTracerIfEnabled(transport: BrowserBridgeTransport): void {
  if (!isBridgeTraceEnabled()) return
  buffer()
  traceTransport(transport, 'runtime')
}

/**
 * Install tracing on the direct transport if enabled. Idempotent.
 */
export function installBridgeTracerIfEnabled(transports: {
  direct: BrowserBridgeTransport
}): void {
  if (!isBridgeTraceEnabled()) return
  // Mark the buffer exists so readers can distinguish "tracer off" from
  // "tracer on but no traffic yet".
  buffer()
  traceTransport(transports.direct, 'direct')
  // eslint-disable-next-line no-console
  console.info('[NexusTrace][BridgeTracer] installed')
}
