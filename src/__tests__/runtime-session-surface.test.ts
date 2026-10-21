/**
 * The protocol's session surface against a FAKE manager: the virtual
 * port, message classification onto topics, the `session` / `task` / `diag`
 * capabilities, provider hooks (attach / detach / list subscription / trace),
 * and the point-to-point replies awaited as request results. Then the
 * client-side seam `createWorkerTransportOverConnection` end to end over a
 * MessageChannel, driven the way BrowserRuntimeClient drives its transport.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { AgentWorkerInboundMessage } from '../browser/worker/workerProtocol'
import { topic, wireError, type EvtFrame, type TopicId } from '../browser/runtimeProtocol'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import {
  CapabilityRegistry,
  ConnectionHub,
  TopicBroker,
  WORKER_ACTION_SCOPES,
  classifyManagerMessage,
  installSessionSurface,
  managerMessage,
  SESSION_MANAGER_ACTION_SCOPES,
  hostEnvironmentOf,
  sessionsEventFor,
  type ConnectionInfo,
  type HostEnvironment,
  type RuntimeContext,
  type SessionOpenPayload,
  type SessionSurfaceHost,
  type RestartWorkInputs,
} from '../browser/runtimeHub'
import {
  connectRuntime,
  createSessionListChannel,
  createSessionStatusChannel,
  createWorkerTransportOverConnection,
  eventToManagerMessage,
  sessionOpenFor,
  sessionRouteFor,
  SESSION_OPEN_FORBIDDEN,
  RuntimeRequestError,
  type ConnectionState,
  type RuntimeConnection,
} from '../browser/runtimeClient'
import { BrowserRuntimeClient } from '../browser/webview/BrowserRuntimeClient'
import { modRoster, resetModSlotRegistryForTests } from '../mods/modSlotRegistry'

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}
async function until(predicate: () => boolean, label: string, rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return
    await flush(1)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** A stand-in for SharedWorkerSessionManager's port protocol. */
class FakeManager implements SessionSurfaceHost {
  dispatched: Array<Record<string, unknown>> = []
  attached: Array<[string, 'attach' | 'detach']> = []
  listSubscribed = 0
  live = new Set<string>(['s1'])
  port: MessagePort | null = null
  /** What `worker.getMessages` answers: the runtime's transcript. */
  messages: unknown[] = ['m1']

  dispatch(port: MessagePort, data: unknown): void {
    this.port = port
    const message = data as Record<string, unknown>
    this.dispatched.push(message)
    // Mimic the manager's replies for the messages that have one.
    if (message.type === 'worker.init') {
      port.postMessage({ type: 'worker.ready', sessionId: message.sessionId, payload: { initialized: true, sessionId: message.sessionId } })
      return
    }
    if (message.type === 'worker.getMessages') {
      port.postMessage({ type: 'worker.messages', sessionId: message.sessionId, payload: { messages: this.messages } })
      return
    }
    if (message.type === 'task.stop') {
      port.postMessage({ type: 'task.stopped', payload: { sessionId: message.sessionId, status: 'stopped', requestId: message.requestId } })
    }
  }
  attachSessionPort(sessionId: string, _port: MessagePort): boolean {
    this.attached.push([sessionId, 'attach'])
    return this.live.has(sessionId)
  }
  detachSessionPort(sessionId: string): void {
    this.attached.push([sessionId, 'detach'])
  }
  subscribeSessionList(): void {
    this.listSubscribed += 1
  }
  unsubscribeSessionList(): void {
    this.listSubscribed -= 1
  }
  getSessionSnapshot(sessionId: string) {
    return this.live.has(sessionId) ? ({ sessionId, initialized: true } as never) : null
  }
  buildSessionInfoList() {
    return [{ sessionId: 's1', initialized: true }]
  }
  toolDetailRequests: Array<[string, string]> = []
  /** `late*` ids read as not-persisted-yet until added here. */
  persistedLate = new Set<string>()
  async loadToolDetail(sessionId: string, toolCallId: string) {
    this.toolDetailRequests.push([sessionId, toolCallId])
    if (toolCallId === 'missing') return null
    if (toolCallId.startsWith('late') && !this.persistedLate.has(toolCallId)) return null
    return { id: toolCallId }
  }
  transcriptRequests: string[] = []
  transcriptError: string | undefined
  async loadPersistedTranscript(sessionId: string) {
    this.transcriptRequests.push(sessionId)
    if (this.transcriptError !== undefined) {
      return { messages: [], error: this.transcriptError }
    }
    return { messages: [{ type: 'user', uuid: `${sessionId}-u1` }] }
  }
  flushes = 0
  flushTrace() {
    this.flushes += 1
    return { records: ['r'], logEntries: ['l'] }
  }
  opened: SessionOpenPayload[] = []
  hostEnvironment: HostEnvironment | null = null
  /** Stands in for the manager's composer: the init it builds goes down the same path. */
  async openSession(port: MessagePort, open: SessionOpenPayload): Promise<void> {
    this.opened.push(open)
    this.dispatch(port, { type: 'worker.init', sessionId: open.sessionId, payload: { ...(open.init ?? {}), sessionId: open.sessionId } })
  }
  publishHostEnvironment(environment: HostEnvironment): void {
    this.hostEnvironment = environment
  }
  restartInputs: RestartWorkInputs = {
    sessions: [], liveTaskCount: 0, teammateStatuses: [], headlessRunCount: 0,
  }
  getRestartReadinessInputs(): RestartWorkInputs {
    return this.restartInputs
  }
  /** What `knownProjectRoots` answers, and the session scopes it was asked for. */
  known: string[] = []
  knownAskedFor: Array<'all' | readonly string[]> = []
  async knownProjectRoots(sessionScope: 'all' | readonly string[]): Promise<readonly string[]> {
    this.knownAskedFor.push(sessionScope)
    return this.known
  }
}

function makeRig() {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const manager = new FakeManager()
  const surface = installSessionSurface({ registry, broker }, manager)
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'ss', bootstrap: () => undefined })
  return { registry, broker, manager, surface, hub }
}

async function connect(rig: ReturnType<typeof makeRig>, scopeCeiling?: 'control' | 'observe' | 'manager'): Promise<RuntimeConnection> {
  const channel = new MessageChannel()
  rig.hub.attach(createMessagePortTransport(channel.port1))
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId: 'c', kind: 'desktop-shell' },
    ...(scopeCeiling ? { scopeCeiling } : {}),
  })
}

describe('classifyManagerMessage', () => {
  it('routes worker events to the session topics by kind, with the legacy projection as payload', () => {
    expect(classifyManagerMessage({ type: 'worker.stream', sessionId: 's', payload: { x: 1 } })).toEqual({
      topic: 'session/s/stream',
      type: 'worker.stream',
      form: 'delta',
      payload: { payload: { x: 1 } },
    })
    expect(classifyManagerMessage({ type: 'worker.messages', sessionId: 's', payload: {} })?.topic).toBe('session/s/transcript')
    expect(classifyManagerMessage({ type: 'worker.turnDiffHistory', sessionId: 's', payload: {} })?.topic).toBe('session/s/diff')
    expect(classifyManagerMessage({ type: 'worker.ready', sessionId: 's', payload: {} })?.topic).toBe('session/s/state')
    expect(classifyManagerMessage({ type: 'worker.pendingMessageUpdated', sessionId: 's', payload: { text: 't' } })).toMatchObject({
      topic: 'session/s/state',
      payload: { payload: { text: 't' } },
    })
    // The runtime's host calls ride its own host port; none is published for a client to execute.
    expect(classifyManagerMessage({ type: 'bridge.request', requestSessionId: 's', payload: { id: 'r' } })).toBeNull()
  })

  it('routes manager-level events to sessions / tasks / diag, and leaves point-to-point replies and junk alone', () => {
    expect(classifyManagerMessage({ type: 'session.updated', payload: {} })?.topic).toBe(topic.sessions())
    expect(classifyManagerMessage({ type: 'session.summary', payload: {} })?.topic).toBe(topic.sessions())
    expect(classifyManagerMessage({ type: 'worker.error', payload: { code: 'x' } })?.topic).toBe(topic.sessions())
    expect(classifyManagerMessage({ type: 'task.stopped', payload: {} })?.topic).toBe(topic.tasks())
    expect(classifyManagerMessage({ type: 'trace.record', payload: {} })?.topic).toBe(topic.diagTrace())
    expect(classifyManagerMessage({ type: 'worker.log', payload: {} })?.topic).toBe(topic.diagTrace())
    expect(classifyManagerMessage({ type: 'toolDetail.ready', payload: {} })).toBeNull()
    expect(classifyManagerMessage({ type: 'trace.snapshot', payload: {} })).toBeNull()
    expect(classifyManagerMessage({ type: 'worker.log.snapshot', payload: {} })).toBeNull()
    expect(classifyManagerMessage({ type: 'something.else' })).toBeNull()
    expect(classifyManagerMessage(null)).toBeNull()
    expect(classifyManagerMessage({ noType: true })).toBeNull()
  })

  it('every worker inbound message type has a session action, and the seam maps names both ways', () => {
    const sample: AgentWorkerInboundMessage['type'][] = ['worker.submitMessage', 'worker.getSkillBody']
    for (const type of sample) {
      const act = type.slice('worker.'.length) as keyof typeof WORKER_ACTION_SCOPES
      expect(WORKER_ACTION_SCOPES[act]).toBeDefined()
      expect(sessionRouteFor(type)).toBe(`session.${act}`)
    }
    // No client sends worker.init: it opens (control) and the runtime builds the init.
    expect((WORKER_ACTION_SCOPES as Record<string, unknown>).init).toBeUndefined()
    // Nor does a client answer or push host bridge traffic for a session.
    expect((WORKER_ACTION_SCOPES as Record<string, unknown>).bridgeResponse).toBeUndefined()
    expect((WORKER_ACTION_SCOPES as Record<string, unknown>).bridgeEvent).toBeUndefined()
    expect(SESSION_MANAGER_ACTION_SCOPES.open).toBe('control')
    expect(WORKER_ACTION_SCOPES.submitMessage).toBe('control')
    expect(WORKER_ACTION_SCOPES.getMessages).toBe('observe')
    expect(eventToManagerMessage({ topic: 't', seq: 1, form: 'delta', type: 'worker.stream', payload: { payload: { a: 1 } } })).toEqual({
      type: 'worker.stream',
      payload: { a: 1 },
    })
    expect(eventToManagerMessage({ topic: 't', seq: 1, form: 'snapshot', payload: null })).toBeNull()
  })
})

