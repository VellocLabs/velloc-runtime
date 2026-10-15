/**
 * Holds SharedWorker `connect` events until the runtime body has loaded, then hands every port over in
 * arrival order; the entry stays tiny so the `import()`-ed body can use the code cache. If the body
 * never loads, `fail` reads each refused port and sends a `bye` frame on every port a message
 * transfers (the page's connection listens there).
 */
import type { ByeFrame } from '../runtimeProtocol/frames'

export type PortAcceptor = (port: MessagePort) => void

/**
 * Sent on every connection wire a client opens after the runtime body failed
 * to load. A type-only import keeps the protocol module out of the entry's
 * runtime graph; the literal is checked against the real frame type here and
 * decoded by the real codec in the unit test, so it cannot drift from the
 * wire format unnoticed.
 */
export const RUNTIME_UNAVAILABLE_BYE: ByeFrame = { kind: 'bye', code: 'runtime_unavailable' }

export interface ConnectGate {
  /** Install as the worker scope's `onconnect`. Safe to call before `open`. */
  readonly onconnect: (event: MessageEvent) => void
  /**
   * Attach the runtime's acceptor. Ports that arrived while the gate was
   * closed are delivered first, in arrival order — including any that connect
   * re-entrantly while the queue drains — and later connects go straight
   * through. Calling `open` after `open` or `fail` is a programming error.
   */
  open(accept: PortAcceptor): void
  /**
   * The runtime will never arrive: start reading every queued SharedWorker
   * port, and every port that connects later, and answer each connection
   * wire a message transfers in with `RUNTIME_UNAVAILABLE_BYE`, so the page's
   * connection ends instead of waiting on `worker.init` forever. Idempotent.
   * Calling `fail` after `open` is a programming error.
   */
  fail(): void
  /** Ports still waiting — for tests and diagnostics. */
  readonly waitingCount: number
}

export function createConnectGate(): ConnectGate {
  const pending: MessagePort[] = []
  let accept: PortAcceptor | null = null
  let failed = false

  // Messages the page queued before `fail()` (its attach message is posted
  // right after `connect`) are delivered once the port starts, so a port
  // refused late still answers every wire the page opened on it.
  const refuse = (port: MessagePort): void => {
    port.addEventListener('message', (event: MessageEvent) => {
      for (const wire of event.ports) {
        wire.postMessage(RUNTIME_UNAVAILABLE_BYE)
      }
    })
    port.start()
  }

  return {
    onconnect(event: MessageEvent) {
      const port = event.ports[0]
      if (!port) {
        return
      }
      if (failed) {
        refuse(port)
      } else if (accept) {
        accept(port)
      } else {
        pending.push(port)
      }
    },
    open(acceptor: PortAcceptor) {
      if (accept) {
        throw new Error('agentRuntimeConnectGate: open() called twice')
      }
      if (failed) {
        throw new Error('agentRuntimeConnectGate: open() after fail()')
      }
      // `accept` is set only AFTER the drain: a connect that arrives
      // re-entrantly while draining is appended to `pending` and delivered
      // by this same loop, so arrival order holds for it too.
      while (pending.length > 0) {
        acceptor(pending.shift()!)
      }
      accept = acceptor
    },
    fail() {
      if (accept) {
        throw new Error('agentRuntimeConnectGate: fail() after open()')
      }
      if (failed) {
        return
      }
      failed = true
      for (const port of pending.splice(0)) {
        refuse(port)
      }
    },
    get waitingCount() {
      return pending.length
    },
  }
}
