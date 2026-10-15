/**
 * Contract: `BrowserWorkerClientTransport` over a `RuntimeConnection` (P-3).
 * `postMessage(worker.X)` becomes `req session.X` (the message minus `type`, plus
 * `sessionId`); `session/<id>/{state,transcript,stream,diff}` events return as
 * `worker.*` messages; manager messages map onto requests and the `sessions` /
 * `tasks` / `diag/trace` topics, the inverse of `classifyManagerMessage`. A
 * session topic's first snapshot is skipped (the client drives its own open);
 * a later `resync` one triggers `onSessionResync`. `worker.init` becomes
 * `session.open`: a `full` connection passes its init fields, a scoped one only
 * what its scope may say. Operations queue until `welcome`.
 */
import type {
  BrowserWorkerClientInboundMessage,
  BrowserWorkerClientTransport,
} from '../webview/BrowserRuntimeClient'
import type { AgentRuntimeWorkerInitPayload, AgentWorkerInboundMessage } from '../worker/workerProtocol'
import { SESSION_TOPIC_KINDS, topic, type RouteKey } from '../runtimeProtocol'
import type { Unsubscribe } from '../runtimeTransport'
import { randomUuid } from '../../utils/randomUuid'
import { isRuntimeRequestError, type RuntimeConnection, type TopicEvent } from './RuntimeConnection'

/**
 * `worker.error` code for a `session.open` the connection's grant refuses
 * (`forbidden_scope`: opening a session is `control`). An `observe` client
 * lands here for every session it shows; `BrowserRuntimeClient` takes the code
 * as "this client may only read" and loads the transcript read-only, the way
 * it does for a `session_shutdown` refusal, instead of waiting on a snapshot
 * that no runtime will send.
 */
export const SESSION_OPEN_FORBIDDEN = 'session_open_forbidden'

/** `worker.submitMessage` → `session.submitMessage`. */
export function sessionRouteFor(workerMessageType: string): RouteKey {
  const act = workerMessageType.startsWith('worker.') ? workerMessageType.slice('worker.'.length) : workerMessageType
  return `session.${act}`
}

/**
 * The `session.open` for an init payload, cut to what this connection's scope
 * may say (`SESSION_OPEN_FULL_FIELDS` are `full` only). The folder goes at every
 * scope; below `full` the runtime binds it only if it is a known project
 * (`runtimeHub/knownProjects.ts`) and refuses it otherwise.
 */
export function sessionOpenFor(
  conn: Pick<RuntimeConnection, 'welcome'>,
  init: AgentRuntimeWorkerInitPayload & { sessionId: string },
): Record<string, unknown> {
  const common = {
    sessionId: init.sessionId,
    ...(init.templateType !== undefined ? { templateType: init.templateType } : {}),
    ...(init.userSpecifiedProviderId && init.userSpecifiedModel
      ? {
          selection: {
            providerId: init.userSpecifiedProviderId,
            modelId: init.userSpecifiedModel,
            ...(init.userSpecifiedThinkingTier ? { thinkingTier: init.userSpecifiedThinkingTier } : {}),
          },
        }
      : {}),
    ...(init.restoredSessionId ? { restored: true } : {}),
    ...(init.forceReinit ? { reinit: true } : {}),
  }
  if (conn.welcome?.scope.mode === 'full') return { ...common, init }
  return init.projectRoot ? { ...common, projectRoot: init.projectRoot } : common
}

/** An `evt` on a session topic back into the `{type, …}` message the manager posted. */
export function eventToManagerMessage(event: TopicEvent): Record<string, unknown> | null {
  if (!event.type) return null
  const payload = (event.payload ?? {}) as Record<string, unknown>
  return { type: event.type, ...payload }
}

type Listener = (message: BrowserWorkerClientInboundMessage) => void

