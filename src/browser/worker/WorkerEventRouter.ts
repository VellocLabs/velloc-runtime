/**
 * WorkerEventRouter — the dispatch ORDER for per-session worker outbound events: instance guard →
 * globals capture → needsAnswer → headless and sub-agent interception → bridge routing → read-model
 * updates → tool-detail recording → metadata merge → port broadcast. Stateless. Interception runs
 * before the general routes so those events never reach UI ports.
 */
import type {
  AgentRuntimeWorkerSnapshot,
  AgentWorkerOutboundMessage,
} from './workerProtocol'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import type { SessionSummaryRepository } from './SessionSummaryRepository'

/** The Manager-implemented branch bodies the router dispatches to. */
export type WorkerEventRouterHost = {
  /** Instance guard: false ⇒ the event came from a stale (disposed
   *  and replaced) worker instance and must be dropped entirely. */
  isCurrentInstance(sessionId: string, instanceId: string): boolean
  /** Capture the session's process-global runtime singletons on
   *  `worker.ready` (sub-agent `ownerGlobals` restore source). */
  captureRuntimeGlobalsOnReady(sessionId: string): void
  /** Track the halted-on-ask flag from a full-snapshot emission; a flip
   *  re-broadcasts the summary. */
  trackNeedsAnswerFromSnapshot(
    sessionId: string,
    snapshot: AgentRuntimeWorkerSnapshot,
  ): void
  /** Refresh the session's status feed off a full-snapshot emission: the
   *  Worker's phase can move without a Manager mark* call — the
   *  retry countdown ticks `worker.state` once a second — and the feed's
   *  delta dedup makes a no-change refresh free. */
  refreshSessionStatus(sessionId: string): void
  /** Headless-run interception. Returns true when the event was consumed
   *  (headless sessions have no subscriber ports; the interceptor still
   *  routes bridge requests so model / fs.* requests reach the host). */
  interceptHeadlessEmit(
    sessionId: string,
    message: AgentWorkerOutboundMessage,
  ): boolean
  /** Background sub-agent interception — same consuming contract as the
   *  headless stage. */
  interceptSubAgentEmit(
    sessionId: string,
    message: AgentWorkerOutboundMessage,
  ): boolean
  /** Route a worker bridge request onto the runtime's host port. */
  routeBridgeRequest(sessionId: string, payload: unknown): void
  /** Record a proactively persisted tool-call detail and wake waiters. */
  recordPersistedToolDetail(
    toolCallId: string,
    detail: BrowserToolCallDetailRecord,
  ): void
  /** The general fan-out: tag the event with its sessionId and post to
   *  every subscribed port of that session. */
  broadcastToSessionPorts(
    sessionId: string,
    message: AgentWorkerOutboundMessage,
  ): void
}

export class WorkerEventRouter {
  constructor(
    private readonly summaryRepo: SessionSummaryRepository,
    private readonly host: WorkerEventRouterHost,
  ) {}