describe('session surface over the hub', () => {
  it('advertises session / task / diag with the declared scopes', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const caps = connection.welcome!.server.capabilities
    expect(caps.find(c => c.cap === 'session')?.acts).toEqual(expect.arrayContaining(['open', 'submitMessage', 'list', 'getToolDetail', 'fork']))
    expect(caps.find(c => c.cap === 'task')?.acts).toEqual(['stop', 'resume', 'transcript', 'recoverBackground'])
    expect(caps.find(c => c.cap === 'diag')?.acts).toEqual(['traceFlush'])
    expect(rig.registry.advertise({ mode: 'observe', sessions: 'all' }).find(c => c.cap === 'session')?.acts).toEqual([
      'getMessages', 'getMessagesSince', 'getState', 'getToolCallDetail', 'getTurnDiffDetail', 'getTurnDiffHistory', 'getSkillBody', 'list', 'getToolDetail', 'transcript',
    ])
    // No per-client detach: the shared virtual port leaves a session with its last topic subscriber.
    expect(caps.find(c => c.cap === 'session')?.acts).not.toContain('detach')
    expect(caps.find(c => c.cap === 'session')?.acts).not.toContain('init')
    expect(rig.registry.advertise({ mode: 'control', sessions: 'all' }).find(c => c.cap === 'session')?.acts).toContain('open')
    connection.close()
  })

  it('runtime.getBuildEntry is observe (a remote can call it); publishHostEnvironment stays full', async () => {
    // A remote client calls getBuildEntry right after welcome to detect
    // version skew, so it must be reachable below `full`. publishHostEnvironment
    // is the desktop's own write and must stay `full`.
    const rig = makeRig()
    const observe = rig.registry.advertise({ mode: 'observe', sessions: 'all' })
      .find(c => c.cap === 'runtime')?.acts ?? []
    const full = rig.registry.advertise({ mode: 'full', sessions: 'all' })
      .find(c => c.cap === 'runtime')?.acts ?? []
    expect(observe).toContain('getBuildEntry')
    expect(observe).not.toContain('publishHostEnvironment')
    expect(full).toContain('publishHostEnvironment')
  })

  it('manager reaches diag and the settings-push worker actions; control does not', async () => {
    const rig = makeRig()
    const manager = rig.registry.advertise({ mode: 'manager', sessions: 'all' })
    expect(manager.find(c => c.cap === 'diag')?.acts).toEqual(['traceFlush'])
    expect(manager.find(c => c.cap === 'session')?.acts).toEqual(
      expect.arrayContaining(['applyRuntimeSettings', 'reloadPlugins']),
    )
    const control = rig.registry.advertise({ mode: 'control', sessions: 'all' })
    expect(control.find(c => c.cap === 'diag')).toBeUndefined()
    expect(control.find(c => c.cap === 'session')?.acts).not.toContain('applyRuntimeSettings')
    expect(control.find(c => c.cap === 'session')?.acts).not.toContain('reloadPlugins')
  })

  it('session.open: a scoped client may name template and model, never init fields, and a folder only when it is a known project; the host environment is full-only', async () => {
    const rig = makeRig()
    const control = await connect(rig, 'control')
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e))

    expect(await code(control.request('session.open', {
      sessionId: 's1',
      templateType: 'code',
      selection: { providerId: 'openai', modelId: 'gpt' },
      restored: true,
    }))).toBe('ok')
    expect(rig.manager.opened.at(-1)).toMatchObject({ sessionId: 's1', templateType: 'code', restored: true })

    // A folder the runtime does not know is a new host path: `full` only.
    expect(await code(control.request('session.open', { sessionId: 's1', projectRoot: '/etc' }))).toBe('forbidden_scope')
    expect(await code(control.request('session.open', { sessionId: 's1', init: { cwd: '/x' } }))).toBe('forbidden_scope')
    expect(await code(control.request('session.open', { sessionId: '' }))).toBe('bad_payload')
    expect(await code(control.request('runtime.publishHostEnvironment', { environment: { cwd: '/' } }))).toBe('forbidden_scope')
    expect(rig.manager.opened).toHaveLength(1)

    // A known project opens — bound in the RUNTIME's spelling, not the client's —
    // and the known set is asked for this connection's session scope.
    rig.manager.known = ['/elsewhere', 'C:\\Repo']
    expect(await code(control.request('session.open', { sessionId: 's1', projectRoot: 'c:/repo/', reinit: true }))).toBe('ok')
    expect(rig.manager.opened.at(-1)).toEqual({ sessionId: 's1', projectRoot: 'C:\\Repo', reinit: true })
    expect(rig.manager.knownAskedFor.at(-1)).toBe('all')
    // Known or not, `init` stays full-only.
    expect(await code(control.request('session.open', { sessionId: 's1', projectRoot: 'C:\\Repo', init: {} }))).toBe('forbidden_scope')
    expect(rig.manager.opened).toHaveLength(2)

    const full = await connect(rig)
    expect(await code(full.request('runtime.publishHostEnvironment', { environment: { cwd: '/w', locale: 'en' } }))).toBe('ok')
    expect(rig.manager.hostEnvironment).toEqual({ cwd: '/w', locale: 'en' })
    // The desktop names any folder, as given; nothing is looked up for it.
    const asked = rig.manager.knownAskedFor.length
    expect(await code(full.request('session.open', { sessionId: 's2', projectRoot: '/repo', init: { cwd: '/w' } }))).toBe('ok')
    expect(rig.manager.opened.at(-1)).toMatchObject({ sessionId: 's2', projectRoot: '/repo' })
    expect(rig.manager.knownAskedFor).toHaveLength(asked)
    control.close()
    full.close()
  })

  it('session.updateSessionMetadata: below `full` a folder must be a known project (writing it is binding it); other fields and `full` pass through', async () => {
    const rig = makeRig()
    rig.manager.known = ['/repo']
    const control = await connect(rig, 'control')
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e))
    const metadataWrites = () => rig.manager.dispatched.filter(m => m.type === 'worker.updateSessionMetadata')

    // The laundering path: a persisted folder is re-bound by the session's next
    // open, and `fsx` roots a scoped connection there — so an unknown one is refused.
    expect(await code(control.request('session.updateSessionMetadata', {
      sessionId: 's1',
      payload: { metadata: { projectRoot: '/etc' } },
    }))).toBe('forbidden_scope')
    expect(metadataWrites()).toHaveLength(0)

    await control.request('session.updateSessionMetadata', {
      sessionId: 's1',
      payload: { metadata: { projectRoot: '/repo/', composerDraft: 'd' } },
    })
    expect(metadataWrites().at(-1)).toEqual({
      type: 'worker.updateSessionMetadata',
      sessionId: 's1',
      payload: { metadata: { projectRoot: '/repo', composerDraft: 'd' } },
    })
    await control.request('session.updateSessionMetadata', { sessionId: 's1', payload: { metadata: { composerDraft: 'x' } } })
    expect(metadataWrites().at(-1)).toEqual({
      type: 'worker.updateSessionMetadata',
      sessionId: 's1',
      payload: { metadata: { composerDraft: 'x' } },
    })

    const full = await connect(rig)
    await full.request('session.updateSessionMetadata', { sessionId: 's1', payload: { metadata: { projectRoot: '/anywhere' } } })
    expect(metadataWrites().at(-1)).toMatchObject({ payload: { metadata: { projectRoot: '/anywhere' } } })
    control.close()
    full.close()
  })

  it('session.<act> dispatches the worker message through the virtual port; a payload without sessionId is bad_payload', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    await connection.request('session.submitMessage', { sessionId: 's1', payload: { prompt: 'hi' } })
    expect(rig.manager.dispatched.at(-1)).toEqual({ type: 'worker.submitMessage', sessionId: 's1', payload: { prompt: 'hi' } })
    expect(rig.manager.port).toBe(rig.surface.port)
    await expect(connection.request('session.submitMessage', { payload: {} })).rejects.toMatchObject({ code: 'bad_payload' })
    // An empty session id is no session id.
    await expect(connection.request('session.submitMessage', { sessionId: '', payload: {} })).rejects.toMatchObject({ code: 'bad_payload' })
    // A payload smuggling its own `type` cannot change what the hub authorized.
    await connection.request('session.interrupt', { sessionId: 's1', type: 'worker.applyRuntimeSettings', config: { x: 1 } })
    expect(rig.manager.dispatched.at(-1)).toEqual({ type: 'worker.interrupt', sessionId: 's1', config: { x: 1 } })
    await connection.request('task.stop', { sessionId: 's1', type: 'worker.init' })
    expect(rig.manager.dispatched.at(-1)).toEqual({ type: 'task.stop', sessionId: 's1' })
    await expect(connection.request('session.bridgeResponse', { sessionId: 's1', payload: { id: 'b' } })).rejects.toMatchObject({ code: 'unknown_route' })
    await expect(connection.request('session.bridgeEvent', { sessionId: 's1', payload: {} })).rejects.toMatchObject({ code: 'unknown_route' })
    await connection.request('session.rename', { sessionId: 's1', title: 'T', requestId: 'r1' })
    expect(rig.manager.dispatched.at(-1)).toEqual({ type: 'session.rename', sessionId: 's1', title: 'T', requestId: 'r1' })
    await connection.request('session.pin', { sessionId: 's1', pinned: true, requestId: 'r1' })
    expect(rig.manager.dispatched.at(-1)).toEqual({ type: 'session.pin', sessionId: 's1', pinned: true, requestId: 'r1' })
    await expect(connection.request('session.pin', { sessionId: 's1', pinned: 'yes' })).rejects.toMatchObject({ code: 'bad_payload' })
    // A fork that names no cut copies the whole conversation.
    await connection.request('session.fork', { fromSessionId: 's1' })
    expect(rig.manager.dispatched.at(-1)).toEqual({ type: 'session.fork', fromSessionId: 's1' })
    await connection.request('session.fork', { fromSessionId: 's1', cutUuid: 'u' })
    expect(rig.manager.dispatched.at(-1)).toMatchObject({ type: 'session.fork', fromSessionId: 's1' })
    // The fork's session binding is judged on `fromSessionId` — the id the
    // manager acts on — never on a `sessionId` riding along in the payload.
    const fork = rig.registry.resolve('session', 'fork')!.spec
    expect(fork.sessionOf!({ fromSessionId: 's2', sessionId: 's1' })).toBe('s2')
    expect(fork.sessionOf!({ sessionId: 's1' })).toBeUndefined()
    await expect(connection.request('session.fork', { sessionId: 's1', cutUuid: 'u' })).rejects.toMatchObject({ code: 'bad_payload' })
    // A retargeted fork binds its copy to a folder: below `full`, only a known project.
    rig.manager.known = ['D:\\work\\app']
    const control = await connect(rig, 'control')
    await control.request('session.fork', { fromSessionId: 's1', retarget: { templateType: 'code', projectRoot: 'd:/work/app/' } })
    expect(rig.manager.dispatched.at(-1)).toEqual({
      type: 'session.fork',
      fromSessionId: 's1',
      retarget: { templateType: 'code', projectRoot: 'D:\\work\\app' },
    })
    await expect(
      control.request('session.fork', { fromSessionId: 's1', retarget: { templateType: 'code', projectRoot: 'C:/Users/me/secrets' } }),
    ).rejects.toMatchObject({ code: 'forbidden_scope' })
    control.close()
    expect(await connection.request('session.list')).toEqual({ sessions: [{ sessionId: 's1', initialized: true }] })
    await connection.request('task.stop', { sessionId: 's1', requestId: 'q' })
    expect(rig.manager.dispatched.at(-1)).toEqual({ type: 'task.stop', sessionId: 's1', requestId: 'q' })
    connection.close()
  })

  it('what the manager posts to the virtual port reaches subscribers of the right topic, once', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const state: unknown[] = []
    const stream: unknown[] = []
    connection.subscribe(topic.session('s1', 'state'), e => state.push(e))
    connection.subscribe(topic.session('s1', 'stream'), e => stream.push(e))
    await until(() => state.length === 1 && stream.length === 1, 'baseline snapshots')
    // The live session's provider snapshot carries its current state.
    expect(state[0]).toMatchObject({ form: 'snapshot', type: 'worker.state', payload: { payload: { sessionId: 's1' } } })
    // Attached once for the session even though two kinds are held.
    expect(rig.manager.attached).toEqual([['s1', 'attach']])
    rig.surface.port.postMessage({ type: 'worker.stream', sessionId: 's1', payload: { tok: 1 } })
    rig.surface.port.postMessage({ type: 'worker.completed', sessionId: 's1', payload: {} })
    await until(() => stream.length === 2 && state.length === 2, 'live events')
    expect(stream[1]).toMatchObject({ type: 'worker.stream', payload: { payload: { tok: 1 } } })
    expect(state[1]).toMatchObject({ type: 'worker.completed' })
    connection.close()
    await until(() => rig.manager.attached.length === 2, 'detach on close')
    expect(rig.manager.attached[1]).toEqual(['s1', 'detach'])
  })

  it('sessions topic: list snapshot from the manager, list-subscription held while anyone listens', async () => {
    const rig = makeRig()
    const a = await connect(rig)
    const b = await connect(rig)
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    const offA = a.subscribe(topic.sessions(), e => seenA.push(e))
    const offB = b.subscribe(topic.sessions(), e => seenB.push(e))
    await until(() => seenA.length === 1 && seenB.length === 1, 'list snapshots')
    expect(seenA[0]).toMatchObject({ form: 'snapshot', type: 'session.list', payload: { payload: { sessions: [{ sessionId: 's1' }] } } })
    expect(rig.manager.listSubscribed).toBe(1)
    rig.surface.port.postMessage({ type: 'session.updated', payload: { session: { sessionId: 's1' } } })
    await until(() => seenA.length === 2 && seenB.length === 2, 'fan-out to both')
    offA()
    await flush()
    expect(rig.manager.listSubscribed).toBe(1)
    offB()
    await until(() => rig.manager.listSubscribed === 0, 'list unsubscribed with the last listener')
    a.close()
    b.close()
  })

  it('a connection bound to a list of sessions sees only those sessions: the list snapshot, its deltas, session.list and the task events', async () => {
    const rig = makeRig()
    rig.manager.buildSessionInfoList = () =>
      [{ sessionId: 's1', initialized: true, title: 'Mine' }, { sessionId: 's2', initialized: true, title: 'Secret' }] as never
    const narrow: ConnectionInfo = { connectionId: 'n', clientId: 'n', kind: 'mobile', scope: { mode: 'control', sessions: ['s1'] }, transport: 'websocket', connectedAt: 0 }
    const seen: EvtFrame[] = []
    await rig.broker.subscribe({ conn: narrow, send: e => seen.push(e), bufferedBytes: () => 0 }, topic.sessions())
    expect(seen[0]).toMatchObject({ form: 'snapshot', type: 'session.list' })
    expect((seen[0]!.payload as { payload: { sessions: unknown[] } }).payload.sessions).toEqual([{ sessionId: 's1', initialized: true, title: 'Mine' }])

    const post = (message: Record<string, unknown>) => rig.surface.port.postMessage(message)
    post({ type: 'session.updated', payload: { session: { sessionId: 's2', title: 'Secret' } } })
    post({ type: 'session.updated', payload: { session: { sessionId: 's1' } } })
    post({ type: 'session.list', payload: { sessions: [{ sessionId: 's1' }, { sessionId: 's2' }] } })
    post({
      type: 'session.summary',
      payload: {
        sessions: [{ sessionId: 's1', running: true }, { sessionId: 's2', running: false }],
        subAgents: [{ sessionId: 'sub-1', spawnerSessionId: 's1' }, { sessionId: 'sub-2', spawnerSessionId: 's2' }],
        skills: [{ spawnerSessionId: 's2', name: 'x' }],
      },
    })
    post({ type: 'session.removed', payload: { sessionId: 's2' } })
    post({ type: 'session.forked', payload: { fromSessionId: 's1', newSessionId: 's9' } })
    post({ type: 'worker.error', payload: { code: 'x', message: 'm' } })
    // Every event spends its seq; the withheld ones as typeless null deltas.
    expect(seen.slice(1).map(e => [e.seq, e.type, e.payload])).toEqual([
      [1, undefined, null],
      [2, 'session.updated', { payload: { session: { sessionId: 's1' } } }],
      [3, 'session.list', { payload: { sessions: [{ sessionId: 's1' }] } }],
      [4, 'session.summary', {
        payload: {
          sessions: [{ sessionId: 's1', running: true }],
          subAgents: [{ sessionId: 'sub-1', spawnerSessionId: 's1' }],
          skills: [],
        },
      }],
      [5, undefined, null],
      [6, 'session.forked', { payload: { fromSessionId: 's1', newSessionId: 's9' } }],
      [7, 'worker.error', { payload: { code: 'x', message: 'm' } }],
    ])
    // An event shape the table does not know is withheld, never passed through.
    expect(sessionsEventFor(narrow, 'session.somethingNew', { payload: { sessionId: 's2' } })).toBeUndefined()
    const everything = { ...narrow, scope: { mode: 'control' as const, sessions: 'all' as const } }
    expect(sessionsEventFor(everything, 'session.somethingNew', { payload: { sessionId: 's2' } })).toEqual({ payload: { sessionId: 's2' } })

    // The request form of the list is cut the same way.
    const list = rig.registry.resolve('session', 'list')!
    const request = { id: 'r', route: { cap: 'session', act: 'list' }, payload: {}, conn: narrow, signal: new AbortController().signal, blobs: {} as never }
    expect(await list.handle(request, {} as RuntimeContext)).toEqual({ sessions: [{ sessionId: 's1', initialized: true, title: 'Mine' }] })

    // The task events name the task's session; the other session's are withheld.
    const tasks: EvtFrame[] = []
    await rig.broker.subscribe({ conn: narrow, send: e => tasks.push(e), bufferedBytes: () => 0 }, topic.tasks())
    post({ type: 'task.stopped', payload: { sessionId: 's2', status: 'stopped' } })
    post({ type: 'task.stopped', payload: { sessionId: 's1', status: 'stopped' } })
    expect(tasks.slice(1).map(e => [e.type, e.payload])).toEqual([
      [undefined, null],
      ['task.stopped', { payload: { sessionId: 's1', status: 'stopped' } }],
    ])
  })

  it('getToolDetail and diag.traceFlush are answered from host methods, not by waiting on port replies', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    expect(await connection.request('session.getToolDetail', { sessionId: 's1', toolCallId: 'tc1' })).toEqual({ detail: { id: 'tc1' } })
    expect(await connection.request('session.getToolDetail', { sessionId: 's1', toolCallId: 'missing' })).toEqual({ detail: null })
    expect(rig.manager.toolDetailRequests).toEqual([['s1', 'tc1'], ['s1', 'missing']])
    expect(rig.manager.dispatched.some(m => m.type === 'toolDetail.subscribe')).toBe(false)
    await expect(connection.request('session.getToolDetail', { sessionId: 's1' })).rejects.toMatchObject({ code: 'bad_payload' })
    expect(await connection.request('diag.traceFlush')).toEqual({ records: ['r'], logEntries: ['l'] })
    expect(rig.manager.flushes).toBe(1)
    expect(rig.manager.dispatched.some(m => m.type === 'trace.flush')).toBe(false)
    connection.close()
  })

  it('diag/trace is full-only and starts the tracer subscription with the first subscriber', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const seen: unknown[] = []
    const off = connection.subscribe(topic.diagTrace(), e => seen.push(e))
    await until(() => rig.manager.dispatched.some(m => m.type === 'trace.subscribe'), 'trace.subscribe')
    rig.surface.port.postMessage({ type: 'trace.record', payload: { record: 1 } })
    await until(() => seen.length === 2, 'baseline + record')
    off()
    await until(() => rig.manager.dispatched.some(m => m.type === 'trace.unsubscribe'), 'trace.unsubscribe')
    expect(rig.broker.authorize(topic.diagTrace(), { connectionId: 'x', clientId: 'x', kind: 'mobile', scope: { mode: 'control', sessions: 'all' }, transport: 'websocket', connectedAt: 0 })).toBe('forbidden')
    connection.close()
  })

  it('a session topic outside scope.sessions is forbidden; dropSessionTopics forgets the session', () => {
    const rig = makeRig()
    const narrow = { connectionId: 'n', clientId: 'n', kind: 'mobile' as const, scope: { mode: 'control' as const, sessions: ['s1'] }, transport: 'websocket' as const, connectedAt: 0 }
    expect(rig.broker.authorize(topic.session('s1', 'state'), narrow)).toBe('ok')
    expect(rig.broker.authorize(topic.session('s2', 'state'), narrow)).toBe('forbidden')
    rig.broker.publish(topic.session('s1', 'stream'), 'x')
    expect(rig.broker.seqOf(topic.session('s1', 'stream'))).toBe(1)
    rig.surface.dropSessionTopics('s1')
    expect(rig.broker.seqOf(topic.session('s1', 'stream'))).toBe(0)
  })

  it("a connection's first session topic adds it to the session's mod roster, its last takes it off (session.attach / detach)", async () => {
    resetModSlotRegistryForTests()
    const rig = makeRig()
    const a = await connect(rig)
    const b = await connect(rig)
    const seen: unknown[] = []
    const offState = a.subscribe(topic.session('s1', 'state'), e => seen.push(e))
    const offStream = a.subscribe(topic.session('s1', 'stream'), e => seen.push(e))
    b.subscribe(topic.session('s1', 'state'), e => seen.push(e))
    await until(() => modRoster('s1').length === 2, 'both clients attached')
    // One entry per connection, however many of the session's topics it holds.
    const ids = modRoster('s1').map(client => client.clientId)
    expect(new Set(ids).size).toBe(2)
    expect(modRoster('s1').every(client => client.surface === 'desktop')).toBe(true)
    offState()
    await flush()
    expect(modRoster('s1')).toHaveLength(2)
    offStream()
    await until(() => modRoster('s1').length === 1, 'a left with its last topic')
    b.close()
    await until(() => modRoster('s1').length === 0, 'b left when its connection closed')
    a.close()
  })
})

