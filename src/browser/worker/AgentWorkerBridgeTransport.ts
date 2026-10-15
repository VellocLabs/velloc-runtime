/**
 * Bridge request/response transport for the agent runtime worker: pending requests, event handler
 * registration and response routing.
 */
import type {
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  BrowserBridgeTransport,
  BridgeEventEnvelope,
  BridgeEventHandler,
  BridgeEventUnsubscribe,
} from '../bridge/browserBridgeProtocol'
import type { AgentWorkerOutboundMessage } from './workerProtocol'

/** Reject reason for requests settled by lifecycle teardown.
 *  An AbortError-named DOMException so consumers can distinguish "the scope
 *  died" from a genuine transport failure. */
function makeAbortError(message: string): Error {
  return new DOMException(message, 'AbortError')
}

export class AgentWorkerBridgeTransport {
  private readonly awaitingReplies = new Map<
    string,
    {
      generation: number
      resolve: (response: BrowserBridgeResponse) => void
      reject: (error: Error) => void
    }
  >()
  private readonly eventHandlers = new Set<BridgeEventHandler>()
  /**
   * The ambient generation new requests are attributed to, advanced at each scope install. Fallback
   * only: scope-owned consumers use a `bindGeneration` view.
   */
  private activeGeneration = 0
  /**
   * Generations whose scope has been disposed. A sealed
   * generation rejects NEW requests immediately — without this,
   * cancelGeneration only swept the requests that existed at call time,
   * so a dispose callback awaiting a bridge call the host never answers
   * hung forever BEFORE the end-of-dispose sweep could run (circular),
   * and a stale closure could park a fresh request after the sweep.
   */
  private readonly cancelledGenerations = new Set<number>()
  private disposed = false

  constructor(
    private readonly emit: (message: AgentWorkerOutboundMessage) => void,
  ) {}

  setActiveGeneration(generation: number): void {
    this.activeGeneration = generation
  }

  /**
   * A generation-bound view: every request through it carries the SCOPE's generation, whenever issued.
   */
  bindGeneration(generation: number): BrowserBridgeTransport {
    return {
      request: <
        C extends BrowserBridgeCapability,
        A extends BrowserBridgeAction<C>,
      >(
        request: BrowserBridgeRequest<C, A>,
      ) => this.request(request, generation),
      subscribeEvents: handler => this.subscribeEvents(handler),
    }
  }

  async request<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    request: BrowserBridgeRequest<C, A>,
    generation?: number,
  ): Promise<BrowserBridgeResponse<C, A>> {
    const boundGeneration = generation ?? this.activeGeneration
    // A sealed generation (its scope was disposed) rejects
    // up front — registering would park the promise until some LATER
    // sweep, which for a request issued from inside that scope's own
    // dispose callbacks never comes.
    if (this.disposed || this.cancelledGenerations.has(boundGeneration)) {
      throw makeAbortError('Runtime scope was disposed.')
    }
    // A duplicate id must not silently orphan the first
    // caller's promise (the second registration would overwrite it and the
    // one response would settle only one of them).
    if (this.awaitingReplies.has(request.id)) {
      throw new Error(`Duplicate bridge request id: ${request.id}`)
    }
    // Register BEFORE emit so a same-tick responder (a sync
    // test transport, or a future in-realm host) can never race the
    // registration and strand the promise.
    const promise = new Promise<BrowserBridgeResponse<C, A>>(
      (resolve, reject) => {
        this.awaitingReplies.set(request.id, {
          generation: boundGeneration,
          resolve: resolve as (response: BrowserBridgeResponse) => void,
          reject,
        })
      },
    )
    try {
      this.emit({
        type: 'worker.bridgeRequest',
        payload: request,
      })
    } catch (error) {
      const pending = this.awaitingReplies.get(request.id)
      this.awaitingReplies.delete(request.id)
      pending?.reject(
        error instanceof Error ? error : new Error(String(error)),
      )
    }
    return promise
  }

  subscribeEvents(handler: BridgeEventHandler): BridgeEventUnsubscribe {
    this.eventHandlers.add(handler)
    return () => {
      this.eventHandlers.delete(handler)
    }
  }

  handleEvent(event: BridgeEventEnvelope): void {
    for (const handler of Array.from(this.eventHandlers)) {
      handler(event)
    }
  }

  settleReply(response: BrowserBridgeResponse): void {
    const pending = this.awaitingReplies.get(response.id)
    if (!pending) {
      return
    }

    this.awaitingReplies.delete(response.id)
    pending.resolve(response)
  }

  /**
   * SEAL a disposed generation: its pending requests reject now and later requests tagged with it
   * reject immediately. Called at the START of scope dispose.
   */
  cancelGeneration(generation: number): void {
    this.cancelledGenerations.add(generation)
    for (const [id, pending] of this.awaitingReplies) {
      if (pending.generation !== generation) continue
      this.awaitingReplies.delete(id)
      pending.reject(makeAbortError('Runtime scope was disposed.'))
    }
  }

  getPendingRequestIds(): string[] {
    return Array.from(this.awaitingReplies.keys())
  }

  dispose(): void {
    // Seal everything: a stale closure requesting after
    // worker disposal must reject immediately, not park forever.
    this.disposed = true
    for (const [id, pending] of this.awaitingReplies) {
      this.awaitingReplies.delete(id)
      pending.reject(makeAbortError('Worker was disposed.'))
    }
    this.eventHandlers.clear()
  }
}
