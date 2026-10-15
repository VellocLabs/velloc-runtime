import { DirectPortBridgeTransport } from '../bridge/DirectPortBridgeTransport'
import type {
  BridgeEventEnvelope,
  BrowserBridgeRequest,
  BrowserBridgeResponse,
} from '../bridge/browserBridgeProtocol'
import type {
  AgentWorkerInboundMessage,
} from './workerProtocol'
import { NEXUS_DIRECT_BRIDGE_CAPABILITIES } from '../bridge/directBridgeCapabilities'

type BridgeRequestWorker = {
  receiveFrame(message: AgentWorkerInboundMessage): Promise<void>
}

/**
 * Host events that arrive at any time (file watch, WebSocket, alarm): delivered to EVERY session (each
 * wrapper keeps only its own ids) and skipped by the per-session forwarders.
 */
export const BROADCAST_HOST_EVENT_ROUTES: ReadonlySet<string> = new Set([
  'fs.onChange',
  'network.onWsMessage',
  'network.onWsClose',
  'alarms.onAlarm',
])

export function isBroadcastHostEvent(event: BridgeEventEnvelope): boolean {
  return BROADCAST_HOST_EVENT_ROUTES.has(
    `${event.route.capability}.${String(event.route.action)}`,
  )
}

export interface BridgeRequestRouterHost {
  getSessionWorker(sessionId: string): BridgeRequestWorker | undefined
  /** Every live session, for the broadcast host events. */
  listSessionIds(): Iterable<string>
  onDirectTransportChanged(
    transport: DirectPortBridgeTransport | null,
  ): void
}

type SessionEventForwarder = {
  transport: DirectPortBridgeTransport
  inFlightRequests: number
  unsubscribe?: () => void
}

/**
 * Security: owns the runtime's host port and routes its sessions' host calls onto it; no call is
 * handed to a client to execute. A call the port does not serve fails at once. One event subscription
 * per session is shared by its concurrent requests.
 */
export class BridgeRequestRouter {
  private directTransport: DirectPortBridgeTransport | null = null
  private readonly sessionEventForwarders = new Map<
    string,
    SessionEventForwarder
  >()

  constructor(private readonly host: BridgeRequestRouterHost) {}

  getDirectTransport(): DirectPortBridgeTransport | null {
    return this.directTransport
  }

  private forwardResponse(requestSessionId: string, payload: unknown): void {
    this.sendToWorker(requestSessionId, {
      type: 'worker.bridgeResponse',
      payload,
    } as AgentWorkerInboundMessage)
  }

  routeRequest(sessionId: string, payload: unknown): void {
    const request = payload as BrowserBridgeRequest
    const directTransport = this.directTransport
    if (
      directTransport &&
      NEXUS_DIRECT_BRIDGE_CAPABILITIES.has(request.route.capability)
    ) {
      this.routeDirectRequest(sessionId, request, directTransport)
      return
    }

    // Never leave the worker-side bridge promise parked when no route exists.
    this.forwardResponse(sessionId, {
      id: request.id,
      route: request.route,
      ok: false,
      error: {
        code: 'bridge_transport_error',
        message: directTransport
          ? `The host bridge port does not serve '${request.route.capability}'.`
          : 'No host bridge port is attached.',
      },
    } as BrowserBridgeResponse)
  }

  /** `bridge.setPort`: the host's port for the runtime. A later one replaces it. */
  setHostPort(port: MessagePort): void {
    this.disposeSessionEventForwarders()
    this.directTransport?.dispose()
    const transport = new DirectPortBridgeTransport({ port })
    this.directTransport = transport
    transport.subscribeEvents(event => {
      // (`shell.onExit` is no longer consumed: the background-shell registry
      // moved into the worker and polls its persistent children.)
      if (isBroadcastHostEvent(event)) {
        for (const sessionId of Array.from(this.host.listSessionIds())) {
          this.sendToWorker(sessionId, {
            type: 'worker.bridgeEvent',
            payload: event,
          })
        }
      }
    })
    this.host.onDirectTransportChanged(transport)
  }

  private routeDirectRequest(
    sessionId: string,
    request: BrowserBridgeRequest,
    transport: DirectPortBridgeTransport,
  ): void {
    this.acquireSessionEventForwarder(sessionId, transport)
    void transport
      .request(request)
      .then(response => {
        this.forwardResponse(sessionId, response)
      })
      .catch(error => {
        this.forwardResponse(sessionId, {
          id: request.id,
          route: request.route,
          ok: false,
          error: {
            code: 'bridge_transport_error',
            message:
              error instanceof Error
                ? error.message
                : 'Unknown direct bridge error',
          },
        } as BrowserBridgeResponse)
      })
      .finally(() => {
        this.releaseSessionEventForwarder(sessionId, transport)
      })
  }

  private acquireSessionEventForwarder(
    sessionId: string,
    transport: DirectPortBridgeTransport,
  ): void {
    const existing = this.sessionEventForwarders.get(sessionId)
    if (existing?.transport === transport) {
      existing.inFlightRequests += 1
      return
    }
    existing?.unsubscribe?.()
    const forwarder: SessionEventForwarder = {
      transport,
      inFlightRequests: 1,
    }
    forwarder.unsubscribe = transport.subscribeEvents?.(event => {
      // Already delivered to every session by the port-wide subscription.
      if (isBroadcastHostEvent(event)) {
        return
      }
      this.sendToWorker(sessionId, {
        type: 'worker.bridgeEvent',
        payload: event,
      })
    })
    this.sessionEventForwarders.set(sessionId, forwarder)
  }

  private releaseSessionEventForwarder(
    sessionId: string,
    transport: DirectPortBridgeTransport,
  ): void {
    const forwarder = this.sessionEventForwarders.get(sessionId)
    if (!forwarder || forwarder.transport !== transport) {
      return
    }
    forwarder.inFlightRequests -= 1
    if (forwarder.inFlightRequests > 0) {
      return
    }
    forwarder.unsubscribe?.()
    this.sessionEventForwarders.delete(sessionId)
  }

  private disposeSessionEventForwarders(): void {
    for (const forwarder of this.sessionEventForwarders.values()) {
      forwarder.unsubscribe?.()
    }
    this.sessionEventForwarders.clear()
  }

  private sendToWorker(
    sessionId: string,
    message: AgentWorkerInboundMessage,
  ): void {
    const worker = this.host.getSessionWorker(sessionId)
    if (worker) {
      void worker.receiveFrame(message)
    }
  }
}