describe('createWorkerTransportOverConnection (the BrowserRuntimeClient seam)', () => {
  it('worker.init subscribes the session topics and becomes session.open; replies come back as worker.* messages', async () => {
    const rig = makeRig()
    const connectionPromise = connect(rig)
    // Pending connection: operations queue until welcome.
    const transport = createWorkerTransportOverConnection(connectionPromise)
    const received: Array<Record<string, unknown>> = []
    transport.addMessageListener(m => received.push(m as unknown as Record<string, unknown>))
    transport.postMessage({ type: 'worker.init', payload: { sessionId: 's1' } as never })
    await until(() => received.some(m => m.type === 'worker.ready'), 'worker.ready via topic')
    expect(rig.manager.opened[0]).toMatchObject({ sessionId: 's1', init: { sessionId: 's1' } })
    expect(rig.manager.dispatched.find(m => m.type === 'worker.init')).toMatchObject({ sessionId: 's1', payload: { sessionId: 's1' } })
    // The provider's snapshot (form snapshot) is NOT replayed as a message — only live events are.
    expect(received.map(m => m.type)).toEqual(['worker.ready'])
    expect(received[0]).toEqual({ type: 'worker.ready', payload: { initialized: true, sessionId: 's1' } })

    transport.postMessage({ type: 'worker.getMessages' } as never)
    await until(() => received.some(m => m.type === 'worker.messages'), 'worker.messages')
    expect(rig.manager.dispatched.at(-1)).toEqual({ type: 'worker.getMessages', sessionId: 's1' })

    // A bridge.request posted to the virtual port reaches no client.
    rig.surface.port.postMessage({ type: 'bridge.request', requestSessionId: 's1', payload: { id: 'q' } })
    await flush()
    expect(received.some(m => m.type === 'worker.bridgeRequest' || m.type === 'bridge.request')).toBe(false)

    // Events for another session never reach this transport.
    rig.surface.port.postMessage({ type: 'worker.stream', sessionId: 'other', payload: {} })
    await flush()
    expect(received.filter(m => m.type === 'worker.stream')).toHaveLength(0)

    transport.dispose?.()
    // Detach happens through the topic hooks (last subscriber), never via a request.
    await until(() => rig.manager.attached.some(([, k]) => k === 'detach'), 'detach')
    expect(rig.manager.dispatched.some(m => m.type === 'session.detach')).toBe(false)
    ;(await connectionPromise).close()
  })

  it('two transports on one session (strict-mode double mount): disposing one leaves the other receiving events', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const first = createWorkerTransportOverConnection(connection, 's1')
    const second = createWorkerTransportOverConnection(connection, 's1')
    const seenFirst: Array<Record<string, unknown>> = []
    const seenSecond: Array<Record<string, unknown>> = []
    first.addMessageListener(m => seenFirst.push(m as unknown as Record<string, unknown>))
    second.addMessageListener(m => seenSecond.push(m as unknown as Record<string, unknown>))
    first.postMessage({ type: 'worker.init', payload: { sessionId: 's1' } as never })
    second.postMessage({ type: 'worker.init', payload: { sessionId: 's1' } as never })
    await until(() => seenSecond.some(m => m.type === 'worker.ready'), 'both inited')
    expect(rig.manager.attached.filter(([, k]) => k === 'attach')).toHaveLength(1)

    // The stale (first) mount is disposed AFTER the second re-inited — the legacy dispatcher's refcount case.
    first.dispose?.()
    await flush()
    expect(rig.manager.attached.some(([, k]) => k === 'detach')).toBe(false)
    rig.surface.port.postMessage({ type: 'worker.stream', sessionId: 's1', payload: { tok: 'still-here' } })
    await until(() => seenSecond.some(m => m.type === 'worker.stream'), 'survivor still receives')
    expect(seenSecond.at(-1)).toEqual({ type: 'worker.stream', payload: { tok: 'still-here' } })
    expect(seenFirst.some(m => m.type === 'worker.stream')).toBe(false)

    second.dispose?.()
    await until(() => rig.manager.attached.some(([, k]) => k === 'detach'), 'detach with the last holder')
    connection.close()
  })

  it('a connection that never came up is reported once to the session as worker.error, not swallowed', async () => {
    const failed = Promise.reject(new Error('runtime connection closed (transport)'))
    failed.catch(() => {})
    const errors: unknown[] = []
    const transport = createWorkerTransportOverConnection(failed, 's1', { onError: e => errors.push(e) })
    const seen: Array<Record<string, unknown>> = []
    transport.addMessageListener(m => seen.push(m as unknown as Record<string, unknown>))
    transport.postMessage({ type: 'worker.init', payload: { sessionId: 's1' } as never })
    transport.postMessage({ type: 'worker.getState' } as never)
    await flush()
    expect(seen).toEqual([
      { type: 'worker.error', payload: { code: 'runtime_connection_failed', message: 'runtime connection closed (transport)' } },
    ])
    expect(errors.length).toBeGreaterThan(0)
  })

  it('toolDetail.subscribe never answers a premature null: it waits for the sidecar, and unsubscribe stops the wait', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const transport = createWorkerTransportOverConnection(connection, 's1', { toolDetailRetryMs: 5 })
    const manager: Array<Record<string, unknown>> = []
    transport.addManagerListener!(m => manager.push(m as Record<string, unknown>))
    transport.postManagerMessage!({ type: 'toolDetail.subscribe', toolCallIds: ['late1', 'late2'], sessionId: 's1' })
    await until(() => rig.manager.toolDetailRequests.filter(([, id]) => id === 'late1').length >= 3, 'retried while not persisted')
    expect(manager).toEqual([])

    rig.manager.persistedLate.add('late1')
    await until(() => manager.length === 1, 'late1 ready once persisted')
    expect(manager[0]).toEqual({ type: 'toolDetail.ready', payload: { toolCallId: 'late1', detail: { id: 'late1' } } })

    transport.postManagerMessage!({ type: 'toolDetail.unsubscribe', toolCallIds: ['late2'] })
    await flush()
    const asked = rig.manager.toolDetailRequests.length
    rig.manager.persistedLate.add('late2')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(rig.manager.toolDetailRequests.length).toBeLessThanOrEqual(asked + 1)
    expect(manager).toHaveLength(1)
    transport.dispose?.()
    connection.close()
  })

  it('toolDetail.subscribe is refcounted per id: one subscriber leaving keeps the other’s wait alive until the sidecar lands', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const transport = createWorkerTransportOverConnection(connection, 's1', { toolDetailRetryMs: 5 })
    const manager: Array<Record<string, unknown>> = []
    transport.addManagerListener!(m => manager.push(m as Record<string, unknown>))
    // Two cards on the same call (a thread and its search hit, say) subscribe
    // to one id; the first to unmount must not silence the second.
    transport.postManagerMessage!({ type: 'toolDetail.subscribe', toolCallIds: ['late3'], sessionId: 's1' })
    transport.postManagerMessage!({ type: 'toolDetail.subscribe', toolCallIds: ['late3'], sessionId: 's1' })
    await until(() => rig.manager.toolDetailRequests.filter(([, id]) => id === 'late3').length >= 2, 'retried while not persisted')
    transport.postManagerMessage!({ type: 'toolDetail.unsubscribe', toolCallIds: ['late3'] })
    await flush()
    rig.manager.persistedLate.add('late3')
    await until(() => manager.length === 1, 'late3 ready for the remaining subscriber')
    expect(manager[0]).toEqual({ type: 'toolDetail.ready', payload: { toolCallId: 'late3', detail: { id: 'late3' } } })

    // The last subscriber leaving ends the wait for good.
    transport.postManagerMessage!({ type: 'toolDetail.subscribe', toolCallIds: ['late4'], sessionId: 's1' })
    transport.postManagerMessage!({ type: 'toolDetail.subscribe', toolCallIds: ['late4'], sessionId: 's1' })
    transport.postManagerMessage!({ type: 'toolDetail.unsubscribe', toolCallIds: ['late4'] })
    transport.postManagerMessage!({ type: 'toolDetail.unsubscribe', toolCallIds: ['late4'] })
    await flush()
    const asked = rig.manager.toolDetailRequests.length
    rig.manager.persistedLate.add('late4')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(rig.manager.toolDetailRequests.length).toBeLessThanOrEqual(asked + 1)
    expect(manager).toHaveLength(1)
    transport.dispose?.()
    connection.close()
  })

  it('toolDetail.subscribe becomes a request answered as toolDetail.ready; trace.flush returns both snapshots; a setCurrent is unmapped and never dispatched', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const errors: unknown[] = []
    const transport = createWorkerTransportOverConnection(connection, 's1', { onError: e => errors.push(e) })
    const manager: Array<Record<string, unknown>> = []
    transport.addManagerListener!(m => manager.push(m as Record<string, unknown>))
    transport.postManagerMessage!({ type: 'toolDetail.subscribe', toolCallIds: ['tc1'], sessionId: 's1' })
    await until(() => manager.some(m => m.type === 'toolDetail.ready'), 'toolDetail.ready')
    expect(manager[0]).toEqual({ type: 'toolDetail.ready', payload: { toolCallId: 'tc1', detail: { id: 'tc1' } } })
    transport.postManagerMessage!({ type: 'toolDetail.unsubscribe', toolCallIds: ['tc1'] })
    transport.postManagerMessage!({ type: 'trace.flush', requestId: 'f1' })
    await until(() => manager.some(m => m.type === 'worker.log.snapshot'), 'trace snapshots')
    expect(manager.filter(m => m.type === 'trace.snapshot')[0]).toEqual({ type: 'trace.snapshot', requestId: 'f1', payload: { records: ['r'] } })
    transport.postManagerMessage!({ type: 'session.detach', sessionId: 's1' })
    await flush()
    expect(rig.manager.dispatched.some(m => m.type === 'session.detach')).toBe(false)
    transport.postManagerMessage!({ type: 'session.setCurrent', sessionId: 's1' })
    transport.postManagerMessage!({ type: 'session.subscribe', all: true })
    await until(() => manager.some(m => m.type === 'session.list'), 'session.list from the sessions snapshot')
    transport.postManagerMessage!({ type: 'task.stop', sessionId: 's1', requestId: 'r9' })
    await until(() => manager.some(m => m.type === 'task.stopped'), 'task.stopped via tasks topic')
    expect(manager.at(-1)).toEqual({ type: 'task.stopped', payload: { sessionId: 's1', status: 'stopped', requestId: 'r9' } })
    transport.postManagerMessage!({ type: 'bogus.thing' })
    expect(errors.some(e => String(e).includes('unmapped'))).toBe(true)
    expect(rig.manager.dispatched.some(m => m.type === 'session.setCurrent')).toBe(false)
    transport.dispose?.()
    connection.close()
  })

  // The shutdown teammate's read-only tab: `BrowserRuntimeClient.startReadOnly`
  // posts `session.transcript` on the manager channel and waits 15s for a
  // reply. Over THIS transport the action did not exist — it fell through to
  // `default:`, was reported as an unmapped manager message, and was never
  // sent. Every read-only load therefore timed out, which is why the tab showed
  // the loading skeleton and never rendered. Nothing caught it: the direct-port
  // protocol implements it, and the unit tests for `startReadOnly` use a fake
  // transport that answers.
  it('session.transcript is a request answered on the manager channel, never dropped', async () => {
    const rig = makeRig();
    const connection = await connect(rig);
    const errors: unknown[] = [];
    const transport = createWorkerTransportOverConnection(connection, 's1', {
      onError: e => errors.push(e),
    });
    const manager: Array<Record<string, unknown>> = [];
    transport.addManagerListener!(m => manager.push(m as Record<string, unknown>));
    transport.postManagerMessage!({
      type: 'session.transcript',
      sessionId: 'shutdown-child',
      requestId: 'rq1',
    });
    await until(
      () => manager.some(m => m.type === 'session.transcript'),
      'session.transcript reply',
    );
    expect(manager.at(-1)).toEqual({
      type: 'session.transcript',
      payload: {
        sessionId: 'shutdown-child',
        requestId: 'rq1',
        messages: [{type: 'user', uuid: 'shutdown-child-u1'}],
      },
    });
    // Answered from the host method, not by waiting on a port reply — there is
    // no runtime for a shutdown session to post one.
    expect(rig.manager.transcriptRequests).toEqual(['shutdown-child']);
    expect(errors.some(e => String(e).includes('unmapped'))).toBe(false);
    transport.dispose?.();
    connection.close();
  });

  it('a transcript READ FAILURE is answered with an error, not left to time out', async () => {
    // The tab must be able to tell "could not read this" from "still reading".
    // Silence is the one answer it cannot act on.
    const rig = makeRig();
    rig.manager.transcriptError = 'EIO: disk read failed';
    const connection = await connect(rig);
    const transport = createWorkerTransportOverConnection(connection, 's1');
    const manager: Array<Record<string, unknown>> = [];
    transport.addManagerListener!(m => manager.push(m as Record<string, unknown>));
    transport.postManagerMessage!({
      type: 'session.transcript',
      sessionId: 'shutdown-child',
      requestId: 'rq2',
    });
    await until(
      () => manager.some(m => m.type === 'session.transcript'),
      'session.transcript error reply',
    );
    expect(manager.at(-1)).toEqual({
      type: 'session.transcript',
      payload: {
        sessionId: 'shutdown-child',
        requestId: 'rq2',
        messages: [],
        error: 'EIO: disk read failed',
      },
    });
    transport.dispose?.();
    connection.close();
  });

  it('managerMessage puts type last and drops a smuggled type', () => {
    expect(managerMessage('worker.interrupt', { sessionId: 's', type: 'worker.init' })).toEqual({ sessionId: 's', type: 'worker.interrupt' })
    expect(managerMessage('task.stop', undefined)).toEqual({ type: 'task.stop' })
    expect(managerMessage('task.stop', 'not-an-object')).toEqual({ type: 'task.stop' })
  })

  it('a failed request surfaces as worker.error to the session listeners instead of vanishing', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const transport = createWorkerTransportOverConnection(connection, 's1')
    const received: Array<Record<string, unknown>> = []
    transport.addMessageListener(m => received.push(m as unknown as Record<string, unknown>))
    // `worker.applyRuntimeSettings` is full-scope — allowed locally — so force an error via a malformed payload route instead:
    // send a message type the registry does not know.
    transport.postMessage({ type: 'worker.notARealMessage' } as never)
    await until(() => received.some(m => m.type === 'worker.error'), 'worker.error')
    expect(received[0]).toMatchObject({ type: 'worker.error', payload: { code: 'runtime_request_failed' } })
    transport.dispose?.()
    connection.close()
  })

  // An `observe` grant may not open a session (`session.open` is `control`).
  // The refusal used to surface as a generic `runtime_request_failed`, which
  // the client rendered as an error banner while it went on waiting for a
  // snapshot — the boot splash never came down on an observe page (the
  // NEXUS_E2E_SCOPE=observe run failed at shared-browser boot).
  it('a scope-refused session.open is reported as session_open_forbidden; other refusals stay runtime_request_failed', async () => {
    const rig = makeRig()
    const connection = await connect(rig, 'observe')
    const transport = createWorkerTransportOverConnection(connection, 's1')
    const received: Array<Record<string, unknown>> = []
    transport.addMessageListener(m => received.push(m as unknown as Record<string, unknown>))
    transport.postMessage({ type: 'worker.init', payload: { sessionId: 's1' } as never })
    await until(() => received.some(m => m.type === 'worker.error'), 'worker.error')
    expect(received[0]).toMatchObject({ type: 'worker.error', payload: { code: SESSION_OPEN_FORBIDDEN } })
    expect(rig.manager.opened).toEqual([])
    // A refused worker action is not an open: it keeps the generic code.
    transport.postMessage({ type: 'worker.submitMessage', payload: {} } as never)
    await until(() => received.filter(m => m.type === 'worker.error').length === 2, 'second worker.error')
    expect(received[1]).toMatchObject({ type: 'worker.error', payload: { code: 'runtime_request_failed' } })
    transport.dispose?.()
    connection.close()
  })

  it('BrowserRuntimeClient on an observe connection settles as a read-only transcript view instead of waiting for a snapshot', async () => {
    const rig = makeRig()
    const connection = await connect(rig, 'observe')
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => createWorkerTransportOverConnection(connection, 's1'),
      hostBridgeTransport: {
        async request(request) {
          return { id: request.id, route: request.route, ok: true, result: {} as never }
        },
      },
      initPayload: { cwd: '/workspace', sessionId: 's1' },
    })
    const state = await client.start()
    expect(rig.manager.opened).toEqual([])
    expect(rig.manager.transcriptRequests).toEqual(['s1'])
    expect(state).toMatchObject({
      status: 'ready',
      lastError: null,
      snapshot: null,
      transcriptOnly: true,
      transcriptMessages: [{ type: 'user', uuid: 's1-u1' }],
    })
    await client.dispose()
    connection.close()
  })

  it('topic ids the seam holds are exactly the four session kinds', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const transport = createWorkerTransportOverConnection(connection, 's7')
    transport.addMessageListener(() => {})
    const held: TopicId[] = ['state', 'transcript', 'stream', 'diff'].map(k => topic.session('s7', k as never))
    await until(() => held.every(t => rig.broker.subscribersOf(t).length === 1), 'four topics held')
    transport.dispose?.()
    await until(() => held.every(t => rig.broker.subscribersOf(t).length === 0), 'released on dispose')
    connection.close()
  })
})