  handle(
    sessionId: string,
    instanceId: string,
    message: AgentWorkerOutboundMessage,
  ): void {
    // Instance guard first — nothing below may see a stale instance's event.
    if (!this.host.isCurrentInstance(sessionId, instanceId)) return

    // Globals capture on ready. Falls through to the normal routes
    // afterwards (the ready snapshot still reaches subscribers).
    if (message.type === 'worker.ready') {
      this.host.captureRuntimeGlobalsOnReady(sessionId)
    }

    // Track the halted-on-ask flag from the worker's own snapshot emissions.
    // ONLY these two types carry the full snapshot as their payload (other
    // outbound payloads have different shapes, and `snapshotNeedsAnswer` on
    // one of those would wrongly read "no asks" and clear the flag).
    if (message.type === 'worker.state' || message.type === 'worker.ready') {
      this.host.trackNeedsAnswerFromSnapshot(
        sessionId,
        message.payload as AgentRuntimeWorkerSnapshot,
      )
      // Worker-driven phase moves (retry countdown ticks, retry→streaming
      // resume) reach the topbar through here — the Manager's mark* write
      // points never fire for them.
      this.host.refreshSessionStatus(sessionId)
    }

    // Turn end refreshes the feed too. `worker.completed` is the client's
    // authoritative "this turn is over" event (it forces the session port's
    // snapshot to isBusy:false), and the feed must not read busy while the
    // composer reads idle. On the normal path the phase already went idle via
    // QueryEngine's `finally → markStreamEnd`, which emits — this is the
    // backstop for every path where that emit did not land. Cheap: emitStatus
    // dedupes a no-op delta.
    if (message.type === 'worker.completed') {
      // The payload IS a full snapshot (AgentRuntimeWorkerSnapshot & {reason}),
      // so reconcile the cached needsAnswer bit here too — otherwise a halt
      // cleared mid-turn (an answered AskUserQuestion) leaves the sidebar dot
      // lit until the next permission-mode change or a window reload.
      this.host.trackNeedsAnswerFromSnapshot(
        sessionId,
        message.payload as AgentRuntimeWorkerSnapshot,
      )
      this.host.refreshSessionStatus(sessionId)
    }

    // Retry countdowns: retry phase is owned by the Worker's
    // AgentTurnController. The Worker detects `api_error` events in its
    // stream loop and drives beginRetry/endRetry itself; the Manager no
    // longer starts or clears retry countdowns here.

    // Headless-run interception — consumes the event when the session is
    // an in-flight headless routine run.
    if (this.host.interceptHeadlessEmit(sessionId, message)) return

    // Background sub-agent interception (worker-hosted Agent tool) —
    // consumes the event when the session is a live sub-agent run.
    if (this.host.interceptSubAgentEmit(sessionId, message)) return

    if (message.type === 'worker.bridgeRequest') {
      this.host.routeBridgeRequest(sessionId, message.payload)
      return
    }

    // The `worker.showMainContents` → `nexus.ui.showMainContents` fan-out
    // is gone: the panel's main-contents-view now tracks the guest's
    // per-session webview_area geometry (`ui.broadcastEvent
    // { action: 'mainContentsLayout' }`, handled in handlePortMessage),
    // which itself follows the session's real tab state.

    if (message.type === 'worker.messages') {
      const payload = message.payload as {
        messages?: unknown[]
        sinceOrdinal?: number
      }
      if (Array.isArray(payload?.messages)) {
        // `worker.getMessagesSince` replies ride this same event type, tagged
        // with their `sinceOrdinal`. A delta array starts at an
        // arbitrary ordinal, so its first user message is whatever the user
        // asked LAST — not the session title. Tell the repo which shape this
        // is so the delta path can't rewrite the title.
        const mode =
          typeof payload.sinceOrdinal === 'number' && payload.sinceOrdinal > 0
            ? ('delta' as const)
            : ('full' as const)
        this.summaryRepo.updateSessionMeta(sessionId, payload.messages, mode)
        // Refresh the fs summary so the next list broadcast includes the appended messages.
        void this.summaryRepo.refreshFsSummary(sessionId)
      }
    }

    if (message.type === 'worker.toolDetailPersisted') {
      const { toolCallId, detail } = message.payload
      this.host.recordPersistedToolDetail(toolCallId, detail)
      // Don't forward this event to session ports — it's manager-internal
      // bookkeeping. Subscribers learn via `toolDetail.ready`.
      return
    }

    if (message.type === 'worker.metadataUpdated') {
      const { metadata } = message.payload
      this.summaryRepo.applyMetadataUpdate(sessionId, metadata)
      // Do not forward to per-session ports — UI already updated its
      // local cache optimistically when it sent the request, and the
      // `session.updated` broadcast is the authoritative echo.
      return
    }

    this.host.broadcastToSessionPorts(sessionId, message)
  }
}