export function createWorkerTransportOverConnection(
  connection: RuntimeConnection | Promise<RuntimeConnection>,
  openingSessionId?: string,
  options: {
    onError?: (error: unknown) => void
    /** Re-ask interval while a tool detail is not persisted yet. Default 1 s. */
    toolDetailRetryMs?: number
  } = {},
): BrowserWorkerClientTransport {
  let sessionId = openingSessionId ?? ''
  let disposed = false
  const sessionListeners = new Set<Listener>()
  const managerListeners = new Set<(data: unknown) => void>()
  const sessionUnsubscribes: Unsubscribe[] = []
  const managerUnsubscribes = new Map<string, Unsubscribe>()
  const ready: Promise<RuntimeConnection> = Promise.resolve(connection)
  const report = (error: unknown): void => options.onError?.(error)
  const toolDetailRetryMs = options.toolDetailRetryMs ?? 1_000
  /** Tool details asked for and not answered yet → the pending retry timer. */
  const toolDetailWaits = new Map<string, ReturnType<typeof setTimeout> | null>()
  /**
   * How many subscribers each waited-on id has. Two concurrent
   * `requestToolCallDetail` calls for one id (two cards on the same call)
   * share this transport, and the one that gives up first — its own timeout —
   * must not silence the other: the wait ends when the LAST one unsubscribes.
   */
  const toolDetailSubscribers = new Map<string, number>()
  /**
   * Which wait an in-flight ask belongs to, per id. Bumped when a wait STARTS;
   * an ask whose generation no longer matches (its wait ended and a new one
   * began while it was on the wire) drops its answer instead of settling or
   * re-arming the new wait. Kept across `endToolDetailWait` on purpose — the
   * stale ask compares against it after the wait is gone.
   */
  const toolDetailGeneration = new Map<string, number>()
  const endToolDetailWait = (toolCallId: string): void => {
    const timer = toolDetailWaits.get(toolCallId)
    if (timer) clearTimeout(timer)
    toolDetailWaits.delete(toolCallId)
    toolDetailSubscribers.delete(toolCallId)
  }

  let connectionFailureReported = false
  const withConnection = (fn: (conn: RuntimeConnection) => void | Promise<unknown>): void => {
    void ready
      .then(
        conn => {
          if (disposed) return
          return fn(conn)
        },
        error => {
          report(error)
          // Without a connection nothing this transport queued will ever run.
          // Say so once, as the error the client already renders, instead of
          // leaving the session on its loading page with no signal.
          if (disposed || connectionFailureReported) return
          connectionFailureReported = true
          emitSession({
            type: 'worker.error',
            payload: {
              code: 'runtime_connection_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          })
        },
      )
      .catch(report)
  }

  const emitSession = (message: Record<string, unknown>): void => {
    for (const listener of Array.from(sessionListeners)) listener(message as BrowserWorkerClientInboundMessage)
  }
  const emitManager = (message: unknown): void => {
    for (const listener of Array.from(managerListeners)) listener(message)
  }

  let refetchPending = false
  /**
   * One full `session.getMessages` for every topic that recovers while one is
   * scheduled or on the wire. Frames are ordered, so a recovery snapshot that
   * arrives first is covered by the pending fetch. Full, not `getMessagesSince`:
   * the gap may span a rewrite (compaction, rewind). The same call recomputes the
   * `diff` topic's turn-diff history.
   */
  const scheduleRefetch = (conn: RuntimeConnection): void => {
    if (refetchPending) return
    refetchPending = true
    queueMicrotask(() => {
      if (disposed) return
      void request(conn, 'session.getMessages', { sessionId }).finally(() => {
        refetchPending = false
      })
    })
  }

  /**
   * A `resync` snapshot: the topic missed deltas. `state` carries the live
   * snapshot; the other three snapshot to `null` and are refetched, and the client
   * drops the turn's partial live events because a stream with a hole cannot be
   * rebuilt.
   */
  const onSessionResync = (conn: RuntimeConnection, kind: string, event: TopicEvent): void => {
    if (kind === 'state') {
      const message = eventToManagerMessage(event)
      if (message) emitSession(message)
      return
    }
    if (kind === 'stream' && !event.more) emitSession({ type: 'worker.streamGap' })
    scheduleRefetch(conn)
  }

  /** Hold every session topic for `sessionId` (idempotent). */
  const holdSessionTopics = (conn: RuntimeConnection): void => {
    if (sessionUnsubscribes.length > 0 || !sessionId) return
    for (const kind of SESSION_TOPIC_KINDS) {
      sessionUnsubscribes.push(
        conn.subscribe(topic.session(sessionId, kind), event => {
          // The first snapshot of a subscription is skipped: the client drives
          // its own open. A later one is a recovery.
          if (event.form === 'snapshot') {
            if (event.resync) onSessionResync(conn, kind, event)
            return
          }
          const message = eventToManagerMessage(event)
          if (message) emitSession(message)
        }),
      )
    }
  }

  /** Hold a manager-level topic once; events go to the manager listeners as messages. */
  const holdManagerTopic = (conn: RuntimeConnection, id: string, includeSnapshots: boolean): void => {
    if (managerUnsubscribes.has(id)) return
    managerUnsubscribes.set(
      id,
      conn.subscribe(id, event => {
        if (event.form === 'snapshot' && (!includeSnapshots || event.payload === null)) return
        const message = eventToManagerMessage(event)
        if (message) emitManager(message)
      }),
    )
  }
  const releaseManagerTopic = (id: string): void => {
    managerUnsubscribes.get(id)?.()
    managerUnsubscribes.delete(id)
  }

  /** Requests parked across a reconnect gap → releases the wait. */
  const gapWaits = new Set<() => void>()
  /**
   * Settles once the connection has left `reconnecting` (ready or closed), or
   * this transport is disposed. Immediate outside a gap.
   */
  const leftGap = (conn: RuntimeConnection): Promise<void> => {
    if (conn.state.status !== 'reconnecting') return Promise.resolve()
    return new Promise<void>(resolve => {
      const release = (): void => {
        gapWaits.delete(release)
        unsubscribe()
        resolve()
      }
      const unsubscribe = conn.watchLinkState(state => {
        if (state.status !== 'reconnecting') release()
      })
      gapWaits.add(release)
    })
  }

  let closedReported = false
  /** `forbiddenCode`: the `worker.error` code a `forbidden_scope` refusal is reported under. */
  const request = async (
    conn: RuntimeConnection,
    route: RouteKey,
    payload: Record<string, unknown>,
    forbiddenCode = 'runtime_request_failed',
  ): Promise<unknown> => {
    // A request made while `reconnecting` waits out the gap: failing it at once
    // becomes a `worker.error`, whose transcript refetch comes back here, a
    // microtask loop that freezes the page. Closed meanwhile: send and be refused.
    await leftGap(conn)
    if (disposed) return undefined
    return conn.request(route, payload).catch(error => {
      report(error)
      // A closed connection refuses every request the same way; the session
      // hears it once. Reporting each one re-arms the same loop from `closed`.
      if (conn.state.status === 'closed') {
        if (closedReported) return
        closedReported = true
      }
      emitSession({
        type: 'worker.error',
        payload: {
          code:
            isRuntimeRequestError(error) && error.code === 'forbidden_scope' ? forbiddenCode : 'runtime_request_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    })
  }

  return {
    postMessage(message: AgentWorkerInboundMessage): void {
      if (message.type === 'worker.init') {
        if (!sessionId) sessionId = message.payload.sessionId || randomUuid()
        const init = { ...message.payload, sessionId }
        withConnection(conn => {
          holdSessionTopics(conn)
          return request(conn, 'session.open', sessionOpenFor(conn, init), SESSION_OPEN_FORBIDDEN)
        })
        return
      }
      const { type, ...rest } = message as { type: string } & Record<string, unknown>
      withConnection(conn => request(conn, sessionRouteFor(type), { ...rest, sessionId }))
    },

    addMessageListener(listener: Listener): () => void {
      sessionListeners.add(listener)
      if (sessionId) withConnection(conn => holdSessionTopics(conn))
      return () => {
        sessionListeners.delete(listener)
      }
    },

    postManagerMessage(data: unknown): void {
      const message = data as { type?: string } & Record<string, unknown>
      if (!message || typeof message.type !== 'string') return
      const { type, ...rest } = message
      switch (type) {
        case 'toolDetail.subscribe': {
          const toolCallIds = (rest.toolCallIds as string[] | undefined) ?? []
          const hint = (rest.sessionId as string | undefined) ?? sessionId
          // A null answer re-asks until the detail is persisted or the caller
          // unsubscribes; a premature null would read as final. `generation`
          // ties an ask to its wait, so a stale ask cannot answer or re-arm a
          // re-subscribe for the same id.
          const ask = (toolCallId: string, generation: number): void => {
            withConnection(async conn => {
              const live = (): boolean =>
                !disposed && toolDetailWaits.has(toolCallId) && toolDetailGeneration.get(toolCallId) === generation
              let detail: unknown = null
              try {
                await leftGap(conn)
                if (!live()) return
                const result = (await conn.request('session.getToolDetail', { sessionId: hint, toolCallId })) as {
                  detail: unknown
                }
                detail = result?.detail ?? null
              } catch (error) {
                if (isRuntimeRequestError(error) && error.retryable && error.code === 'cancelled') {
                  // The WIRE went away under the request (a reconnect gap
                  // opened — the connection's own retryable `cancelled`), which
                  // says nothing about the detail. Wait the gap out and re-ask
                  // on the timer below instead of settling a permanent null.
                  // The timer, not an immediate re-ask: a wire that keeps
                  // refusing would otherwise loop on microtasks alone.
                  await leftGap(conn)
                  if (!live()) return
                } else {
                  // A refused request will not start succeeding: answer it.
                  report(error)
                  if (!live()) return
                  endToolDetailWait(toolCallId)
                  emitManager({ type: 'toolDetail.ready', payload: { toolCallId, detail: null } })
                  return
                }
              }
              if (!live()) return
              if (detail !== null) {
                endToolDetailWait(toolCallId)
                emitManager({ type: 'toolDetail.ready', payload: { toolCallId, detail } })
                return
              }
              const previous = toolDetailWaits.get(toolCallId)
              if (previous) clearTimeout(previous)
              toolDetailWaits.set(
                toolCallId,
                setTimeout(() => ask(toolCallId, generation), toolDetailRetryMs),
              )
            })
          }
          for (const toolCallId of toolCallIds) {
            toolDetailSubscribers.set(toolCallId, (toolDetailSubscribers.get(toolCallId) ?? 0) + 1)
            if (toolDetailWaits.has(toolCallId)) continue
            const generation = (toolDetailGeneration.get(toolCallId) ?? 0) + 1
            toolDetailGeneration.set(toolCallId, generation)
            toolDetailWaits.set(toolCallId, null)
            ask(toolCallId, generation)
          }
          return
        }
        case 'toolDetail.unsubscribe': {
          for (const toolCallId of (rest.toolCallIds as string[] | undefined) ?? []) {
            const remaining = (toolDetailSubscribers.get(toolCallId) ?? 0) - 1
            if (remaining > 0) {
              toolDetailSubscribers.set(toolCallId, remaining)
              continue
            }
            endToolDetailWait(toolCallId)
          }
          return
        }
        case 'session.subscribe': {
          withConnection(conn => {
            if (rest.all) holdManagerTopic(conn, topic.sessions(), true)
          })
          return
        }
        case 'session.unsubscribe': {
          if (rest.all) releaseManagerTopic(topic.sessions())
          return
        }
        case 'session.list': {
          withConnection(async conn => {
            const result = await conn.request('session.list', {})
            emitManager({ type: 'session.list', payload: result })
          })
          return
        }
        case 'session.transcript': {
          // The shutdown read-only tab's transcript load, request/reply because no
          // runtime exists to publish it. The reply carries the caller's
          // `requestId`; a failure answers with `error` so the tab can tell
          // "could not read" from "still reading".
          const requestId = rest.requestId as string | undefined
          const target = (rest.sessionId as string | undefined) ?? sessionId
          withConnection(async conn => {
            let payload: { messages?: unknown[]; error?: string }
            try {
              payload = (await conn.request('session.transcript', {
                sessionId: target,
              })) as { messages?: unknown[]; error?: string }
            } catch (error) {
              report(error)
              payload = {
                messages: [],
                error: error instanceof Error ? error.message : String(error),
              }
            }
            emitManager({
              type: 'session.transcript',
              payload: {
                sessionId: target,
                requestId,
                messages: payload?.messages ?? [],
                ...(payload?.error !== undefined ? { error: payload.error } : {}),
              },
            })
          })
          return
        }
        case 'session.delete':
        case 'session.rename':
        case 'session.pin':
        case 'session.fork': {
          withConnection(conn => {
            holdManagerTopic(conn, topic.sessions(), false)
            return request(conn, `session.${type.slice('session.'.length)}`, rest)
          })
          return
        }
        case 'session.detach':
          // The protocol has no per-client detach: the hub's virtual port is
          // shared, and it leaves a session when the LAST subscriber of the
          // session's topics goes — which `dispose()` triggers by releasing
          // this transport's subscriptions.
          return
        case 'task.stop':
        case 'task.resume':
        case 'task.transcript':
        case 'task.recoverBackground': {
          withConnection(conn => {
            holdManagerTopic(conn, topic.tasks(), false)
            return request(conn, `task.${type.slice('task.'.length)}`, rest)
          })
          return
        }
        case 'trace.flush': {
          withConnection(async conn => {
            const result = (await conn.request('diag.traceFlush', {})) as { records: unknown; logEntries: unknown }
            emitManager({
              type: 'trace.snapshot',
              ...(rest.requestId !== undefined ? { requestId: rest.requestId } : {}),
              payload: { records: result.records },
            })
            emitManager({ type: 'worker.log.snapshot', payload: { entries: result.logEntries } })
          })
          return
        }
        case 'trace.subscribe':
          withConnection(conn => holdManagerTopic(conn, topic.diagTrace(), false))
          return
        case 'trace.unsubscribe':
          releaseManagerTopic(topic.diagTrace())
          return
        default:
          report(new Error(`[runtimeClient] unmapped manager message '${type}'`))
      }
    },

    addManagerListener(listener: (data: unknown) => void): () => void {
      managerListeners.add(listener)
      return () => {
        managerListeners.delete(listener)
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      for (const release of Array.from(gapWaits)) release()
      for (const timer of toolDetailWaits.values()) if (timer) clearTimeout(timer)
      toolDetailWaits.clear()
      toolDetailSubscribers.clear()
      toolDetailGeneration.clear()
      for (const unsubscribe of sessionUnsubscribes) unsubscribe()
      sessionUnsubscribes.length = 0
      for (const unsubscribe of managerUnsubscribes.values()) unsubscribe()
      managerUnsubscribes.clear()
      sessionListeners.clear()
      managerListeners.clear()
      // No `session.detach` request: releasing the subscriptions above is what
      // detaches — on the last holder only (see the surface's provider hooks).
      // Two transports on one session (React strict-mode double mount) must
      // not silence each other, which is what a per-transport detach did.
    },
  }
}