// The broker's only recovery for a subscriber that missed deltas (it
// lagged, or its `since` fell out of the replay ring) is a fresh snapshot,
// and the session topics snapshot to `null` (all but `state`). The seam used
// to drop every snapshot, so the deltas of the gap were simply lost: a missed
// `worker.completed` left the client in `submitting`, missed `worker.messages`
// left the thread stale. Driven through the REAL broker lag path: the server
// end of the connection reports a backlog past `lagBytes`, then drains.
describe('createWorkerTransportOverConnection recovering a session-topic gap', () => {
  async function connectLaggable(rig: ReturnType<typeof makeRig>) {
    let buffered = 0
    const channel = new MessageChannel()
    const serverTransport = createMessagePortTransport(channel.port1)
    rig.hub.attach({ ...serverTransport, bufferedBytes: () => buffered })
    const connection = await connectRuntime({
      transport: createMessagePortTransport(channel.port2),
      client: { clientId: 'c', kind: 'desktop-shell' },
    })
    return {
      connection,
      lag: () => {
        buffered = 2 * 1024 * 1024
      },
      drain: () => {
        buffered = 0
      },
    }
  }

  /** One manager message per session topic kind, as the worker would post them. */
  function postEachKind(rig: ReturnType<typeof makeRig>, tag: string, state: Record<string, unknown> = {}): void {
    const post = (message: Record<string, unknown>) => rig.surface.port.postMessage({ sessionId: 's1', ...message })
    post({ type: 'worker.state', payload: { sessionId: 's1', initialized: true, isBusy: true, tag, ...state } })
    post({ type: 'worker.messages', payload: { messages: [tag] } })
    post({ type: 'worker.stream', payload: { event: { tag } } })
    post({ type: 'worker.turnDiffHistory', payload: { turns: [], tag } })
  }

  const getMessagesCount = (rig: ReturnType<typeof makeRig>) =>
    rig.manager.dispatched.filter(m => m.type === 'worker.getMessages').length

  it('the initial snapshots emit nothing; a lag on every topic yields the state snapshot, ONE getMessages and a streamGap', async () => {
    const rig = makeRig()
    const { connection, lag, drain } = await connectLaggable(rig)
    const transport = createWorkerTransportOverConnection(connection, 's1')
    const received: Array<Record<string, unknown>> = []
    transport.addMessageListener(m => received.push(m as unknown as Record<string, unknown>))
    const held: TopicId[] = ['state', 'transcript', 'stream', 'diff'].map(k => topic.session('s1', k as never))
    await until(() => held.every(t => rig.broker.subscribersOf(t).length === 1), 'four topics held')
    await flush()
    // The four initial snapshots (a live `worker.state` among them) are skipped.
    expect(received).toEqual([])

    postEachKind(rig, 'before')
    await until(() => received.length === 4, 'one live event per topic')

    // The backlog passes lagBytes: this round is skipped on every topic...
    lag()
    postEachKind(rig, 'lost', { isBusy: false })
    await flush()
    expect(received).toHaveLength(4)
    // ...and once drained, each topic's next publish starts its recovery snapshot.
    drain()
    const asked = getMessagesCount(rig)
    postEachKind(rig, 'trigger')
    await until(() => received.some(m => m.type === 'worker.messages' && (m.payload as { messages: unknown[] }).messages[0] === 'm1'), 'the refetched transcript')
    await flush()

    const recovered = received.slice(4)
    // `state`: the live snapshot, applied once (it is what the skipped deltas converged to).
    expect(recovered.filter(m => m.type === 'worker.state')).toEqual([
      { type: 'worker.state', payload: { sessionId: 's1', initialized: true } },
    ])
    // `stream`: the client is told its live turn has a hole.
    expect(recovered.filter(m => m.type === 'worker.streamGap')).toEqual([{ type: 'worker.streamGap' }])
    // `transcript` + `diff` + `stream`: exactly one refetch, answered on the transcript topic.
    expect(getMessagesCount(rig) - asked).toBe(1)
    expect(rig.manager.dispatched.filter(m => m.type === 'worker.getMessages').at(-1)).toEqual({
      type: 'worker.getMessages',
      sessionId: 's1',
    })
    // Nothing of the skipped round leaked through.
    expect(JSON.stringify(recovered)).not.toContain('lost')

    // Deltas then flow as before, and a later live event is not a recovery.
    postEachKind(rig, 'after')
    await until(() => received.filter(m => JSON.stringify(m).includes('after')).length === 4, 'live again')
    expect(getMessagesCount(rig) - asked).toBe(1)
    transport.dispose?.()
    connection.close()
  })

  it('BrowserRuntimeClient leaves submitting and shows the runtime transcript although worker.completed fell in the gap', async () => {
    const rig = makeRig()
    const { connection, lag, drain } = await connectLaggable(rig)
    const client = new BrowserRuntimeClient({
      createWorkerTransport: () => createWorkerTransportOverConnection(connection, 's1'),
      hostBridgeTransport: {
        async request(request) {
          return { id: request.id, route: request.route, ok: true, result: {} as never }
        },
      },
      initPayload: { cwd: '/workspace', sessionId: 's1' },
    })
    await client.start()
    await until(() => client.getState().transcriptMessages.length === 1, 'the opening transcript')
    // What the runtime holds once the turn below has run.
    rig.manager.messages = ['m1', 'turn-reply']
    const post = (message: Record<string, unknown>) => rig.surface.port.postMessage({ sessionId: 's1', ...message })

    // A turn is streaming.
    post({ type: 'worker.state', payload: { sessionId: 's1', initialized: true, isBusy: true } })
    post({ type: 'worker.stream', payload: { event: { type: 'stream_event', event: { type: 'ping' } } } })
    await until(() => client.getState().liveEvents.length === 1, 'the live turn')
    expect(client.getState().status).toBe('submitting')

    // The rest of the turn, its completion included, falls in a lag.
    lag()
    post({ type: 'worker.stream', payload: { event: { type: 'stream_event', event: { type: 'ping', lost: true } } } })
    post({ type: 'worker.completed', payload: { sessionId: 's1', initialized: true, isBusy: false, reason: 'submitMessage_complete' } })
    post({ type: 'worker.messages', payload: { messages: ['lost'] } })
    await flush()
    drain()
    // The next event on each topic is what starts its recovery.
    post({ type: 'worker.state', payload: { sessionId: 's1', initialized: true, isBusy: false } })
    post({ type: 'worker.stream', payload: { event: { type: 'stream_event', event: { type: 'ping', next: true } } } })
    post({ type: 'worker.messages', payload: { messages: ['next'] } })
    await until(() => client.getState().status === 'ready', 'the client leaves submitting')
    await until(() => client.getState().transcriptMessages.length === 2, 'the refetched transcript')
    expect(client.getState().transcriptMessages).toEqual(['m1', 'turn-reply'])
    expect(client.getState().liveEvents).toEqual([])
    await client.dispose()
    connection.close()
  })
})

