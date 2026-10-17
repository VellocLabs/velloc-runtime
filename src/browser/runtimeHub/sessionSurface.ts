/**
 * The session surface of the protocol (P-3). The hub owns ONE virtual `MessagePort` handed to
 * `PortMessageRouter`; requests become router messages, manager posts are classified onto topics and
 * published once. Wire shape: `evt.type` is the message `type`; `evt.payload` the message without
 * `type` (and `sessionId`).
 */
import type {
  AgentRuntimeWorkerInitPayload,
  AgentRuntimeWorkerSnapshot,
  AgentWorkerInboundMessage,
} from '../worker/workerProtocol'
import type { SessionCard } from '../worker/sharedWorkerProtocol'
import {
  parseTopic,
  topic,
  wireError,
  type EvtForm,
  type Scope,
  type ScopeMode,
  type TopicId,
} from '../runtimeProtocol'
import { currentTemplateChannel } from '../../branding/updateChannels'
import { buildEntryUrl } from './buildEntry'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import { knownProjectRootOrRefuse } from './knownProjects'
import {
  computeRestartReadiness,
  UNREADABLE_WORK_INPUTS,
  type RestartWorkInputs,
} from './restartReadiness'
import type { TopicBroker } from './TopicBroker'
import { modRosterAttach, modRosterDetach } from '../../mods/modSlotRegistry'
import type { ActionSpec, ConnectionInfo, HandlerRequest, TopicProvider } from './types'

// ---- opening a session -------------------------------------------------------------

/**
 * Security: `session.open` — the runtime builds the init payload. Anyone may name the template and
 * model; only `full` may override init fields; a new `projectRoot` is `full`, below `full` it must be
 * a known project, bound in the runtime's spelling (also for `session.updateSessionMetadata`).
 */
export type SessionOpenPayload = {
  sessionId: string
  templateType?: string
  selection?: { providerId: string; modelId: string; thinkingTier?: string }
  /** The id came from a client's persisted pointer and may name a deleted session. */
  restored?: boolean
  /** Re-run init on the live runtime (the folder re-bind; idle and empty sessions only). */
  reinit?: boolean
  /** Bind this host folder: any folder at `full`, a known project below it. */
  projectRoot?: string
  /** `full` only: init fields the desktop supplies itself. Per-session keys are ignored here. */
  init?: Partial<AgentRuntimeWorkerInitPayload>
}

export const SESSION_OPEN_FULL_FIELDS = ['init'] as const

/** The host half of an init payload: everything but the per-session keys. */
export type HostEnvironment = Omit<
  AgentRuntimeWorkerInitPayload,
  'sessionId' | 'projectRoot' | 'restoredSessionId' | 'forceReinit' | 'traceId'
>

const PER_SESSION_INIT_KEYS = ['sessionId', 'projectRoot', 'restoredSessionId', 'forceReinit', 'traceId'] as const

/** The host half of an init payload: the payload minus its per-session keys. */
export function hostEnvironmentOf(payload: Partial<AgentRuntimeWorkerInitPayload>): HostEnvironment {
  const env: Record<string, unknown> = { ...payload }
  for (const key of PER_SESSION_INIT_KEYS) delete env[key]
  return env as HostEnvironment
}

function isSessionOpenPayload(value: unknown): value is SessionOpenPayload {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  if (typeof p.sessionId !== 'string' || p.sessionId === '') return false
  if (p.templateType !== undefined && typeof p.templateType !== 'string') return false
  if (p.projectRoot !== undefined && typeof p.projectRoot !== 'string') return false
  if (p.init !== undefined && (!p.init || typeof p.init !== 'object')) return false
  if (p.selection !== undefined) {
    const sel = p.selection as Record<string, unknown> | null
    if (!sel || typeof sel.providerId !== 'string' || typeof sel.modelId !== 'string') return false
  }
  return true
}

// ---- what the manager provides ----------------------------------------------------

