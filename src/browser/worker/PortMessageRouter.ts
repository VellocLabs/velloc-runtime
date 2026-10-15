import type {
  SharedWorkerInboundMessage,
  SessionWorkerInboundMessage,
  SessionCard,
} from './sharedWorkerProtocol'
import { isSafeSessionId, isSessionMessage } from './sharedWorkerProtocol'
import { traceLine } from '../../utils/debugLog'
import { setKernelControlPort } from '../workerKernel/IsolatedWorkerKernel'

/**
 * The Manager-side capabilities the router dispatches into.
 * Each member is a named Manager behavior; the router owns only WHICH
 * branch runs for a given inbound message type (and the trivial reply
 * envelopes it builds inline). Session-map, task-registry, and
 * diagnostics state all stay with their owners behind these calls.
 */
export interface PortMessageRouterHost {
  // Per-session envelope (worker.init / worker.submitMessage / …).
  handleSessionMessage(port: MessagePort, message: SessionWorkerInboundMessage): void
  // Bridge plumbing.
  setHostBridgePort(port: MessagePort): void
  // `port.disconnect`: the page is unloading — release everything this port
  // holds (hub subscriptions, session attachments, diagnostics).
  handlePortDisconnect(port: MessagePort): void
  // UI ⇄ Runtime protocol: one ClientConnection per transferred port
  // (`RuntimeHub.attachPort`). Sits beside the legacy WebUI attach.
  attachRuntimePort(port: MessagePort, homeDir: string, panelId: string | undefined): void
  // Session registry queries + lifecycle.
  buildSessionInfoList(): SessionCard[]
  detachSessionPort(sessionId: string, port: MessagePort): void
  deleteSession(port: MessagePort, sessionId: string, requestId: string | undefined): void
  retitleSession(
    port: MessagePort,
    sessionId: string,
    title: string,
    requestId: string | undefined,
  ): void
  pinSession(
    port: MessagePort,
    sessionId: string,
    pinned: boolean,
    requestId: string | undefined,
  ): void
  forkSession(
    port: MessagePort,
    fromSessionId: string,
    cutUuid: string | undefined,
    requestId: string | undefined,
    moveCutMessageToDraft?: boolean,
    title?: string,
  ): void
  // Background Tasks drawer control surface.
  handleTaskStop(
    port: MessagePort,
    message: Extract<SharedWorkerInboundMessage, { type: 'task.stop' }>,
  ): void
  handleTaskResume(
    port: MessagePort,
    message: Extract<SharedWorkerInboundMessage, { type: 'task.resume' }>,
  ): void
  handleTaskTranscript(
    port: MessagePort,
    message: Extract<SharedWorkerInboundMessage, { type: 'task.transcript' }>,
  ): void
  handleSessionTranscript(
    port: MessagePort,
    message: Extract<SharedWorkerInboundMessage, { type: 'session.transcript' }>,
  ): void
  handleRecoverBackground(
    message: Extract<
      SharedWorkerInboundMessage,
      { type: 'task.recoverBackground' }
    >,
  ): void
  // Subscription lifecycles.
  handleSubscribe(port: MessagePort, all: boolean, sessionIds: string[] | undefined): void
  handleUnsubscribe(port: MessagePort, all: boolean, sessionIds: string[] | undefined): void
  handleToolDetailSubscribe(
    port: MessagePort,
    toolCallIds: string[],
    sessionIdHint: string | undefined,
  ): void
  handleToolDetailUnsubscribe(port: MessagePort, toolCallIds: string[]): void
  // Diagnostics (trace overlay) lifecycle.
  handleTraceFlush(port: MessagePort, requestId: string | undefined): void
  handleTraceSubscribe(port: MessagePort, traceId: string | undefined): void
  handleTraceUnsubscribe(port: MessagePort): void
}

/**
 * Inbound port-message dispatch for the SharedWorker: the single owner of which handler runs for each
 * client message. Stateless. Wire message type strings are compatibility boundaries; do not rename.
 */
export class PortMessageRouter {
  constructor(private readonly host: PortMessageRouterHost) {}

