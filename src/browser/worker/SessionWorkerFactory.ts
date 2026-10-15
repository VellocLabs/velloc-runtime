import type {
  AgentRuntimeWorkerOptions,
} from './AgentRuntimeWorker'
import type { AgentWorkerOutboundMessage } from './workerProtocol'
import type { BrowserConversationStorageBackend } from '../../sessions/sessionStore'
import type { AgentRuntimeWorkerHandle } from './AgentRuntimeWorkerHandle'

/** Manager-side seam: the emit sink workers report into, and the host
 *  callback object every worker receives (the Manager itself — tool hooks
 *  and cross-session concerns reach it through this). */
export interface SessionWorkerFactoryHost {
  /** Route one worker outbound event, tagged with its instance token. */
  onEmit(
    sessionId: string,
    instanceId: string,
    message: AgentWorkerOutboundMessage,
  ): void
  /** The value passed as `AgentRuntimeWorkerOptions.host`. */
  getWorkerHost(): AgentRuntimeWorkerOptions['host']
}

/**
 * The single worker-allocation recipe: a fresh instance token per worker (events with a stale token are
 * dropped), the emit closure that tags them, and the routed storage backend. Does not own the sessions map.
 */
export class SessionWorkerFactory {
  constructor(
    private readonly createWorkerFn: (
      options: AgentRuntimeWorkerOptions,
    ) => AgentRuntimeWorkerHandle,
    private readonly host: SessionWorkerFactoryHost,
  ) {}

  create(
    sessionId: string,
    backend?: BrowserConversationStorageBackend | null,
  ): { worker: AgentRuntimeWorkerHandle; instanceId: string } {
    const instanceId = crypto.randomUUID()
    const worker = this.createWorkerFn({
      emit: (outMessage: AgentWorkerOutboundMessage) => {
        this.host.onEmit(sessionId, instanceId, outMessage)
      },
      host: this.host.getWorkerHost(),
      ...(backend ? { conversationStorageBackend: backend } : {}),
    })
    return { worker, instanceId }
  }
}
