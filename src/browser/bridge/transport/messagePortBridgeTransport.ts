/**
 * Generic `BrowserBridgeTransport` over one `MessagePort` (WebUI ↔ SharedWorker),
 * same wire shape as `DirectPortBridgeTransport` but no per-route policy and no
 * binary side-ports: every request is a plain JSON round-trip.
 */

import type {
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
  BridgeEventEnvelope,
  BridgeEventHandler,
  BridgeEventUnsubscribe,
} from '../protocol/core'

/**
 * Wire envelope for the WebUI ↔ SharedWorker channel. `hostBridge: true` is the
 * sanity tag: any non-bridge message on the port is dropped silently.
 */
export type MessagePortBridgeMessage =
  | {
      hostBridge: true
      direction: 'request'
      id: string
      route: BrowserBridgeRoute
      payload: Record<string, unknown>
      context?: Record<string, unknown>
    }
  | {
      hostBridge: true
      direction: 'response'
      id: string
      route: BrowserBridgeRoute
      ok: true
      result: unknown
    }
  | {
      hostBridge: true
      direction: 'response'
      id: string
      route: BrowserBridgeRoute
      ok: false
      error: { code: string; message: string; data?: unknown }
    }
  | {
      hostBridge: true
      direction: 'event'
      id?: string
      route: BrowserBridgeRoute
      payload: Record<string, unknown>
    }

export function isMessagePortBridgeMessage(
  data: unknown,
): data is MessagePortBridgeMessage {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  if (d.hostBridge !== true) return false
  return (
    d.direction === 'request'
    || d.direction === 'response'
    || d.direction === 'event'
  )
}

export type MessagePortBridgeTransportOptions = {
  port: MessagePort
  /** Default 30000 ms — same as `DirectPortBridgeTransport`. Past this
   *  point we reject the pending Promise with a timeout error. */
  requestTimeoutMs?: number
  /** When true the transport calls `port.start()` itself; pass `false`
   *  if the caller has already started the port (e.g. when receiving a
   *  port via `bridge.setPort`-style handshake where the receiver wants
   *  to inspect first). Defaults to `true`. */
  autoStart?: boolean
}

type AwaitedReply = {
  resolve(response: BrowserBridgeResponse): void
  reject(reason: unknown): void
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * BrowserBridgeTransport implementation for use over a single
 * `MessagePort`. Both ends of a `MessageChannel` can use this — the
 * direction is symmetric — though typically only one side actively
 * drives requests and the other side hosts the handler.
 */
export class MessagePortBridgeTransport implements BrowserBridgeTransport {
  private readonly port: MessagePort
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<string, AwaitedReply>()
  private readonly eventHandlers = new Set<BridgeEventHandler>()
  private disposed = false

  constructor(options: MessagePortBridgeTransportOptions) {
    this.port = options.port
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.port.addEventListener('message', this.receiveFrame)
    if (options.autoStart !== false) {
      this.port.start()
    }
  }

  async request<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    request: BrowserBridgeRequest<C, A>,
  ): Promise<BrowserBridgeResponse<C, A>> {
    if (this.disposed) {
      throw new Error('MessagePortBridgeTransport is disposed')
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        reject(
          new Error(
            `[MessagePortBridgeTransport] request '${request.route.capability}.${String(
              request.route.action,
            )}' (id=${request.id}) timed out after ${this.requestTimeoutMs}ms`,
          ),
        )
      }, this.requestTimeoutMs)
      this.pending.set(request.id, {
        resolve: resolve as (response: BrowserBridgeResponse) => void,
        reject,
        timer,
      })
      const envelope: MessagePortBridgeMessage = {
        hostBridge: true,
        direction: 'request',
        id: request.id,
        route: request.route,
        payload: request.payload as Record<string, unknown>,
        ...(request.context ? { context: request.context } : {}),
      }
      try {
        this.port.postMessage(envelope)
      } catch (e) {
        this.pending.delete(request.id)
        if (timer) clearTimeout(timer)
        reject(e)
      }
    })
  }

  subscribeEvents(handler: BridgeEventHandler): BridgeEventUnsubscribe {
    this.eventHandlers.add(handler)
    return () => {
      this.eventHandlers.delete(handler)
    }
  }

  /**
   * Tear down the transport. Pending requests reject with a "disposed"
   * error; the port itself is closed. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.port.removeEventListener('message', this.receiveFrame)
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(
        new Error(
          `[MessagePortBridgeTransport] disposed before response (id=${id})`,
        ),
      )
    }
    this.pending.clear()
    this.eventHandlers.clear()
    try {
      this.port.close()
    } catch {
      /* port already closed */
    }
  }

  private readonly receiveFrame = (rawEvent: Event): void => {
    const event = rawEvent as MessageEvent
    const data = event.data
    if (!isMessagePortBridgeMessage(data)) return

    if (data.direction === 'response') {
      const pending = this.pending.get(data.id)
      if (!pending) return
      this.pending.delete(data.id)
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve(data as BrowserBridgeResponse)
      return
    }

    if (data.direction === 'event') {
      const envelope: BridgeEventEnvelope = {
        route: data.route,
        id: data.id,
        payload: data.payload,
      }
      for (const handler of this.eventHandlers) {
        try {
          handler(envelope)
        } catch (e) {
          // A subscriber error shouldn't break sibling subscribers.
          console.error(
            `[MessagePortBridgeTransport] event handler error: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      return
    }

    // direction === 'request' arriving on this transport means the
    // peer is asking US for something. The base transport doesn't
    // host handlers — that's the worker-side dispatcher's job. We
    // silently ignore; a peer that wants symmetric handling can
    // subclass / attach its own message listener.
  }
}