  handle(port: MessagePort, event: MessageEvent): void {
    // Runtime schema guard: `event.data` is
    // attacker/version-skew-shaped input, not a trusted union member. A
    // null/primitive payload would throw inside `isSessionMessage`'s
    // `'sessionId' in msg` before any branch ran.
    const data = event.data as unknown
    if (
      !data ||
      typeof data !== 'object' ||
      typeof (data as { type?: unknown }).type !== 'string'
    ) {
      return
    }
    const message = data as SharedWorkerInboundMessage

    // Field-shape guard: session ids become storage paths, and the array /
    // string fields are iterated or `.trim()`ed by the handlers, so every
    // identifier a page can post is checked here — BEFORE any branch runs.
    const rejection = validateInboundShape(message)
    if (rejection) {
      this.reject(port, message, rejection)
      return
    }

    if (isSessionMessage(message)) {
      this.host.handleSessionMessage(port, message)
      return
    }

    switch (message.type) {
      case 'bridge.setPort': {
        const bridgePort = event.ports?.[0]
        if (bridgePort) {
          this.host.setHostBridgePort(bridgePort)
        }
        return
      }

      case 'port.disconnect': {
        this.host.handlePortDisconnect(port)
        return
      }

      case 'bridge.attachRuntimePort': {
        const runtimePort = event.ports?.[0]
        if (runtimePort) {
          this.host.attachRuntimePort(runtimePort, message.homeDir, message.panelId)
        }
        return
      }

      case 'workerHost.attachControlPort': {
        // The guest window's end of the isolated-worker kernel's control
        // channel. Every window's boot sends one; the kernel keeps them as a
        // pool (a provider mod's worker must come back through whichever
        // window is still open) and drops one whose window leaves. It is
        // realm-global infra — not a scope-bound slot, so no per-runtime
        // ownership.
        const controlPort = event.ports?.[0]
        if (controlPort) {
          setKernelControlPort(controlPort)
        }
        return
      }

      case 'session.list': {
        // One-shot request: reply only to the requester. Does not create
        // a subscription — callers that want live diffs must explicitly
        // call session.subscribe.
        port.postMessage({
          type: 'session.list',
          payload: { sessions: this.host.buildSessionInfoList() },
        })
        return
      }

      case 'session.detach': {
        this.host.detachSessionPort(message.sessionId, port)
        return
      }

      case 'session.delete': {
        this.host.deleteSession(port, message.sessionId, message.requestId)
        return
      }

      case 'session.rename': {
        this.host.retitleSession(
          port,
          message.sessionId,
          message.title,
          message.requestId,
        )
        return
      }

      case 'session.pin': {
        this.host.pinSession(
          port,
          message.sessionId,
          message.pinned,
          message.requestId,
        )
        return
      }

      case 'session.fork': {
        this.host.forkSession(
          port,
          message.fromSessionId,
          message.cutUuid,
          message.requestId,
          message.moveCutMessageToDraft,
          message.title,
        )
        return
      }

      // Human-initiated background sub-agent control (the Background Tasks
      // drawer). Routes to the SAME manager methods the TaskStop / AgentResume
      // model tools use; both already `scheduleSummary()` internally so the
      // next `session.summary` flush flips the row. The host handlers ack so
      // the drawer can clear pending state / toast on a no-op.
      case 'task.stop': {
        this.host.handleTaskStop(port, message)
        return
      }

      case 'task.resume': {
        this.host.handleTaskResume(port, message)
        return
      }

      case 'task.transcript': {
        this.host.handleTaskTranscript(port, message)
        return
      }

      case 'session.transcript': {
        this.host.handleSessionTranscript(port, message)
        return
      }

      case 'task.recoverBackground': {
        this.host.handleRecoverBackground(message)
        return
      }

      case 'session.subscribe': {
        this.host.handleSubscribe(port, message.all ?? false, message.sessionIds)
        return
      }

      case 'session.unsubscribe': {
        this.host.handleUnsubscribe(port, message.all ?? false, message.sessionIds)
        return
      }

      case 'toolDetail.subscribe': {
        this.host.handleToolDetailSubscribe(
          port,
          message.toolCallIds,
          message.sessionId,
        )
        return
      }

      case 'toolDetail.unsubscribe': {
        this.host.handleToolDetailUnsubscribe(port, message.toolCallIds)
        return
      }

      case 'trace.flush': {
        this.host.handleTraceFlush(port, message.requestId)
        return
      }

      case 'trace.subscribe': {
        this.host.handleTraceSubscribe(port, message.traceId)
        return
      }

      case 'trace.unsubscribe': {
        this.host.handleTraceUnsubscribe(port)
        return
      }

      default: {
        // Unknown-type diagnostic: a silently-ignored
        // message usually means a NEW protocol type was never wired into
        // this router — surface it instead of losing it.
        traceLine(
          `[PortMessageRouter] unhandled message type: ${(message as { type: string }).type}`,
          { level: 'info' },
        )
        return
      }
    }
  }

