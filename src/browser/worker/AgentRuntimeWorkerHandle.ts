import type { HookNotification } from '../../lifecycleHooks/sessionLifecycleHooks'
import type {
  AgentRuntimeInitResult,
  AgentRuntimeWorkerInitPayload,
  AgentRuntimeWorkerSnapshot,
  AgentWorkerInboundMessage,
} from './workerProtocol'
import type {
  AgentSessionPhase,
  AgentSessionToolInfo,
  AgentToolKind,
} from './AgentTurnState'
import type { AgentToolEndTransition } from './AgentTurnController'
import type { OwnerRuntimeGlobals } from './taskTypes'
import type { Message } from '../../runtime/RuntimeTypes'

/**
 * Manager-facing runtime worker contract. Kept separate from both concrete
 * worker and manager so orchestration modules depend on one narrow seam.
 */
export interface AgentRuntimeWorkerHandle {
  receiveFrame(message: AgentWorkerInboundMessage): Promise<void>
  reinitialize(
    payload: AgentRuntimeWorkerInitPayload,
  ): Promise<AgentRuntimeInitResult>
  getSnapshot(): AgentRuntimeWorkerSnapshot
  applyDiagnosticGates?(payload: AgentRuntimeWorkerInitPayload): void
  fireSessionDeletedStop?(): Promise<void>
  /** The session's `Notification` hooks, for a notification about it. */
  fireNotificationHooks?(notification: HookNotification): Promise<void>
  enqueueSubmit(message: AgentWorkerInboundMessage, priority: number): void
  consumePendingAsNextSubmit(): void
  pumpSubmits(): void
  isBusy(): boolean
  isStopping(): boolean
  getPhase(): AgentSessionPhase
  markStreamStart(): void
  markStreamEnd(): void
  markStreamEndWithBoundary?(): boolean
  markToolStart(name: string, kind: AgentToolKind, actionType?: string): void
  markToolEnd(): AgentSessionToolInfo | undefined
  markToolEndWithBoundary?(): AgentToolEndTransition
  submitAndWait?(
    message: Extract<
      AgentWorkerInboundMessage,
      { type: 'worker.submitMessage' }
    >,
    source: 'user' | 'mailbox' | 'task_delivery',
  ): Promise<
    | { status: 'completed' }
    | { status: 'aborted'; reason: string }
    | { status: 'failed'; code: string; message: string }
  >
  dispose?(): Promise<void>
  getRuntimeGlobals?(): OwnerRuntimeGlobals | undefined
  /** The last assistant text in this session's transcript, or '' when
   *  there is none. The teammate turn-end report reads it: a locked-down
   *  child has no SendMessage, so this is its only upward channel. */
  getFinalAssistantText?(): string
  /** The uuid of the message `getFinalAssistantText` reads, or undefined
   *  when there is none (or it carries no uuid). The turn-end report keys
   *  its dedup on this, so a new turn with the same words still reports. */
  getFinalAssistantMessageUuid?(): string | undefined
  /**
   * UI-ready split: the provisional boot feed (snapshot + sanitized
   * transcript) while the runtime build is still in flight, so a port that
   * attaches mid-build can be replayed the `worker.uiReady` +
   * `worker.messages` pair it missed. Null before the transcript read and
   * once the runtime is installed.
   */
  getProvisionalBootFeed?(): {
    snapshot: AgentRuntimeWorkerSnapshot
    messages: Message[]
  } | null
}