// A remote whose desktop went away sits in `reconnecting`, where the real
// connection refuses every request at once (retryable). Each refusal became a
// `worker.error`; `BrowserRuntimeClient` answers every `worker.error` by
// re-fetching the transcript through this seam — so the pair spun forever in
// microtasks and the page never yielded (frozen timers, dead clicks).
// `echoErrors` below is that client reaction, capped so a
// regression fails instead of hanging the test run.
describe('createWorkerTransportOverConnection across a reconnect gap', () => {
  function gapConnection() {
    let state: ConnectionState = {
      status: 'reconnecting',
      attempt: 1,
      lastWelcome: {} as never,
      nextAttemptAt: 0,
    }
    const listeners = new Set<(state: ConnectionState) => void>()
    const sent: string[] = []
    let refused = 0
    const conn = {
      get state() {
        return state
      },
      welcome: null,
      watchLinkState(listener: (state: ConnectionState) => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      // Same answers as RuntimeConnection.request in each state.
      request(route: string) {
        if (state.status === 'reconnecting') {
          refused += 1
          return Promise.reject(
            new RuntimeRequestError({ ...wireError('cancelled', 'reconnecting to the runtime'), retryable: true }, route),
          )
        }
        if (state.status === 'closed') {
          refused += 1
          return Promise.reject(new RuntimeRequestError(wireError('cancelled', 'connection closed'), route))
        }
        sent.push(route)
        return Promise.resolve({})
      },
      subscribe: () => () => {},
    } as unknown as RuntimeConnection
    const setState = (next: ConnectionState): void => {
      state = next
      for (const listener of Array.from(listeners)) listener(next)
    }
    return { conn, sent, setState, refused: () => refused, listeners }
  }

  const getMessagesSince = { type: 'worker.getMessagesSince', payload: { sinceOrdinal: 3 } } as never

  function echoErrors(transport: ReturnType<typeof createWorkerTransportOverConnection>, cap = 50) {
    const errors: Array<Record<string, unknown>> = []
    transport.addMessageListener(message => {
      if (message.type !== 'worker.error') return
      errors.push(message as unknown as Record<string, unknown>)
      if (errors.length < cap) transport.postMessage(getMessagesSince)
    })
    return errors
  }

  it('a request made while reconnecting waits for ready and is sent once, instead of looping on refusals', async () => {
    const rig = gapConnection()
    const transport = createWorkerTransportOverConnection(rig.conn, 's1')
    const errors = echoErrors(transport)
    transport.postMessage(getMessagesSince)
    await flush()
    expect(rig.refused()).toBe(0)
    expect(errors).toEqual([])
    rig.setState({ status: 'ready', welcome: {} as never })
    await flush()
    expect(rig.sent).toEqual(['session.getMessagesSince'])
    expect(errors).toEqual([])
    expect(rig.listeners.size).toBe(0)
    transport.dispose?.()
  })

  it('a closed connection reports its refusal to the session once, however many requests follow', async () => {
    const rig = gapConnection()
    rig.setState({ status: 'closed', code: 'transport' })
    const transport = createWorkerTransportOverConnection(rig.conn, 's1')
    const errors = echoErrors(transport)
    transport.postMessage(getMessagesSince)
    transport.postMessage({ type: 'worker.getState' } as never)
    await flush()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ type: 'worker.error', payload: { code: 'runtime_request_failed' } })
    // Both requests, plus the one re-fetch the single error provoked — refused, not reported.
    expect(rig.refused()).toBe(3)
    transport.dispose?.()
  })

  it('a gap that ends closed sends the parked request into the refusal, reported once', async () => {
    const rig = gapConnection()
    const transport = createWorkerTransportOverConnection(rig.conn, 's1')
    const errors = echoErrors(transport)
    transport.postMessage(getMessagesSince)
    transport.postMessage({ type: 'worker.getState' } as never)
    await flush()
    rig.setState({ status: 'closed', code: 'transport' })
    await flush()
    expect(errors).toHaveLength(1)
    expect(rig.sent).toEqual([])
    transport.dispose?.()
  })

  it('dispose drops requests parked in the gap: nothing is sent when the connection comes back', async () => {
    const rig = gapConnection()
    const transport = createWorkerTransportOverConnection(rig.conn, 's1')
    transport.postMessage(getMessagesSince)
    await flush()
    transport.dispose?.()
    expect(rig.listeners.size).toBe(0)
    rig.setState({ status: 'ready', welcome: {} as never })
    await flush()
    expect(rig.sent).toEqual([])
  })

  /**
   * A connection whose `session.getToolDetail` answers are under the test's
   * control: each ask is parked and settled by hand, so the order of asks,
   * gaps and (un)subscribes can be staged exactly.
   */
  function toolDetailConnection() {
    let state: ConnectionState = { status: 'ready', welcome: {} as never }
    const listeners = new Set<(state: ConnectionState) => void>()
    const asks: Array<{ resolve: (detail: unknown) => void; reject: (error: unknown) => void }> = []
    const conn = {
      get state() {
        return state
      },
      welcome: {},
      watchLinkState(listener: (state: ConnectionState) => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      request(route: string) {
        if (route !== 'session.getToolDetail') return Promise.resolve({})
        return new Promise((resolve, reject) => {
          asks.push({ resolve: detail => resolve({ detail }), reject })
        })
      },
      subscribe: () => () => {},
    } as unknown as RuntimeConnection
    const setState = (next: ConnectionState): void => {
      state = next
      for (const listener of Array.from(listeners)) listener(next)
    }
    /** What RuntimeConnection rejects an in-flight request with when the wire drops. */
    const gapRejection = () =>
      new RuntimeRequestError(
        { ...wireError('cancelled', 'runtime connection closed (transport)'), retryable: true },
        'session.getToolDetail',
      )
    return { conn, asks, setState, gapRejection }
  }

  it('a toolDetail ask cut off by the gap is re-asked once the connection is back, not answered null for good', async () => {
    // The ask's own request path went to `conn.request` directly: the gap's
    // retryable refusal landed in its catch, which reported the detail as null
    // — final, to the client — for a call whose sidecar was simply not read yet.
    const rig = toolDetailConnection()
    const transport = createWorkerTransportOverConnection(rig.conn, 's1', { toolDetailRetryMs: 5 })
    const manager: Array<Record<string, unknown>> = []
    transport.addManagerListener!(m => manager.push(m as Record<string, unknown>))
    transport.postManagerMessage!({ type: 'toolDetail.subscribe', toolCallIds: ['tc1'], sessionId: 's1' })
    await flush()
    expect(rig.asks).toHaveLength(1)

    // The wire drops under the in-flight ask: reconnecting, and the request rejects retryable.
    rig.setState({ status: 'reconnecting', attempt: 1, lastWelcome: {} as never, nextAttemptAt: 0 })
    rig.asks[0]!.reject(rig.gapRejection())
    await flush()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(manager).toEqual([])
    expect(rig.asks).toHaveLength(1) // nothing asked into the gap

    rig.setState({ status: 'ready', welcome: {} as never })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(rig.asks.length).toBeGreaterThanOrEqual(2)
    rig.asks[1]!.resolve({ id: 'tc1' })
    await flush()
    expect(manager).toEqual([{ type: 'toolDetail.ready', payload: { toolCallId: 'tc1', detail: { id: 'tc1' } } }])
    transport.dispose?.()
  })

  it('unsubscribe + re-subscribe while an ask is in flight leaves ONE retry chain, not two', async () => {
    // `toolDetailWaits.set` on the stale ask's completion overwrote the new
    // wait's entry without clearing its timer: two chains asked for the same
    // id from then on, and the orphaned one could never be stopped.
    const rig = toolDetailConnection()
    const transport = createWorkerTransportOverConnection(rig.conn, 's1', { toolDetailRetryMs: 10 })
    const manager: Array<Record<string, unknown>> = []
    transport.addManagerListener!(m => manager.push(m as Record<string, unknown>))
    transport.postManagerMessage!({ type: 'toolDetail.subscribe', toolCallIds: ['tc2'], sessionId: 's1' })
    await flush()
    expect(rig.asks).toHaveLength(1)

    transport.postManagerMessage!({ type: 'toolDetail.unsubscribe', toolCallIds: ['tc2'] })
    transport.postManagerMessage!({ type: 'toolDetail.subscribe', toolCallIds: ['tc2'], sessionId: 's1' })
    await flush()
    expect(rig.asks).toHaveLength(2)

    // Both asks come back "not persisted yet"; only the LIVE wait may re-arm.
    rig.asks[0]!.resolve(null)
    rig.asks[1]!.resolve(null)
    await flush()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(rig.asks).toHaveLength(3)
    // The stale ask answering with a detail must not reach the client either.
    rig.asks[2]!.resolve({ id: 'tc2' })
    await flush()
    expect(manager).toEqual([{ type: 'toolDetail.ready', payload: { toolCallId: 'tc2', detail: { id: 'tc2' } } }])
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(rig.asks).toHaveLength(3)
    transport.dispose?.()
  })
})

