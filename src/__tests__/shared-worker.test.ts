import { projectHomeFor } from '../utils/conversationStoragePaths'
import { getBackgroundShellSpawner } from '../toolkit/run/backgroundShellSink'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SharedWorkerSessionManager,
  type AgentRuntimeWorkerHandle,
} from '../browser/worker/SharedWorkerSessionManager'
import type {
  AgentSessionPhase as SessionPhase,
  AgentSessionToolInfo as SessionToolInfo,
  AgentToolKind as ToolKind,
} from '../browser/worker/AgentTurnState'
import { initializeRoutineRuntime } from '../routines/routineRuntime'
import {
  processFs,
  installProcessFs,
  resetProcessFs,
} from '../utils/fs/runtimeFs'

// The routine runtime boot does real scheduler/runner work; we only care which
// `fs` bootRoutineRuntimeOnce hands it, so stub the initializer to capture it.
vi.mock('../routines/routineRuntime', async orig => ({
  ...(await orig<typeof import('../routines/routineRuntime')>()),
  initializeRoutineRuntime: vi.fn(async () => ({ stop: () => {} })),
}))
import type {
  SharedWorkerInboundMessage,
  SharedWorkerOutboundMessage,
} from '../browser/worker/sharedWorkerProtocol'
import { isSessionMessage } from '../browser/worker/sharedWorkerProtocol'
import { SharedWorkerPortHub } from '../browser/worker/SharedWorkerPortHub'
import { installPortDisconnectOnUnload } from '../browser/runtimeClient/sharedWorkerConnection'
import {
  createBrowserRuntimeSharedWorker,
  createSharedWorkerTransport,
} from '../browser/webview/BrowserRuntimeClient'
import { createBrowserRuntimeSharedWorker as createSharedWorkerFromFactoryModule } from '../browser/webview/createBrowserRuntimeSharedWorker'
import type {
  AgentRuntimeInitResult,
  AgentRuntimeWorkerInitPayload,
  AgentRuntimeWorkerSnapshot,
  AgentWorkerInboundMessage,
  AgentWorkerOutboundMessage,
} from '../browser/worker/workerProtocol'
import type { AgentRuntimeWorkerOptions } from '../browser/worker/AgentRuntimeWorker'
import type {
  BrowserConversationStorageBackend,
  BrowserConversationStoragePayload,
  BrowserSessionMetadata,
  BrowserTranscriptEntry,
  BrowserTranscriptWriteEntry,
  SessionMetaFile,
} from '../sessions/sessionStore'
import { SESSION_META_TYPE } from '../runtime/VercelModelConstants'
import {
  getAllSkillInvocationEvents,
  recordSkillInvocationEvent,
} from '../skillLibrary/skillInvocationLog'

function createMockPort(): MessagePort & {
  _listeners: Map<string, Array<(event: MessageEvent) => void>>
  _posted: unknown[]
  _simulateMessage: (data: unknown, ports?: MessagePort[]) => void
  _started: boolean
} {
  const listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  const posted: unknown[] = []

  const port = {
    _listeners: listeners,
    _posted: posted,
    _started: false,
    _simulateMessage(data: unknown, ports?: MessagePort[]) {
      const handlers = listeners.get('message') ?? []
      const event = { data, ports: ports ?? [] } as unknown as MessageEvent
      for (const handler of handlers) {
        handler(event)
      }
    },
    addEventListener(type: string, handler: (event: MessageEvent) => void) {
      const existing = listeners.get(type) ?? []
      existing.push(handler)
      listeners.set(type, existing)
    },
    removeEventListener(type: string, handler: (event: MessageEvent) => void) {
      const existing = listeners.get(type) ?? []
      listeners.set(
        type,
        existing.filter(h => h !== handler),
      )
    },
    postMessage(data: unknown) {
      posted.push(data)
    },
    start() {
      port._started = true
    },
    close() {},
    onmessage: null,
    onmessageerror: null,
    dispatchEvent: () => true,
  } as unknown as MessagePort & {
    _listeners: Map<string, Array<(event: MessageEvent) => void>>
    _posted: unknown[]
    _simulateMessage: (data: unknown, ports?: MessagePort[]) => void
    _started: boolean
  }

  return port
}

function createTestSnapshot(
  sessionId: string = 'test-session',
): AgentRuntimeWorkerSnapshot {
  return {
    initialized: true,
    sessionId,
    cwd: '/workspace',
    currentProviderId: 'demo',
    activeModelId: 'mock-model',
    currentSelection: {
      providerId: 'demo',
      modelId: 'mock-model',
    },
    modelCatalog: null,
    availableModels: ['mock-model'],
    toolNames: [],
    commandNames: [],
    messageCount: 0,
    isBusy: false,
    isStopping: false,
    pendingBridgeRequestIds: [],
  }
}

function createMockWorkerFactory() {
  const instances: MockRuntimeWorker[] = []

  function factory(options: AgentRuntimeWorkerOptions): AgentRuntimeWorkerHandle {
    const worker = new MockRuntimeWorker(options)
    instances.push(worker)
    return worker
  }

  return { factory, instances }
}

class MockRuntimeWorker implements AgentRuntimeWorkerHandle {
  private readonly emit: (message: AgentWorkerOutboundMessage) => void
  private sessionId: string | undefined
  private initialized = false
  readonly receivedMessages: AgentWorkerInboundMessage[] = []
  readonly diagnosticGateCalls: AgentRuntimeWorkerInitPayload[] = []
  // Counts session-deleted Stop fires — used by the forceReinit (re-bind)
  // tests to assert the stale worker is torn down before the rebuild.
  stopCallCount = 0
  /**
   * Test control for the generic submit path: 'complete' (default) emits
   * stream+completed synchronously; 'silent' emits nothing so the session
   * stays busy until the test drives completion via the public mark* methods.
   */
  submitBehavior: 'complete' | 'silent' = 'complete'

  constructor(options: AgentRuntimeWorkerOptions) {
    this.emit = options.emit
  }

  applyDiagnosticGates(payload: AgentRuntimeWorkerInitPayload): void {
    this.diagnosticGateCalls.push(payload)
  }

  async fireSessionDeletedStop(): Promise<void> {
    this.stopCallCount += 1
  }

  enqueueSubmit(message: AgentWorkerInboundMessage, _priority: number): void {
    // Direct execution — the mock doesn't model the queue dispatch loop.
    void this.executeSubmitMessage(message)
  }

  private async executeSubmitMessage(message: AgentWorkerInboundMessage): Promise<void> {
    this.receivedMessages.push(message)
    if (message.type !== 'worker.submitMessage') return
    if (message.payload.prompt === '__bridge_fs') {
      this.emit({
        type: 'worker.bridgeRequest',
        payload: {
          id: 'bridge-fs-1',
          route: { namespace: 'nexus', capability: 'fs', action: 'cwd' },
          payload: {},
        },
      })
      return
    }
    if (message.payload.prompt === '__bridge_network') {
      this.emit({
        type: 'worker.bridgeRequest',
        payload: {
          id: 'bridge-network-1',
          route: { namespace: 'nexus', capability: 'network', action: 'httpGet' },
          payload: { url: 'https://example.com/' },
        },
      })
      return
    }
    if (message.payload.prompt === '__bridge_context') {
      this.emit({
        type: 'worker.bridgeRequest',
        payload: {
          id: 'bridge-context-1',
          // A capability no host serves (an untyped name: the never-served
          // `context` capability was removed).
          route: { namespace: 'nexus', capability: 'context' as never, action: 'session' as never },
          payload: {},
        },
      })
      return
    }
    if (message.payload.prompt === '__bridge_browser') {
      this.emit({
        type: 'worker.bridgeRequest',
        payload: {
          id: 'bridge-browser-1',
          route: { namespace: 'nexus', capability: 'session', action: 'onStop' },
          payload: { reason: 'completed' },
        },
      })
      return
    }
    if (this.submitBehavior === 'silent') {
      return
    }
    this.emit({
      type: 'worker.stream',
      payload: {
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 'Hello' },
        },
      },
    })
    this.emit({
      type: 'worker.completed',
      payload: {
        ...this.getSnapshot(),
        reason: 'submitMessage_complete',
      },
    })
  }

  /** Route a submit: busy → pending message, idle → enqueue for execution. */
  private handleSubmitMessage(
    message: Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
  ): void {
    const busy = this.mockPhase.kind === 'running'
    if (busy && typeof message.payload.prompt === 'string') {
      this.pendingMessage = this.pendingMessage
        ? this.pendingMessage + '\n' + message.payload.prompt
        : message.payload.prompt
      this.emit({
        type: 'worker.pendingMessageUpdated',
        payload: { text: this.pendingMessage, reason: 'appended' },
      })
      return
    }
    this.enqueueSubmit(message, 0)
  }

  private pendingMessage: string | undefined
  private mockPhase: SessionPhase = { kind: 'idle' }
  private mockStreamActive = false
  private mockStopRequested = false
  private mockNeedsAnswer = false

  consumePendingAsNextSubmit(): void {
    if (!this.pendingMessage) return
    const text = this.pendingMessage
    this.pendingMessage = undefined
    this.emit({
      type: 'worker.pendingMessageUpdated',
      payload: { text: '', reason: 'consumed' },
    })
    this.enqueueSubmit(
      { type: 'worker.submitMessage', payload: { prompt: text } },
      0,
    )
  }

  pumpSubmits(): void {
    // no-op — the mock dispatches immediately via enqueueSubmit
  }

  isBusy(): boolean {
    return this.mockPhase.kind === 'running'
  }

  isStopping(): boolean {
    return false
  }

  getPhase(): SessionPhase {
    return this.mockPhase
  }

  setPhase(phase: SessionPhase): void {
    this.mockPhase = phase
  }

  markStreamStart(): void {
    this.mockStreamActive = true
    if (this.mockPhase.kind !== 'idle') return
    this.mockPhase = { kind: 'running', sub: { type: 'streaming' } }
  }

  markStreamEnd(): void {
    this.mockStreamActive = false
    if (this.mockPhase.kind !== 'running') return
    if (this.mockPhase.sub.type === 'tools') return
    this.mockPhase = { kind: 'idle' }
    this.consumePendingAsNextSubmit()
    this.pumpSubmits()
  }

  markToolStart(_name: string, _kind: ToolKind, _actionType?: string): void {
    // no-op in test mock
  }

  markToolEnd(): SessionToolInfo | undefined {
    return undefined
  }

  getStopRequested(): boolean {
    return this.mockStopRequested
  }

  setStopRequested(value: boolean): void {
    this.mockStopRequested = value
  }

  getNeedsAnswer(): boolean {
    return this.mockNeedsAnswer
  }

  setNeedsAnswer(value: boolean): void {
    this.mockNeedsAnswer = value
  }

  // Explicit init result. The mock always rebuilds cleanly, so
  // it reports `ready`; tests exercising rejected/failed/superseded paths
  // monkey-patch this per instance.
  async reinitialize(
    payload: AgentRuntimeWorkerInitPayload,
  ): Promise<AgentRuntimeInitResult> {
    await this.receiveFrame({ type: 'worker.init', payload })
    return { status: 'ready', generation: 1 }
  }

  async receiveFrame(message: AgentWorkerInboundMessage): Promise<void> {
    // worker.submitMessage is recorded by executeSubmitMessage (only when
    // actually executed, not when routed to pendingMessage).
    if (message.type !== 'worker.submitMessage') {
      this.receivedMessages.push(message)
    }

    switch (message.type) {
      case 'worker.init':
        this.sessionId = message.payload.sessionId
        this.initialized = true
        this.emit({
          type: 'worker.ready',
          payload: this.getSnapshot(),
        })
        return

      case 'worker.getState':
        this.emit({
          type: 'worker.state',
          payload: this.getSnapshot(),
        })
        return

      case 'worker.getMessages':
        this.emit({
          type: 'worker.messages',
          payload: { messages: [] },
        })
        return

      case 'worker.submitMessage':
        this.handleSubmitMessage(message)
        return

      case 'worker.clearPendingMessage':
        this.pendingMessage = undefined
        this.emit({ type: 'worker.pendingMessageCleared', payload: {} })
        return

      case 'worker.interrupt':
        if (this.pendingMessage) {
          this.pendingMessage = undefined
          this.emit({ type: 'worker.pendingMessageCleared', payload: {} })
        }
        this.mockPhase = { kind: 'idle' }
        this.emit({ type: 'worker.state', payload: this.getSnapshot() })
        return

      case 'worker.bridgeResponse':
        return

      default:
        return
    }
  }

  getSnapshot(): AgentRuntimeWorkerSnapshot {
    return createTestSnapshot(this.sessionId ?? 'unknown')
  }

  /** Test seam: emit an arbitrary outbound message as if the real worker did
   *  (drives `handleWorkerEmit` paths like the needs-answer summary flag). */
  emitOut(message: AgentWorkerOutboundMessage): void {
    this.emit(message)
  }
}

/** Every `worker.bridgeResponse` payload the mock workers received. */
function bridgeResponses(factory: { instances: Array<{ receivedMessages: AgentWorkerInboundMessage[] }> }): unknown[] {
  return factory.instances
    .flatMap(worker => worker.receivedMessages)
    .filter(message => message.type === 'worker.bridgeResponse')
    .map(message => (message as { payload: unknown }).payload)
}

// --- isSessionMessage ---

describe('isSessionMessage', () => {
  it('returns true for worker messages with sessionId', () => {
    const msg: SharedWorkerInboundMessage = {
      type: 'worker.getState',
      sessionId: 'sess-1',
    }
    expect(isSessionMessage(msg)).toBe(true)
  })

  it('returns false for bridge.setPort', () => {
    const msg: SharedWorkerInboundMessage = { type: 'bridge.setPort' }
    expect(isSessionMessage(msg)).toBe(false)
  })

  it('returns false for session.list', () => {
    const msg: SharedWorkerInboundMessage = { type: 'session.list' }
    expect(isSessionMessage(msg)).toBe(false)
  })

  it('returns false for session.detach', () => {
    const msg: SharedWorkerInboundMessage = {
      type: 'session.detach',
      sessionId: 'sess-1',
    }
    expect(isSessionMessage(msg)).toBe(false)
  })
})

// --- page-unload release (client half of port.disconnect) ---

describe('installPortDisconnectOnUnload', () => {
  it('posts port.disconnect ONCE on pagehide / beforeunload, wired once per port', () => {
    const listeners = new Map<string, () => void>()
    const target = globalThis as { addEventListener?: unknown }
    const original = target.addEventListener
    target.addEventListener = (type: string, listener: () => void) => {
      listeners.set(type, listener)
    }
    try {
      const port = createMockPort()
      installPortDisconnectOnUnload(port)
      // Idempotent: a second connection over the same port adds no listeners.
      installPortDisconnectOnUnload(port)
      expect([...listeners.keys()].sort()).toEqual(['beforeunload', 'pagehide'])
      listeners.get('pagehide')!()
      listeners.get('beforeunload')!()
      expect(port._posted).toEqual([{ type: 'port.disconnect' }])
    } finally {
      target.addEventListener = original
    }
  })
})

// --- SharedWorkerPortHub ---

describe('SharedWorkerPortHub', () => {
  it('drops a port whose postMessage throws from every subscriber set', () => {
    // A closed client port gives exactly one signal: `postMessage` throws.
    // Swallowing it left the dead port in the hub for the realm's life.
    const hub = new SharedWorkerPortHub()
    const dead = createMockPort()
    dead.postMessage = () => {
      throw new Error('port closed')
    }
    const live = createMockPort()
    for (const port of [dead, live]) {
      hub.connect(port)
      hub.subscribe(port, true, ['s1'])
      hub.subscribeToolDetail(port, ['t1'])
    }
    hub.broadcastToSession('s1', { type: 'x' })
    expect(hub.portCount).toBe(1)
    expect(hub.getListSubscribers()).toEqual([live])
    expect(hub.getSubscribersFor('s1')).toEqual([live])
    expect([...hub.getToolDetailSubscribers('t1')]).toEqual([live])
    expect(live._posted).toEqual([{ type: 'x' }])
  })
})

// --- SharedWorkerSessionManager ---

