import type {
  AgentWorkerInboundMessage,
  AgentWorkerOutboundMessage,
} from '../worker/workerProtocol'
import type { NexusAgentChangeSection } from '../bridge/protocol/ui'
import { randomUuid } from '../../utils/randomUuid'

/**
 * The stream topic missed events (`createWorkerTransportOverConnection`
 * recovering a gap). Made by the transport, never sent by a worker and never
 * on the wire: the current turn's live events have a hole and are dropped; the
 * transcript refetch that accompanies it brings back what the turn persisted.
 */
export type WorkerStreamGapMessage = { type: 'worker.streamGap' }

/** The session's sub-agent file-change sections, from its diff topic (F-2).
 *  Sent by the runtime's manager, not by the session's worker. */
export type AgentChangesMessage = {
  type: 'worker.agentChanges'
  payload: { agents: NexusAgentChangeSection[] }
}

/** Union delivered to client message listeners. */
export type BrowserWorkerClientInboundMessage =
  | AgentWorkerOutboundMessage
  | WorkerStreamGapMessage
  | AgentChangesMessage

export interface BrowserWorkerClientTransport {
  postMessage(message: AgentWorkerInboundMessage): void | Promise<void>
  addMessageListener(
    listener: (message: BrowserWorkerClientInboundMessage) => void,
  ): () => void
  /**
   * Send a raw envelope directly to the SharedWorker manager — used for
   * manager-level protocol like `toolDetail.subscribe` that isn't scoped
   * to a single session's worker. Optional; transports that don't front a
   * SharedWorker can omit it (the client degrades gracefully).
   */
  postManagerMessage?(data: unknown): void
  /**
   * Subscribe to manager-level broadcasts (`toolDetail.ready`, etc.).
   * The listener receives the raw message data as sent by the manager.
   * Returns an unsubscribe function.
   */
  addManagerListener?(listener: (data: unknown) => void): () => void
  dispose?(): void | Promise<void>
}

type SharedWorkerDispatchEntry = {
  listeners: Set<(message: BrowserWorkerClientInboundMessage) => void>
  /**
   * Number of live transports sharing this entry: two can front one session (strict-mode
   * double mount, async dispose), and a stale dispose must not delete the shared entry.
   */
  refs: number
}

class SharedWorkerPortDispatcher {
  private readonly port: MessagePort
  private readonly sessions = new Map<string, SharedWorkerDispatchEntry>()
  private readonly globalListeners = new Set<(event: MessageEvent) => void>()
  private started = false

  constructor(sharedWorker: SharedWorker) {
    this.port = sharedWorker.port
    this.port.addEventListener('message', this.receiveFrame)
  }

  register(
    sessionId: string,
  ): SharedWorkerDispatchEntry {
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = { listeners: new Set(), refs: 0 }
      this.sessions.set(sessionId, entry)
    }
    entry.refs++
    this.startOnce()
    return entry
  }

  /**
   * Release one transport's hold on the session entry. The entry (and the
   * session's message routing) survives until the LAST holder unregisters.
   * Returns true when this call removed the entry — the caller uses that to
   * decide whether to tell the manager to detach the session from this port.
   */
  unregister(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId)
    if (!entry) return true
    entry.refs--
    if (entry.refs <= 0) {
      this.sessions.delete(sessionId)
      return true
    }
    return false
  }

  addGlobalListener(listener: (event: MessageEvent) => void): () => void {
    this.globalListeners.add(listener)
    this.startOnce()
    return () => {
      this.globalListeners.delete(listener)
    }
  }

  postMessage(data: unknown, transfer?: Transferable[]): void {
    this.startOnce()
    if (transfer) {
      this.port.postMessage(data, transfer)
    } else {
      this.port.postMessage(data)
    }
  }

  private startOnce(): void {
    if (!this.started) {
      this.port.start()
      this.started = true
    }
  }

  private receiveFrame = (event: MessageEvent): void => {
    const data = event.data as Record<string, unknown>
    if (!data || typeof data.type !== 'string') return

    for (const listener of this.globalListeners) {
      listener(event)
    }

    const sessionId = data.sessionId as string
    if (!sessionId) return

    const entry = this.sessions.get(sessionId)
    if (!entry) return

    const { sessionId: _sid, ...stripped } = data
    const message = stripped as unknown as BrowserWorkerClientInboundMessage
    for (const listener of entry.listeners) {
      listener(message)
    }
  }
}

const dispatcherCache = new WeakMap<SharedWorker, SharedWorkerPortDispatcher>()

function getOrCreateDispatcher(
  sharedWorker: SharedWorker,
): SharedWorkerPortDispatcher {
  let dispatcher = dispatcherCache.get(sharedWorker)
  if (!dispatcher) {
    dispatcher = new SharedWorkerPortDispatcher(sharedWorker)
    dispatcherCache.set(sharedWorker, dispatcher)
  }
  return dispatcher
}

export function createSharedWorkerTransport(
  sharedWorker: SharedWorker,
  openingSessionId?: string,
): BrowserWorkerClientTransport {
  let sessionId = openingSessionId ?? ''
  const dispatcher = getOrCreateDispatcher(sharedWorker)
  let entry: SharedWorkerDispatchEntry | null = null
  const pendingListeners = new Set<
    (message: BrowserWorkerClientInboundMessage) => void
  >()

  function flushPendingListeners(): void {
    if (!entry || pendingListeners.size === 0) return
    for (const listener of pendingListeners) {
      entry.listeners.add(listener)
    }
    pendingListeners.clear()
  }

  return {
    postMessage(message: AgentWorkerInboundMessage): void {
      if (message.type === 'worker.init') {
        if (!sessionId) {
          sessionId =
            message.payload.sessionId || randomUuid()
        }
        // Hold at most ONE ref per transport: a re-init on the live
        // transport (forceReinit) or an addMessageListener that already
        // registered must not double-count — dispose releases exactly one.
        if (!entry) {
          entry = dispatcher.register(sessionId)
        }
        flushPendingListeners()
        dispatcher.postMessage({
          ...message,
          sessionId,
          payload: { ...message.payload, sessionId },
        })
        return
      }

      dispatcher.postMessage({ ...message, sessionId })
    },

    addMessageListener(
      listener: (message: BrowserWorkerClientInboundMessage) => void,
    ): () => void {
      if (!entry && sessionId) {
        entry = dispatcher.register(sessionId)
      }
      if (entry) {
        entry.listeners.add(listener)
      } else {
        pendingListeners.add(listener)
      }
      return () => {
        entry?.listeners.delete(listener)
        pendingListeners.delete(listener)
      }
    },

    postManagerMessage(data: unknown): void {
      dispatcher.postMessage(data)
    },

    addManagerListener(listener: (data: unknown) => void): () => void {
      return dispatcher.addGlobalListener(event => {
        listener((event as MessageEvent).data)
      })
    },

    dispose(): void {
      if (sessionId) {
        // Only the LAST local holder detaches the session from the shared
        // port — a strict-mode ghost's late dispose must not tear down the
        // routing (dispatcher entry + manager port attachment) that the
        // surviving client of the SAME session is using.
        const last = dispatcher.unregister(sessionId)
        if (last) {
          dispatcher.postMessage({ type: 'session.detach', sessionId })
        }
      }
      pendingListeners.clear()
      entry = null
    },
  }
}