describe('sessionOpenFor (the seam cuts an init to its scope)', () => {
  const init = {
    sessionId: 's1',
    cwd: '/w',
    projectRoot: '/repo',
    templateType: 'code',
    userSpecifiedProviderId: 'openai',
    userSpecifiedModel: 'gpt',
    userSpecifiedThinkingTier: 'high',
    restoredSessionId: true,
    forceReinit: true,
  }
  const welcome = (mode: 'full' | 'control') => ({ welcome: { scope: { mode } } }) as never

  it('the desktop passes its init along; a scoped client sends only what its scope may say', () => {
    expect(sessionOpenFor(welcome('full'), init as never)).toEqual({
      sessionId: 's1',
      templateType: 'code',
      selection: { providerId: 'openai', modelId: 'gpt', thinkingTier: 'high' },
      restored: true,
      reinit: true,
      init,
    })
    // The folder rides along at every scope (the runtime checks it is a known
    // project); it used to be dropped, which opened the session somewhere else.
    expect(sessionOpenFor(welcome('control'), init as never)).toEqual({
      sessionId: 's1',
      projectRoot: '/repo',
      templateType: 'code',
      selection: { providerId: 'openai', modelId: 'gpt', thinkingTier: 'high' },
      restored: true,
      reinit: true,
    })
  })

  it('hostEnvironmentOf drops every per-session key', () => {
    expect(hostEnvironmentOf({ ...init, traceId: 't', locale: 'en' } as never)).toEqual({
      cwd: '/w',
      templateType: 'code',
      userSpecifiedProviderId: 'openai',
      userSpecifiedModel: 'gpt',
      userSpecifiedThinkingTier: 'high',
      locale: 'en',
    })
  })
})

