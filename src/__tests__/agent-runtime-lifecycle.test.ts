/**
 * AgentRuntimeWorker lifecycle: concurrent init is latest-wins, a stale createAgentRuntime resolution does not
 * clear the current runtime, forceReinit's preflight runs before dispose, and submitAndWait waits for the turn.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { AgentRuntimeWorker } from '../browser/worker/AgentRuntimeWorker'
import { AgentTurnController } from '../browser/worker/AgentTurnController'

// --- Mock createAgentRuntime so we control timing ---

vi.mock('../browser/runtime/createAgentRuntime', () => ({
  createAgentRuntime: vi.fn(),
  createBrowserRuntime: vi.fn(),
}))
import { createAgentRuntime } from '../browser/runtime/createAgentRuntime'

// --- Mock getActiveSessionManager (Worker imports it) ---
vi.mock('../browser/worker/SharedWorkerSessionManager', () => ({
  getActiveSessionManager: () => null,
}))

// --- Helpers ---

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void
  reject!: (error: unknown) => void
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

function makeMockRuntime(overrides: Record<string, unknown> = {}) {
  return {
    engine: {
      boundSessionId: () => 'test-session',
      getCurrentModel: () => 'test-model',
      getCurrentProviderId: () => 'test-provider',
      getCurrentThinkingTier: () => undefined,
      transcriptRows: () => [],
      setModelSelection: vi.fn(),
      getCurrentPermissionMode: () => 'default',
      setPermissionMode: vi.fn(),
      applyRuntimeSettings: vi.fn(),
      cancelTurn: vi.fn(),
      dispose: vi.fn(async () => {}),
      submitTurn: async function* (): AsyncGenerator<unknown, void, unknown> {
        yield { type: 'assistant', message: { content: [] } }
      },
    },
    conversationStore: {
      getSessionMetadata: vi.fn(async () => ({})),
      updateSessionMetadata: vi.fn(async () => ({})),
      saveToolCallDetail: vi.fn(async () => {}),
      loadSessionSummary: vi.fn(async () => null),
    },
    hostBridge: { getModelCatalog: vi.fn(async () => null) },
    tools: [],
    options: { cwd: '/workspace', settingsHomeDir: '/home' },
    setAppState: vi.fn(),
    getAppState: () => ({}),
    dispose: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeInitPayload(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'test-session',
    projectRoot: '/workspace',
    hostMode: 'nexus',
    ...overrides,
  }
}

function createWorker() {
  const emitted: Array<{ type: string; payload?: unknown }> = []
  const worker = new AgentRuntimeWorker({
    emit: message => {
      emitted.push(message as { type: string; payload?: unknown })
    },
  })
  return { worker, emitted }
}

// ============================================================================
// Concurrent init latest-wins
// ============================================================================

describe('Concurrent init latest-wins', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('keeps the newest scope current when old disposal resolves late', async () => {
    const { worker, emitted } = createWorker()

    // Control createAgentRuntime timing with deferreds.
    const runtimeA = makeMockRuntime({ tag: 'A' })
    const runtimeB = makeMockRuntime({ tag: 'B' })
    const createA = new Deferred<unknown>()
    const createB = new Deferred<unknown>()

    let callCount = 0
    vi.mocked(createAgentRuntime).mockImplementation(() => {
      callCount++
      if (callCount === 1) return createA.promise as never
      return createB.promise as never
    })

    // Start Init A — it will await createAgentRuntime (deferred).
    const initA = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-a' }),
    } as never)

    // Let the microtask for disposeRuntimeScope settle (it's null, instant).
    await vi.waitFor(() => {
      expect(callCount).toBe(1)
    })

    // Start Init B — supersedes A.
    const initB = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-b' }),
    } as never)

    await vi.waitFor(() => {
      expect(callCount).toBe(2)
    })

    // Resolve B first (the newer init completes first).
    createB.resolve(runtimeB)
    await initB

    // Now resolve A (the stale init completes late).
    createA.resolve(runtimeA)
    await initA

    // B must remain current.
    const snapshot = worker.getSnapshot()
    expect(snapshot.initialized).toBe(true)
    // The runtime should be B's, not A's.
    const internalRuntime = (worker as unknown as { runtime: { tag?: string } })
      .runtime
    expect(internalRuntime?.tag).toBe('B')
  })

  it('does not emit worker.ready from a superseded init', async () => {
    const { worker, emitted } = createWorker()

    const runtimeA = makeMockRuntime({ tag: 'A' })
    const runtimeB = makeMockRuntime({ tag: 'B' })
    const createA = new Deferred<unknown>()
    const createB = new Deferred<unknown>()

    let callCount = 0
    vi.mocked(createAgentRuntime).mockImplementation(() => {
      callCount++
      if (callCount === 1) return createA.promise as never
      return createB.promise as never
    })

    const initA = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-a' }),
    } as never)

    await vi.waitFor(() => expect(callCount).toBe(1))

    const initB = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-b' }),
    } as never)

    await vi.waitFor(() => expect(callCount).toBe(2))

    // Resolve B, then A.
    createB.resolve(runtimeB)
    await initB
    createA.resolve(runtimeA)
    await initA

    // Only ONE worker.ready should have been emitted (from B).
    const readyEvents = emitted.filter(m => m.type === 'worker.ready')
    expect(readyEvents.length).toBe(1)
  })
})

// ============================================================================
// Stale createAgentRuntime must not clear current runtime
// ============================================================================

describe('Stale createAgentRuntime must not clear current runtime', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('does not null out the current runtime when a stale create resolves', async () => {
    const { worker } = createWorker()

    const runtimeA = makeMockRuntime({ tag: 'A' })
    const runtimeB = makeMockRuntime({ tag: 'B' })
    const createA = new Deferred<unknown>()
    const createB = new Deferred<unknown>()

    let callCount = 0
    vi.mocked(createAgentRuntime).mockImplementation(() => {
      callCount++
      if (callCount === 1) return createA.promise as never
      return createB.promise as never
    })

    // Init A starts.
    const initA = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-a' }),
    } as never)
    await vi.waitFor(() => expect(callCount).toBe(1))

    // Init B supersedes.
    const initB = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-b' }),
    } as never)
    await vi.waitFor(() => expect(callCount).toBe(2))

    // B completes first — runtime is now B.
    createB.resolve(runtimeB)
    await initB

    const snapshotAfterB = worker.getSnapshot()
    expect(snapshotAfterB.initialized).toBe(true)

    // A completes late.
    createA.resolve(runtimeA)
    await initA

    // Runtime must still be B, not null.
    const snapshotAfterA = worker.getSnapshot()
    expect(snapshotAfterA.initialized).toBe(true)
    const internalRuntime = (worker as unknown as { runtime: { tag?: string } | null })
      .runtime
    expect(internalRuntime).not.toBeNull()
    expect(internalRuntime?.tag).toBe('B')
  })
})

// ============================================================================
// forceReinit preflight must happen before dispose
// ============================================================================

describe('forceReinit preflight must happen before dispose', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('rejects force reinit on a non-empty session WITHOUT disposing the runtime', async () => {
    const { worker, emitted } = createWorker()

    // First: successfully init with a runtime that has messages.
    const runtimeWithMessages = makeMockRuntime()
    runtimeWithMessages.engine.transcriptRows = () => [
      { type: 'user', uuid: '1', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: '2', message: { role: 'assistant', content: 'hi' } },
    ] as never[]

    vi.mocked(createAgentRuntime).mockResolvedValue(runtimeWithMessages as never)

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload(),
    } as never)

    // Verify initialized with messages.
    const snapshotBefore = worker.getSnapshot()
    expect(snapshotBefore.initialized).toBe(true)
    expect(snapshotBefore.messageCount).toBe(2)

    // Now attempt force reinit.
    vi.mocked(createAgentRuntime).mockClear()
    const newRuntime = makeMockRuntime({ tag: 'new' })
    vi.mocked(createAgentRuntime).mockResolvedValue(newRuntime as never)

    emitted.length = 0
    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ forceReinit: true, projectRoot: '/new-project' }),
    } as never)

    // Correct behavior: the reinit should be REJECTED because the session
    // has messages. An error should be emitted.
    const errors = emitted.filter(m => m.type === 'worker.error')
    expect(errors.length).toBeGreaterThan(0)
    expect(
      (errors[0]?.payload as { code?: string })?.code,
    ).toBe('worker_reinit_not_allowed')

    // The original runtime must NOT have been disposed.
    expect(runtimeWithMessages.engine.dispose).not.toHaveBeenCalled()

    // The runtime must still be the original (not the new one, not null).
    const internalRuntime = (worker as unknown as { runtime: unknown }).runtime
    expect(internalRuntime).toBe(runtimeWithMessages)
  })
})

// ============================================================================
// submitAndWait turn-completion contract
// ============================================================================

describe('submitAndWait turn-completion contract', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('submitAndWait resolves only AFTER the turn completes', async () => {
    const { worker, emitted } = createWorker()

    // Create a runtime whose submitMessage generator blocks on a deferred.
    const turnStarted = new Deferred<void>()
    const turnFinish = new Deferred<void>()

    const runtime = makeMockRuntime()
    runtime.engine.submitTurn = async function* () {
      turnStarted.resolve()
      await turnFinish.promise
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }
    }

    vi.mocked(createAgentRuntime).mockResolvedValue(runtime as never)

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload(),
    } as never)

    emitted.length = 0

    // submitAndWait is the explicit turn-completion API. It must NOT
    // resolve until the turn's generator finishes.
    const submitPromise = worker.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'hello' } } as never,
      'user',
    )

    // Wait for the turn to actually start executing.
    await turnStarted.promise

    let submitResolved = false
    let submitResult: unknown
    void submitPromise.then(r => { submitResolved = true; submitResult = r })

    // Give microtasks a chance to flush.
    await new Promise(r => setTimeout(r, 10))

    // The turn is still running (turnFinish not resolved) — submitAndWait
    // must still be pending.
    expect(submitResolved).toBe(false)

    // The turn hasn't completed — no worker.completed emitted yet.
    const completedEvents = emitted.filter(m => m.type === 'worker.completed')
    expect(completedEvents.length).toBe(0)

    // Now finish the turn.
    turnFinish.resolve()
    await new Promise(r => setTimeout(r, 50))

    // NOW submitAndWait resolves with 'completed'.
    expect(submitResolved).toBe(true)
    expect(submitResult).toEqual({ status: 'completed' })

    // And worker.completed was emitted.
    const completedAfter = emitted.filter(m => m.type === 'worker.completed')
    expect(completedAfter.length).toBe(1)
  })

  it('receiveFrame(worker.submitMessage) remains fire-and-forget for UI', async () => {
    // The UI path intentionally keeps fire-and-forget semantics — the UI
    // observes completion via the worker.completed event, not the promise.
    const { worker } = createWorker()

    const turnFinish = new Deferred<void>()
    const runtime = makeMockRuntime()
    runtime.engine.submitTurn = async function* () {
      await turnFinish.promise
      yield { type: 'assistant', message: { content: [] } }
    }
    vi.mocked(createAgentRuntime).mockResolvedValue(runtime as never)

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload(),
    } as never)

    // receiveFrame(submit) resolves on enqueue (UI contract unchanged).
    let resolved = false
    void worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: 'hi' },
    } as never).then(() => { resolved = true })

    await new Promise(r => setTimeout(r, 10))
    expect(resolved).toBe(true) // fire-and-forget: resolves before turn ends

    turnFinish.resolve()
    await new Promise(r => setTimeout(r, 20))
  })

  it('Manager headless pattern with submitAndWait does NOT finalize early', async () => {
    // The Manager uses submitAndWait, which resolves only after the turn completes.

    const { worker } = createWorker()

    const turnStarted = new Deferred<void>()
    const turnFinish = new Deferred<void>()
    let turnCompleted = false

    const runtime = makeMockRuntime()
    runtime.engine.submitTurn = async function* () {
      turnStarted.resolve()
      await turnFinish.promise
      turnCompleted = true
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'result' }] } }
    }

    vi.mocked(createAgentRuntime).mockResolvedValue(runtime as never)

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload(),
    } as never)

    // Simulate Manager's headless drive using submitAndWait:
    let finalized = false
    const drivePromise = (async () => {
      await worker.submitAndWait(
        { type: 'worker.submitMessage', payload: { prompt: 'do work' } } as never,
        'user',
      )
      // This point is only reached AFTER the turn completes.
      finalized = true
    })()

    await turnStarted.promise
    await new Promise(r => setTimeout(r, 10))

    // Turn is still running — submitAndWait must NOT have resolved yet,
    // so the Manager has NOT reached the finalize point.
    expect(turnCompleted).toBe(false)
    expect(finalized).toBe(false) // Not prematurely finalized!

    // Finish the turn.
    turnFinish.resolve()
    await drivePromise
    await new Promise(r => setTimeout(r, 20))

    // Now the turn completed and the Manager can safely finalize.
    expect(turnCompleted).toBe(true)
    expect(finalized).toBe(true)
  })
})

// ============================================================================
// Worker dispose lifecycle
// ============================================================================

describe('Worker dispose lifecycle', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('worker.dispose() cleans up runtime and bridge transport', async () => {
    const { worker } = createWorker()

    const runtime = makeMockRuntime()
    vi.mocked(createAgentRuntime).mockResolvedValue(runtime as never)

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload(),
    } as never)

    expect(worker.getSnapshot().initialized).toBe(true)

    // Dispose should clean up.
    await worker.dispose()

    // After dispose, runtime should be null.
    const internalRuntime = (worker as unknown as { runtime: unknown }).runtime
    expect(internalRuntime).toBeNull()
    expect(runtime.engine.dispose).toHaveBeenCalled()
  })
})

// ============================================================================
// Retry timer ownership
// ============================================================================

describe('Retry timer ownership', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('AgentTurnController.beginRetry creates a timer that endRetry clears', () => {
    // This test verifies the controller's retry timer lifecycle works
    // in isolation — the Manager-level leak (delete without clearRetry)
    // is a separate integration concern.
    const stateChanges: number[] = []
    const controller = new AgentTurnController({
      onStateChanged: () => stateChanges.push(Date.now()),
      onTurnReady: () => {},
      onPendingMessageChanged: () => {},
      onPendingMessageCleared: () => {},
    })

    vi.useFakeTimers()

    controller.beginRetry({
      retryInMs: 10_000,
      attempt: 1,
      maxRetries: 5,
      errorKind: 'timeout',
    })

    expect(controller.getPhase().kind).toBe('running')
    const sub = (controller.getPhase() as { sub: { type: string } }).sub
    expect(sub.type).toBe('retry')

    // Advance 3 seconds — should have ticked.
    vi.advanceTimersByTime(3_000)
    expect(stateChanges.length).toBeGreaterThanOrEqual(3)

    // endRetry clears the timer.
    controller.endRetry()
    const countAfterEnd = stateChanges.length
    vi.advanceTimersByTime(5_000)
    // No more ticks after endRetry.
    expect(stateChanges.length).toBe(countAfterEnd)

    vi.useRealTimers()
  })
})

// ============================================================================
// runtimeScopeSignal: the scope's lifetime reaches the tool-use context
// ============================================================================

describe('runtimeScopeSignal follows the runtime scope', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('hands each build its scope signal, aborted on supersession and on worker dispose', async () => {
    // Work that outlives a tool call (SuperShell continuing in the background)
    // stops on this signal; without it every later step fails one at a time
    // with "Runtime scope was disposed.".
    const { worker } = createWorker()
    const signals: AbortSignal[] = []
    vi.mocked(createAgentRuntime).mockImplementation((async (opts: { runtimeScopeSignal?: AbortSignal }) => {
      signals.push(opts.runtimeScopeSignal!)
      return makeMockRuntime()
    }) as never)

    await worker.receiveFrame({ type: 'worker.init', payload: makeInitPayload() } as never)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[0]!.aborted).toBe(false)

    await worker.receiveFrame({ type: 'worker.init', payload: makeInitPayload() } as never)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)

    await worker.dispose()
    expect(signals[1]!.aborted).toBe(true)
  })
})