export type SessionSurfaceHost = {
  /** `PortMessageRouter.handle(port, {data})` — the manager's single inbound entry. */
  dispatch(port: MessagePort, data: unknown): void
  /** Add the port to a live session's fan-out set; false when the session is not live. */
  attachSessionPort(sessionId: string, port: MessagePort): boolean
  detachSessionPort(sessionId: string, port: MessagePort): void
  /** `session.subscribe {all:true}` semantics without the list reply. */
  subscribeSessionList(port: MessagePort): void
  unsubscribeSessionList(port: MessagePort): void
  getSessionSnapshot(sessionId: string): AgentRuntimeWorkerSnapshot | null
  buildSessionInfoList(): SessionCard[]
  /** The tool-detail sidecar (cache, then disk across candidate sessions), or null. */
  loadToolDetail(sessionId: string, toolCallId: string): Promise<unknown>
  /**
   * A session's PERSISTED transcript, read without creating a runtime — what
   * the shutdown read-only tab renders. A failed read comes back as `error`,
   * never as an empty list.
   */
  loadPersistedTranscript(
    sessionId: string,
  ): Promise<{ messages: unknown[]; error?: string }>
  /** Drain the worker-realm tracer ring and console ring (what `trace.flush` posts). */
  flushTrace(): { records: unknown; logEntries: unknown }
  /**
   * Open a session from a client's `session.open`: build the init payload and
   * run it through the manager's init path, with `port` as the requesting
   * port. Scope has been checked already. Rejects when there is nothing to
   * build from (no host environment published yet).
   */
  /** `panelId` is the opening client's panel — the window whose boot overlay
   *  this session's runtime build reports progress to. */
  openSession(port: MessagePort, payload: SessionOpenPayload, panelId: string | undefined): Promise<void>
  /**
   * The folders a connection with this session scope may name below `full`:
   * the workspace index and the folders of the sessions it may see
   * (`knownProjects.ts`).
   */
  knownProjectRoots(sessionScope: Scope['sessions']): Promise<readonly string[]>
  /** `runtime.publishHostEnvironment`: the desktop's host half of every init payload. */
  publishHostEnvironment(environment: HostEnvironment): void
  /**
   * `runtime.getRestartReadiness`: the worker-memory work sources (sessions'
   * phases and asks, live tasks, teammates, headless routine runs). A source
   * the manager cannot read comes back `null`, which counts as blocking.
   */
  getRestartReadinessInputs(): RestartWorkInputs
}

// ---- classification of manager → port messages onto topics ---------------------------

export type ClassifiedMessage = {
  topic: TopicId
  type: string
  form: EvtForm
  payload: Record<string, unknown>
}

const STREAM_TYPES = new Set(['worker.stream'])
const TRANSCRIPT_TYPES = new Set(['worker.messages'])
const DIFF_TYPES = new Set([
  'worker.turnDiffHistory',
  'worker.turnDiffDetail',
  'worker.sessionChangeFigures',
])
const SESSIONS_TYPES = new Set([
  'session.list',
  'session.updated',
  'session.removed',
  'session.forked',
  'session.summary',
])
const TASK_TYPES = new Set(['task.stopped', 'task.resumed', 'task.transcript'])
const DIAG_STREAM_TYPES = new Set(['trace.record', 'worker.log'])

/**
 * Where a manager message goes. `null` = not a topic event: a point-to-point
 * reply the legacy port protocol has (`toolDetail.ready`, `trace.snapshot`,
 * `worker.log.snapshot` — the protocol answers those requests from host
 * methods instead) or something unknown, which is dropped.
 */