describe('createSessionStatusChannel (phase 5b: the topbar off the settings port)', () => {
  const state = (sessionId: string, payload: Record<string, unknown>) => ({
    type: 'session.currentState',
    payload: { sessionId, ...payload },
  })

  it('delivers one session\u2019s status, ignores the rest of its state topic, and drops the subscription with the last listener', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const channel = createSessionStatusChannel({ connection: async () => connection })
    const seen: Array<Record<string, unknown>> = []
    const off = channel.subscribe('s1', payload => seen.push(payload as unknown as Record<string, unknown>))
    await flush()

    rig.surface.port.postMessage(state('s1', { kind: 'snapshot', phase: 'running' }))
    await until(() => seen.length === 1, 'the snapshot')
    expect(seen[0]).toMatchObject({ sessionId: 's1', kind: 'snapshot', phase: 'running' })

    // Another session's status, and a non-status message on the same topic.
    rig.surface.port.postMessage(state('other', { kind: 'snapshot', phase: 'idle' }))
    rig.surface.port.postMessage({ type: 'worker.ready', sessionId: 's1', payload: {} })
    await flush()
    expect(seen).toHaveLength(1)

    off()
    rig.surface.port.postMessage(state('s1', { kind: 'delta', phase: 'idle' }))
    await flush()
    expect(seen).toHaveLength(1)
    connection.close()
  })

  it('two listeners on one session share a subscription; each sees every event', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const channel = createSessionStatusChannel({ connection: async () => connection })
    const a: unknown[] = []
    const b: unknown[] = []
    const offA = channel.subscribe('s1', p => a.push(p))
    const offB = channel.subscribe('s1', p => b.push(p))
    await flush()

    rig.surface.port.postMessage(state('s1', { kind: 'delta', phase: 'running' }))
    await until(() => a.length === 1 && b.length === 1, 'both listeners')

    // One leaving keeps the other's feed alive.
    offA()
    rig.surface.port.postMessage(state('s1', { kind: 'delta', phase: 'idle' }))
    await until(() => b.length === 2, 'the survivor still hears it')
    expect(a).toHaveLength(1)
    offB()
    connection.close()
  })
})

