import { turnBoard } from '../../sessions/turnBoard'
import type { SessionWorkerInboundMessage } from './sharedWorkerProtocol'
import { DEFAULT_PANEL_ID, type SessionOpenPayload } from '../runtimeHub'
import { wireError } from '../runtimeProtocol'
import { composeSessionInit } from './sessionOpenComposer'
import { modContributionsState } from '../../mods/ui/contributionsState'
import type { SharedWorkerSessionManager } from './SharedWorkerSessionManager'

type Manager = SharedWorkerSessionManager
type SessionEntry = NonNullable<ReturnType<Manager['sessions']['get']>>

/** The manager state and callbacks frame routing reads; owned by the manager. */
export type SessionFrameRouterDeps = {
  panelOfSession: Manager['panelOfSession']
  sessions: Manager['sessions']
  runtimeHub: Manager['runtimeHub']
  taskDelivery: Manager['taskDelivery']
  tracer: Manager['tracer']
  getInitOrchestrator: () => Manager['initOrchestrator']
  getProposals: () => Manager['proposals']
  getChildReports: () => Manager['childReports']
  getFsSummaries: () => Manager['fsSummaries']
  getHostEnvironment: () => Manager['hostEnvironment']
  getLastInitTemplate: () => Manager['lastInitTemplate']
  interruptCascade: Manager['interruptCascade']
}

/**
 * Contract: routes a client's session frames — `session.open` composed into a
 * `worker.init`, `worker.init` to the init orchestrator, any other frame to
 * the session's worker with the cross-session side effects of a person's
 * submit and Stop. Owns no state; every map belongs to the manager.
 */
export class SessionFrameRouter {
  constructor(private readonly deps: SessionFrameRouterDeps) {}

  /**
   * `session.open`: build the session's init payload here — from the published
   * host environment, the desktop's own fields when it sent them, the
   * session's persisted binding and, for a forced-folder type with no folder,
   * the user's last folder of that type (the runtime's workspace index) — then
   * run it through the same init path a `worker.init` takes.
   */
  async openSession(
    port: MessagePort,
    open: SessionOpenPayload,
    panelId?: string,
  ): Promise<void> {
    // Which window's boot overlay this session's runtime build reports to.
    this.deps.panelOfSession.set(open.sessionId, panelId ?? DEFAULT_PANEL_ID)
    const summary = this.deps.getFsSummaries().peek(open.sessionId)
    const composed = composeSessionInit({
      open,
      hostEnvironment: this.deps.getHostEnvironment(),
      lastInitTemplate: this.deps.getLastInitTemplate(),
      persisted: {
        ...(summary?.projectRoot ? { projectRoot: summary.projectRoot } : {}),
        ...(summary?.templateType ? { templateType: summary.templateType } : {}),
      },
      pluginTemplates: modContributionsState().templates,
    })
    if (!composed.payload) {
      throw wireError('host_unavailable', composed.reason)
    }
    const { payload } = composed
    if (composed.needsLastFolderFor) {
      const workspace = await this.deps.runtimeHub.workspace.current().catch(() => null)
      const lastFolder = workspace?.lastFolderByType[composed.needsLastFolderFor]
      if (lastFolder) payload.projectRoot = lastFolder
    }
    this.deps.getInitOrchestrator().handle(port, {
      type: 'worker.init',
      sessionId: open.sessionId,
      payload,
    })
  }

  handleSessionMessage(
    port: MessagePort,
    message: SessionWorkerInboundMessage,
  ): void {
    const { sessionId } = message

    if (message.type === 'worker.init') {
      this.deps.getInitOrchestrator().handle(port, message)
      return
    }

    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      port.postMessage({
        type: 'worker.error',
        payload: {
          code: 'session_not_found',
          message: `Session '${sessionId}' not found`,
        },
      })
      return
    }

    this.deliverSessionFrame(session, message, port)

    // User Stop on a session = "halt everything this session started", not just
    // the parent turn. The interrupt above unblocks any TaskOutput(block) the
    // parent was parked on (its abort path stops that ONE awaited sub-agent);
    // this cascade additionally stops every OTHER background sub-agent the
    // session launched but wasn't blocked on. `stopSubAgent` is idempotent, so a
    // sub-agent the parent was already blocked on is safe to re-stop. (Sync
    // in-context forks aren't worker sessions — they stop via the interrupt's
    // child-abort, not here.)
    if (message.type === 'worker.interrupt') {
      // Suppress background-task re-activation: a task finishing moments after
      // Stop must not inject a `<task-notification>` turn that revives the
      // conversation the user just halted. Drop anything already queued (it
      // would otherwise flush the instant the interrupted turn unwinds) and set
      // the flag to suppress results that finalize during the stopping window.
      // Both clear on the next genuine user submit.
      // Suppression is now owned by TaskDeliveryQueue.
      this.deps.interruptCascade(sessionId)
    }
  }

  /**
   * Hand a frame to the session's worker the way the session's own client
   * does. Every submit through here is the person's input: it runs the
   * per-submit hooks first. A failure is traced, and reported on `port` when
   * there is one. (F-36)
   */
  deliverSessionFrame(
    session: SessionEntry,
    message: SessionWorkerInboundMessage,
    port: MessagePort | null,
  ): void {
    const { sessionId } = message
    // A person's submit re-arms background-task delivery held by a Stop.
    if (message.type === 'worker.submitMessage') {
      this.deps.taskDelivery.resumeParent(sessionId)
      this.deps.getChildReports().personWrote(sessionId, message.payload.prompt)
      // A person's new message closes the session's open offers (F-36).
      this.deps.getProposals().supersedeOpenOffers(sessionId)
      // It also answers the turn's closing; one that starts a turn drops the plan (F-41).
      turnBoard.personWrote(sessionId, !session.worker.isBusy() && !session.worker.isHaltedOnUser())
    }

    // The worker owns the submit queue and the pending message; the manager
    // only adds the cross-session concerns.
    void session.worker.receiveFrame(message).catch(error => {
      if (
        this.deps.sessions.get(sessionId) !== session ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        return
      }
      const messageText =
        error instanceof Error ? error.message : String(error)
      try {
        port?.postMessage({
          type: 'worker.error',
          sessionId,
          payload: {
            code: 'worker_message_failed',
            message: messageText,
          },
        })
      } catch {
        // Port may already be gone.
      }
      this.deps.tracer.event('worker.manager.message.failed', {
        attrs: { sessionId, type: message.type, message: messageText },
      })
    })
  }
}