describe('SharedWorkerSessionManager', () => {
  let manager: SharedWorkerSessionManager
  let workerFactory: ReturnType<typeof createMockWorkerFactory>

  beforeEach(() => {
    workerFactory = createMockWorkerFactory()
    manager = new SharedWorkerSessionManager({
      createWorker: workerFactory.factory,
    })
  })

  it('connects a port and starts it', () => {
    const port = createMockPort()
    manager.handleConnect(port)
    expect(port._started).toBe(true)
    expect(port._listeners.get('message')?.length).toBe(1)
  })

  // `session.transcript` (read-only shutdown tab): the manager normalizes a
  // bare array OR a {messages:[…]} payload, filters to message-shaped entries,
  // and reports a read failure as an explicit error — never as empty content.
  describe('handleSessionTranscript', () => {
    /** Records the routing calls the read makes before it loads. */
    let routedBeforeLoad: string[] = []
    let loadedAfterRouting: boolean[] = []

    function seedTranscriptStorage(loadImpl: () => Promise<unknown>) {
      routedBeforeLoad = []
      loadedAfterRouting = []
      const coordinator = (
        manager as unknown as {
          storageCoordinator: { storage: unknown; groupedStorage: unknown }
        }
      ).storageCoordinator
      const storage = {
        load: (sessionId: string) => {
          loadedAfterRouting.push(routedBeforeLoad.includes(sessionId))
          return loadImpl()
        },
        // A session nobody has routed yet resolves to the DEFAULT project dir,
        // which answers with an empty payload rather than an error. The read
        // must establish routing first or a teammate's transcript (nested under
        // its lead) is read from a directory that does not hold it.
        routeSessionFromMeta: async (sessionId: string) => {
          routedBeforeLoad.push(sessionId)
          return undefined
        },
      }
      coordinator.storage = storage
      coordinator.groupedStorage = storage
    }

    function requestTranscript(port: ReturnType<typeof createMockPort>) {
      manager.handleConnect(port)
      port._simulateMessage({
        type: 'session.transcript',
        sessionId: 'shutdown-child',
        requestId: 'req-1',
      })
    }

    function lastTranscript(port: ReturnType<typeof createMockPort>) {
      return port._posted
        .map(m => m as { type?: string; payload?: unknown })
        .find(m => m.type === 'session.transcript')?.payload as {
        sessionId?: string
        requestId?: string
        messages?: unknown[]
        error?: string
      } | undefined
    }

    // An `observe` client cannot open a session, so its read can be the
    // runtime's first touch of storage — which used to come up only on a
    // `worker.init`, and the read answered "session storage is not available".
    it('brings storage up from the published host environment when no session has yet', async () => {
      const coordinator = (
        manager as unknown as {
          storageCoordinator: { ensureStorage: (path: string | null) => Promise<void> }
        }
      ).storageCoordinator
      const ensured: Array<string | null> = []
      coordinator.ensureStorage = async path => {
        ensured.push(path)
        seedTranscriptStorage(async () => [{ type: 'user', uuid: 'u1' }])
      }
      ;(manager as unknown as { hostEnvironment: unknown }).hostEnvironment = {
        sessionStoragePath: '/home/.velloc',
      }
      const port = createMockPort()
      requestTranscript(port)
      await new Promise(r => setTimeout(r, 10))
      expect(ensured).toEqual(['/home/.velloc'])
      const payload = lastTranscript(port)
      expect(payload?.messages).toHaveLength(1)
      expect(payload?.error).toBeUndefined()
    })

    it('accepts a bare message array', async () => {
      seedTranscriptStorage(async () => [
        { type: 'user', uuid: 'u1' },
        { type: 'assistant', uuid: 'a1' },
      ])
      const port = createMockPort()
      requestTranscript(port)
      await new Promise(r => setTimeout(r, 10))
      const payload = lastTranscript(port)
      expect(payload?.messages).toHaveLength(2)
      expect(payload?.error).toBeUndefined()
    })

    it('accepts a { messages: [] } record payload', async () => {
      seedTranscriptStorage(async () => ({ messages: [{ type: 'user', uuid: 'u1' }] }))
      const port = createMockPort()
      requestTranscript(port)
      await new Promise(r => setTimeout(r, 10))
      expect(lastTranscript(port)?.messages).toHaveLength(1)
    })

    it('filters out non-message entries', async () => {
      seedTranscriptStorage(async () => [
        { type: 'user', uuid: 'u1' },
        { noType: true },
        null,
        'a string',
      ])
      const port = createMockPort()
      requestTranscript(port)
      await new Promise(r => setTimeout(r, 10))
      expect(lastTranscript(port)?.messages).toEqual([{ type: 'user', uuid: 'u1' }])
    })

    // The storage load KEEPS the title records and the legacy meta line (the
    // store folds them into meta), and each one has a `type`. The read-only tab
    // renders this list as-is, so after a restart a shut-down teammate's
    // `ai-title` came up as an assistant bubble of raw JSON.
    it('drops the title records and the legacy session meta line', async () => {
      seedTranscriptStorage(async () => [
        { type: 'user', uuid: 'u1', transcriptLine: 0 },
        { type: 'assistant', uuid: 'a1', transcriptLine: 1 },
        {
          type: 'ai-title',
          sessionId: 'shutdown-child',
          aiTitle: 'edit the login form',
          updatedAt: 1,
          transcriptLine: 2,
        },
        {
          type: 'custom-title',
          sessionId: 'shutdown-child',
          customTitle: 'login form',
          updatedAt: 2,
          transcriptLine: 3,
        },
        {
          type: '__session_meta',
          sessionId: 'shutdown-child',
          updatedAt: 3,
          transcriptLine: 4,
        },
      ])
      const port = createMockPort()
      requestTranscript(port)
      await new Promise(r => setTimeout(r, 10))
      const payload = lastTranscript(port)
      expect(payload?.error).toBeUndefined()
      expect(payload?.messages).toEqual([
        { type: 'user', uuid: 'u1', transcriptLine: 0 },
        { type: 'assistant', uuid: 'a1', transcriptLine: 1 },
      ])
    })

    it('establishes the session routing BEFORE reading the transcript', async () => {
      seedTranscriptStorage(async () => [{ type: 'user', uuid: 'u1' }])
      const port = createMockPort()
      requestTranscript(port)
      await new Promise(r => setTimeout(r, 10))
      expect(routedBeforeLoad).toEqual(['shutdown-child'])
      expect(loadedAfterRouting).toEqual([true])
      expect(lastTranscript(port)?.messages).toHaveLength(1)
    })

    it('reports a read failure as an explicit error, not an empty transcript', async () => {
      seedTranscriptStorage(async () => {
        throw new Error('EIO: cannot read transcript')
      })
      const port = createMockPort()
      requestTranscript(port)
      await new Promise(r => setTimeout(r, 10))
      const payload = lastTranscript(port)
      expect(payload?.messages).toEqual([])
      expect(payload?.error).toContain('EIO')
    })
  })

  // The worker.init gate: a session whose persisted meta
  // carries the shutdown marker must NEVER get a runtime — even when the
  // boot-active pointer names it before session.list has landed. This is the
  // authoritative chokepoint behind the boot-active-shutdown-tab case.
  describe('worker.init shutdown gate', () => {
    function seedMetaStorage(shutdown: boolean) {
      const coordinator = (
        manager as unknown as {
          storageCoordinator: { storage: unknown; groupedStorage: unknown }
        }
      ).storageCoordinator
      coordinator.storage = {
        readSessionMeta: async () => ({
          schemaVersion: 1,
          sessionId: 'shutdown-child',
          updatedAt: 1,
          metadata: shutdown ? { shutdown: true, shutdownAt: 5 } : {},
        }),
        load: async () => [],
      }
      coordinator.groupedStorage = coordinator.storage
    }

    it('refuses worker.init for a shutdown-marked session — no runtime registered', async () => {
      seedMetaStorage(true)
      const port = createMockPort()
      manager.handleConnect(port)
      port._simulateMessage({
        type: 'worker.init',
        sessionId: 'shutdown-child',
        payload: { cwd: '/workspace', sessionId: 'shutdown-child' },
      })
      await new Promise(r => setTimeout(r, 30))
      const err = port._posted
        .map(m => m as { type?: string; payload?: { code?: string } })
        .find(m => m.type === 'worker.error')
      expect(err?.payload?.code).toBe('session_shutdown')
      // The decisive assertion: no worker was created / no runtime registered.
      expect(workerFactory.instances).toHaveLength(0)
      expect(
        (manager as unknown as { sessions: Map<string, unknown> }).sessions.has(
          'shutdown-child',
        ),
      ).toBe(false)
    })

    // A teammate's runtime is owned by the TeamCoordinator that spawned it and
    // does not survive a browser restart. Clicking its tab afterwards sent a
    // plain worker.init, which booted a FRESH generic runtime at the flat
    // project dir — no transcript there, so the tab opened blank.
    it('refuses worker.init for a teammate whose runtime did not survive a restart, and persists the marker', async () => {
      seedMetaStorage(false)
      const writes: Array<{ id: string; metadata: Record<string, unknown> }> = []
      const coordinator = (
        manager as unknown as {
          storageCoordinator: { storage: Record<string, unknown> }
        }
      ).storageCoordinator
      coordinator.storage.writeSessionMeta = async (
        id: string,
        meta: { metadata: Record<string, unknown> },
      ) => {
        writes.push({ id, metadata: meta.metadata })
      }
      const teammateId = 'teammate-lead-1-worker-1789000000000'
      const port = createMockPort()
      manager.handleConnect(port)
      port._simulateMessage({
        type: 'worker.init',
        sessionId: teammateId,
        payload: {
          cwd: '/workspace',
          sessionId: teammateId,
          projectRoot: 'D:/proj',
        },
      })
      await new Promise(r => setTimeout(r, 30))
      const err = port._posted
        .map(m => m as { type?: string; payload?: { code?: string } })
        .find(m => m.type === 'worker.error')
      expect(err?.payload?.code).toBe('session_shutdown')
      expect(workerFactory.instances).toHaveLength(0)
      expect(
        (manager as unknown as { sessions: Map<string, unknown> }).sessions.has(
          teammateId,
        ),
      ).toBe(false)
      // Persisted, so the tab strip and the next open settle on read-only.
      expect(writes).toHaveLength(1)
      expect(writes[0]?.id).toBe(teammateId)
      expect(writes[0]?.metadata.shutdown).toBe(true)
      // Nothing in this realm ended it: lost to a restart, and said so.
      expect(typeof writes[0]?.metadata.lostAt).toBe('number')
    })

    it('marks a teammate the coordinator tore down as shut down, not LOST, when its own marker write failed', async () => {
      // A deliberate teardown whose marker did not land left the id unmarked;
      // the next worker.init then wrote `lost` — and the lead was told its
      // teammate was lost to a restart. The coordinator's own record says
      // otherwise, so this is the teardown's marker, retried.
      seedMetaStorage(false)
      const writes: Array<{ id: string; metadata: Record<string, unknown> }> = []
      let failNextWrite = true
      const coordinator = (
        manager as unknown as {
          storageCoordinator: { storage: Record<string, unknown> }
        }
      ).storageCoordinator
      coordinator.storage.writeSessionMeta = async (
        id: string,
        meta: { metadata: Record<string, unknown> },
      ) => {
        if (failNextWrite) {
          failNextWrite = false
          throw new Error('EIO')
        }
        writes.push({ id, metadata: meta.metadata })
      }
      const teammateId = 'teammate-lead-1-worker-1789000000002'
      const teams = (
        manager as unknown as {
          teams: {
            teammates: Map<string, unknown>
            teardown(sessionId: string): Promise<void>
          }
        }
      ).teams
      teams.teammates.set(teammateId, {
        teamName: 'lead-1',
        name: 'worker',
        key: 'worker',
        spawnerSessionId: 'lead-1',
        status: 'active',
        startedAt: 1,
        trust: 'trusted',
      })
      await teams.teardown(teammateId)
      expect(writes).toHaveLength(0)

      const port = createMockPort()
      manager.handleConnect(port)
      port._simulateMessage({
        type: 'worker.init',
        sessionId: teammateId,
        payload: { cwd: '/workspace', sessionId: teammateId },
      })
      await new Promise(r => setTimeout(r, 30))
      const err = port._posted
        .map(m => m as { type?: string; payload?: { code?: string } })
        .find(m => m.type === 'worker.error')
      expect(err?.payload?.code).toBe('session_shutdown')
      expect(writes).toHaveLength(1)
      expect(writes[0]?.metadata.shutdown).toBe(true)
      expect(writes[0]?.metadata.lostAt).toBeUndefined()
    })

    it('still refuses an orphaned teammate when the marker cannot be written', async () => {
      const coordinator = (
        manager as unknown as {
          storageCoordinator: { storage: unknown; groupedStorage: unknown }
        }
      ).storageCoordinator
      // No meta row yet: markSessionShutdown reports false.
      coordinator.storage = {
        readSessionMeta: async () => null,
        load: async () => [],
      }
      coordinator.groupedStorage = coordinator.storage
      const teammateId = 'teammate-lead-1-worker-1789000000001'
      const port = createMockPort()
      manager.handleConnect(port)
      port._simulateMessage({
        type: 'worker.init',
        sessionId: teammateId,
        payload: { cwd: '/workspace', sessionId: teammateId },
      })
      await new Promise(r => setTimeout(r, 30))
      const err = port._posted
        .map(m => m as { type?: string; payload?: { code?: string } })
        .find(m => m.type === 'worker.error')
      expect(err?.payload?.code).toBe('session_shutdown')
      expect(workerFactory.instances).toHaveLength(0)
    })

    it('does NOT gate a non-shutdown session', async () => {
      seedMetaStorage(false)
      const port = createMockPort()
      manager.handleConnect(port)
      port._simulateMessage({
        type: 'worker.init',
        sessionId: 'live-session',
        payload: { cwd: '/workspace', sessionId: 'live-session' },
      })
      await new Promise(r => setTimeout(r, 30))
      const err = port._posted
        .map(m => m as { type?: string; payload?: { code?: string } })
        .find(m => m.type === 'worker.error')
      expect(err?.payload?.code).not.toBe('session_shutdown')
    })
  })

  it('deleting a session drops its status cache and leaves the others alone', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    for (const id of ['session-a', 'session-b']) {
      port._simulateMessage({
        type: 'worker.init',
        sessionId: id,
        payload: { cwd: '/workspace', sessionId: id },
      })
    }
    await new Promise(resolve => setTimeout(resolve, 10))
    const feed = manager as unknown as {
      feed: { prevStatus: Map<string, unknown>; emitStatus(id: string): void }
    }
    feed.feed.emitStatus('session-a')
    feed.feed.emitStatus('session-b')
    expect([...feed.feed.prevStatus.keys()].sort()).toEqual(['session-a', 'session-b'])

    port._simulateMessage({ type: 'session.delete', sessionId: 'session-b' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(
      [...feed.feed.prevStatus.keys()],
      'the deleted session must leave nothing that could re-emit',
    ).toEqual(['session-a'])
  })

  it('deleting a session drops its skill event log and recovery entry; the others keep theirs', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    for (const id of ['session-a', 'session-b']) {
      port._simulateMessage({
        type: 'worker.init',
        sessionId: id,
        payload: { cwd: '/workspace', sessionId: id },
      })
      recordSkillInvocationEvent(id, {
        id: `evt-${id}`,
        skillName: 'review',
        skillPath: '/skills/review/SKILL.md',
        invokedAt: 1,
        status: 'loaded',
        agentId: null,
      })
    }
    await new Promise(resolve => setTimeout(resolve, 10))
    const internals = manager as unknown as {
      skillEventsRecovery: Map<string, Promise<void>>
    }
    internals.skillEventsRecovery.set('session-a', Promise.resolve())
    internals.skillEventsRecovery.set('session-b', Promise.resolve())

    port._simulateMessage({ type: 'session.delete', sessionId: 'session-b' })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(getAllSkillInvocationEvents('session-b')).toEqual([])
    expect(internals.skillEventsRecovery.has('session-b')).toBe(false)
    expect(getAllSkillInvocationEvents('session-a').map(e => e.id)).toEqual(['evt-session-a'])
    expect(internals.skillEventsRecovery.has('session-a')).toBe(true)
  })

  it('a reaped background run (sub-agent finalize) leaves no status cache entry behind', async () => {
    // The router refreshes the status feed on `worker.ready` BEFORE the
    // sub-agent interceptor runs, so `prevStatus` grew an entry per
    // background run — and only the UI delete path ever forgot one.
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'parent-fs',
      payload: { cwd: '/workspace', sessionId: 'parent-fs' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const internals = manager as unknown as {
      feed: { prevStatus: Map<string, unknown> }
      sessions: Map<string, unknown>
      taskRegistry: { resolveNative(id: string): string }
    }
    const taskId = manager.spawnSubAgentSession({
      spawnerSessionId: 'parent-fs',
      prompt: 'p',
      description: 'd',
    })!
    const native = internals.taskRegistry.resolveNative(taskId)
    expect(native).toMatch(/^subagent-/)
    // The mock worker completes its single turn at once; the run finalizes
    // and its entry is reaped.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(internals.sessions.has(native)).toBe(false)
    expect(internals.feed.prevStatus.has(native)).toBe(false)
  })

  it('deleting a lead waits for its teammates\u2019 teardown before sweeping storage and forgetting the lead', async () => {
    // `abortTeammatesOf` only FIRED the aborts; each teammate's teardown
    // (marker read-modify-write, disposal, retirement) then raced the lead's
    // recursive `deleteSession` + `deleteMetaByParent`, and `forgetLead` ran
    // before the teardown re-populated what it had cleared.
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'lead-1',
      payload: { cwd: '/workspace', sessionId: 'lead-1' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const teammateId = manager.spawnTeammateSession({
      teamName: 'lead-1',
      teammateName: 'worker',
      prompt: 'do it',
      spawnerSessionId: 'lead-1',
    })!
    expect(teammateId).toMatch(/^teammate-lead-1-worker-/)
    // The teammate runs its first turn and parks on its mailbox.
    await new Promise(resolve => setTimeout(resolve, 10))

    // Storage with a SLOW teammate marker write (the FIRST one — teardown
    // re-asserts the marker after disposal, and that second write is fast),
    // so the ordering is observable.
    const order: string[] = []
    let releaseMetaWrite: () => void = () => {}
    let heldOnce = false
    // A child the lead had on record from an earlier run (already shut down,
    // no live runtime): its meta row goes with the lead's, and so must its
    // cached summary and its clients' list entry.
    const oldChildId = 'teammate-lead-1-old-1700000000000'
    const storage = {
      readSessionMeta: async (id: string) => ({ id, updatedAt: 1, metadata: {} }),
      writeSessionMeta: async (id: string) => {
        order.push(`meta:${id}`)
        if (!heldOnce) {
          heldOnce = true
          await new Promise<void>(resolve => {
            releaseMetaWrite = resolve
          })
        }
        order.push(`meta-done:${id}`)
      },
      loadSessionSummary: async () => null,
      deleteSession: async (id: string) => {
        order.push(`delete:${id}`)
      },
      deleteMetaByParent: async (id: string) => {
        order.push(`deleteMetaByParent:${id}`)
      },
      projectRouteOf: () => undefined,
      listTeammateChildren: async () => [
        { sessionId: oldChildId, teammateName: 'old', shutdown: true },
      ],
    }
    const caches = manager as unknown as {
      sessionMeta: Map<string, unknown>
      fsSummaries: Map<string, unknown>
    }
    caches.fsSummaries.set(oldChildId, { sessionId: oldChildId })
    caches.fsSummaries.set(teammateId, { sessionId: teammateId })
    const coordinator = (
      manager as unknown as {
        storageCoordinator: { storage: unknown; groupedStorage: unknown }
      }
    ).storageCoordinator
    coordinator.storage = storage
    coordinator.groupedStorage = storage
    const teams = (
      manager as unknown as { teams: { wasTornDown(id: string): boolean } }
    ).teams

    port._simulateMessage({
      type: 'session.delete',
      sessionId: 'lead-1',
      requestId: 'req-del',
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    // The teammate's teardown is mid-marker-write: the lead's sweep has NOT
    // started underneath it.
    expect(order).toEqual([`meta:${teammateId}`])
    expect(
      port._posted.some(m => (m as { type?: string }).type === 'session.removed'),
    ).toBe(false)

    releaseMetaWrite()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(order).toEqual([
      `meta:${teammateId}`,
      `meta-done:${teammateId}`,
      // The marker re-asserted once the runtime is disposed (see teardown).
      `meta:${teammateId}`,
      `meta-done:${teammateId}`,
      'delete:lead-1',
      'deleteMetaByParent:lead-1',
    ])
    // `forgetLead` ran AFTER the teardown retired the teammate — nothing of
    // the lead survives in the coordinator.
    expect(teams.wasTornDown(teammateId)).toBe(false)
    const removed = port._posted.filter(
      m => (m as { type?: string }).type === 'session.removed',
    ) as Array<{ payload: { sessionId: string; requestId?: string } }>
    expect(removed[0]?.payload).toEqual({ sessionId: 'lead-1', requestId: 'req-del' })
    // The lead's children are announced too — the one that was running and
    // the one only on record — and their cached summaries go with the rows
    // `deleteMetaByParent` dropped. Before this only the lead was announced:
    // the tab strip kept a child whose storage was gone, and its summary
    // stayed cached here and in every client list until a restart.
    expect(removed.slice(1).map(m => m.payload)).toEqual(
      expect.arrayContaining([{ sessionId: teammateId }, { sessionId: oldChildId }]),
    )
    expect(removed).toHaveLength(3)
    expect(caches.fsSummaries.has(teammateId)).toBe(false)
    expect(caches.fsSummaries.has(oldChildId)).toBe(false)
  })

  it('a turn end runs the session\'s Notification hooks (idle_prompt) beside the turn_complete notice', async () => {
    // F-7: `Notification` had no caller. The session's own runtime now runs
    // those hooks when a turn ends.
    const fired: unknown[] = []
    const internals = manager as unknown as {
      sessions: Map<string, unknown>
      runtimeHub: { broker: { subscribe(sub: unknown, topic: string): Promise<void> } }
      maybeNotifyTurnEnd(sessionId: string, prev: string | null, next: string): void
      buildSessionInfo(sessionId: string): unknown
    }
    // The title is read off the session's snapshot; this entry has none.
    internals.buildSessionInfo = () => ({ title: 'Fix the build' })
    const seen: Array<{ payload: unknown }> = []
    await internals.runtimeHub.broker.subscribe(
      { conn: { connectionId: 'n', clientId: 'n', kind: 'desktop-shell', scope: { mode: 'full', sessions: 'all' }, transport: 'message-port', connectedAt: 0 }, send: (e: { payload: unknown }) => seen.push(e), bufferedBytes: () => 0 },
      'notifications',
    )
    internals.sessions.set('session-n', {
      worker: { fireNotificationHooks: async (notification: unknown) => void fired.push(notification) },
      instanceId: 'i',
      ports: new Set(),
      model: null,
      counters: {},
      needsAnswer: false,
    })
    internals.maybeNotifyTurnEnd('session-n', 'idle', 'idle')
    expect(fired).toEqual([])
    internals.maybeNotifyTurnEnd('session-n', 'streaming', 'idle')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fired).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('is waiting for your input'),
        title: 'Fix the build',
        notificationType: 'idle_prompt',
      }),
    ])
    expect(seen.slice(1).map(e => e.payload)).toEqual([
      expect.objectContaining({ notificationType: 'turn_complete', sessionId: 'session-n' }),
    ])
    internals.sessions.delete('session-n')
    delete (internals as { buildSessionInfo?: unknown }).buildSessionInfo
  })

  it('a turn-end notification names the panel that owns the session; deleting the session forgets the panel', async () => {
    const internals = manager as unknown as {
      panelOfSession: Map<string, string>
      runtimeHub: { broker: { subscribe(sub: unknown, topic: string): Promise<void> } }
      notificationSink(opts: { message: string; notificationType: string; sessionId?: string }): Promise<unknown>
    }
    // `session.open` records the opening window; the notification carries it
    // so that ONE desktop window asks the host for a toast, not every window.
    internals.panelOfSession.set('session-a', 'panel-2')
    internals.panelOfSession.set('session-b', 'panel-3')
    const seen: Array<{ payload: unknown }> = []
    await internals.runtimeHub.broker.subscribe(
      { conn: { connectionId: 'n', clientId: 'n', kind: 'desktop-shell', scope: { mode: 'full', sessions: 'all' }, transport: 'message-port', connectedAt: 0 }, send: (e: { payload: unknown }) => seen.push(e), bufferedBytes: () => 0 },
      'notifications',
    )
    await internals.notificationSink({ message: 'done', notificationType: 'turn_complete', sessionId: 'session-a' })
    await internals.notificationSink({ message: 'done', notificationType: 'turn_complete' })
    expect(seen.slice(1).map(e => e.payload)).toEqual([
      { message: 'done', notificationType: 'turn_complete', sessionId: 'session-a', panelId: 'panel-2' },
      { message: 'done', notificationType: 'turn_complete' },
    ])

    // The map was written on every open and never emptied.
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({ type: 'session.delete', sessionId: 'session-b' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect([...internals.panelOfSession.keys()]).toEqual(['session-a'])
  })

  it('session.open builds the init from the published host environment; a code session takes the last folder of its type', async () => {
    const internals = manager as unknown as {
      runtimeHub: { workspace: { current(): Promise<{ lastFolderByType: Record<string, string> }> } }
      runtimeSessionSurface: { port: MessagePort }
      openSession(port: MessagePort, open: Record<string, unknown>): Promise<void>
      hostEnvironment: unknown
    }
    internals.runtimeHub.workspace.current = async () => ({ lastFolderByType: { code: '/last/code', chat: '/never' } })
    const port = internals.runtimeSessionSurface.port

    // Before the desktop published anything, there is nothing to build from.
    await expect(internals.openSession(port, { sessionId: 'remote-1' })).rejects.toMatchObject({ code: 'host_unavailable' })

    internals.hostEnvironment = { cwd: '/workspace', locale: 'en', templateType: 'agent' }
    await internals.openSession(port, { sessionId: 'remote-code', templateType: 'code' })
    await internals.openSession(port, { sessionId: 'remote-chat', templateType: 'chat' })
    await new Promise(resolve => setTimeout(resolve, 20))

    const initOf = (sessionId: string) =>
      workerFactory.instances
        .flatMap(worker => worker.receivedMessages)
        .find(m => m.type === 'worker.init' && (m as { payload: { sessionId?: string } }).payload.sessionId === sessionId) as
        | { payload: Record<string, unknown> }
        | undefined
    expect(initOf('remote-code')?.payload).toMatchObject({ cwd: '/workspace', locale: 'en', templateType: 'code', projectRoot: '/last/code' })
    expect(initOf('remote-chat')?.payload).toMatchObject({ templateType: 'chat' })
    expect(initOf('remote-chat')?.payload).not.toHaveProperty('projectRoot')
  })

  it('a client that starts viewing a session gets its full status snapshot (presence)', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-v',
      payload: { cwd: '/workspace', sessionId: 'session-v' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    port._simulateMessage({ type: 'session.subscribe', sessionIds: ['session-v'] })
    const presence = (manager as unknown as {
      runtimeHub: { presence: { set(connectionId: string, sessionId: string | null): boolean } }
    }).runtimeHub.presence

    // Emit once so the next ordinary emit would be a delta…
    manager.markStreamStart('session-v')
    manager.markStreamEnd('session-v')
    const before = port._posted.length
    // …but a client starting to view it must get a baseline.
    presence.set('connection-1', 'session-v')
    const states = port._posted
      .slice(before)
      .filter(m => (m as { type?: string }).type === 'session.currentState') as Array<{
      payload: { kind: string; sessionId: string }
    }>
    expect(states.map(m => `${m.payload.sessionId}:${m.payload.kind}`)).toEqual(['session-v:snapshot'])
  })

  it('there is no current session: session.setCurrent is not a message any more', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    expect('setCurrentSession' in manager).toBe(false)
    port._simulateMessage({ type: 'session.setCurrent', sessionId: 'x' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect((manager as unknown as { feed: object }).feed).not.toHaveProperty('currentSessionId')
  })

  // Every worker kind binds its runtime through `bindSessionRuntime`. When the
  // feed had ONE current session, a sub-agent spawned mid-turn stole it and the
  // foreground session's later emits — the turn-end idle included — were
  // dropped, leaving the running indicator animating over an idle composer.
  // Each session now publishes its own status; the regression stays pinned.
  it('a background sub-agent bind never silences the foreground session status', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-fg',
      payload: { cwd: '/workspace', sessionId: 'session-fg' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    port._simulateMessage({
      type: 'session.subscribe',
      sessionIds: ['session-fg'],
    })

    const taskId = manager.spawnSubAgentSession({
      spawnerSessionId: 'session-fg',
      prompt: 'find the loader',
      description: 'find config',
    })
    expect(taskId, 'sub-agent spawn must succeed').toBeTruthy()
    // spawn returns the PUBLIC `a…` task id; the entry (and every worker-side
    // path) is keyed by the native `subagent-…` session id.
    const subSessionId = [
      ...(manager as unknown as { sessions: Map<string, unknown> }).sessions.keys(),
    ].find(id => id.startsWith('subagent-'))
    expect(subSessionId, 'sub-agent session entry must exist').toBeTruthy()
    // What the sub-agent's own AgentRuntimeWorker does when its runtime lands.
    await manager.bindSessionRuntime(subSessionId!, {
      getSessionMetadata: async () => ({}),
      updateSessionMetadata: async () => ({}),
    } as never)

    // And the foreground session's feed still reaches its subscribers — the
    // turn-end idle in particular, which is what releases the indicator.
    const before = port._posted.length
    manager.markStreamStart('session-fg')
    manager.markStreamEnd('session-fg')
    const states = port._posted
      .slice(before)
      .filter(m => (m as { type?: string }).type === 'session.currentState')
    expect(states.length, 'foreground feed must keep emitting').toBeGreaterThan(0)
    const last = states[states.length - 1] as {
      payload?: { sessionPhase?: { kind?: string } }
    }
    expect(last.payload?.sessionPhase?.kind).toBe('idle')
  })

  // Turn end must refresh the current feed even when the phase went idle
  // WITHOUT passing the Manager's mark* write points (the only other emitters).
  // `worker.completed` is the client's authoritative end-of-turn event and
  // forces the composer idle, so a feed left reading busy is a guaranteed
  // disagreement between the status bar and the composer.
  it('worker.completed refreshes the current-session feed', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-done',
      payload: { cwd: '/workspace', sessionId: 'session-done' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    port._simulateMessage({
      type: 'session.subscribe',
      sessionIds: ['session-done'],
    })

    const worker = workerFactory.instances.at(-1)!
    manager.markStreamStart('session-done')
    // Phase returns to idle on the worker's own teardown path — no Manager
    // write point, so no emit rides it.
    worker.markStreamEnd()
    const before = port._posted.length

    worker.emitOut({
      type: 'worker.completed',
      payload: { ...worker.getSnapshot(), reason: 'submitMessage_complete' },
    } as AgentWorkerOutboundMessage)
    await new Promise(resolve => setTimeout(resolve, 10))

    const states = port._posted
      .slice(before)
      .filter(m => (m as { type?: string }).type === 'session.currentState')
    expect(
      states.length,
      'worker.completed must push the settled phase to the feed',
    ).toBeGreaterThan(0)
    const last = states[states.length - 1] as {
      payload?: { phase?: string; sessionPhase?: { kind?: string } }
    }
    expect(last.payload?.sessionPhase?.kind).toBe('idle')
    expect(last.payload?.phase).toBe('idle')
  })

  it('a stale bindSessionRuntime continuation cannot re-apply over the successor bind', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-bind',
      payload: { cwd: '/workspace', sessionId: 'session-bind' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    let releaseA: (() => void) | undefined
    const storeA = {
      getSessionMetadata: () =>
        new Promise(resolve => {
          releaseA = () =>
            resolve({
              llmSelection: { providerId: 'a', modelId: 'model-a' },
            })
        }),
      updateSessionMetadata: vi.fn(async () => ({})),
    }
    const storeB = {
      getSessionMetadata: async () => ({
        llmSelection: { providerId: 'b', modelId: 'model-b' },
      }),
      updateSessionMetadata: vi.fn(async () => ({})),
    }

    // Bind A parks on its metadata read; bind B (the force-reinit successor)
    // completes first.
    const bindA = manager.bindSessionRuntime('session-bind', storeA as never)
    await manager.bindSessionRuntime('session-bind', storeB as never)
    const entry = (
      manager as unknown as {
        sessions: Map<string, { model: { modelId?: string } | null }>
      }
    ).sessions.get('session-bind')
    expect(entry?.model?.modelId).toBe('model-b')

    // Un-park A — its continuation must detect the store was superseded and
    // bail instead of re-applying the OLD store's metadata.
    releaseA?.()
    await bindA
    expect(entry?.model?.modelId).toBe('model-b')
    // The stale continuation must not keep writing into the old store either.
    expect(storeA.updateSessionMetadata).not.toHaveBeenCalled()
  })

  it('forceReinit commits pointers and old-stub deletion only after the rebuild succeeds', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-rebind',
      payload: { cwd: '/workspace', sessionId: 'session-rebind' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const worker = workerFactory.instances[0]
    const entry = (
      manager as unknown as {
        sessions: Map<
          string,
          { projectRoot?: string; templateType?: string }
        >
      }
    ).sessions.get('session-rebind')
    expect(entry).toBeDefined()
    const prevProjectRoot = entry!.projectRoot

    // Failure: the worker's rebuild reports `failed` — the live pointers
    // must keep their pre-reinit values.
    const originalReinitialize = worker.reinitialize.bind(worker)
    worker.reinitialize = async () => ({
      status: 'failed',
      code: 'worker_init_failed',
      message: 'rebuild failed',
    })
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-rebind',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-rebind',
        forceReinit: true,
        projectRoot: 'D:/new-folder',
        templateType: 'code',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(entry!.projectRoot).toBe(prevProjectRoot)
    expect(entry!.templateType).not.toBe('code')

    // Worker-preflight rejection: a message landed
    // between the Manager's preflight and the worker's — `rejected` resolves
    // NORMALLY, and the commit must still not run.
    worker.reinitialize = async () => ({
      status: 'rejected',
      code: 'worker_reinit_not_allowed',
    })
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-rebind',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-rebind',
        forceReinit: true,
        projectRoot: 'D:/new-folder',
        templateType: 'code',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(entry!.projectRoot).toBe(prevProjectRoot)
    expect(entry!.templateType).not.toBe('code')

    // Success: with a working rebuild the pointers commit.
    worker.reinitialize = originalReinitialize
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-rebind',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-rebind',
        forceReinit: true,
        projectRoot: 'D:/new-folder',
        templateType: 'code',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(entry!.projectRoot).toBe('D:/new-folder')
    expect(entry!.templateType).toBe('code')
  })

  it('a stale reinit whose ready resolves LAST cannot overwrite the newest commit', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-race-b',
      payload: { cwd: '/workspace', sessionId: 'session-race-b' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const worker = workerFactory.instances.at(-1)!
    const entry = (
      manager as unknown as {
        sessions: Map<string, { projectRoot?: string }>
      }
    ).sessions.get('session-race-b')

    let resolveStale: ((r: AgentRuntimeInitResult) => void) | undefined
    let call = 0
    worker.reinitialize = (payload: AgentRuntimeWorkerInitPayload) => {
      call += 1
      if (call === 1) {
        // Reinit A parks — superseded by B, but its runInit guard resolves
        // it as a normal return; a naive worker would report ready.
        return new Promise<AgentRuntimeInitResult>(resolve => {
          resolveStale = resolve
        })
      }
      return Promise.resolve({
        status: 'ready' as const,
        generation: 2,
      })
    }

    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-race-b',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-race-b',
        forceReinit: true,
        projectRoot: 'D:/folder-a',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-race-b',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-race-b',
        forceReinit: true,
        projectRoot: 'D:/folder-b',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(entry?.projectRoot).toBe('D:/folder-b')

    // The STALE reinit's ready lands last — the rebind revision must reject
    // its commit.
    resolveStale?.({ status: 'ready', generation: 1 })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(entry?.projectRoot).toBe('D:/folder-b')
  })

  it('a failed-init entry re-inits on reconnect and gates lastInitTemplate on success', async () => {
    const initDispatches: number[] = []
    let failFirst = true
    const localManager = new SharedWorkerSessionManager({
      createWorker: options => {
        const worker = new MockRuntimeWorker(options)
        const original = worker.receiveFrame.bind(worker)
        worker.receiveFrame = async (m: AgentWorkerInboundMessage) => {
          if (m.type === 'worker.init') {
            initDispatches.push(1)
            if (failFirst) {
              failFirst = false
              throw new Error('boot failed')
            }
          }
          return original(m)
        }
        return worker
      },
    })
    const internals = localManager as unknown as {
      sessions: Map<string, { initFailed?: boolean }>
      lastInitTemplate: unknown
    }
    const port = createMockPort()
    localManager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-retry',
      payload: { cwd: '/workspace', sessionId: 'session-retry' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const entry = internals.sessions.get('session-retry')
    expect(entry?.initFailed, 'the failed init must mark the entry').toBe(true)
    // A failed init must NOT publish its template to future
    // routine/sub-agent/teammate spawns.
    expect(internals.lastInitTemplate).toBeNull()

    // Reconnect with a plain worker.init. Red-without: the reuse branch
    // replied worker.ready from an initialized=false snapshot and never
    // re-dispatched — the runtime stayed dead forever.
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-retry',
      payload: { cwd: '/workspace', sessionId: 'session-retry' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(initDispatches.length, 'the retry must re-dispatch init').toBe(2)
    expect(entry?.initFailed).toBe(false)
    expect(internals.lastInitTemplate).not.toBeNull()
  })

  // `restoredSessionId` is about ONE id; the headless-spawn template is replayed under freshly minted ids, so the
  // flag belongs in its scrub list beside `sessionId` and `forceReinit`.
  it('the boot pointer flag is scrubbed from the headless-spawn template', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    const internals = manager as unknown as {
      lastInitTemplate: AgentRuntimeWorkerInitPayload | null
    }

    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-restored-boot',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-restored-boot',
        restoredSessionId: true,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(internals.lastInitTemplate, 'the template must be published').not
      .toBeNull()
    // Red without the fix: `true`, and every spawn below inherits it.
    expect(
      internals.lastInitTemplate?.restoredSessionId,
      'a spawn must never inherit another session was-restored marker',
    ).toBeUndefined()
    // The identity fields it sits beside are scrubbed for the same reason —
    // asserted together so a future edit cannot quietly drop one of them.
    expect(internals.lastInitTemplate?.sessionId).toBeUndefined()
    expect(internals.lastInitTemplate?.forceReinit).toBeUndefined()
    // The template still carries what it exists to carry.
    expect(internals.lastInitTemplate?.cwd).toBe('/workspace')
  })

  it('bindSessionRuntime persists the init payload metadata, not the stale entry values', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-bindmeta',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-bindmeta',
        projectRoot: 'D:/old-folder',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // The rebind's runtime build binds its NEW store while the entry still
    // holds the OLD projectRoot (the two-phase commit lands after init).
    const updates: Array<Record<string, unknown>> = []
    const newStore = {
      getSessionMetadata: async () => undefined,
      updateSessionMetadata: vi.fn(async (patch: Record<string, unknown>) => {
        updates.push(patch)
        return {}
      }),
    }
    await manager.bindSessionRuntime('session-bindmeta', newStore as never, {
      templateType: 'code',
      projectRoot: 'D:/new-folder',
    })

    // Red-without: the empty-store backfill wrote entry.projectRoot
    // (D:/old-folder) into the NEW store — Manager memory then said new
    // while the store said old, and the next resume followed the store.
    expect(updates.some(u => u.projectRoot === 'D:/new-folder')).toBe(true)
    expect(updates.some(u => u.projectRoot === 'D:/old-folder')).toBe(false)
    expect(updates.some(u => u.templateType === 'code')).toBe(true)
  })

  /** Seed the manager's storage coordinator with a grouped-routing mock so
   *  the tests can observe WHEN `setSessionProjectDir` fires
   *  relative to init completion (the two-phase routing commit). */
  function seedGroupedRouting(target: SharedWorkerSessionManager) {
    const routes = new Map<string, string>()
    const routingCalls: string[] = []
    const storage = {
      listSessions: vi.fn(async () => []),
      loadSessionSummary: vi.fn(async (sessionId: string) => ({
        sessionId,
        updatedAt: 1,
        messageCount: 1,
        firstPrompt: 'hi',
        previewText: 'hi',
      })),
      projectRouteOf: vi.fn((sessionId: string) => routes.get(sessionId)),
      setSessionProjectDir: vi.fn((sessionId: string, dir: string) => {
        routes.set(sessionId, dir)
        routingCalls.push(dir)
      }),
      dropSessionRouting: vi.fn((sessionId: string) => {
        routes.delete(sessionId)
      }),
      deleteSessionInDir: vi.fn(async () => {}),
    }
    const coordinator = (
      target as unknown as {
        storageCoordinator: {
          storage: unknown
          groupedStorage: unknown
          homeDir: string
        }
      }
    ).storageCoordinator
    coordinator.storage = storage
    coordinator.groupedStorage = storage
    coordinator.homeDir = '/home/me'
    return { routes, routingCalls, storage }
  }

  it('forceReinit re-points storage routing only on the newest ready; a failed rebuild marks the entry for retry', async () => {
    const { routes, routingCalls, storage } = seedGroupedRouting(manager)
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-routing',
      payload: { cwd: '/workspace', sessionId: 'session-r7-routing' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const worker = workerFactory.instances.at(-1)!
    const entry = (
      manager as unknown as {
        sessions: Map<string, { projectRoot?: string; initFailed?: boolean }>
      }
    ).sessions.get('session-r7-routing')
    const committedDir = routes.get('session-r7-routing')
    expect(committedDir).toBeDefined()
    const callsAfterCreate = routingCalls.length

    // FAILED rebuild: routing must stay on the committed dir and the entry
    // must flag itself for the reconnect retry (the reinit disposed the old
    // scope pre-build, so the worker has NO runtime left).
    const originalReinitialize = worker.reinitialize.bind(worker)
    worker.reinitialize = async () => ({
      status: 'failed',
      code: 'worker_init_failed',
      message: 'rebuild failed',
    })
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-routing',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r7-routing',
        forceReinit: true,
        projectRoot: 'D:/new-folder',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(routes.get('session-r7-routing')).toBe(committedDir)
    expect(routingCalls.length).toBe(callsAfterCreate)
    expect(entry?.initFailed, 'a failed rebuild leaves a dead worker').toBe(
      true,
    )

    // REJECTED worker preflight: the old runtime is intact — routing (and
    // the retry flag's meaning) must be untouched.
    worker.reinitialize = async () => ({
      status: 'rejected',
      code: 'worker_reinit_not_allowed',
    })
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-routing',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r7-routing',
        forceReinit: true,
        projectRoot: 'D:/new-folder',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(routes.get('session-r7-routing')).toBe(committedDir)
    expect(routingCalls.length).toBe(callsAfterCreate)

    // Reconnect with a PLAIN init: the retry path rebuilds and recovers
    // (the whole point — a force-reinit failure must be recoverable the
    // same way a first-init failure is).
    worker.reinitialize = originalReinitialize
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-routing',
      payload: { cwd: '/workspace', sessionId: 'session-r7-routing' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(entry?.initFailed).toBe(false)

    // Successful force-rebind: routing follows the commit, and the old-dir
    // stub is swept.
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-routing',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r7-routing',
        forceReinit: true,
        projectRoot: 'D:/new-folder',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const reboundDir = routes.get('session-r7-routing')
    expect(reboundDir).toBeDefined()
    expect(reboundDir).not.toBe(committedDir)
    expect(entry?.projectRoot).toBe('D:/new-folder')
    expect(storage.deleteSessionInDir).toHaveBeenCalledWith(
      committedDir,
      'session-r7-routing',
    )
  })

  it('a failed newest rebind after a superseded one leaves routing at the last commit', async () => {
    const { routes, routingCalls } = seedGroupedRouting(manager)
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-super',
      payload: { cwd: '/workspace', sessionId: 'session-r7-super' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const worker = workerFactory.instances.at(-1)!
    const entry = (
      manager as unknown as {
        sessions: Map<string, { projectRoot?: string; initFailed?: boolean }>
      }
    ).sessions.get('session-r7-super')
    const committedDir = routes.get('session-r7-super')
    const callsAfterCreate = routingCalls.length

    let resolveStale: ((r: AgentRuntimeInitResult) => void) | undefined
    let call = 0
    worker.reinitialize = () => {
      call += 1
      if (call === 1) {
        return new Promise<AgentRuntimeInitResult>(resolve => {
          resolveStale = resolve
        })
      }
      return Promise.resolve({
        status: 'failed' as const,
        code: 'worker_init_failed',
        message: 'rebuild failed',
      })
    }

    // Rebind B parks; rebind C supersedes it and FAILS. Red-without: B and
    // C each re-pointed the router at PREPARE time, so routing died on C's
    // target while the entry, runtime, and old stub all stayed at the
    // commit.
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-super',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r7-super',
        forceReinit: true,
        projectRoot: 'D:/folder-b',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-super',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r7-super',
        forceReinit: true,
        projectRoot: 'D:/folder-c',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(routes.get('session-r7-super')).toBe(committedDir)
    expect(routingCalls.length).toBe(callsAfterCreate)
    expect(entry?.projectRoot).not.toBe('D:/folder-c')
    expect(entry?.initFailed, 'the NEWEST rebind failed').toBe(true)

    // B's late supersede resolution changes nothing either.
    resolveStale?.({ status: 'superseded', generation: 1 })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(routes.get('session-r7-super')).toBe(committedDir)
    expect(routingCalls.length).toBe(callsAfterCreate)
    expect(entry?.initFailed).toBe(true)
  })

  it('a superseded or orphaned initial init cannot commit its template', async () => {
    const parked: Array<(r: AgentRuntimeInitResult) => void> = []
    const localManager = new SharedWorkerSessionManager({
      createWorker: options => {
        const worker = new MockRuntimeWorker(options)
        const original = worker.reinitialize.bind(worker)
        let call = 0
        worker.reinitialize = (payload: AgentRuntimeWorkerInitPayload) => {
          call += 1
          if (call === 1) {
            // Each session's FIRST init parks (a slow cold boot).
            return new Promise<AgentRuntimeInitResult>(resolve => {
              parked.push(resolve)
            })
          }
          return original(payload)
        }
        return worker
      },
    })
    const internals = localManager as unknown as {
      lastInitTemplate: { templateType?: string } | null
    }
    const port = createMockPort()
    localManager.handleConnect(port)

    // Initial init A parks mid-build; a force-rebind B completes and
    // commits ITS template.
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-template',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r7-template',
        templateType: 'chat',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(internals.lastInitTemplate).toBeNull()
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-template',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r7-template',
        forceReinit: true,
        templateType: 'code',
        projectRoot: 'D:/folder-b',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(internals.lastInitTemplate?.templateType).toBe('code')

    // A finally resolves as SUPERSEDED.
    parked.shift()?.({ status: 'superseded', generation: 1 })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(internals.lastInitTemplate?.templateType).toBe('code')
// A DELETED session's late init must not publish either: the second
// session's first init parks, the session is deleted, then the init
// reports ready — the worker-identity guard (entry gone) blocks the
// commit.
    // commit (red-without: the commit sat outside that guard).
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-orphan',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r7-orphan',
        templateType: 'agent',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    port._simulateMessage({
      type: 'session.delete',
      sessionId: 'session-r7-orphan',
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    parked.shift()?.({ status: 'ready', generation: 1 })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(internals.lastInitTemplate?.templateType).toBe('code')
  })

  it('the failed-entry retry re-runs the persisted-root reconcile and storage prepare', async () => {
    // The retry is a fresh page reconnect: its payload has lost both the
    // bound folder and the storage path. Red-without: the retry dispatched
    // the RAW payload — no reconcile, no stamp — so the one path whose
    // whole purpose is recovery rebuilt the runtime in the sandbox
    // workspace.
    let failNext = true
    const localFactory = createMockWorkerFactory()
    const localManager = new SharedWorkerSessionManager({
      createWorker: options => {
        const worker = localFactory.factory(options) as MockRuntimeWorker
        const original = worker.reinitialize.bind(worker)
        worker.reinitialize = (payload: AgentRuntimeWorkerInitPayload) => {
          if (failNext) {
            failNext = false
            return Promise.resolve({
              status: 'failed' as const,
              code: 'worker_init_failed',
              message: 'boot failed',
            })
          }
          return original(payload)
        }
        return worker
      },
    })
    const { routes, routingCalls } = seedGroupedRouting(localManager)
    ;(
      localManager as unknown as {
        fsSummaries: { set: (id: string, summary: unknown) => void }
      }
    ).fsSummaries.set('session-r7-retry', {
      sessionId: 'session-r7-retry',
      projectRoot: '/home/me/projA',
    })
    const port = createMockPort()
    localManager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-retry',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r7-retry',
        templateType: 'code',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const entry = (
      localManager as unknown as {
        sessions: Map<string, { initFailed?: boolean }>
      }
    ).sessions.get('session-r7-retry')
    expect(entry?.initFailed).toBe(true)
    const callsAfterFailedCreate = routingCalls.length

    // Reconnect with the page's re-guessed payload: no projectRoot, no
    // sessionStoragePath.
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-retry',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r7-retry',
        templateType: 'code',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(entry?.initFailed).toBe(false)
    const retryInit = localFactory.instances[0].receivedMessages.find(
      message => message.type === 'worker.init',
    ) as Extract<AgentWorkerInboundMessage, { type: 'worker.init' }> | undefined
    expect(retryInit, 'the retry must dispatch an init').toBeDefined()
    expect(
      retryInit!.payload.projectRoot,
      'the persisted folder must be reconciled into the retry payload',
    ).toBe('/home/me/projA')
    expect(
      retryInit!.payload.sessionStoragePath,
      'the storage target must be stamped into the retry payload',
    ).toContain('projects')
    // The retry's ready committed the routing it prepared.
    expect(routingCalls.length).toBeGreaterThan(callsAfterFailedCreate)
    expect(routes.get('session-r7-retry')).toContain('projects')
  })

  it('an explicitly-unbound bind does not fall back to the entry stale folder', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r7-unbind',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r7-unbind',
        projectRoot: 'D:/old-folder',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // A rebuild that carries initMeta WITHOUT a projectRoot is an unbound
    // build — that is its truth, not an omission. Red-without: `??` fell
    // through to entry.projectRoot and backfilled the old folder into the
    // new store.
    const unboundUpdates: Array<Record<string, unknown>> = []
    const unboundStore = {
      getSessionMetadata: async () => undefined,
      updateSessionMetadata: vi.fn(async (patch: Record<string, unknown>) => {
        unboundUpdates.push(patch)
        return {}
      }),
    }
    await manager.bindSessionRuntime(
      'session-r7-unbind',
      unboundStore as never,
      { templateType: 'code', projectRoot: undefined },
    )
    expect(unboundUpdates.some(u => 'projectRoot' in u)).toBe(false)
    expect(unboundUpdates.some(u => u.templateType === 'code')).toBe(true)

    // A caller with NO initMeta at all (tests, legacy hosts) still gets
    // the entry fallback.
    const legacyUpdates: Array<Record<string, unknown>> = []
    const legacyStore = {
      getSessionMetadata: async () => undefined,
      updateSessionMetadata: vi.fn(async (patch: Record<string, unknown>) => {
        legacyUpdates.push(patch)
        return {}
      }),
    }
    await manager.bindSessionRuntime('session-r7-unbind', legacyStore as never)
    expect(legacyUpdates.some(u => u.projectRoot === 'D:/old-folder')).toBe(
      true,
    )
  })

  it('a ready whose bind metadata did not persist keeps the old-dir stub', async () => {
    const { routes, storage } = seedGroupedRouting(manager)
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r9-stub',
      payload: { cwd: '/workspace', sessionId: 'session-r9-stub' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const worker = workerFactory.instances.at(-1)!
    const entry = (
      manager as unknown as {
        sessions: Map<string, { projectRoot?: string }>
      }
    ).sessions.get('session-r9-stub')

    // Rebind to B whose critical bind write FAILED: runtime + routing +
    // pointers commit (the runtime IS live there), but the old-dir stub
    // must survive — it is the only durable record left pointing anywhere.
    worker.reinitialize = async () => ({
      status: 'ready',
      generation: 2,
      bindPersisted: false,
    })
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r9-stub',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r9-stub',
        forceReinit: true,
        projectRoot: 'D:/folder-b',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(entry?.projectRoot).toBe('D:/folder-b')
    const routedAfterB = routes.get('session-r9-stub')
    expect(routedAfterB).toBeDefined()
    expect(storage.deleteSessionInDir).not.toHaveBeenCalled()

    // A later rebind whose bind DID persist sweeps normally.
    worker.reinitialize = async () => ({
      status: 'ready',
      generation: 3,
      bindPersisted: true,
    })
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r9-stub',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r9-stub',
        forceReinit: true,
        projectRoot: 'D:/folder-c',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(storage.deleteSessionInDir).toHaveBeenCalledWith(
      routedAfterB,
      'session-r9-stub',
    )
  })

  it('lastInitTemplate carries the RECONCILED projectRoot, never the pre-reconcile payload', async () => {
    const localFactory = createMockWorkerFactory()
    const localManager = new SharedWorkerSessionManager({
      createWorker: localFactory.factory,
    })
    seedGroupedRouting(localManager)
    ;(
      localManager as unknown as {
        fsSummaries: { set: (id: string, summary: unknown) => void }
      }
    ).fsSummaries.set('session-r9-template', {
      sessionId: 'session-r9-template',
      projectRoot: '/home/me/projA',
    })
    const internals = localManager as unknown as {
      lastInitTemplate: {
        projectRoot?: string
        sessionStoragePath?: string
        templateType?: string
      } | null
    }
    const port = createMockPort()
    localManager.handleConnect(port)
    // The page reconnect payload LOST the bound folder; the manager-side
    // reconcile restores it into the payload before the worker boots.
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r9-template',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r9-template',
        templateType: 'code',
        logCallModel: true,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // Red-without: the template was snapshotted BEFORE the reconcile ran,
    // so routines/sub-agents/teammates spawned from it lost the session's
    // real folder (projectRoot undefined) — and it leaked the per-session
    // stamped sessionStoragePath.
    expect(internals.lastInitTemplate).not.toBeNull()
    expect(internals.lastInitTemplate?.projectRoot).toBe('/home/me/projA')
    expect(internals.lastInitTemplate?.sessionStoragePath).toBeUndefined()
    expect(internals.lastInitTemplate?.templateType).toBe('code')
    // The call-model trace flag must not propagate to
    // background spawns — a headless sub-agent inheriting it would install
    // its portless emitter over the parent's.
    expect(
      (internals.lastInitTemplate as { logCallModel?: boolean } | null)
        ?.logCallModel,
    ).toBeUndefined()
  })

  it('two concurrent initial inits for a NEW session create exactly one worker', async () => {
    const localFactory = createMockWorkerFactory()
    const localManager = new SharedWorkerSessionManager({
      createWorker: localFactory.factory,
    })
    // Park BOTH inits inside handleWorkerInit's first await so their
    // entry-existence checks would race without the serialization.
    let release: (() => void) | undefined
    const parked = new Promise<void>(resolve => {
      release = resolve
    })
    ;(
      localManager as unknown as {
        storageCoordinator: { ensureStorage: () => Promise<void> }
      }
    ).storageCoordinator.ensureStorage = () => parked

    const portA = createMockPort()
    const portB = createMockPort()
    localManager.handleConnect(portA)
    localManager.handleConnect(portB)
    portA._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r9-concurrent',
      payload: { cwd: '/workspace', sessionId: 'session-r9-concurrent' },
    })
    portB._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r9-concurrent',
      payload: { cwd: '/workspace', sessionId: 'session-r9-concurrent' },
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    release?.()
    await new Promise(resolve => setTimeout(resolve, 10))

    // Red-without: both inits passed the "no entry yet" check and TWO
    // workers were created — the second overwrote the first in the map
    // while the orphan kept initializing with no dispose.
    expect(localFactory.instances).toHaveLength(1)
    expect(
      portA._posted.some(
        m => (m as { type?: string }).type === 'worker.ready',
      ),
    ).toBe(true)
    expect(
      portB._posted.some(
        m => (m as { type?: string }).type === 'worker.ready',
      ),
    ).toBe(true)
  })

  it('a stale committed routing is re-scanned when its dir has no summary', async () => {
    // First reconnect: the routing scan transiently fails, the create
    // eagerly commits a GUESS routing, and the worker init fails too. The
    // retry's reconcile must not trust the guess blindly — established
    // routing with NO summary gets one corrective scan.
    const REAL_DIR = '/home/me/.velloc/projects/D--proj-real'
    const routes = new Map<string, string>()
    let scanFails = true
    const storage = {
      listSessions: vi.fn(async () => {
        if (scanFails) {
          scanFails = false
          throw new Error('readdir failed')
        }
        // Real GroupedConversationStorage semantics: a successful scan
        // rebuilds the sessionId→projectDir map, overwriting stale routes.
        routes.set('session-r9-scan', REAL_DIR)
        return ['session-r9-scan']
      }),
      loadSessionSummary: vi.fn(async (sessionId: string) => {
        if (routes.get(sessionId) !== REAL_DIR) return null
        return {
          sessionId,
          updatedAt: 5,
          messageCount: 4,
          firstPrompt: 'hi',
          previewText: 'hi',
          projectRoot: 'D:/proj/real',
        }
      }),
      projectRouteOf: vi.fn((id: string) => routes.get(id)),
      setSessionProjectDir: vi.fn((id: string, dir: string) => {
        routes.set(id, dir)
      }),
      dropSessionRouting: vi.fn((id: string) => {
        routes.delete(id)
      }),
      deleteSessionInDir: vi.fn(async () => {}),
    }
    let failNext = true
    const localFactory = createMockWorkerFactory()
    const localManager = new SharedWorkerSessionManager({
      createWorker: options => {
        const worker = localFactory.factory(options) as MockRuntimeWorker
        const original = worker.reinitialize.bind(worker)
        worker.reinitialize = (payload: AgentRuntimeWorkerInitPayload) => {
          if (failNext) {
            failNext = false
            return Promise.resolve({
              status: 'failed' as const,
              code: 'worker_init_failed',
              message: 'boot failed',
            })
          }
          return original(payload)
        }
        return worker
      },
    })
    const coordinator = (
      localManager as unknown as {
        storageCoordinator: {
          storage: unknown
          groupedStorage: unknown
          homeDir: string
        }
      }
    ).storageCoordinator
    coordinator.storage = storage
    coordinator.groupedStorage = storage
    coordinator.homeDir = '/home/me'

    const port = createMockPort()
    localManager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r9-scan',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r9-scan',
        templateType: 'code',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const entry = (
      localManager as unknown as {
        sessions: Map<string, { initFailed?: boolean }>
      }
    ).sessions.get('session-r9-scan')
    expect(entry?.initFailed).toBe(true)

    // Second reconnect: retry must rediscover the REAL dir and boot there.
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r9-scan',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r9-scan',
        templateType: 'code',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(entry?.initFailed).toBe(false)
    const retryInit = localFactory.instances[0].receivedMessages.find(
      message => message.type === 'worker.init',
    ) as Extract<AgentWorkerInboundMessage, { type: 'worker.init' }> | undefined
    // Red-without: the established-routing read missed and gave up — the
    // retry rebuilt the session EMPTY in the guessed dir, projectRoot
    // undefined.
    expect(retryInit?.payload.projectRoot).toBe('D:/proj/real')
    expect(routes.get('session-r9-scan')).toContain('proj-real')
  })

  it('a Manager-preflight reinit rejection answers the requesting port', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r9-preflight',
      payload: { cwd: '/workspace', sessionId: 'session-r9-preflight' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    // Make the live session busy so the MANAGER preflight rejects (the
    // worker's own preflight is never reached).
    workerFactory.instances.at(-1)!.markStreamStart()

    const requester = createMockPort()
    manager.handleConnect(requester)
    requester._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r9-preflight',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r9-preflight',
        forceReinit: true,
        projectRoot: 'D:/new-folder',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // Red-without: only a tracer event — the requesting port (the folder
    // picker) waited forever on an init that would never complete.
    const error = requester._posted.find(
      m =>
        (m as { type?: string }).type === 'worker.error' &&
        (m as { payload?: { code?: string } }).payload?.code ===
          'worker_reinit_not_allowed',
    )
    expect(error, 'the requester must learn the preflight rejection').toBeDefined()
  })

  it('a reconnect during an in-flight init gets ONE ready, initialized, never a premature snapshot', async () => {
    let releaseInit: (() => void) | undefined
    const localFactory = createMockWorkerFactory()
    const localManager = new SharedWorkerSessionManager({
      createWorker: options => {
        const worker = localFactory.factory(options) as MockRuntimeWorker
        const originalReinit = worker.reinitialize.bind(worker)
        const originalSnapshot = worker.getSnapshot.bind(worker)
        let initialized = false
        // The worker's init PARKS (a slow real boot) and its snapshot
        // honestly reports uninitialized until it completes.
        worker.reinitialize = async (payload: AgentRuntimeWorkerInitPayload) => {
          await new Promise<void>(resolve => {
            releaseInit = resolve
          })
          initialized = true
          return originalReinit(payload)
        }
        worker.getSnapshot = () => ({ ...originalSnapshot(), initialized })
        return worker
      },
    })
    const portA = createMockPort()
    const portB = createMockPort()
    localManager.handleConnect(portA)
    localManager.handleConnect(portB)
    portA._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r11-reuse',
      payload: { cwd: '/workspace', sessionId: 'session-r11-reuse' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(releaseInit, 'the first init must be parked').toBeDefined()

    // A second port reconnects while the init is still in flight — the
    // reuse branch must NOT reply with a premature initialized:false
    // snapshot.
    portB._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r11-reuse',
      payload: { cwd: '/workspace', sessionId: 'session-r11-reuse' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(
      portB._posted.filter(
        m => (m as { type?: string }).type === 'worker.ready',
      ),
    ).toHaveLength(0)

    releaseInit?.()
    await new Promise(resolve => setTimeout(resolve, 10))
    for (const [label, port] of [
      ['portA', portA],
      ['portB', portB],
    ] as const) {
      const readies = port._posted.filter(
        m => (m as { type?: string }).type === 'worker.ready',
      )
      expect(readies, `${label} must get exactly one ready`).toHaveLength(1)
      expect(
        (readies[0] as { payload?: { initialized?: boolean } }).payload
          ?.initialized,
        `${label}'s ready must be the real initialized one`,
      ).toBe(true)
    }
    expect(localFactory.instances).toHaveLength(1)
  })

  it('the critical bind overwrites a STALE stored projectRoot when initMeta is authoritative', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r11-stale',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r11-stale',
        projectRoot: 'D:/entry-root',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // An earlier failed rebind left the store's durable record pointing at
    // the WRONG folder. This build (initMeta present = effective truth)
    // runs at the new one.
    const updates: Array<Record<string, unknown>> = []
    const staleStore = {
      getSessionMetadata: async () => ({
        templateType: 'code',
        projectRoot: 'D:/stale-old',
      }),
      updateSessionMetadata: vi.fn(async (patch: Record<string, unknown>) => {
        updates.push(patch)
        return {}
      }),
    }
    const persisted = await manager.bindSessionRuntime(
      'session-r11-stale',
      staleStore as never,
      { templateType: 'code', projectRoot: 'D:/rebound-new' },
    )
    expect(persisted).toBe(true)
    expect(updates.some(u => u.projectRoot === 'D:/rebound-new')).toBe(true)

    // Meta-less callers keep the backfill-only guard: entry-derived values
    // must never clobber a root the shell persisted directly.
    const legacyUpdates: Array<Record<string, unknown>> = []
    const legacyStore = {
      getSessionMetadata: async () => ({
        projectRoot: 'D:/shell-persisted',
      }),
      updateSessionMetadata: vi.fn(async (patch: Record<string, unknown>) => {
        legacyUpdates.push(patch)
        return {}
      }),
    }
    await manager.bindSessionRuntime(
      'session-r11-stale',
      legacyStore as never,
    )
    expect(legacyUpdates.some(u => 'projectRoot' in u)).toBe(false)
  })

  it('a retry that recovers into an UNBOUND runtime clears the entry stale projectRoot', async () => {
    let call = 0
    const localFactory = createMockWorkerFactory()
    const localManager = new SharedWorkerSessionManager({
      createWorker: options => {
        const worker = localFactory.factory(options) as MockRuntimeWorker
        worker.reinitialize = async () => {
          call += 1
          if (call === 1) {
            return {
              status: 'failed' as const,
              code: 'worker_init_failed',
              message: 'boot failed',
            }
          }
          // The retry rebuilt an UNBOUND runtime — its effective slice
          // says so explicitly (projectRoot undefined IS the truth).
          return {
            status: 'ready' as const,
            generation: 1,
            effectiveInit: { templateType: 'code', projectRoot: undefined },
          }
        }
        return worker
      },
    })
    const port = createMockPort()
    localManager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r12-unbind',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-r12-unbind',
        templateType: 'code',
        projectRoot: 'D:/old-a',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const entry = (
      localManager as unknown as {
        sessions: Map<string, { projectRoot?: string; initFailed?: boolean }>
      }
    ).sessions.get('session-r12-unbind')
    expect(entry?.initFailed).toBe(true)
    expect(entry?.projectRoot).toBe('D:/old-a')

    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r12-unbind',
      payload: { cwd: '/workspace', sessionId: 'session-r12-unbind' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(entry?.initFailed).toBe(false)
    // Red-without: the truthy gate kept D:/old-a — the sidebar, shell
    // paths, and background spawns kept reading a folder the runtime no
    // longer runs in.
    expect(entry?.projectRoot).toBeUndefined()
  })

  it('the critical bind corrects a STALE stored templateType when initMeta carries one', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-r12-ttype',
      payload: { cwd: '/workspace', sessionId: 'session-r12-ttype' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const updates: Array<Record<string, unknown>> = []
    const store = {
      getSessionMetadata: async () => ({
        templateType: 'chat',
        projectRoot: 'D:/x',
      }),
      updateSessionMetadata: vi.fn(async (patch: Record<string, unknown>) => {
        updates.push(patch)
        return {}
      }),
    }
    // Red-without: backfill-only skipped the write — the durable record
    // kept the wrong type and the next resume booted the wrong template.
    await manager.bindSessionRuntime('session-r12-ttype', store as never, {
      templateType: 'code',
      projectRoot: 'D:/x',
    })
    expect(updates.some(u => u.templateType === 'code')).toBe(true)
  })

  it('an established-routing miss rescans even after a MEMOIZED successful scan', async () => {
    const REAL_DIR = '/home/me/.velloc/projects/D--proj-real'
    const STALE_DIR = '/home/me/.velloc/projects/D--stale-guess'
    const routes = new Map<string, string>([['s-r12-refresh', STALE_DIR]])
    const storage = {
      listSessions: vi.fn(async () => {
        // A real rescan re-discovers the session's actual dir.
        routes.set('s-r12-refresh', REAL_DIR)
        return ['s-r12-refresh']
      }),
      loadSessionSummary: vi.fn(async (id: string) =>
        routes.get(id) === REAL_DIR
          ? {
              sessionId: id,
              updatedAt: 5,
              messageCount: 3,
              firstPrompt: 'hi',
              previewText: 'hi',
              projectRoot: 'D:/proj/real',
            }
          : null,
      ),
      projectRouteOf: vi.fn((id: string) => routes.get(id)),
      setSessionProjectDir: vi.fn((id: string, dir: string) => {
        routes.set(id, dir)
      }),
      dropSessionRouting: vi.fn((id: string) => {
        routes.delete(id)
      }),
    }
    const m = manager as unknown as {
      storageCoordinator: {
        storage: unknown
        groupedStorage: unknown
        homeDir: string
      }
      summaryRepo: {
        sessionRoutingPromise: Promise<string[] | null> | null
        reconcilePersistedSessionBinding(
          id: string,
          payload: Record<string, unknown>,
        ): Promise<void>
      }
    }
    m.storageCoordinator.storage = storage
    m.storageCoordinator.groupedStorage = storage
    m.storageCoordinator.homeDir = '/home/me'
    // A PRIOR scan already succeeded — the memo would replay it forever.
    m.summaryRepo.sessionRoutingPromise = Promise.resolve(['s-r12-refresh'])

    const payload: Record<string, unknown> = {
      cwd: '/workspace',
      sessionId: 's-r12-refresh',
    }
    await m.summaryRepo.reconcilePersistedSessionBinding('s-r12-refresh', payload)
    // Red-without: the corrective path awaited the MEMOIZED promise —
    // listSessions never re-ran and the stale route was never corrected.
    expect(storage.listSessions).toHaveBeenCalledTimes(1)
    expect(payload.projectRoot).toBe('D:/proj/real')
  })

  it('a throw before the worker dispatch reaches the requesting port', async () => {
    const localManager = new SharedWorkerSessionManager({
      createWorker: options => new MockRuntimeWorker(options),
    })
    ;(
      localManager as unknown as {
        storageCoordinator: { ensureStorage: () => Promise<void> }
      }
    ).storageCoordinator.ensureStorage = () =>
      Promise.reject(new Error('storage down'))
    const port = createMockPort()
    localManager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-storage-down',
      payload: { cwd: '/workspace', sessionId: 'session-storage-down' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // Red-without: the outer void dispatch had no catch — the rejection was
    // unhandled and the port never learned the init died.
    const error = port._posted.find(
      m =>
        (m as { type?: string }).type === 'worker.error' &&
        ((m as { payload?: { code?: string } }).payload?.code ===
          'worker_manager_init_failed'),
    )
    expect(error, 'the port must learn the manager-side init failure').toBeDefined()
  })

  it('creates a session on worker.init and sends worker.ready', async () => {
    const port = createMockPort()
    manager.handleConnect(port)

    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-abc',
      payload: { cwd: '/workspace', sessionId: 'session-abc' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    const ready = port._posted.find(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'worker.ready',
    ) as SharedWorkerOutboundMessage | undefined

    expect(ready).toBeDefined()
    expect(ready!.type).toBe('worker.ready')
    expect((ready as { sessionId: string }).sessionId).toBe('session-abc')
    expect(workerFactory.instances).toHaveLength(1)
  })

  it('resumes an existing session idempotently', async () => {
    const port1 = createMockPort()
    const port2 = createMockPort()
    manager.handleConnect(port1)
    manager.handleConnect(port2)

    port1._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-xyz',
      payload: { cwd: '/workspace', sessionId: 'session-xyz' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    port2._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-xyz',
      payload: { cwd: '/workspace', sessionId: 'session-xyz' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    const readyMessages = port2._posted.filter(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'worker.ready',
    )
    expect(readyMessages.length).toBe(1)
    expect(workerFactory.instances).toHaveLength(1)
  })

  it('re-inits the live worker IN PLACE on forceReinit (no teardown, new projectRoot)', async () => {
    // Project-folder re-bind: a second worker.init for a LIVE session with
    // `forceReinit: true` must re-run init ON THE SAME worker (rebuilding its
    // runtime with the new projectRoot) — NOT hit the reuse fast path (which
    // drops the new folder) and NOT destroy + recreate the worker (a fresh
    // worker would hang re-establishing its host-bridge wiring).
    const port1 = createMockPort()
    manager.handleConnect(port1)
    port1._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-rebind',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-rebind',
        projectRoot: '/old',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(workerFactory.instances).toHaveLength(1)

    const port2 = createMockPort()
    manager.handleConnect(port2)
    port2._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-rebind',
      payload: {
        cwd: '/new',
        sessionId: 'session-rebind',
        projectRoot: '/new',
        forceReinit: true,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // Same worker, re-inited in place — NOT destroyed/recreated, NOT stopped.
    expect(workerFactory.instances).toHaveLength(1)
    expect(workerFactory.instances[0].stopCallCount).toBe(0)
    // The live worker received a SECOND worker.init carrying the new projectRoot.
    const inits = workerFactory.instances[0].receivedMessages.filter(
      message => message.type === 'worker.init',
    ) as Array<Extract<AgentWorkerInboundMessage, { type: 'worker.init' }>>
    expect(inits).toHaveLength(2)
    expect(inits[1].payload.projectRoot).toBe('/new')
    // It re-emitted worker.ready back to the requesting port.
    expect(
      port2._posted.some(
        msg => (msg as SharedWorkerOutboundMessage).type === 'worker.ready',
      ),
    ).toBe(true)
  })

  it('a non-forceReinit re-init reuses the worker without re-running init', async () => {
    // Contrast guard: the ordinary reconnect path reuses the worker via the
    // manager's snapshot fast-path — it must NOT forward a second worker.init
    // to the worker (that would re-run runInit needlessly) and must not stop.
    const port1 = createMockPort()
    manager.handleConnect(port1)
    port1._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-keep',
      payload: { cwd: '/workspace', sessionId: 'session-keep' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const port2 = createMockPort()
    manager.handleConnect(port2)
    port2._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-keep',
      payload: { cwd: '/workspace', sessionId: 'session-keep' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(workerFactory.instances).toHaveLength(1)
    expect(workerFactory.instances[0].stopCallCount).toBe(0)
    const inits = workerFactory.instances[0].receivedMessages.filter(
      message => message.type === 'worker.init',
    )
    expect(inits).toHaveLength(1)
  })

  it('restores the persisted projectRoot from fs summaries on resume', async () => {
    // Reload scenario: the manager has preloaded the session's persisted summary
    // (carrying its bound folder), but the page's `createSessionInitPayload`
    // raced the session-list broadcast and had no recent-folders fallback, so
    // the init payload omits `projectRoot`. The manager must inject the
    // persisted folder so the resumed runtime re-binds it instead of falling
    // back to the sandbox `workspace`.
    ;(
      manager as unknown as {
        fsSummaries: { set: (id: string, summary: unknown) => void }
      }
    ).fsSummaries.set('session-resume', {
      sessionId: 'session-resume',
      projectRoot: '/home/me/projA',
    })

    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-resume',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-resume',
        templateType: 'code',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const init = workerFactory.instances[0].receivedMessages.find(
      message => message.type === 'worker.init',
    ) as
      | Extract<AgentWorkerInboundMessage, { type: 'worker.init' }>
      | undefined
    expect(init?.payload.projectRoot).toBe('/home/me/projA')
  })

  it('reconciles projectRoot with ONE targeted summary read — no full preload wait, no scan on a fast-path hit', async () => {
    // Startup-perf invariant (see reconcilePersistedSessionBinding): when the
    // sidebar preload hasn't finished, the boot-critical worker.init must NOT
    // await it (O(N) summary reads). Fast path: one loadSessionSummary at the
    // session's type-default project dir. When that read locates the session,
    // the listSessions routing scan must not run at all.
    const storage = {
      listSessions: vi.fn(async () => []),
      loadSessionSummary: vi.fn(async (sessionId: string) => ({
        sessionId,
        updatedAt: 1,
        messageCount: 1,
        firstPrompt: 'hi',
        previewText: 'hi',
        // No projectRoot — a normal unbound session; nothing to inject.
      })),
      // Unrouted at entry — the reconcile must take the fast path, not the
      // established-routing read.
      projectRouteOf: vi.fn(() => undefined),
      setSessionProjectDir: vi.fn(),
      dropSessionRouting: vi.fn(),
    }
    const m = (
      manager as unknown as {
        storageCoordinator: {
          storage: unknown
          groupedStorage: unknown
          homeDir: string
        }
      }
    ).storageCoordinator
    m.storage = storage
    m.groupedStorage = storage
    m.homeDir = '/home/me'

    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-fast',
      payload: { cwd: '/workspace', sessionId: 'session-fast' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // Exactly one targeted read; the routing scan never ran.
    expect(storage.loadSessionSummary).toHaveBeenCalledTimes(1)
    expect(storage.listSessions).not.toHaveBeenCalled()
    // The fast path pre-routed the session to its type-default project dir.
    expect(storage.setSessionProjectDir).toHaveBeenCalledWith(
      'session-fast',
      expect.stringContaining('projects'),
    )
    const init = workerFactory.instances[0].receivedMessages.find(
      message => message.type === 'worker.init',
    ) as
      | Extract<AgentWorkerInboundMessage, { type: 'worker.init' }>
      | undefined
    expect(init).toBeDefined()
    expect(init?.payload.projectRoot).toBeUndefined()
  })

  it('does NOT clobber routing the scan already established (bound session, scan-resolved, summary not yet preloaded)', async () => {
    // The high-risk cold-boot window on large profiles: the cheap routing scan
    // (`listSessions`) has ALREADY resolved and mapped the bound session to its
    // real project dir, but the throttled sidebar preload hasn't cached its
    // summary yet. The reconcile must read at the ESTABLISHED routing — a
    // speculative pre-route to the type-default dir would make the read miss,
    // and dropping the routing afterwards could never be repaired (the scan
    // promise is memoized and will not re-populate), so the session would boot
    // in the sandbox and append into the wrong project dir.
    const REAL_DIR = '/home/me/.velloc/projects/D--proj-x'
    const routes = new Map<string, string>([['session-bound', REAL_DIR]])
    const storage = {
      listSessions: vi.fn(async () => ['session-bound']),
      loadSessionSummary: vi.fn(async (sessionId: string) => {
        // Real GroupedConversationStorage semantics: the read routes via the
        // routing map; only the REAL dir has the transcript.
        if (routes.get(sessionId) !== REAL_DIR) return null
        return {
          sessionId,
          updatedAt: 1,
          messageCount: 3,
          firstPrompt: 'hi',
          previewText: 'hi',
          projectRoot: 'D:\\proj\\x',
        }
      }),
      projectRouteOf: vi.fn((sessionId: string) => routes.get(sessionId)),
      setSessionProjectDir: vi.fn((sessionId: string, dir: string) => {
        routes.set(sessionId, dir)
      }),
      dropSessionRouting: vi.fn((sessionId: string) => {
        routes.delete(sessionId)
      }),
    }
    const m = manager as unknown as {
      storageCoordinator: {
        storage: unknown
        groupedStorage: unknown
        homeDir: string
      }
      summaryRepo: { sessionRoutingPromise: Promise<string[]> | null }
    }
    m.storageCoordinator.storage = storage
    m.storageCoordinator.groupedStorage = storage
    m.storageCoordinator.homeDir = '/home/me'
    // Scan already completed — memoized. A dropped routing entry would never
    // be re-populated from here.
    m.summaryRepo.sessionRoutingPromise = Promise.resolve(['session-bound'])

    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-bound',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-bound',
        templateType: 'code',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // The persisted folder must be recovered from the established routing…
    const init = workerFactory.instances[0].receivedMessages.find(
      message => message.type === 'worker.init',
    ) as
      | Extract<AgentWorkerInboundMessage, { type: 'worker.init' }>
      | undefined
    expect(init?.payload.projectRoot).toBe('D:\\proj\\x')
    // …the reconcile must not have re-scanned (memoized) or dropped the entry…
    expect(storage.listSessions).not.toHaveBeenCalled()
    expect(storage.dropSessionRouting).not.toHaveBeenCalled()
    // …and the scan's routing survives for the worker's own storage backend.
    // (prepareWorkerStorage re-stamps from the now-corrected payload, so the
    // map may be re-set — but only ever to a dir derived from the REAL root.)
    expect(routes.get('session-bound')).toBeDefined()
  })

  it('falls back to the routing scan for a bound session missing from the type-default dir', async () => {
    // Cold-resume of a bound code session: it lives under its real folder's
    // project dir, so the fast-path read at the type-default dir misses. The
    // reconcile must then run the listSessions routing scan and re-read the
    // summary — recovering the persisted projectRoot (the pre-optimization
    // behavior, minus the full O(N) summary preload).
    const REAL_DIR = '/home/me/.velloc/projects/D--proj-x'
    const routes = new Map<string, string>()
    const storage = {
      listSessions: vi.fn(async () => {
        // The scan discovers the session's real project dir.
        routes.set('session-bound', REAL_DIR)
        return ['session-bound']
      }),
      loadSessionSummary: vi.fn(async (sessionId: string) => {
        // Real GroupedConversationStorage semantics: the read routes via the
        // routing map, and only the REAL dir has the transcript — a read
        // routed at the speculative type-default dir misses.
        if (routes.get(sessionId) !== REAL_DIR) return null
        return {
          sessionId,
          updatedAt: 1,
          messageCount: 3,
          firstPrompt: 'hi',
          previewText: 'hi',
          projectRoot: 'D:\\proj\\x',
        }
      }),
      projectRouteOf: vi.fn((sessionId: string) => routes.get(sessionId)),
      setSessionProjectDir: vi.fn((sessionId: string, dir: string) => {
        routes.set(sessionId, dir)
      }),
      dropSessionRouting: vi.fn((sessionId: string) => {
        routes.delete(sessionId)
      }),
    }
    const m = (
      manager as unknown as {
        storageCoordinator: {
          storage: unknown
          groupedStorage: unknown
          homeDir: string
        }
      }
    ).storageCoordinator
    m.storage = storage
    m.groupedStorage = storage
    m.homeDir = '/home/me'

    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-bound',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-bound',
        templateType: 'code',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // Fast-path miss → the wrong pre-route is dropped, the scan runs, and the
    // second read recovers the persisted folder.
    expect(storage.dropSessionRouting).toHaveBeenCalledWith('session-bound')
    expect(storage.listSessions).toHaveBeenCalledTimes(1)
    const init = workerFactory.instances[0].receivedMessages.find(
      message => message.type === 'worker.init',
    ) as
      | Extract<AgentWorkerInboundMessage, { type: 'worker.init' }>
      | undefined
    expect(init?.payload.projectRoot).toBe('D:\\proj\\x')
  })

  it('restores an UNBOUND session\'s persisted templateType so a resumed chat thread reads its own project dir', async () => {
    // The boot session's `worker.init` carries no templateType (it precedes the `session.list` broadcast); an unbound
    // session's templateType is its whole address, so the reconcile restores it.
    const CHAT_DIR = '/home/me/.velloc/projects/-home-me--velloc-shared-workspace-chat'
    const routes = new Map<string, string>([['session-chat', CHAT_DIR]])
    const storage = {
      listSessions: vi.fn(async () => ['session-chat']),
      loadSessionSummary: vi.fn(async (sessionId: string) => {
        // Real GroupedConversationStorage semantics: the read routes via the
        // routing map, and only the chat dir holds this session.
        if (routes.get(sessionId) !== CHAT_DIR) return null
        return {
          sessionId,
          updatedAt: 1,
          messageCount: 2,
          firstPrompt: 'who r u?',
          previewText: 'who r u?',
          // Unbound: no projectRoot at all. Only the type locates it.
          templateType: 'chat',
        }
      }),
      projectRouteOf: vi.fn((sessionId: string) => routes.get(sessionId)),
      setSessionProjectDir: vi.fn((sessionId: string, dir: string) => {
        routes.set(sessionId, dir)
      }),
      dropSessionRouting: vi.fn((sessionId: string) => {
        routes.delete(sessionId)
      }),
    }
    const m = manager as unknown as {
      storageCoordinator: {
        storage: unknown
        groupedStorage: unknown
        homeDir: string
      }
      summaryRepo: { sessionRoutingPromise: Promise<string[]> | null }
    }
    m.storageCoordinator.storage = storage
    m.storageCoordinator.groupedStorage = storage
    m.storageCoordinator.homeDir = '/home/me'
    // The sidebar preload's routing scan already mapped the session to its real
    // (chat) dir — the common cold-boot window.
    m.summaryRepo.sessionRoutingPromise = Promise.resolve(['session-chat'])

    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-chat',
      // No templateType — exactly what the restored boot pointer produces.
      payload: { cwd: '/workspace', sessionId: 'session-chat' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const init = workerFactory.instances[0].receivedMessages.find(
      message => message.type === 'worker.init',
    ) as
      | Extract<AgentWorkerInboundMessage, { type: 'worker.init' }>
      | undefined
    // Red-without: undefined → the runtime also built the WRONG template.
    expect(init?.payload.templateType).toBe('chat')
    // Red-without: `…-shared-workspace-agent`, an empty dir — the welcome page.
    expect(init?.payload.sessionStoragePath).toBe(CHAT_DIR)
    // And the routing the manager enumerates/deletes through stays on the real
    // dir rather than being re-stamped to the type-default guess.
    expect(routes.get('session-chat')).toBe(CHAT_DIR)
  })

  it('a failed routing scan does not latch preloadComplete — a later resume still recovers its folder', async () => {
    // Transient readdir failure during the sidebar preload. If it latched
    // `preloadComplete` (the old behavior), the reconcile's targeted-read path
    // (gated on `!preloadComplete`) would be disabled for the worker's whole
    // lifetime and every bound-session resume would boot in the sandbox. The
    // failed scan must stay un-latched AND un-memoized so the next caller
    // retries and the resume recovers its persisted folder.
    const REAL_DIR = '/home/me/.velloc/projects/D--proj-x'
    const routes = new Map<string, string>()
    let failScans = 1
    const storage = {
      listSessions: vi.fn(async () => {
        if (failScans > 0) {
          failScans -= 1
          throw new Error('transient readdir failure')
        }
        routes.set('session-bound', REAL_DIR)
        return ['session-bound']
      }),
      loadSessionSummary: vi.fn(async (sessionId: string) => {
        if (routes.get(sessionId) !== REAL_DIR) return null
        return {
          sessionId,
          updatedAt: 1,
          messageCount: 3,
          firstPrompt: 'hi',
          previewText: 'hi',
          projectRoot: 'D:\\proj\\x',
        }
      }),
      projectRouteOf: vi.fn((sessionId: string) => routes.get(sessionId)),
      setSessionProjectDir: vi.fn((sessionId: string, dir: string) => {
        routes.set(sessionId, dir)
      }),
      dropSessionRouting: vi.fn((sessionId: string) => {
        routes.delete(sessionId)
      }),
    }
    const m = manager as unknown as {
      storageCoordinator: {
        storage: unknown
        groupedStorage: unknown
        homeDir: string
      }
      summaryRepo: {
        preloadComplete: boolean
        sessionRoutingPromise: Promise<string[] | null> | null
        preloadFsSummaries: () => Promise<void>
      }
    }
    m.storageCoordinator.storage = storage
    m.storageCoordinator.groupedStorage = storage
    m.storageCoordinator.homeDir = '/home/me'

    // The preload's scan fails → preloadComplete must NOT latch, and the
    // failed attempt must not stay memoized.
    await m.summaryRepo.preloadFsSummaries()
    expect(m.summaryRepo.preloadComplete).toBe(false)
    expect(m.summaryRepo.sessionRoutingPromise).toBeNull()

    // A resume after the failed preload: the reconcile retries the scan
    // (fast path misses at the type-default dir → slow path re-scans, which
    // now succeeds) and recovers the persisted folder.
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-bound',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-bound',
        templateType: 'code',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const init = workerFactory.instances[0].receivedMessages.find(
      message => message.type === 'worker.init',
    ) as
      | Extract<AgentWorkerInboundMessage, { type: 'worker.init' }>
      | undefined
    expect(init?.payload.projectRoot).toBe('D:\\proj\\x')
  })

  it('routes fork writes before appending so the new worker loads the seeded transcript', async () => {
    // Fork is manager-side and happens before the new session's worker.init. In
    // grouped storage, the new id must be mapped before the first append;
    // otherwise the copy lands in the default workspace while worker.init later
    // routes by template/projectRoot and opens an empty session.
    const sourceProjectDir = '/home/me/.velloc/projects/source-project'
    const routes = new Map<string, string>([
      ['source-session', sourceProjectDir],
    ])
    const appendRoutes: string[] = []
    const appended: BrowserTranscriptEntry[] = []
    const metaWrites: Array<{ sessionId: string; route: string; meta: SessionMetaFile }> = []
    const storage = {
      append: vi.fn(async (sessionId: string, entry: BrowserTranscriptEntry) => {
        appendRoutes.push(routes.get(sessionId) ?? 'DEFAULT_WORKSPACE')
        appended.push(entry)
      }),
      readSessionMeta: vi.fn(async () => null),
      writeSessionMeta: vi.fn(async (sessionId: string, meta: SessionMetaFile) => {
        metaWrites.push({
          sessionId,
          route: routes.get(sessionId) ?? 'DEFAULT_WORKSPACE',
          meta,
        })
      }),
      load: vi.fn(async (): Promise<BrowserConversationStoragePayload> => [
        {
          type: 'user',
          uuid: 'u1',
          sessionId: 'source-session',
          parentUuid: null,
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        } as unknown as BrowserTranscriptEntry,
      ]),
      flush: vi.fn(async () => {}),
      loadSessionMetadata: vi.fn(
        async (): Promise<BrowserSessionMetadata> => ({ templateType: 'agent' }),
      ),
      loadSessionSummary: vi.fn(async (sessionId: string) => ({
        sessionId,
        updatedAt: 1,
        messageCount: appended.length,
        firstPrompt: 'hello',
        previewText: 'hello',
      })),
      projectRouteOf: vi.fn((sessionId: string) => routes.get(sessionId)),
      setSessionProjectDir: vi.fn((sessionId: string, projectDir: string) => {
        routes.set(sessionId, projectDir)
      }),
      loadToolCallDetail: vi.fn(async () => null),
      saveToolCallDetail: vi.fn(async () => {}),
    }
    const m = (
      manager as unknown as {
        storageCoordinator: {
          storage: BrowserConversationStorageBackend
          groupedStorage: typeof storage
          homeDir: string
        }
      }
    ).storageCoordinator
    m.storage = storage as unknown as BrowserConversationStorageBackend
    m.groupedStorage = storage
    m.homeDir = '/home/me'

    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'session.fork',
      fromSessionId: 'source-session',
      cutUuid: 'u1',
      requestId: 'fork-1',
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const ack = port._posted.find(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'session.forked',
    ) as Extract<SharedWorkerOutboundMessage, { type: 'session.forked' }> | undefined
    expect(ack).toBeDefined()
    const newSessionId = ack!.payload.newSessionId
    expect(storage.setSessionProjectDir).toHaveBeenCalledWith(
      newSessionId,
      sourceProjectDir,
    )
    // The log (one copied message) and the projection (`meta.json`) both
    // route to the source's project dir; no `__session_meta` in the log.
    expect(appendRoutes).toEqual([sourceProjectDir])
    expect(
      appended.some(e => (e as { type?: string }).type === SESSION_META_TYPE),
    ).toBe(false)
    expect(metaWrites).toHaveLength(1)
    expect(metaWrites[0]).toMatchObject({
      sessionId: newSessionId,
      route: sourceProjectDir,
    })
    expect(metaWrites[0]!.meta.metadata.messageCount).toBe(1)
  })

  it('writeSessionBundle routes, appends, projects, saves sidecars and publishes — the import write path', async () => {
    // The session-import adapter hands a converted session to this one
    // method (fork shares it). Grouped layout: the id is routed to the dir
    // derived from projectRoot BEFORE the first append; the log, then
    // meta.json, then every sidecar; then the summary refresh that makes the
    // sidebar see it. `hasStoredSession` is the importer's dedup check.
    const routes = new Map<string, string>()
    const appendRoutes: string[] = []
    const appended: BrowserTranscriptEntry[] = []
    const metaWrites: Array<{ sessionId: string; route: string; meta: SessionMetaFile }> = []
    const savedDetails: Array<{ sessionId: string; toolCallId: string }> = []
    const storage = {
      append: vi.fn(async (sessionId: string, entry: BrowserTranscriptEntry) => {
        appendRoutes.push(routes.get(sessionId) ?? 'DEFAULT_WORKSPACE')
        appended.push(entry)
      }),
      // The summary refresh reads the projection back; "no meta.json" means
      // "nothing on disk" and publishes nothing, so hand back what was written.
      readSessionMeta: vi.fn(
        async (sessionId: string) =>
          metaWrites.find(w => w.sessionId === sessionId)?.meta ?? null,
      ),
      writeSessionMeta: vi.fn(async (sessionId: string, meta: SessionMetaFile) => {
        metaWrites.push({ sessionId, route: routes.get(sessionId) ?? 'DEFAULT_WORKSPACE', meta })
      }),
      load: vi.fn(async (): Promise<BrowserConversationStoragePayload> => []),
      flush: vi.fn(async () => {}),
      loadSessionSummary: vi.fn(async (sessionId: string) => ({
        sessionId,
        updatedAt: 1,
        messageCount: appended.length,
        firstPrompt: 'hello',
        previewText: 'hello',
      })),
      listSessions: vi.fn(async () => Array.from(routes.keys())),
      projectRouteOf: vi.fn((sessionId: string) => routes.get(sessionId)),
      setSessionProjectDir: vi.fn((sessionId: string, projectDir: string) => {
        routes.set(sessionId, projectDir)
      }),
      loadToolCallDetail: vi.fn(async () => null),
      saveToolCallDetail: vi.fn(async (sessionId: string, detail: { toolCallId: string }) => {
        savedDetails.push({ sessionId, toolCallId: detail.toolCallId })
      }),
    }
    const m = (
      manager as unknown as {
        storageCoordinator: {
          storage: BrowserConversationStorageBackend
          groupedStorage: typeof storage
          homeDir: string
        }
      }
    ).storageCoordinator
    m.storage = storage as unknown as BrowserConversationStorageBackend
    m.groupedStorage = storage
    m.homeDir = '/home/me'

    const importedId = '3f2a6c1e-9b4d-4e8a-8c1d-0a1b2c3d4e5f'
    expect(await manager.hasStoredSession(importedId)).toBe(false)
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({ type: 'session.subscribe', all: true })
    await manager.writeSessionBundle({
      sessionId: importedId,
      entries: [
        {
          type: 'user',
          uuid: 'u1',
          sessionId: importedId,
          parentUuid: null,
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        } as unknown as BrowserTranscriptWriteEntry,
      ],
      meta: {
        schemaVersion: 1,
        sessionId: importedId,
        updatedAt: 5,
        metadata: { templateType: 'code', projectRoot: '/work/app', messageCount: 1 },
      },
      toolDetails: [{ toolCallId: 'toolu_1', toolName: 'Read', args: {}, result: 'x' }],
      projectRoot: '/work/app',
      templateType: 'code',
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const expectedDir = projectHomeFor('/home/me', '/work/app')
    expect(storage.setSessionProjectDir).toHaveBeenCalledWith(importedId, expectedDir)
    expect(appendRoutes).toEqual([expectedDir])
    expect(metaWrites).toEqual([
      expect.objectContaining({ sessionId: importedId, route: expectedDir }),
    ])
    expect(savedDetails).toEqual([{ sessionId: importedId, toolCallId: 'toolu_1' }])
    expect(await manager.hasStoredSession(importedId)).toBe(true)
    expect(
      port._posted.some(
        (msg: unknown) =>
          (msg as SharedWorkerOutboundMessage).type === 'session.updated' &&
          (msg as { payload: { session: { sessionId: string } } }).payload
            .session.sessionId === importedId,
      ),
    ).toBe(true)
  })

  it('writeSubAgentBundle routes the sub-agent under the parent, writes task.json, publishes nothing', async () => {
    const routes = new Map<string, string>()
    const appendRoutes: string[] = []
    const metaWrites: Array<{ sessionId: string; route: string }> = []
    const storage = {
      append: vi.fn(async (sessionId: string) => {
        appendRoutes.push(routes.get(sessionId) ?? 'DEFAULT_WORKSPACE')
      }),
      readSessionMeta: vi.fn(async () => null),
      writeSessionMeta: vi.fn(async (sessionId: string) => {
        metaWrites.push({ sessionId, route: routes.get(sessionId) ?? 'DEFAULT_WORKSPACE' })
      }),
      load: vi.fn(async (): Promise<BrowserConversationStoragePayload> => []),
      flush: vi.fn(async () => {}),
      loadSessionSummary: vi.fn(async () => null),
      listSessions: vi.fn(async () => Array.from(routes.keys())),
      projectRouteOf: vi.fn((sessionId: string) => routes.get(sessionId)),
      setSessionProjectDir: vi.fn((sessionId: string, projectDir: string) => {
        routes.set(sessionId, projectDir)
      }),
      loadToolCallDetail: vi.fn(async () => null),
      saveToolCallDetail: vi.fn(async () => {}),
    }
    const m = (
      manager as unknown as {
        storageCoordinator: {
          storage: BrowserConversationStorageBackend
          groupedStorage: typeof storage
          homeDir: string
          writeSubAgentTaskFile: unknown
        }
      }
    ).storageCoordinator
    m.storage = storage as unknown as BrowserConversationStorageBackend
    m.groupedStorage = storage
    m.homeDir = '/home/me'
    const taskWrites: Array<[string, string, string, string]> = []
    m.writeSubAgentTaskFile = vi.fn(async (...args: [string, string, string, string]) => {
      taskWrites.push(args)
    })

    const parentId = '3f2a6c1e-9b4d-4e8a-8c1d-0a1b2c3d4e5f'
    const subId = 'subagent-a1b2'
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({ type: 'session.subscribe', all: true })
    // Not routed yet → refuses (the parent locates the subagents dir).
    await expect(
      manager.writeSubAgentBundle(parentId, {
        sessionId: subId, entries: [], toolDetails: [], task: {},
        meta: { schemaVersion: 1, sessionId: subId, updatedAt: 1, metadata: {} },
      }),
    ).rejects.toThrow()
    routes.set(parentId, projectHomeFor('/home/me', '/work/app'))
    await manager.writeSubAgentBundle(parentId, {
      sessionId: subId,
      entries: [],
      toolDetails: [],
      meta: { schemaVersion: 1, sessionId: subId, updatedAt: 1, metadata: {} },
      task: { schemaVersion: 1, taskId: 'a0000001', sessionId: subId },
    })
    const expectedDir = `${projectHomeFor('/home/me', '/work/app')}/${parentId}/subagents`.replace(/\\/g, '/')
    expect(routes.get(subId)!.replace(/\\/g, '/')).toBe(expectedDir)
    expect(metaWrites).toEqual([{ sessionId: subId, route: routes.get(subId) }])
    expect(taskWrites).toEqual([[parentId, subId, 'task.json', JSON.stringify({ schemaVersion: 1, taskId: 'a0000001', sessionId: subId })]])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(
      port._posted.some(
        (msg: unknown) =>
          (msg as SharedWorkerOutboundMessage).type === 'session.updated' &&
          (msg as { payload: { session: { sessionId: string } } }).payload.session.sessionId === subId,
      ),
    ).toBe(false)
  })

  it('writeSubAgentBundle self-routes the parent from the bundle projectRoot when the parent is not written yet', async () => {
    // Import writes sub-agents BEFORE the parent transcript (so a failed
    // sub-agent write leaves no dead task-id ack in the append-only parent), so
    // the parent's routing may not be committed yet. The bundle carries the
    // shared projectRoot; the write commits routing from it.
    const routes = new Map<string, string>()
    const metaWrites: string[] = []
    const storage = {
      append: vi.fn(async () => {}),
      readSessionMeta: vi.fn(async () => null),
      writeSessionMeta: vi.fn(async (sessionId: string) => {
        metaWrites.push(sessionId)
      }),
      load: vi.fn(async (): Promise<BrowserConversationStoragePayload> => []),
      flush: vi.fn(async () => {}),
      loadSessionSummary: vi.fn(async () => null),
      listSessions: vi.fn(async () => Array.from(routes.keys())),
      projectRouteOf: vi.fn((sessionId: string) => routes.get(sessionId)),
      setSessionProjectDir: vi.fn((sessionId: string, projectDir: string) => {
        routes.set(sessionId, projectDir)
      }),
      loadToolCallDetail: vi.fn(async () => null),
      saveToolCallDetail: vi.fn(async () => {}),
    }
    const m = (
      manager as unknown as {
        storageCoordinator: {
          storage: BrowserConversationStorageBackend
          groupedStorage: typeof storage
          homeDir: string
          writeSubAgentTaskFile: unknown
        }
      }
    ).storageCoordinator
    m.storage = storage as unknown as BrowserConversationStorageBackend
    m.groupedStorage = storage
    m.homeDir = '/home/me'
    const taskWrites: Array<[string, string, string, string]> = []
    m.writeSubAgentTaskFile = vi.fn(async (...args: [string, string, string, string]) => {
      taskWrites.push(args)
    })

    const parentId = '3f2a6c1e-9b4d-4e8a-8c1d-0a1b2c3d4e5f'
    const subId = 'subagent-a1b2'
    // Parent NOT pre-routed (routes empty). The bundle's own projectRoot drives
    // routing — an imported sub-agent shares its parent's project dir.
    await manager.writeSubAgentBundle(parentId, {
      sessionId: subId,
      entries: [],
      toolDetails: [],
      meta: {
        schemaVersion: 1,
        sessionId: subId,
        updatedAt: 1,
        metadata: { projectRoot: '/work/app' },
      },
      task: { schemaVersion: 1, taskId: 'a0000001', sessionId: subId },
    })
    const expectedParentDir = projectHomeFor('/home/me', '/work/app')
    const expectedSubDir = `${expectedParentDir}/${parentId}/subagents`.replace(/\\/g, '/')
    expect(routes.get(parentId)).toBe(expectedParentDir)
    expect(routes.get(subId)!.replace(/\\/g, '/')).toBe(expectedSubDir)
    expect(metaWrites).toEqual([subId])
    expect(taskWrites).toHaveLength(1)
  })

  it('honours an exclusive fork: cut prompt left out, carried as the composer draft', async () => {
    // "Fork from here" posts `moveCutMessageToDraft`. The forked transcript
    // must stop BEFORE the cut prompt and hand that prompt to the new
    // session's composer instead of replaying it.
    const appended: BrowserTranscriptEntry[] = []
    const metaWrites: SessionMetaFile[] = []
    const storage = {
      append: vi.fn(async (_sessionId: string, entry: BrowserTranscriptEntry) => {
        appended.push(entry)
      }),
      readSessionMeta: vi.fn(async () => null),
      writeSessionMeta: vi.fn(async (_sessionId: string, meta: SessionMetaFile) => {
        metaWrites.push(meta)
      }),
      load: vi.fn(async (): Promise<BrowserConversationStoragePayload> => [
        {
          type: 'user',
          uuid: 'u1',
          sessionId: 'source-session',
          parentUuid: null,
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        } as unknown as BrowserTranscriptEntry,
      ]),
      flush: vi.fn(async () => {}),
      loadSessionMetadata: vi.fn(
        async (): Promise<BrowserSessionMetadata> => ({ templateType: 'agent' }),
      ),
      loadSessionSummary: vi.fn(async (sessionId: string) => ({
        sessionId,
        updatedAt: 1,
        messageCount: 0,
        firstPrompt: '',
        previewText: '',
      })),
      loadToolCallDetail: vi.fn(async () => null),
      saveToolCallDetail: vi.fn(async () => {}),
    }
    const m = (
      manager as unknown as {
        storageCoordinator: { storage: BrowserConversationStorageBackend }
      }
    ).storageCoordinator
    m.storage = storage as unknown as BrowserConversationStorageBackend

    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'session.fork',
      fromSessionId: 'source-session',
      cutUuid: 'u1',
      requestId: 'fork-draft-1',
      moveCutMessageToDraft: true,
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const ack = port._posted.find(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'session.forked',
    ) as
      | Extract<SharedWorkerOutboundMessage, { type: 'session.forked' }>
      | undefined
    expect(ack).toBeDefined()

    // Nothing replayed into the log; the draft rides the projection.
    expect(appended).toHaveLength(0)
    expect(metaWrites).toHaveLength(1)
    expect(metaWrites[0]!.metadata.composerDraft).toBe('hello')
  })

  it('names a "Fork from here" copy with the title the page sends', async () => {
    // The page localizes "<source title> (fork)" and posts it; the manager
    // persists it as the fork's own custom-title action + meta.json title, so
    // the copy is telling apart from the original in the sidebar.
    const appended: BrowserTranscriptEntry[] = []
    const metaWrites: SessionMetaFile[] = []
    const storage = {
      append: vi.fn(async (_sessionId: string, entry: BrowserTranscriptEntry) => {
        appended.push(entry)
      }),
      readSessionMeta: vi.fn(async () => null),
      writeSessionMeta: vi.fn(async (_sessionId: string, meta: SessionMetaFile) => {
        metaWrites.push(meta)
      }),
      load: vi.fn(async (): Promise<BrowserConversationStoragePayload> => [
        {
          type: 'user',
          uuid: 'u1',
          sessionId: 'source-session',
          parentUuid: null,
          transcriptOrdinal: 0,
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        } as unknown as BrowserTranscriptEntry,
        {
          type: 'assistant',
          uuid: 'a1',
          sessionId: 'source-session',
          parentUuid: 'u1',
          transcriptOrdinal: 1,
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        } as unknown as BrowserTranscriptEntry,
      ]),
      flush: vi.fn(async () => {}),
      loadSessionMetadata: vi.fn(
        async (): Promise<BrowserSessionMetadata> => ({
          templateType: 'agent',
          customTitle: 'Original',
        }),
      ),
      loadSessionSummary: vi.fn(async (sessionId: string) => ({
        sessionId,
        updatedAt: 1,
        messageCount: 2,
        firstPrompt: 'hello',
        previewText: 'hi',
      })),
      loadToolCallDetail: vi.fn(async () => null),
      saveToolCallDetail: vi.fn(async () => {}),
    }
    const m = (
      manager as unknown as {
        storageCoordinator: { storage: BrowserConversationStorageBackend }
      }
    ).storageCoordinator
    m.storage = storage as unknown as BrowserConversationStorageBackend

    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'session.fork',
      fromSessionId: 'source-session',
      cutUuid: 'a1',
      requestId: 'fork-title-1',
      moveCutMessageToDraft: true,
      title: 'Original (fork)',
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const ack = port._posted.find(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'session.forked',
    )
    expect(ack).toBeDefined()
    expect(metaWrites).toHaveLength(1)
    expect(metaWrites[0]!.customTitle).toBe('Original (fork)')
    expect('customTitle' in metaWrites[0]!.metadata).toBe(false)
    const titleRecords = appended.filter(
      e => (e as { type?: string }).type === 'custom-title',
    )
    expect(titleRecords).toHaveLength(1)
    expect(titleRecords[0]).toMatchObject({ customTitle: 'Original (fork)' })

    // Rewind (no title) keeps the source's exact title.
    appended.length = 0
    metaWrites.length = 0
    port._simulateMessage({
      type: 'session.fork',
      fromSessionId: 'source-session',
      cutUuid: 'a1',
      requestId: 'rewind-title-1',
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(metaWrites[0]!.customTitle).toBe('Original')
  })

  it('disk-only rename: routes first, writes one custom-title + meta.json, and never acks a rename it could not persist', async () => {
    const appended: BrowserTranscriptEntry[] = []
    const metaWrites: SessionMetaFile[] = []
    const metas = new Map<string, SessionMetaFile>([
      [
        'closed-session',
        {
          schemaVersion: 1,
          sessionId: 'closed-session',
          updatedAt: 10,
          metadata: { llmSelection: { providerId: 'p', modelId: 'm' } },
        },
      ],
    ])
    const storage = {
      append: vi.fn(async (_sessionId: string, entry: BrowserTranscriptEntry) => {
        appended.push(entry)
      }),
      readSessionMeta: vi.fn(async (sessionId: string) => metas.get(sessionId) ?? null),
      writeSessionMeta: vi.fn(async (sessionId: string, meta: SessionMetaFile) => {
        metaWrites.push(meta)
        metas.set(sessionId, meta)
      }),
      load: vi.fn(async (): Promise<BrowserConversationStoragePayload> => null),
      flush: vi.fn(async () => {}),
      listSessions: vi.fn(async () => ['closed-session']),
      loadSessionSummary: vi.fn(async (sessionId: string) => {
        const meta = metas.get(sessionId)
        return meta
          ? {
              sessionId,
              updatedAt: meta.updatedAt,
              messageCount: 0,
              firstPrompt: '',
              previewText: '',
              customTitle: meta.customTitle,
            }
          : null
      }),
      loadToolCallDetail: vi.fn(async () => null),
      saveToolCallDetail: vi.fn(async () => {}),
    }
    const m = (
      manager as unknown as {
        storageCoordinator: { storage: BrowserConversationStorageBackend }
      }
    ).storageCoordinator
    m.storage = storage as unknown as BrowserConversationStorageBackend

    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'session.rename',
      sessionId: 'closed-session',
      title: 'Renamed Closed',
      requestId: 'ren-1',
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // The routing scan ran BEFORE the probe (a grouped storage would otherwise
    // look in the default dir and find nothing), then one log record + the
    // projection, keeping the unlogged fields.
    expect(storage.listSessions).toHaveBeenCalled()
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({ type: 'custom-title', customTitle: 'Renamed Closed' })
    expect(metaWrites).toHaveLength(1)
    expect(metaWrites[0]!.customTitle).toBe('Renamed Closed')
    expect(metaWrites[0]!.metadata.llmSelection).toEqual({ providerId: 'p', modelId: 'm' })
    const acked = port._posted.some(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'session.updated' &&
        (msg as { payload: { session: { sessionId: string } } }).payload.session
          .sessionId === 'closed-session',
    )
    expect(acked).toBe(true)

    // Nothing on disk for this id: nothing is written and NO session.updated
    // ack is posted — the UI must not show a rename that has no durable
    // counterpart.
    port._posted.length = 0
    appended.length = 0
    metaWrites.length = 0
    port._simulateMessage({
      type: 'session.rename',
      sessionId: 'ghost-session',
      title: 'Ghost',
      requestId: 'ren-2',
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(appended).toHaveLength(0)
    expect(metaWrites).toHaveLength(0)
    expect(
      port._posted.some(
        (msg: unknown) =>
          (msg as SharedWorkerOutboundMessage).type === 'session.updated' &&
          (msg as { payload: { session: { sessionId: string } } }).payload
            .session.sessionId === 'ghost-session',
      ),
    ).toBe(false)
  })

  it('re-applies diagnostic gates when an existing worker is reused', async () => {
    // Models a page reload after the user enables "Verbose logging" /
    // "Trace overlay": the SharedWorker persists, so the reconnect reuses
    // the worker WITHOUT re-running runInit. The fresh init payload's
    // trace flag must still reach the worker, or the overlay's
    // Model-JSON tab stays empty.
    const port1 = createMockPort()
    const port2 = createMockPort()
    manager.handleConnect(port1)
    manager.handleConnect(port2)

    // First boot: tracing off.
    port1._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-trace',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-trace',
        traceModelRequests: false,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // Reload with the toggle on: same session, tracing now requested.
    port2._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-trace',
      payload: {
        cwd: '/workspace',
        sessionId: 'session-trace',
        traceModelRequests: true,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // Worker reused (no second instance), and the fresh trace flag was
    // forwarded to it via applyDiagnosticGates.
    expect(workerFactory.instances).toHaveLength(1)
    const reused = workerFactory.instances[0]
    expect(reused.diagnosticGateCalls).toHaveLength(1)
    expect(reused.diagnosticGateCalls[0].traceModelRequests).toBe(true)
  })

  it('broadcasts outbound messages to all subscribed ports', async () => {
    const port1 = createMockPort()
    const port2 = createMockPort()
    manager.handleConnect(port1)
    manager.handleConnect(port2)

    port1._simulateMessage({
      type: 'worker.init',
      sessionId: 'broadcast-test',
      payload: { cwd: '/workspace', sessionId: 'broadcast-test' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    port2._simulateMessage({
      type: 'worker.init',
      sessionId: 'broadcast-test',
      payload: { cwd: '/workspace', sessionId: 'broadcast-test' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    port1._posted.length = 0
    port2._posted.length = 0

    port1._simulateMessage({
      type: 'worker.getState',
      sessionId: 'broadcast-test',
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    const port1States = port1._posted.filter(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'worker.state',
    )
    const port2States = port2._posted.filter(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'worker.state',
    )
    expect(port1States.length).toBe(1)
    expect(port2States.length).toBe(1)
  })

  it('routes session.detach and stops broadcasting', async () => {
    const port1 = createMockPort()
    const port2 = createMockPort()
    manager.handleConnect(port1)
    manager.handleConnect(port2)

    port1._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-detach',
      payload: { cwd: '/workspace', sessionId: 'session-detach' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    port2._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-detach',
      payload: { cwd: '/workspace', sessionId: 'session-detach' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    port1._simulateMessage({
      type: 'session.detach',
      sessionId: 'session-detach',
    })

    port1._posted.length = 0
    port2._posted.length = 0

    port2._simulateMessage({
      type: 'worker.getState',
      sessionId: 'session-detach',
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    const port1States = port1._posted.filter(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'worker.state',
    )
    const port2States = port2._posted.filter(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'worker.state',
    )
    expect(port1States.length).toBe(0)
    expect(port2States.length).toBe(1)
  })

  it('responds to session.list', async () => {
    const port = createMockPort()
    manager.handleConnect(port)

    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'list-test-a',
      payload: { cwd: '/workspace', sessionId: 'list-test-a' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    port._simulateMessage({ type: 'session.list' })

    const listResponse = port._posted.find(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'session.list',
    ) as SharedWorkerOutboundMessage | undefined

    expect(listResponse).toBeDefined()
    if (listResponse && listResponse.type === 'session.list') {
      expect(listResponse.payload.sessions).toHaveLength(1)
      expect(listResponse.payload.sessions[0]!.sessionId).toBe('list-test-a')
    }
  })

  it('sets bridge port and starts it', () => {
    const uiPort = createMockPort()
    const bridgePort = createMockPort()
    manager.handleConnect(uiPort)

    uiPort._simulateMessage({ type: 'bridge.setPort' }, [bridgePort])

    expect(bridgePort._started).toBe(true)
    expect(bridgePort._listeners.get('message')?.length).toBe(1)
  })

  it('routes browser bridge requests through the direct bridge port when direct mode is enabled', async () => {
    // shouldUseDirectBridge() now includes 'browser' alongside
    // fs/model/process/ui (see SharedWorkerSessionManager.ts), so a
    // browser-capability request issued while a direct-mode bridge port
    // is attached travels straight to the bridge port via
    // DirectPortBridgeTransport rather than getting relayed back through
    // the session port.
    const uiPort = createMockPort()
    const bridgePort = createMockPort()
    manager.handleConnect(uiPort)

    uiPort._simulateMessage({ type: 'bridge.setPort' }, [bridgePort])

    uiPort._simulateMessage({
      type: 'worker.init',
      sessionId: 'browser-route-test',
      payload: { cwd: '/workspace', sessionId: 'browser-route-test' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))
    uiPort._posted.length = 0
    bridgePort._posted.length = 0

    uiPort._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: 'browser-route-test',
      payload: { prompt: '__bridge_browser' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    // The bridge request reaches the bridge port via the direct
    // transport, which posts a JSON-serialized envelope (see
    // DirectPortBridgeTransport.ts:437,442). Parse each posted message
    // and confirm at least one carries route.capability === 'session'.
    expect(bridgePort._posted.length).toBeGreaterThanOrEqual(1)
    const directlyPosted = bridgePort._posted.find((msg: unknown) => {
      let record: { route?: { capability?: string } } | null = null
      if (typeof msg === 'string') {
        try {
          record = JSON.parse(msg) as { route?: { capability?: string } }
        } catch {
          return false
        }
      } else if (msg && typeof msg === 'object') {
        const obj = msg as { route?: { capability?: string }; payload?: { route?: { capability?: string } } }
        record = obj.payload ?? obj
      }
      return record?.route?.capability === 'session'
    })
    expect(directlyPosted).toBeDefined()

    // Nothing is handed to the page that opened the session.
    expect(uiPort._posted.some(msg => (msg as { type?: string }).type === 'bridge.request')).toBe(false)
  })

  // The runtime makes its own host calls. `network` (WebFetch,
  // provider model lists) used to fall through to the session's page, which
  // executed it on its own port and answered with `session.bridgeResponse` —
  // a `full` action, so a scoped client's session never got its model list,
  // and a background run with no page got nothing at all.
  it("a session's network call rides the runtime's host port, never the page that opened it", async () => {
    const uiPort = createMockPort()
    const bridgePort = createMockPort()
    manager.handleConnect(uiPort)
    uiPort._simulateMessage({ type: 'bridge.setPort' }, [bridgePort])
    uiPort._simulateMessage({
      type: 'worker.init',
      sessionId: 'network-route-test',
      payload: { cwd: '/workspace', sessionId: 'network-route-test' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    uiPort._posted.length = 0
    bridgePort._posted.length = 0

    uiPort._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: 'network-route-test',
      payload: { prompt: '__bridge_network' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const routes = bridgePort._posted.map(msg => {
      const record = (typeof msg === 'string' ? JSON.parse(msg) : msg) as { route?: { capability?: string; action?: string } }
      return `${record.route?.capability}.${record.route?.action}`
    })
    expect(routes).toContain('network.httpGet')
    expect(uiPort._posted.some(msg => (msg as { type?: string }).type === 'bridge.request')).toBe(false)
  })

  it('a host call the host port does not serve fails at once instead of waiting on a page', async () => {
    const uiPort = createMockPort()
    const bridgePort = createMockPort()
    manager.handleConnect(uiPort)
    uiPort._simulateMessage({ type: 'bridge.setPort' }, [bridgePort])
    uiPort._simulateMessage({
      type: 'worker.init',
      sessionId: 'unserved-route-test',
      payload: { cwd: '/workspace', sessionId: 'unserved-route-test' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    uiPort._posted.length = 0

    uiPort._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: 'unserved-route-test',
      payload: { prompt: '__bridge_context' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(bridgeResponses(workerFactory)).toContainEqual(
      expect.objectContaining({ id: 'bridge-context-1', ok: false, error: expect.objectContaining({ code: 'bridge_transport_error' }) }),
    )
    expect(uiPort._posted.some(msg => (msg as { type?: string }).type === 'bridge.request')).toBe(false)
  })

  it('with no host port attached a host call fails at once', async () => {
    const uiPort = createMockPort()
    manager.handleConnect(uiPort)
    uiPort._simulateMessage({
      type: 'worker.init',
      sessionId: 'no-port-test',
      payload: { cwd: '/workspace', sessionId: 'no-port-test' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    uiPort._posted.length = 0

    uiPort._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: 'no-port-test',
      payload: { prompt: '__bridge_network' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(bridgeResponses(workerFactory)).toContainEqual(
      expect.objectContaining({ id: 'bridge-network-1', ok: false, error: expect.objectContaining({ code: 'bridge_transport_error' }) }),
    )
    expect(uiPort._posted.some(msg => (msg as { type?: string }).type === 'bridge.request')).toBe(false)
  })

  // The host's copy of the curated catalog is what `model.catalog` answers,
  // and a session's model selection is validated against that answer. The PAGE
  // used to publish it, so a scoped client (refused `model.publishCatalog`,
  // which is `full`) left the host without one and every selection in its
  // sessions failed as unavailable.
  it('the runtime publishes the curated model catalog to the host port at boot', async () => {
    const uiPort = createMockPort()
    const bridgePort = createMockPort()
    manager.handleConnect(uiPort)
    uiPort._simulateMessage({ type: 'bridge.setPort' }, [bridgePort])

    await vi.waitFor(() => {
      const routes = bridgePort._posted.map(msg => {
        const record = (typeof msg === 'string' ? JSON.parse(msg) : msg) as {
          route?: { capability?: string; action?: string }
          payload?: { catalog?: { providers?: unknown } }
        }
        return record
      })
      const published = routes.find(r => r.route?.capability === 'model' && r.route?.action === 'publishCatalog')
      expect(published, 'the runtime must publish the catalog, not a client').toBeDefined()
      expect(published?.payload?.catalog).toBeDefined()
    }, { timeout: 4000 })
  })

  // R5 (no reverse call): the turn-end nudge is published for clients to
  // render, not dispatched to this machine's host. Before, the runtime called
  // `ui.showNotification` on its own host port, so a remote client could never
  // be told and this window's toast fired even with nobody at it.
  it('a turn-end notification is published on the notifications topic, not sent to the host', async () => {
    const uiPort = createMockPort()
    const bridgePort = createMockPort()
    manager.handleConnect(uiPort)
    uiPort._simulateMessage({ type: 'bridge.setPort' }, [bridgePort])
    const m = manager as unknown as {
      notificationSink(opts: { message: string; notificationType: string; sessionId?: string }): Promise<unknown>
      runtimeHub: { broker: { publish(topic: string, payload: unknown, opts?: { type?: string }): number } }
    }
    const published: Array<{ topic: string; payload: unknown; type?: string }> = []
    const realPublish = m.runtimeHub.broker.publish.bind(m.runtimeHub.broker)
    m.runtimeHub.broker.publish = (topic, payload, opts) => {
      published.push({ topic, payload, type: opts?.type })
      return realPublish(topic, payload, opts)
    }
    bridgePort._posted.length = 0

    await m.notificationSink({ message: 'waiting for you', notificationType: 'turn_complete', sessionId: 's1' })

    expect(published).toContainEqual(
      expect.objectContaining({ topic: 'notifications', type: 'turnEnd', payload: expect.objectContaining({ sessionId: 's1' }) }),
    )
    const toHost = bridgePort._posted.map(msg => {
      const record = (typeof msg === 'string' ? JSON.parse(msg) : msg) as { route?: { action?: string } }
      return record.route?.action
    })
    expect(toHost).not.toContain('showNotification')
  })

  // `waitForDirectBridgeTransport` must not resolve while no direct port exists, and must resolve with the transport
  // once a late `bridge.setPort` (direct) wires it.
  it('waitForDirectBridgeTransport waits for a late-wired direct bridge port instead of bailing', async () => {
    const m = manager as unknown as {
      bootServices: {
        waitForDirectBridgeTransport(ms: number): Promise<unknown>
      }
      bridgeRouter: { getDirectTransport(): unknown }
    }
    expect(m.bridgeRouter.getDirectTransport()).toBeFalsy()

    const uiPort = createMockPort()
    manager.handleConnect(uiPort)

    const waitP = m.bootServices.waitForDirectBridgeTransport(4000)
    let settled = false
    void waitP.then(() => {
      settled = true
    })

    // No direct port yet → must stay pending (the pre-fix bail returned
    // immediately; the wait must not).
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(settled, 'must not resolve while no direct port is wired').toBe(false)

    // Wire the direct port late (simulates the slow boot handshake under load).
    const bridgePort = createMockPort()
    uiPort._simulateMessage({ type: 'bridge.setPort' }, [bridgePort])

    const resolved = await waitP
    expect(
      resolved,
      'resolves with the transport once the direct port arrives',
    ).toBeTruthy()
    expect(m.bridgeRouter.getDirectTransport()).toBeTruthy()
  })

  // Regression: bootRoutineRuntimeOnce runs in the boot path BEFORE any
  // per-session createBrowserRuntime installs the global fs adapter, so it used
  // the unconfiguredFs stub — RoutineRegistry was bound to a dead fs
  // (readFile throws "not configured") and the boot settings read warned on
  // every boot. It must build a bridge-backed fs from the transport instead.
  it('boots the routine runtime with a bridge-backed fs, not the unconfigured stub', async () => {
    const prevFs = processFs()
    resetProcessFs() // global fs = Unsupported stub (the boot reality)
    let bridgeRequests = 0
    const fakeTransport = {
      request: async () => {
        bridgeRequests++
        return { ok: false as const, error: { code: 'ENOENT', message: 'no such file' } }
      },
    }
    const m = manager as unknown as {
      bridgeRouter: { directTransport: unknown }
      storageCoordinator: {
        storagePath: string | null
        homeDir: string | null
      }
      bootServices: {
        routineRuntimeHandle: unknown
        bootRoutineRuntimeOnce(): Promise<void>
      }
    }
    m.bridgeRouter.directTransport = fakeTransport
    m.storageCoordinator.storagePath = '/workspace/.velloc'
    m.storageCoordinator.homeDir = null // skip the readUserLayer/reconcile branch; the routine fs is the target
    m.bootServices.routineRuntimeHandle = undefined

    try {
      await m.bootServices.bootRoutineRuntimeOnce()

      const fsArg = vi.mocked(initializeRoutineRuntime).mock.calls.at(-1)?.[0]?.fs
      expect(fsArg, 'routine runtime must receive an fs').toBeDefined()

      let err = ''
      await fsArg!
        .readFile('/workspace/.velloc/routines.jsonl', { encoding: 'utf-8' })
        .catch((e: unknown) => {
          err = e instanceof Error ? e.message : String(e)
        })
      // It routed through the bridge transport (so it's bridge-backed) and did
      // NOT throw the stub's "not configured" error.
      expect(bridgeRequests, 'readFile must hit the bridge transport').toBeGreaterThan(0)
      expect(err).not.toMatch(/not configured/i)
    } finally {
      installProcessFs(prevFs)
    }
  })

  it('returns error for messages to non-existent sessions', () => {
    const port = createMockPort()
    manager.handleConnect(port)

    port._simulateMessage({
      type: 'worker.getState',
      sessionId: 'non-existent',
    })

    const error = port._posted.find(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'worker.error',
    ) as SharedWorkerOutboundMessage | undefined

    expect(error).toBeDefined()
    if (error && error.type === 'worker.error') {
      expect(error.payload.code).toBe('session_not_found')
    }
  })

  it('port.disconnect routes to handlePortDisconnect and releases the port everywhere', async () => {
    // Production never called `handlePortDisconnect` — a SharedWorker gets no
    // close event for a client port — so every page (re)load leaked its port
    // in the hub and in every `session.ports` set. The page now posts
    // `port.disconnect` on unload; this pins the route.
    const port = createMockPort()
    manager.handleConnect(port)
    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'disconnect-msg',
      payload: { cwd: '/workspace', sessionId: 'disconnect-msg' },
    })
    port._simulateMessage({ type: 'session.subscribe', all: true })
    await new Promise(resolve => setTimeout(resolve, 10))
    const internals = manager as unknown as {
      portHub: { portCount: number; getListSubscribers(): MessagePort[] }
      sessions: Map<string, { ports: Set<MessagePort> }>
    }
    expect(internals.portHub.portCount).toBe(1)
    expect(internals.portHub.getListSubscribers()).toHaveLength(1)
    expect(internals.sessions.get('disconnect-msg')?.ports.has(port)).toBe(true)

    port._simulateMessage({ type: 'port.disconnect' })

    expect(internals.portHub.portCount).toBe(0)
    expect(internals.portHub.getListSubscribers()).toHaveLength(0)
    expect(internals.sessions.get('disconnect-msg')?.ports.has(port)).toBe(false)
    // The session itself survives — a reload re-attaches to it.
    expect(internals.sessions.has('disconnect-msg')).toBe(true)
  })

  describe('rejects malformed identifiers before any handler runs', () => {
    // Session ids become storage paths (`joinRuntimePath(projectDir,
    // sessionId)` → a recursive delete on `session.delete`); `title` is
    // `.trim()`ed; `sessionIds` / `toolCallIds` are iterated. None of it was
    // checked past `typeof type === 'string'`.
    function errorsOn(port: ReturnType<typeof createMockPort>) {
      return port._posted
        .map(m => m as { type?: string; sessionId?: string; requestId?: string; payload?: { code?: string } })
        .filter(m => m.type === 'worker.error')
    }

    it.each([
      ['session.delete', { type: 'session.delete', sessionId: '../../etc', requestId: 'r1' }],
      ['session.transcript', { type: 'session.transcript', sessionId: 'a/b', requestId: 'r2' }],
      ['session.detach', { type: 'session.detach', sessionId: '..' }],
      ['session.rename', { type: 'session.rename', sessionId: 'has space', title: 'x' }],
      ['session.fork', { type: 'session.fork', fromSessionId: 'C:\\evil', cutUuid: 'u' }],
      ['task.stop', { type: 'task.stop', sessionId: '' }],
      ['task.resume', { type: 'task.resume', sessionId: 42, prompt: 'p' }],
      ['task.transcript', { type: 'task.transcript', sessionId: '.hidden', requestId: 'r3' }],
      ['task.recoverBackground', { type: 'task.recoverBackground', sessionId: 'x'.repeat(200) }],
      ['worker.getState', { type: 'worker.getState', sessionId: '../sibling' }],
      ['worker.init (payload.sessionId)', { type: 'worker.init', sessionId: 'ok-1', payload: { cwd: '/w', sessionId: '../x' } }],
      ['worker.init (payload.spawnerSessionId)', { type: 'worker.init', sessionId: 'ok-2', payload: { cwd: '/w', sessionId: 'ok-2', spawnerSessionId: 'lead/../x' } }],
      ['session.subscribe', { type: 'session.subscribe', sessionIds: ['fine', '../bad'] }],
      ['toolDetail.subscribe (sessionId hint)', { type: 'toolDetail.subscribe', toolCallIds: ['t1'], sessionId: 'no/way' }],
    ])('%s with an unsafe session id is refused as invalid_session_id', (_label, message) => {
      const port = createMockPort()
      manager.handleConnect(port)
      port._simulateMessage(message)
      const errors = errorsOn(port)
      expect(errors).toHaveLength(1)
      expect(errors[0]!.payload?.code).toBe('invalid_session_id')
      // Nothing was dispatched: no worker was allocated, no session registered.
      expect(workerFactory.instances).toHaveLength(0)
      expect((manager as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
    })

    it('echoes the requestId (and a string sessionId) so the requester\u2019s promise settles', () => {
      const port = createMockPort()
      manager.handleConnect(port)
      port._simulateMessage({ type: 'session.delete', sessionId: 'bad/id', requestId: 'req-9' })
      const [error] = errorsOn(port)
      expect(error).toMatchObject({ type: 'worker.error', sessionId: 'bad/id', requestId: 'req-9' })
    })

    it.each([
      ['session.rename title', { type: 'session.rename', sessionId: 'ok', title: 7 }, "'title'"],
      ['session.fork cutUuid', { type: 'session.fork', fromSessionId: 'ok', cutUuid: null }, "'cutUuid'"],
      ['session.subscribe sessionIds', { type: 'session.subscribe', sessionIds: 'ok' }, "'sessionIds'"],
      ['session.unsubscribe sessionIds', { type: 'session.unsubscribe', sessionIds: [1, 2] }, "'sessionIds'"],
      ['toolDetail.subscribe toolCallIds', { type: 'toolDetail.subscribe', toolCallIds: 't1' }, "'toolCallIds'"],
      ['toolDetail.unsubscribe toolCallIds', { type: 'toolDetail.unsubscribe', toolCallIds: [{}] }, "'toolCallIds'"],
    ])('%s of the wrong shape is refused as invalid_message', (_label, message, field) => {
      const port = createMockPort()
      manager.handleConnect(port)
      port._simulateMessage(message)
      const errors = errorsOn(port)
      expect(errors).toHaveLength(1)
      expect(errors[0]!.payload?.code).toBe('invalid_message')
      expect((errors[0]!.payload as { message?: string }).message).toContain(field)
    })

    it('every id shape this realm mints passes', () => {
      const port = createMockPort()
      manager.handleConnect(port)
      for (const id of [
        '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        'subagent-Explore_1a2b3c4d_5e6f',
        'teammate-proj-m-1a2b3c4d-1789000000000',
        'headless-rt_abc123_def456-1789000000000',
        'a1b2c3d4e5',
        'session-1',
      ]) {
        port._simulateMessage({ type: 'session.detach', sessionId: id })
      }
      expect(errorsOn(port)).toHaveLength(0)
    })
  })

  it('cleans up port subscriptions on disconnect', async () => {
    const port1 = createMockPort()
    const port2 = createMockPort()
    manager.handleConnect(port1)

    port1._simulateMessage({
      type: 'worker.init',
      sessionId: 'disconnect-test',
      payload: { cwd: '/workspace', sessionId: 'disconnect-test' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    manager.handlePortDisconnect(port1)

    manager.handleConnect(port2)
    port2._simulateMessage({
      type: 'worker.init',
      sessionId: 'disconnect-test',
      payload: { cwd: '/workspace', sessionId: 'disconnect-test' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    const ready = port2._posted.find(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'worker.ready',
    )
    expect(ready).toBeDefined()
    expect(workerFactory.instances).toHaveLength(1)
  })

  it('manages multiple independent sessions', async () => {
    const port = createMockPort()
    manager.handleConnect(port)

    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-1',
      payload: { cwd: '/workspace', sessionId: 'session-1' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    port._simulateMessage({
      type: 'worker.init',
      sessionId: 'session-2',
      payload: { cwd: '/workspace', sessionId: 'session-2' },
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    expect(workerFactory.instances).toHaveLength(2)

    port._posted.length = 0
    port._simulateMessage({ type: 'session.list' })

    const listResponse = port._posted.find(
      (msg: unknown) =>
        (msg as SharedWorkerOutboundMessage).type === 'session.list',
    ) as SharedWorkerOutboundMessage | undefined

    if (listResponse && listResponse.type === 'session.list') {
      const ids = listResponse.payload.sessions.map(s => s.sessionId).sort()
      expect(ids).toEqual(['session-1', 'session-2'])
    }
  })

  // The panel's build-info feed — live fan-out plus replay to a late attach —
  // is `shell/<panelId>` now (a delta and the topic's snapshot), covered by
  // `runtime-shell.test.ts`.

  it('adopts the persistent shells a previous worker left running once the port AND the manifest are known (B3)', async () => {
    // The background-shell registry is the worker's (persistent host children,
    // shell.spawn + persist): a worker that comes back while one still runs
    // finds it with shell.persistentList and shows it live again. It needs
    // the host port and a manifest listing the persistent shells — whichever
    // arrives second triggers it, once per port.
    const m = manager as unknown as {
      bridgeRouter: { directTransport: unknown }
      hostEnvironment: unknown
      maybeAdoptPersistentShells(): void
      taskRegistry: {
        getLiveByType(id: string, type: string): { taskId: string; spawnerSessionId: string; command: string } | undefined
      }
      shells: { finalizeForTest(id: string, status: 'stopped', summary: string): void }
    }
    const lists: number[] = []
    m.bridgeRouter.directTransport = {
      request: async (req: { route: { capability: string; action: string } }) => {
        if (req.route.action === 'persistentList') {
          lists.push(1)
          return {
            ok: true,
            result: {
              shells: [{
                id: 'persist-x',
                command: 'bash -c npm run dev',
                logPath: 'C:/Users/me/.velloc/projects/p/sess-x/tasks/bdev12345.output',
                startedMs: 5,
                running: true,
              }],
            },
          }
        }
        if (req.route.action === 'stat') return { ok: true, result: { size: 0 } }
        return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'unexpected' } }
      },
    }
    const flush = () => new Promise(r => setTimeout(r, 0))

    // Port, no manifest: the host may not serve persistent shells — no call.
    m.maybeAdoptPersistentShells()
    await flush()
    expect(lists).toHaveLength(0)
    expect(getBackgroundShellSpawner()?.canSpawn()).toBe(false)

    m.hostEnvironment = {
      hostManifest: {
        capabilities: ['shell', 'fs'],
        toolNames: [],
        commandNames: [],
        hostedTools: [],
        primitives: ['shell.spawn.persist', 'shell.persistentList', 'shell.persistentKill'],
      },
    }
    expect(getBackgroundShellSpawner()?.canSpawn()).toBe(true)
    m.maybeAdoptPersistentShells()
    await flush()
    expect(m.taskRegistry.getLiveByType('persist-x', 'local_bash')).toMatchObject({
      taskId: 'bdev12345',
      spawnerSessionId: 'sess-x',
      command: 'npm run dev',
    })

    // Once per port: a second trigger lists nothing more (the poll aside).
    const before = lists.length
    m.maybeAdoptPersistentShells()
    await flush()
    expect(lists.length - before).toBeLessThanOrEqual(1)
    expect(m.taskRegistry.getLiveByType('persist-x', 'local_bash')).toBeDefined()
    m.shells.finalizeForTest('persist-x', 'stopped', 'cleanup')
  })
})

describe('SharedWorkerSessionManager — pendingMessage (next message)', () => {
  let manager: SharedWorkerSessionManager
  let workerFactory: ReturnType<typeof createMockWorkerFactory>

  const SESSION = 'pending-session'

  async function initSession(port: ReturnType<typeof createMockPort>) {
    port._simulateMessage({
      type: 'worker.init',
      sessionId: SESSION,
      payload: { cwd: '/workspace', sessionId: SESSION },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  function submitsReceived(): AgentWorkerInboundMessage[] {
    return workerFactory.instances[0].receivedMessages.filter(
      m => m.type === 'worker.submitMessage',
    )
  }

  function pendingEvents(
    port: ReturnType<typeof createMockPort>,
    type: string,
  ): Array<Record<string, unknown>> {
    return port._posted.filter(
      (m): m is Record<string, unknown> =>
        (m as { type?: string }).type === type,
    ) as Array<Record<string, unknown>>
  }

  beforeEach(() => {
    workerFactory = createMockWorkerFactory()
    manager = new SharedWorkerSessionManager({
      createWorker: workerFactory.factory,
    })
  })

  it('routes a plain-text submit while RUNNING into pendingMessage (not the worker) and broadcasts the full text', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    await initSession(port)
    const worker = workerFactory.instances[0]
    worker.submitBehavior = 'silent'

    // First turn starts and stays running.
    port._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'first' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    manager.markStreamStart(SESSION)
    port._posted.length = 0

    // A submit while running must NOT reach the worker; it becomes the
    // pending message, broadcast in full.
    port._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'please also update the README' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(submitsReceived()).toHaveLength(1) // only 'first'
    const updates = pendingEvents(port, 'worker.pendingMessageUpdated')
    expect(updates).toHaveLength(1)
    expect((updates[0] as { payload: { text: string; reason: string } }).payload)
      .toEqual({ text: 'please also update the README', reason: 'appended' })
    expect((updates[0] as { sessionId: string }).sessionId).toBe(SESSION)
  })

  it('appends subsequent running submits to the SAME pending string with a newline and re-broadcasts the full text', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    await initSession(port)
    const worker = workerFactory.instances[0]
    worker.submitBehavior = 'silent'
    port._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'first' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    manager.markStreamStart(SESSION)

    port._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'fix the test' },
    })
    port._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'then run the suite' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const updates = pendingEvents(port, 'worker.pendingMessageUpdated')
    expect(updates).toHaveLength(2)
    const last = (updates[1] as { payload: { text: string } }).payload
    expect(last.text).toBe('fix the test\nthen run the suite')
    expect(submitsReceived()).toHaveLength(1)
  })

  it('consumes the pending message on completion (markStreamEnd): broadcasts empty + enqueues it as the next turn with no idle gap', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    await initSession(port)
    const worker = workerFactory.instances[0]
    worker.submitBehavior = 'silent'
    port._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'first' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    manager.markStreamStart(SESSION)

    port._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'queued follow-up' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(submitsReceived()).toHaveLength(1)
    port._posted.length = 0

    // Completion: pending is consumed and re-dispatched in the SAME pass.
    manager.markStreamEnd(SESSION)
    await new Promise(resolve => setTimeout(resolve, 10))

    const consumed = pendingEvents(port, 'worker.pendingMessageUpdated')
    expect(consumed).toHaveLength(1)
    expect((consumed[0] as { payload: { text: string; reason: string } }).payload)
      .toEqual({ text: '', reason: 'consumed' })

    // The pending text was dispatched to the worker as the next submit turn.
    const submits = submitsReceived()
    expect(submits).toHaveLength(2)
    expect((submits[1] as { payload: { prompt: string } }).payload.prompt)
      .toBe('queued follow-up')
  })

  it('clears the pending message on worker.clearPendingMessage and does NOT dispatch it on later completion', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    await initSession(port)
    const worker = workerFactory.instances[0]
    worker.submitBehavior = 'silent'
    port._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'first' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    manager.markStreamStart(SESSION)
    port._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'to be cleared' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    port._posted.length = 0

    port._simulateMessage({
      type: 'worker.clearPendingMessage',
      sessionId: SESSION,
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const cleared = pendingEvents(port, 'worker.pendingMessageCleared')
    expect(cleared).toHaveLength(1)
    expect((cleared[0] as { sessionId: string }).sessionId).toBe(SESSION)
    // The Worker handles clearPendingMessage internally.
    expect(
      workerFactory.instances[0].receivedMessages.some(
        m => m.type === 'worker.clearPendingMessage',
      ),
    ).toBe(true)

    manager.markStreamEnd(SESSION)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(submitsReceived()).toHaveLength(1) // no re-dispatch of cleared text
  })

  it('clears the pending message on worker.interrupt (Stop)', async () => {
    const port = createMockPort()
    manager.handleConnect(port)
    await initSession(port)
    const worker = workerFactory.instances[0]
    worker.submitBehavior = 'silent'
    port._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'first' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    manager.markStreamStart(SESSION)
    port._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'will be stopped' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    port._posted.length = 0

    port._simulateMessage({ type: 'worker.interrupt', sessionId: SESSION })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(pendingEvents(port, 'worker.pendingMessageCleared')).toHaveLength(1)
  })

  it('fans pending broadcasts out to EVERY port attached to the session (multi-WebView)', async () => {
    const port1 = createMockPort()
    const port2 = createMockPort()
    manager.handleConnect(port1)
    manager.handleConnect(port2)
    await initSession(port1)
    // Second WebView attaches to the SAME session.
    await initSession(port2)
    const worker = workerFactory.instances[0]
    worker.submitBehavior = 'silent'
    port1._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'first' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    manager.markStreamStart(SESSION)

    port1._simulateMessage({
      type: 'worker.submitMessage',
      sessionId: SESSION,
      payload: { prompt: 'shared pending' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(pendingEvents(port1, 'worker.pendingMessageUpdated')).toHaveLength(1)
    expect(pendingEvents(port2, 'worker.pendingMessageUpdated')).toHaveLength(1)
  })
})

// --- SharedWorker transport adapter ---

describe('createSharedWorkerTransport', () => {
  it('creates a SharedWorker with correct URL and options', () => {
    const originalSharedWorker = globalThis.SharedWorker
    const instances: Array<{ url: URL; options?: WorkerOptions }> = []

    class MockSharedWorker {
      port: MessagePort
      constructor(url: URL | string, options?: WorkerOptions) {
        instances.push({
          url: typeof url === 'string' ? new URL(url) : url,
          options,
        })
        this.port = createMockPort()
      }
    }

    globalThis.SharedWorker = MockSharedWorker as unknown as typeof SharedWorker

    try {
      const sw = createBrowserRuntimeSharedWorker()
      expect(sw).toBeInstanceOf(MockSharedWorker)
      expect(instances).toHaveLength(1)
      expect(instances[0]!.options).toMatchObject({
        type: 'module',
        name: 'chromium-runtime-shared-worker',
      })
      expect(String(instances[0]!.url)).toContain(
        '/browser/worker/agentRuntime.sharedworker.ts',
      )
    } finally {
      globalThis.SharedWorker = originalSharedWorker
    }
  })

  it('injects sessionId into outbound messages', () => {
    const mockPort = createMockPort()
    const mockSharedWorker = { port: mockPort } as unknown as SharedWorker

    const transport = createSharedWorkerTransport(mockSharedWorker, 'test-sid')

    transport.postMessage({ type: 'worker.getState' })

    expect(mockPort._posted).toHaveLength(1)
    const sent = mockPort._posted[0] as Record<string, unknown>
    expect(sent.type).toBe('worker.getState')
    expect(sent.sessionId).toBe('test-sid')
  })

  it('filters incoming messages by sessionId', () => {
    const mockPort = createMockPort()
    const mockSharedWorker = { port: mockPort } as unknown as SharedWorker

    const transport = createSharedWorkerTransport(mockSharedWorker, 'my-session')
    const received: unknown[] = []
    transport.addMessageListener(msg => received.push(msg))

    mockPort._simulateMessage({
      type: 'worker.state',
      sessionId: 'my-session',
      payload: createTestSnapshot('my-session'),
    })

    mockPort._simulateMessage({
      type: 'worker.state',
      sessionId: 'other-session',
      payload: createTestSnapshot('other-session'),
    })

    expect(received).toHaveLength(1)
    expect((received[0] as Record<string, unknown>).type).toBe('worker.state')
  })

  it('strips sessionId from delivered messages', () => {
    const mockPort = createMockPort()
    const mockSharedWorker = { port: mockPort } as unknown as SharedWorker

    const transport = createSharedWorkerTransport(mockSharedWorker, 'my-session')
    const received: unknown[] = []
    transport.addMessageListener(msg => received.push(msg))

    mockPort._simulateMessage({
      type: 'worker.state',
      sessionId: 'my-session',
      payload: createTestSnapshot('my-session'),
    })

    const msg = received[0] as Record<string, unknown>
    expect(msg.sessionId).toBeUndefined()
    expect(msg.type).toBe('worker.state')
  })

  it('sends session.detach on dispose', () => {
    const mockPort = createMockPort()
    const mockSharedWorker = { port: mockPort } as unknown as SharedWorker

    const transport = createSharedWorkerTransport(mockSharedWorker, 'sid-dispose')
    transport.dispose?.()

    const detach = mockPort._posted.find(
      (msg: unknown) =>
        (msg as SharedWorkerInboundMessage).type === 'session.detach',
    ) as SharedWorkerInboundMessage | undefined
    expect(detach).toBeDefined()
    if (detach && detach.type === 'session.detach') {
      expect(detach.sessionId).toBe('sid-dispose')
    }
  })

  it("a stale twin's dispose does not sever a live same-session transport (strict-mode double-mount)", () => {
    // Regression: React strict mode double-mounts the shell; the first
    // mount's client is disposed ASYNCHRONOUSLY after the second mount's
    // client re-registered the SAME sessionId on the page-singleton
    // dispatcher. Pre-fix, the ghost's dispose deleted the shared entry
    // (and posted session.detach), so the live client stopped receiving
    // worker.stream events mid-turn — UI froze while the worker ran on.
    const mockPort = createMockPort()
    const mockSharedWorker = { port: mockPort } as unknown as SharedWorker

    const ghost = createSharedWorkerTransport(mockSharedWorker, 'sid-twin')
    const ghostSeen: unknown[] = []
    ghost.addMessageListener(msg => ghostSeen.push(msg))

    const live = createSharedWorkerTransport(mockSharedWorker, 'sid-twin')
    const liveSeen: unknown[] = []
    live.addMessageListener(msg => liveSeen.push(msg))

    // The ghost dies late (strict-mode cleanup's `void client.dispose()`).
    ghost.dispose?.()

    // Not the last holder → the session must NOT be detached from the port.
    expect(
      mockPort._posted.some(
        (msg: unknown) =>
          (msg as SharedWorkerInboundMessage).type === 'session.detach',
      ),
    ).toBe(false)

    // The live twin still receives session-tagged messages.
    mockPort._simulateMessage({
      type: 'worker.state',
      sessionId: 'sid-twin',
      payload: createTestSnapshot('sid-twin'),
    })
    expect(liveSeen).toHaveLength(1)
    expect((liveSeen[0] as Record<string, unknown>).type).toBe('worker.state')

    // The LAST holder's dispose detaches exactly once.
    live.dispose?.()
    const detaches = mockPort._posted.filter(
      (msg: unknown) =>
        (msg as SharedWorkerInboundMessage).type === 'session.detach',
    )
    expect(detaches).toHaveLength(1)
  })

  it('auto-discovers sessionId from worker.init when not provided', () => {
    const mockPort = createMockPort()
    const mockSharedWorker = { port: mockPort } as unknown as SharedWorker

    const transport = createSharedWorkerTransport(mockSharedWorker)

    transport.postMessage({
      type: 'worker.init',
      payload: { cwd: '/workspace', sessionId: 'auto-session-id' },
    })

    const sent = mockPort._posted[0] as Record<string, unknown>
    expect(sent.sessionId).toBe('auto-session-id')

    transport.postMessage({ type: 'worker.getState' })

    const sent2 = mockPort._posted[1] as Record<string, unknown>
    expect(sent2.sessionId).toBe('auto-session-id')
  })

  it('generates sessionId when worker.init has no sessionId', () => {
    const mockPort = createMockPort()
    const mockSharedWorker = { port: mockPort } as unknown as SharedWorker

    const transport = createSharedWorkerTransport(mockSharedWorker)

    transport.postMessage({
      type: 'worker.init',
      payload: { cwd: '/workspace' },
    })

    const sent = mockPort._posted[0] as Record<string, unknown>
    const sessionId = sent.sessionId as string
    expect(sessionId).toBeDefined()
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)
  })

  it('removes listener on unsubscribe', () => {
    const mockPort = createMockPort()
    const mockSharedWorker = { port: mockPort } as unknown as SharedWorker

    const transport = createSharedWorkerTransport(mockSharedWorker, 'sid')
    const received: unknown[] = []
    const unsubscribe = transport.addMessageListener(msg =>
      received.push(msg),
    )

    mockPort._simulateMessage({
      type: 'worker.state',
      sessionId: 'sid',
      payload: createTestSnapshot('sid'),
    })

    expect(received).toHaveLength(1)

    unsubscribe()

    mockPort._simulateMessage({
      type: 'worker.state',
      sessionId: 'sid',
      payload: createTestSnapshot('sid'),
    })

    expect(received).toHaveLength(1)
  })
})

// --- shared SharedWorker factory (warm-up <-> boot dedup guard) ---

describe('createBrowserRuntimeSharedWorker shared factory', () => {
  it('is the SAME factory BrowserRuntimeClient re-exports', () => {
    // The index.html warm-up (src/glic/warmSharedWorker.ts) and the main boot
    // path (nexusBoot -> BrowserRuntimeClient) must go through ONE factory so
    // they resolve to the same worker URL + name and therefore the SAME
    // SharedWorker instance. If BrowserRuntimeClient re-inlined its own copy,
    // the warm-up would warm a different worker than the one boot connects to,
    // silently defeating the optimization.
    expect(createBrowserRuntimeSharedWorker).toBe(
      createSharedWorkerFromFactoryModule,
    )
  })

  it('points at a worker entry that EXISTS on disk', () => {
    // Resolve the worker factory's `new URL(.., import.meta.url)` specifier as the browser would and require the file
    // to exist: a renamed entry breaks neither build nor typecheck, only every boot.
    const originalSharedWorker = globalThis.SharedWorker
    let captured: URL | string | undefined

    class CapturingSharedWorker {
      port: MessagePort
      constructor(url: URL | string) {
        captured = url
        this.port = createMockPort()
      }
    }

    globalThis.SharedWorker =
      CapturingSharedWorker as unknown as typeof SharedWorker
    try {
      createSharedWorkerFromFactoryModule()
    } finally {
      globalThis.SharedWorker = originalSharedWorker
    }

    expect(captured).toBeInstanceOf(URL)
    expect(existsSync(fileURLToPath(captured as URL))).toBe(true)
  })
})

// --- needs-answer summary flag ---
// The sidebar's "needs your response" dot rides the manager's `session.summary`, derived worker-side, so it works
// for a disposed client: the flag flips the row, a flag-only flip still broadcasts, and clearing the ask clears it.
describe('SharedWorkerSessionManager — needsAnswer summary flag', () => {
  it('surfaces a pending ask on the summary row, and clears it when resolved', async () => {
    const workerFactory = createMockWorkerFactory()
    const manager = new SharedWorkerSessionManager({
      createWorker: workerFactory.factory,
    })
    const sessionPort = createMockPort()
    manager.handleConnect(sessionPort)
    sessionPort._simulateMessage({
      type: 'worker.init',
      sessionId: 'S-ask',
      payload: { cwd: '/workspace', sessionId: 'S-ask' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    // A sidebar-style list subscriber — summaries go to `all: true` ports.
    const listPort = createMockPort()
    manager.handleConnect(listPort)
    listPort._simulateMessage({ type: 'session.subscribe', all: true })
    await new Promise(resolve => setTimeout(resolve, 10))

    const worker = workerFactory.instances[0]
    const lastSummaryRow = () => {
      const summaries = listPort._posted.filter(
        (m: unknown) =>
          (m as { type?: string }).type === 'session.summary',
      ) as Array<{
        payload?: {
          sessions?: Array<{ sessionId: string; needsAnswer?: boolean }>
        }
      }>
      const last = summaries[summaries.length - 1]
      return last?.payload?.sessions?.find(r => r.sessionId === 'S-ask')
    }

    // The worker halts on a permission ask — its own worker.state emission is
    // the ONLY signal (the tool stays in flight; no phase transition).
    worker.emitOut({
      type: 'worker.state',
      payload: {
        ...createTestSnapshot('S-ask'),
        pendingPermissions: {
          'tool-1': { toolName: 'Write' },
        } as never,
      },
    } as AgentWorkerOutboundMessage)
    // Summary flush is debounced (SUMMARY_COALESCE_MS = 100ms).
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(lastSummaryRow()?.needsAnswer).toBe(true)

    // The ask resolves — the next clean snapshot clears the flag.
    worker.emitOut({
      type: 'worker.state',
      payload: createTestSnapshot('S-ask'),
    } as AgentWorkerOutboundMessage)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(lastSummaryRow()?.needsAnswer).toBe(false)
  })
})

describe('SharedWorkerSessionManager — background-row recovery (task.recoverBackground)', () => {
  // The drawer's lazy recovery reads the transcript, rebuilds the shell rows
  // and completes the SuperShell rows from their tool-detail sidecars. Two
  // things that went wrong there: a SuperShell sidecar the session's own
  // storage did not hold fell through to the cross-session search, which
  // waited on EVERY in-flight recovery — including the one asking — and hung;
  // and the shell rows, which need no sidecar, were held behind those reads.
  function launchTurn(callId: string, toolName: string, args: Record<string, unknown>) {
    return {
      type: 'assistant',
      timestamp: '2026-09-14T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: callId, toolName, args }],
      },
    }
  }
  function resultTurn(callId: string, result?: unknown) {
    return {
      type: 'user',
      timestamp: '2026-09-14T10:01:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: callId, ...(result !== undefined ? { result } : {}) },
        ],
      },
    }
  }

  function makeManagerWithTranscript(loadToolCallDetail: (sessionId: string, id: string) => Promise<unknown>) {
    const manager = new SharedWorkerSessionManager({
      createWorker: createMockWorkerFactory().factory,
    })
    const coordinator = (
      manager as unknown as { storageCoordinator: { storage: unknown; groupedStorage: unknown } }
    ).storageCoordinator
    const storage = {
      load: async () => [
        launchTurn('sh-1', 'Bash', { command: 'npm test' }),
        resultTurn('sh-1', { shell_id: 'b1', status: 'running' }),
        launchTurn('ss-1', 'SuperShell', { description: 'Build' }),
        resultTurn('ss-1'),
      ],
      loadToolCallDetail,
      routeSessionFromMeta: async () => undefined,
    }
    coordinator.storage = storage
    coordinator.groupedStorage = storage
    const internals = manager as unknown as {
      handleRecoverBackground(sessionId: string): Promise<void>
      recoveredBash: Map<string, unknown[]>
    }
    return { manager, internals }
  }

  it('a SuperShell sidecar missing from the session storage does not hang the recovery on itself', async () => {
    // The session's own read answers null; the cross-session search must not
    // wait for the recovery that is asking.
    const { internals } = makeManagerWithTranscript(async () => null)
    const outcome = await Promise.race([
      internals.handleRecoverBackground('S-rec').then(() => 'settled'),
      new Promise<string>(resolve => setTimeout(() => resolve('hung'), 500)),
    ])
    expect(outcome).toBe('settled')
  })

  it('publishes the shell rows before the SuperShell sidecar reads settle', async () => {
    let releaseSidecar!: () => void
    const sidecar = new Promise<unknown>(resolve => {
      releaseSidecar = () => resolve(null)
    })
    const { internals } = makeManagerWithTranscript(() => sidecar)
    const recovery = internals.handleRecoverBackground('S-rows')
    // Let the transcript read land; the sidecar read is still pending.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(internals.recoveredBash.get('S-rows')?.length).toBe(1)
    releaseSidecar()
    await recovery
    expect(internals.recoveredBash.get('S-rows')?.length).toBe(1)
  })

  it('brings back the session-title namer rows a restart dropped, with the stored title as detail', async () => {
    // The namer's registry record dies with the worker; its stored titles are
    // what a reloaded session still has. A title stored during THIS lifetime
    // keeps its registry row, so it must not be listed a second time.
    const manager = new SharedWorkerSessionManager({
      createWorker: createMockWorkerFactory().factory,
    })
    const coordinator = (
      manager as unknown as { storageCoordinator: { storage: unknown; groupedStorage: unknown } }
    ).storageCoordinator
    const before = Date.now() - 60_000
    const storage = {
      load: async () => [
        launchTurn('a-1', 'Read', { file_path: 'x' }),
        { type: 'ai-title', sessionId: 'S-title', aiTitle: 'First name', updatedAt: before },
        { type: 'ai-title', sessionId: 'S-title', aiTitle: 'Better name', updatedAt: before + 1_000 },
        { type: 'ai-title', sessionId: 'S-title', aiTitle: 'This lifetime', updatedAt: Date.now() + 60_000 },
      ],
      loadToolCallDetail: async () => null,
      routeSessionFromMeta: async () => undefined,
    }
    coordinator.storage = storage
    coordinator.groupedStorage = storage
    const internals = manager as unknown as {
      handleRecoverBackground(sessionId: string): Promise<void>
      feed: { buildSummaryPayload(): { subAgents?: NexusTaskSummaryRowLike[] } }
      taskControl: { loadInfo(id: string): { type: string; outputText?: string } | null }
    }
    type NexusTaskSummaryRowLike = {
      sessionId: string
      spawnerSessionId: string
      status: string
      type?: string
      querySource?: string
      startedAt?: number
      finishedAt?: number
    }
    await internals.handleRecoverBackground('S-title')
    const titleRows = (internals.feed.buildSummaryPayload().subAgents ?? []).filter(
      row => row.querySource === 'rename_generate_name',
    )
    expect(titleRows.map(row => [row.spawnerSessionId, row.status, row.type, row.startedAt])).toEqual([
      ['S-title', 'success', 'local_fast', before + 1_000],
      ['S-title', 'success', 'local_fast', before],
    ])
    expect(titleRows.every(row => row.finishedAt === undefined)).toBe(true)
    expect(internals.taskControl.loadInfo(titleRows[0]!.sessionId)).toMatchObject({
      type: 'local_fast',
      outputText: 'Better name',
    })
  })
})