describe('createSessionListChannel (phase 5a: the shell off the raw port)', () => {
  it('opens with the session list, turns requests into manager messages, and returns replies as topic events', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const channel = createSessionListChannel({ connection: async () => connection })
    const seen: Array<Record<string, unknown>> = []
    const off = channel.onMessage(message => seen.push(message))

    await until(() => seen.some(m => m.type === 'session.list'), 'the list snapshot')
    expect(seen.find(m => m.type === 'session.list')).toEqual({
      type: 'session.list',
      payload: { sessions: [{ sessionId: 's1', initialized: true }] },
    })
    expect(rig.manager.listSubscribed).toBe(1)

    channel.request('session.rename', { sessionId: 's1', title: 'T', requestId: 'r1' })
    channel.request('session.fork', { fromSessionId: 's1', cutUuid: 'u', requestId: 'r2' })
    channel.request('task.stop', { sessionId: 's1', requestId: 'r3' })
    channel.request('session.pin', { sessionId: 's1', pinned: true, requestId: 'r4' })
    await until(() => rig.manager.dispatched.length >= 4, 'four dispatches')
    expect(rig.manager.dispatched.map(m => m.type)).toEqual(['session.rename', 'session.fork', 'task.stop', 'session.pin'])
    expect(rig.manager.dispatched[1]).toMatchObject({ fromSessionId: 's1', cutUuid: 'u', requestId: 'r2' })

    // The manager answers the port that asked (the hub's); the answer is a topic event.
    rig.manager.port!.postMessage({ type: 'session.forked', payload: { requestId: 'r2', newSessionId: 's2' } })
    await until(() => seen.some(m => m.type === 'session.forked'), 'the fork ack')
    await until(() => seen.some(m => m.type === 'task.stopped'), 'the task reply')
    expect(seen.find(m => m.type === 'task.stopped')).toMatchObject({ payload: { requestId: 'r3', status: 'stopped' } })

    off()
    await until(() => rig.manager.listSubscribed === 0, 'released with the last listener')
    connection.close()
  })

  it('a refused request is reported, not thrown', async () => {
    const rig = makeRig()
    const connection = await connect(rig)
    const errors: unknown[] = []
    const channel = createSessionListChannel({ connection: async () => connection, onError: e => errors.push(e) })
    channel.request('session.delete', {} as Record<string, unknown>)
    await until(() => errors.length === 1, 'the report')
    connection.close()
  })
})