export function classifyManagerMessage(data: unknown): ClassifiedMessage | null {
  if (!data || typeof data !== 'object') return null
  const message = data as Record<string, unknown>
  const type = message.type
  if (typeof type !== 'string') return null

  if (type.startsWith('worker.') && typeof message.sessionId === 'string') {
    const { type: _t, sessionId, ...payload } = message
    const kind = STREAM_TYPES.has(type)
      ? 'stream'
      : TRANSCRIPT_TYPES.has(type)
        ? 'transcript'
        : DIFF_TYPES.has(type)
          ? 'diff'
          : 'state'
    return { topic: topic.session(sessionId as string, kind), type, form: 'delta', payload }
  }
  // A session's status (phase / active tool / counters) is that session's, not
  // the list's: it rides `session/<id>/state`, read by whoever shows the session.
  if (type === 'session.currentState') {
    const sessionId = (message.payload as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const { type: _t, ...payload } = message
    return { topic: topic.session(sessionId, 'state'), type, form: 'delta', payload }
  }
  const { type: _type, ...payload } = message
  if (SESSIONS_TYPES.has(type) || (type === 'worker.error' && typeof message.sessionId !== 'string')) {
    return { topic: topic.sessions(), type, form: 'delta', payload }
  }
  if (TASK_TYPES.has(type)) return { topic: topic.tasks(), type, form: 'delta', payload }
  if (DIAG_STREAM_TYPES.has(type)) return { topic: topic.diagTrace(), type, form: 'delta', payload }
  return null
}

// ---- the virtual port ----------------------------------------------------------------

/**
 * A `MessagePort` in shape only: the manager posts to it, nothing is ever
 * received on it. `postMessage` is the only method with behaviour.
 */
export function createRuntimeTopicPort(onMessage: (data: unknown) => void): MessagePort {
  const port = {
    postMessage: (data: unknown) => onMessage(data),
    start: () => {},
    close: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    onmessage: null,
    onmessageerror: null,
  }
  return port as unknown as MessagePort
}

// ---- action tables -------------------------------------------------------------------

type WorkerAct = AgentWorkerInboundMessage['type'] extends infer T
  ? T extends `worker.${infer A}`
    ? A
    : never
  : never

/**
 * Every `worker.*` inbound message as a `session.<act>` action with its scope; `satisfies` makes a
 * missing row fail `tsc`. Excluded: `worker.init` and the host bridge's replies and events.
 */
export const WORKER_ACTION_SCOPES = {
  // Push the user's agent settings onto every live session; refresh the host's
  // plugins. Manager-level: both ride on settings a manager may already write.
  applyRuntimeSettings: 'manager',
  reloadPlugins: 'manager',
  // Reload the session's mods whose module text changed: it loads code into
  // the session's workers, so full only (the same bar as `mods.reload`).
  reloadMods: 'full',
  submitMessage: 'control',
  interrupt: 'control',
  clearPendingMessage: 'control',
  removeInjectMessage: 'control',
  resolveToolUseConfirm: 'control',
  addPermissionRule: 'control',
  applyPermissionUpdate: 'control',
  clearPlanApproval: 'control',
  setModelSelection: 'control',
  setPermissionMode: 'control',
  setSkipDangerousMode: 'control',
  // Writes the user settings file, like `/autocompact` from the composer.
  setAutoCompactWindow: 'control',
  updateSessionMetadata: 'control',
  cancelAutoTitle: 'control',
  refreshModelCatalog: 'control',
  getMessages: 'observe',
  getMessagesSince: 'observe',
  getState: 'observe',
  getToolCallDetail: 'observe',
  getTurnDiffDetail: 'observe',
  getTurnDiffHistory: 'observe',
  getSkillBody: 'observe',
} as const satisfies Record<Exclude<WorkerAct, 'init' | 'bridgeResponse' | 'bridgeEvent'>, ScopeMode>

/** Manager-level session actions that are not `worker.*` messages. */
export const SESSION_MANAGER_ACTION_SCOPES = {
  open: 'control',
  list: 'observe',
  rename: 'control',
  // Writes one flag into the session's metadata, like `rename`.
  pin: 'control',
  fork: 'control',
  delete: 'control',
  getToolDetail: 'observe',
  transcript: 'observe',
} as const satisfies Record<string, ScopeMode>

export const TASK_ACTION_SCOPES = {
  stop: 'control',
  resume: 'control',
  transcript: 'observe',
  recoverBackground: 'observe',
} as const satisfies Record<string, ScopeMode>

// ---- what a session-bound connection may see -------------------------------------------

/** Whether `conn` may see `sessionId` — the session-topic rule, read for one row. */
const sessionVisibleTo = (conn: ConnectionInfo, sessionId: unknown): boolean =>
  conn.scope.sessions === 'all' || (typeof sessionId === 'string' && conn.scope.sessions.includes(sessionId))

/** `rows` cut to the ones whose `key` names a session `conn` may see. */
const rowsVisibleTo = <T>(conn: ConnectionInfo, rows: readonly T[], key: keyof T & string): T[] =>
  rows.filter(row => sessionVisibleTo(conn, (row as Record<string, unknown>)[key]))

const innerOf = (payload: unknown): Record<string, unknown> | null => {
  const inner = (payload as { payload?: unknown } | null)?.payload
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : null
}

/**
 * A `sessions` topic event as ONE connection may see it. A connection with
 * every session gets it as published. One bound to a list of sessions gets a
 * list (`session.list`, `session.summary`) cut to those sessions, a
 * per-session event only when it names one of them, a manager-level
 * `worker.error` (no session) as is — and nothing else: an event shape this
 * table does not know is withheld (`undefined`), never passed through.
 */
export function sessionsEventFor(conn: ConnectionInfo, type: string | undefined, payload: unknown): unknown {
  if (conn.scope.sessions === 'all') return payload
  const inner = innerOf(payload)
  switch (type) {
    case 'session.list': {
      const sessions = Array.isArray(inner?.sessions) ? (inner.sessions as SessionCard[]) : []
      return { ...(payload as object), payload: { ...inner, sessions: rowsVisibleTo(conn, sessions, 'sessionId') } }
    }
    case 'session.summary': {
      const rows = (key: string, by: string) =>
        Array.isArray(inner?.[key]) ? { [key]: rowsVisibleTo(conn, inner[key] as Record<string, unknown>[], by) } : {}
      return {
        ...(payload as object),
        payload: { ...inner, ...rows('sessions', 'sessionId'), ...rows('subAgents', 'spawnerSessionId'), ...rows('skills', 'spawnerSessionId') },
      }
    }
    case 'session.updated':
      return sessionVisibleTo(conn, (inner?.session as { sessionId?: unknown } | undefined)?.sessionId) ? payload : undefined
    case 'session.removed':
      return sessionVisibleTo(conn, inner?.sessionId) ? payload : undefined
    case 'session.forked':
      // The requester's ack: it named the source, and may see the fork land.
      return sessionVisibleTo(conn, inner?.fromSessionId) ? payload : undefined
    case 'worker.error':
      return payload
    default:
      return undefined
  }
}

/** A `tasks` topic event as ONE connection may see it: every one names the task's session. */
export function tasksEventFor(conn: ConnectionInfo, payload: unknown): unknown {
  return sessionVisibleTo(conn, innerOf(payload)?.sessionId) ? payload : undefined
}

const textOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** The session a payload names; an empty string is no session. */
const sessionIdOf = (payload: unknown): string | undefined =>
  textOrUndefined((payload as { sessionId?: unknown } | null)?.sessionId)
/**
 * `session.fork` acts on `fromSessionId` — the only id its manager handler
 * reads — so that is the id judged against `scope.sessions`. Reading
 * `sessionId` first let a payload carrying both pass the check on a session
 * the connection may see and fork one it may not.
 */
const forkSourceOf = (payload: unknown): string | undefined =>
  textOrUndefined((payload as { fromSessionId?: unknown } | null)?.fromSessionId)
const hasSessionId = (payload: unknown): boolean => sessionIdOf(payload) !== undefined
const isObject = (payload: unknown): boolean => !!payload && typeof payload === 'object'

/**
 * The manager message for an authorized action. `type` is set LAST so a
 * payload smuggling its own `type` cannot change what the hub authorized.
 */
export function managerMessage(type: string, payload: unknown): Record<string, unknown> {
  const fields = isObject(payload) ? (payload as Record<string, unknown>) : {}
  const { type: _ignored, ...rest } = fields
  return { ...rest, type }
}

// ---- install ---------------------------------------------------------------------------

export type SessionSurface = {
  /** The virtual port the manager sees. */
  port: MessagePort
  /** Forget a session's topics (after `session.removed`). */
  dropSessionTopics(sessionId: string): void
}

export function installSessionSurface(
  hub: {
    registry: CapabilityRegistry
    broker: TopicBroker
    readonly bootBuild?: string | null
    /** Every open connection (RuntimeHub's ConnectionHub). Absent = unreadable,
     *  so `getRestartReadiness` reports `other_clients`. */
    readonly connections?: { list(): readonly ConnectionInfo[] }
  },
  host: SessionSurfaceHost,
): SessionSurface {
  const { registry, broker } = hub

  const port = createRuntimeTopicPort(data => {
    const classified = classifyManagerMessage(data)
    if (!classified) return
    broker.publish(classified.topic, classified.payload, { type: classified.type, form: classified.form })
  })

  // ---- session topics: attach/detach the virtual port per session --------------------

  const attachedKinds = new Map<string, Set<string>>()
  // Per session, how many of its topics each connection holds: its first is
  // its attach to the session's roster, its last its detach (`session.attach`
  // / `session.detach` for the session's mods).
  const clientTopics = new Map<string, Map<string, number>>()
  const rosterSubscribed = (sessionId: string, conn: ConnectionInfo) => {
    let held = clientTopics.get(sessionId)
    if (!held) {
      held = new Map()
      clientTopics.set(sessionId, held)
    }
    const count = (held.get(conn.connectionId) ?? 0) + 1
    held.set(conn.connectionId, count)
    if (count === 1) modRosterAttach(sessionId, { clientId: conn.connectionId, surface: 'desktop' })
  }
  const rosterUnsubscribed = (sessionId: string, conn: ConnectionInfo) => {
    const held = clientTopics.get(sessionId)
    const count = held?.get(conn.connectionId)
    if (!held || count === undefined) return
    if (count > 1) {
      held.set(conn.connectionId, count - 1)
      return
    }
    held.delete(conn.connectionId)
    if (held.size === 0) clientTopics.delete(sessionId)
    modRosterDetach(sessionId, conn.connectionId)
  }
  const sessionTopicProvider: TopicProvider = {
    matches: id => parseTopic(id)?.family === 'session',
    authorize: (id, conn) => {
      const parsed = parseTopic(id)
      if (parsed?.family !== 'session') return false
      return conn.scope.sessions === 'all' || conn.scope.sessions.includes(parsed.sessionId)
    },
    async *snapshot(id) {
      const parsed = parseTopic(id)
      if (parsed?.family !== 'session' || parsed.kind !== 'state') return
      const snapshot = host.getSessionSnapshot(parsed.sessionId)
      if (snapshot) yield { type: 'worker.state', payload: { payload: snapshot } }
    },
    onSubscribe: (id, conn, first) => {
      const parsed = parseTopic(id)
      if (parsed?.family !== 'session') return
      rosterSubscribed(parsed.sessionId, conn)
      if (!first) return
      let kinds = attachedKinds.get(parsed.sessionId)
      if (!kinds) {
        kinds = new Set()
        attachedKinds.set(parsed.sessionId, kinds)
      }
      const wasEmpty = kinds.size === 0
      kinds.add(parsed.kind)
      if (wasEmpty) host.attachSessionPort(parsed.sessionId, port)
    },
    onUnsubscribe: (id, conn, last) => {
      const parsed = parseTopic(id)
      if (parsed?.family !== 'session') return
      rosterUnsubscribed(parsed.sessionId, conn)
      if (!last) return
      const kinds = attachedKinds.get(parsed.sessionId)
      kinds?.delete(parsed.kind)
      if (kinds && kinds.size === 0) {
        attachedKinds.delete(parsed.sessionId)
        host.detachSessionPort(parsed.sessionId, port)
      }
    },
  }

  // Anyone may subscribe to the list and the task events; what each connection
  // SEES of them is cut to its sessions (`sessionsEventFor` / `tasksEventFor`).
  const sessionsProvider: TopicProvider = {
    matches: id => id === topic.sessions(),
    authorize: () => true,
    async *snapshot(_id, conn) {
      const sessions = rowsVisibleTo(conn, host.buildSessionInfoList(), 'sessionId')
      yield { type: 'session.list', payload: { payload: { sessions } } }
    },
    project: (_id, conn, evt) => sessionsEventFor(conn, evt.type, evt.payload),
    onSubscribe: (_id, _conn, first) => {
      if (first) host.subscribeSessionList(port)
    },
    onUnsubscribe: (_id, _conn, last) => {
      if (last) host.unsubscribeSessionList(port)
    },
  }

  const tasksProvider: TopicProvider = {
    matches: id => id === topic.tasks(),
    authorize: () => true,
    // eslint-disable-next-line require-yield
    async *snapshot() {},
    project: (_id, conn, evt) => tasksEventFor(conn, evt.payload),
  }

  const diagTraceProvider: TopicProvider = {
    matches: id => id === topic.diagTrace(),
    // Diagnostic stream is a manager's troubleshooting surface, not a secret.
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'manager'),
    // eslint-disable-next-line require-yield
    async *snapshot() {},
    onSubscribe: (_id, _conn, first) => {
      if (first) host.dispatch(port, { type: 'trace.subscribe' })
    },
    onUnsubscribe: (_id, _conn, last) => {
      if (last) host.dispatch(port, { type: 'trace.unsubscribe' })
    },
  }

  broker.registerProvider(sessionTopicProvider)
  broker.registerProvider(sessionsProvider)
  broker.registerProvider(tasksProvider)
  broker.registerProvider(diagTraceProvider)

  // ---- capabilities --------------------------------------------------------------------

  const sessionActions: Record<string, ActionSpec> = {}
  for (const [act, scope] of Object.entries(WORKER_ACTION_SCOPES)) {
    sessionActions[act] = { scope, sessionOf: sessionIdOf, guard: hasSessionId }
  }
  sessionActions.open = {
    scope: SESSION_MANAGER_ACTION_SCOPES.open,
    sessionOf: sessionIdOf,
    guard: isSessionOpenPayload,
  }
  sessionActions.list = { scope: SESSION_MANAGER_ACTION_SCOPES.list }
  sessionActions.rename = { scope: SESSION_MANAGER_ACTION_SCOPES.rename, sessionOf: sessionIdOf, guard: hasSessionId }
  sessionActions.pin = {
    scope: SESSION_MANAGER_ACTION_SCOPES.pin,
    sessionOf: sessionIdOf,
    guard: p => hasSessionId(p) && typeof (p as { pinned?: unknown }).pinned === 'boolean',
  }
  sessionActions.fork = {
    scope: SESSION_MANAGER_ACTION_SCOPES.fork,
    sessionOf: forkSourceOf,
    guard: p => forkSourceOf(p) !== undefined,
  }
  sessionActions.delete = { scope: SESSION_MANAGER_ACTION_SCOPES.delete, sessionOf: sessionIdOf, guard: hasSessionId }
  sessionActions.getToolDetail = {
    scope: SESSION_MANAGER_ACTION_SCOPES.getToolDetail,
    sessionOf: sessionIdOf,
    guard: p => hasSessionId(p) && typeof (p as { toolCallId?: unknown }).toolCallId === 'string',
  }
  // Reading a session's persisted transcript is a REQUEST WITH A VALUE, like
  // `list` and `getToolDetail` — not a manager message fanned back over the
  // shared port. Without this entry the action fell through
  // `WORKER_ACTION_SCOPES` (there is no `worker.transcript`) and the client's
  // request was dropped unmapped, so the read-only tab waited out its 15s
  // timeout on EVERY load. It reads no runtime, so `observe`.
  sessionActions.transcript = {
    scope: SESSION_MANAGER_ACTION_SCOPES.transcript,
    sessionOf: sessionIdOf,
    guard: hasSessionId,
  }

  registry.registerCapability({
    cap: 'session',
    actions: sessionActions,
    handle: async (request: HandlerRequest) => {
      const act = request.route.act
      const payload = request.payload as Record<string, unknown>
      switch (act) {
        case 'open': {
          let open = request.payload as SessionOpenPayload
          if (request.conn.scope.mode !== 'full') {
            const named = SESSION_OPEN_FULL_FIELDS.filter(field => open[field] !== undefined)
            if (named.length > 0) {
              throw wireError('forbidden_scope', `session.open: '${named.join("', '")}' need scope 'full'`)
            }
            if (open.projectRoot !== undefined) {
              const known = await host.knownProjectRoots(request.conn.scope.sessions)
              open = { ...open, projectRoot: knownProjectRootOrRefuse(open.projectRoot, known, 'session.open') }
            }
          }
          await host.openSession(port, open, request.conn.panelId)
          return undefined
        }
        case 'updateSessionMetadata': {
          // The persisted folder is what the next open of this session binds
          // (`SessionSummaryRepository.reconcilePersistedSessionBinding`), so
          // writing it is binding it: the same known-project rule as `open`.
          const metadata = (payload.payload as { metadata?: Record<string, unknown> } | undefined)?.metadata
          if (request.conn.scope.mode !== 'full' && metadata?.projectRoot !== undefined) {
            const known = await host.knownProjectRoots(request.conn.scope.sessions)
            const projectRoot = knownProjectRootOrRefuse(metadata.projectRoot, known, 'session.updateSessionMetadata')
            host.dispatch(
              port,
              managerMessage('worker.updateSessionMetadata', {
                ...payload,
                payload: { ...(payload.payload as Record<string, unknown>), metadata: { ...metadata, projectRoot } },
              }),
            )
            return undefined
          }
          host.dispatch(port, managerMessage('worker.updateSessionMetadata', payload))
          return undefined
        }
        case 'list':
          return { sessions: rowsVisibleTo(request.conn, host.buildSessionInfoList(), 'sessionId') }
        case 'getToolDetail':
          return { detail: await host.loadToolDetail(payload.sessionId as string, payload.toolCallId as string) }
        case 'transcript':
          return await host.loadPersistedTranscript(payload.sessionId as string)
        case 'rename':
        case 'pin':
        case 'fork':
        case 'delete':
          host.dispatch(port, managerMessage(`session.${act}`, payload))
          return undefined
        default:
          host.dispatch(port, managerMessage(`worker.${act}`, payload))
          return undefined
      }
    },
  })

  registry.registerCapability({
    cap: 'task',
    actions: Object.fromEntries(
      Object.entries(TASK_ACTION_SCOPES).map(([act, scope]) => [
        act,
        { scope, sessionOf: sessionIdOf, guard: hasSessionId } satisfies ActionSpec,
      ]),
    ),
    handle: async request => {
      host.dispatch(port, managerMessage(`task.${request.route.act}`, request.payload))
      return undefined
    },
  })

  registry.registerCapability({
    cap: 'runtime',
    actions: {
      publishHostEnvironment: {
        scope: 'full',
        guard: p => !!p && typeof p === 'object' && !!(p as { environment?: unknown }).environment
          && typeof (p as { environment?: unknown }).environment === 'object',
      },
      // Read-only build identity. A REMOTE client calls this right after
      // welcome to detect version skew against the bundle it just downloaded,
      // and to take this runtime's update channel as its own
      // (`adoptRuntimeChannel`), so it must be reachable below `full`. It
      // reveals only the build stamp, the immutable entry URL and the channel —
      // no user data, nothing writable — so `observe`. (P-3: a new action's
      // scope is justified in a comment.)
      getBuildEntry: { scope: 'observe' },
      // Read-only: may the desktop page reload into a new build without
      // losing worker-memory state? Only the desktop's own page asks, and the
      // answer reveals the activity of EVERY session and every connected
      // client, so `full`. (P-3: a new action's scope is justified in a comment.)
      getRestartReadiness: { scope: 'full' },
    },
    handle: async request => {
      if (request.route.act === 'getRestartReadiness') {
        let work: RestartWorkInputs
        try {
          work = host.getRestartReadinessInputs()
        } catch {
          work = UNREADABLE_WORK_INPUTS
        }
        let connections: readonly ConnectionInfo[] | null
        try {
          connections = hub.connections ? hub.connections.list() : null
        } catch {
          connections = null
        }
        return computeRestartReadiness({ ...work, caller: request.conn, connections })
      }
      if (request.route.act === 'getBuildEntry') {
        const build = hub.bootBuild ?? null
        const workerHref =
          (globalThis as { location?: { href?: string } }).location?.href ?? ''
        return {
          build,
          entryUrl: buildEntryUrl(workerHref, build),
          // THIS realm's channel — the template files every session here runs.
          channel: currentTemplateChannel(),
        }
      }
      host.publishHostEnvironment((request.payload as { environment: HostEnvironment }).environment)
      return undefined
    },
  })

  registry.registerCapability({
    cap: 'diag',
    actions: { traceFlush: { scope: 'manager' } },
    handle: async () => host.flushTrace(),
  })

  return {
    port,
    dropSessionTopics: sessionId => {
      for (const kind of ['state', 'transcript', 'stream', 'diff'] as const) {
        broker.dropTopic(topic.session(sessionId, kind))
      }
      attachedKinds.delete(sessionId)
    },
  }
}

export type { ConnectionInfo }