  /**
   * Answer a malformed message with the worker's existing error envelope
   * (the shape `session_not_found` / `session_shutdown` already use), so the
   * requester's pending promise settles instead of hanging. The offending id
   * is echoed only when it is a string — it is the correlation key the
   * client keyed its request on.
   */
  private reject(
    port: MessagePort,
    message: SharedWorkerInboundMessage,
    rejection: { code: string; message: string },
  ): void {
    const sessionId = (message as { sessionId?: unknown }).sessionId
    const requestId = (message as { requestId?: unknown }).requestId
    try {
      port.postMessage({
        type: 'worker.error',
        ...(typeof sessionId === 'string' ? { sessionId } : {}),
        ...(typeof requestId === 'string' ? { requestId } : {}),
        payload: rejection,
      })
    } catch {
      // Port may already be gone.
    }
    traceLine(
      `[PortMessageRouter] rejected ${message.type}: ${rejection.message}`,
      { level: 'warn' },
    )
  }
}

const INVALID_SESSION_ID = 'invalid_session_id'
const INVALID_MESSAGE = 'invalid_message'

function badId(field: string): { code: string; message: string } {
  return {
    code: INVALID_SESSION_ID,
    message: `'${field}' is not a valid session id`,
  }
}

function badField(
  field: string,
  expected: string,
): { code: string; message: string } {
  return {
    code: INVALID_MESSAGE,
    message: `'${field}' must be ${expected}`,
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string')
}

/**
 * The per-type field checks. Every message that names a session must name
 * a SAFE one (`isSafeSessionId`); optional ids are checked when present;
 * list fields must be arrays of strings; `session.rename`'s `title` must be
 * a string. Returns the rejection to send, or null when the message is
 * well-formed. Types with no checked fields fall through as valid — the
 * handlers own their remaining semantics.
 */
function validateInboundShape(
  message: SharedWorkerInboundMessage,
): { code: string; message: string } | null {
  const m = message as Record<string, unknown> & { type: string }

  // `worker.*` envelope — plus the two ids a `worker.init` payload can
  // carry into storage routing (its own, and the lead it nests under).
  if (m.type.startsWith('worker.')) {
    if ('sessionId' in m && !isSafeSessionId(m.sessionId)) return badId('sessionId')
    if (m.type === 'worker.init') {
      const payload = m.payload
      if (payload && typeof payload === 'object') {
        const p = payload as { sessionId?: unknown; spawnerSessionId?: unknown }
        if (p.sessionId !== undefined && !isSafeSessionId(p.sessionId)) {
          return badId('payload.sessionId')
        }
        if (
          p.spawnerSessionId !== undefined &&
          !isSafeSessionId(p.spawnerSessionId)
        ) {
          return badId('payload.spawnerSessionId')
        }
      }
    }
    return null
  }

  switch (m.type) {
    case 'session.transcript':
    case 'session.detach':
    case 'session.delete':
    case 'task.stop':
    case 'task.resume':
    case 'task.transcript':
    case 'task.recoverBackground':
      return isSafeSessionId(m.sessionId) ? null : badId('sessionId')

    case 'session.rename':
      if (!isSafeSessionId(m.sessionId)) return badId('sessionId')
      if (typeof m.title !== 'string') return badField('title', 'a string')
      return null

    case 'session.pin':
      if (!isSafeSessionId(m.sessionId)) return badId('sessionId')
      if (typeof m.pinned !== 'boolean') return badField('pinned', 'a boolean')
      return null

    case 'session.fork':
      if (!isSafeSessionId(m.fromSessionId)) return badId('fromSessionId')
      if (m.cutUuid !== undefined && typeof m.cutUuid !== 'string') {
        return badField('cutUuid', 'a string')
      }
      return null

    case 'session.subscribe':
    case 'session.unsubscribe':
      if (m.sessionIds !== undefined) {
        if (!isStringArray(m.sessionIds)) {
          return badField('sessionIds', 'an array of strings')
        }
        if (!m.sessionIds.every(isSafeSessionId)) return badId('sessionIds[]')
      }
      return null

    case 'toolDetail.subscribe':
      if (!isStringArray(m.toolCallIds)) {
        return badField('toolCallIds', 'an array of strings')
      }
      if (m.sessionId !== undefined && !isSafeSessionId(m.sessionId)) {
        return badId('sessionId')
      }
      return null

    case 'toolDetail.unsubscribe':
      return isStringArray(m.toolCallIds)
        ? null
        : badField('toolCallIds', 'an array of strings')

    default:
      return null
  }
}
