/**
 * Agent runtime correctness: detached disposal must not corrupt the new scope, executeSubmit failures propagate
 * as failed/aborted, stale worker events must not finalize new workers, and disposal is awaited.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { AgentRuntimeWorker } from '../browser/worker/AgentRuntimeWorker'
import { AgentTurnController } from '../browser/worker/AgentTurnController'

// --- Mock createAgentRuntime ---
vi.mock('../browser/runtime/createAgentRuntime', () => ({
  createAgentRuntime: vi.fn(),
  createBrowserRuntime: vi.fn(),
}))
import { createAgentRuntime } from '../browser/runtime/createAgentRuntime'

// --- Mock SharedWorkerSessionManager (Worker may import it) ---
vi.mock('../browser/worker/SharedWorkerSessionManager', () => ({
  getActiveSessionManager: () => null,
}))

// --- Helpers ---

/** Structural type for accessing scope controllers in tests. */
type AgentModelControllerLike = {
  getCatalog(): unknown
  setCatalog(v: unknown): void
  getInitPromise(): Promise<void> | null
  setInitPromise(p: Promise<void> | null): void
  getHasEngineSelection(): boolean
  setHasEngineSelection(v: boolean): void
  getTierFallbackWarned(): boolean
  setTierFallbackWarned(v: boolean): void
  reset(): void
}
type AgentPermissionCoordinatorLike = {
  getResolvers(): Map<string, unknown>
  getSkipDangerousMode(): boolean
  setSkipDangerousMode(v: boolean): void
  abortAllConfirmations(reason: string): void
  reset(): void
}

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
      applyRuleChange: vi.fn(),
      addAllowRule: vi.fn(),
      clearPendingPermission: vi.fn(),
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
    hostBridge: {
      getModelCatalog: vi.fn(async () => null),
      session: { onStop: vi.fn(async () => {}) },
    },
    tools: [],
    options: { cwd: '/workspace', settingsHomeDir: '/home', projectRoot: '/workspace' },
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

function createWorker(host?: Record<string, unknown>) {
  const emitted: Array<{ type: string; payload?: unknown }> = []
  const worker = new AgentRuntimeWorker({
    emit: message => {
      emitted.push(message as { type: string; payload?: unknown })
    },
    ...(host ? { host: host as never } : {}),
  })
  return { worker, emitted }
}

// ============================================================================
// SCOPE ISOLATION: Detached disposal must not corrupt the new scope
// ============================================================================

describe('Scope isolation: detached disposal must not corrupt new scope', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('disposeDetachedScope must not clear new scope model state', async () => {
    const { worker } = createWorker()

    // Runtime A: slow engine.dispose so disposeDetachedScope(A) hangs.
    const runtimeA = makeMockRuntime({ tag: 'A' })
    const disposeA = new Deferred<void>()
    runtimeA.engine.dispose = vi.fn(() => disposeA.promise)

    // Runtime B: instant.
    const runtimeB = makeMockRuntime({ tag: 'B' })

    let callCount = 0
    vi.mocked(createAgentRuntime).mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve(runtimeA) as never
      return Promise.resolve(runtimeB) as never
    })

    // Init A completes (no previous scope to dispose).
    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-a' }),
    } as never)

    // Access scope A's model controller and set state.
    const scopeA = (worker as unknown as { runtimeScope: { models: AgentModelControllerLike } }).runtimeScope
    scopeA.models.setHasEngineSelection(true)
    scopeA.models.setCatalog({ providers: [] })

    // Init B supersedes A. A new scope B is created with FRESH controllers.
    // disposeDetachedScope(A) must only reset scope A's controllers.
    const initB = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-b' }),
    } as never)

    // Scope B has its own fresh controllers; scope A's disposal resets only scope A's.
    const scopeB = (worker as unknown as { runtimeScope: { models: AgentModelControllerLike } }).runtimeScope
    // Scope B should be a DIFFERENT object from scope A.
    expect(scopeB).not.toBe(scopeA)
    // Scope B's models should be fresh (hasEngineSelection = false from constructor).
    expect(scopeB.models.getHasEngineSelection()).toBe(false)

    // Scope A's models should have been reset by disposeDetachedScope.
    expect(scopeA.models.getHasEngineSelection()).toBe(false)
    expect(scopeA.models.getCatalog()).toBeNull()

    // Cleanup: resolve A's dispose so initB can complete.
    disposeA.resolve()
    await initB
  })

  it('disposeDetachedScope must not abort new scope tool confirmations', async () => {
    const { worker } = createWorker()

    const runtimeA = makeMockRuntime({ tag: 'A' })
    const disposeA = new Deferred<void>()
    runtimeA.engine.dispose = vi.fn(() => disposeA.promise)

    const runtimeB = makeMockRuntime({ tag: 'B' })

    let callCount = 0
    vi.mocked(createAgentRuntime).mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve(runtimeA) as never
      return Promise.resolve(runtimeB) as never
    })

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-a' }),
    } as never)

    // A has a pending tool confirmation in scope A's permission coordinator.
    const scopeA = (worker as unknown as { runtimeScope: { permissions: AgentPermissionCoordinatorLike } }).runtimeScope
    const confirmResolveA = vi.fn()
    scopeA.permissions.getResolvers().set('tool-use-A', confirmResolveA)

    // Init B supersedes A. Scope B gets its OWN permission coordinator.
    const initB = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-b' }),
    } as never)

    // disposeDetachedScope(A) aborts scope A's confirmations: A's resolver is called.
    expect(confirmResolveA).toHaveBeenCalled()

    // Scope B's permission coordinator is a DIFFERENT instance, unaffected.
    const scopeB = (worker as unknown as { runtimeScope: { permissions: AgentPermissionCoordinatorLike } }).runtimeScope
    expect(scopeB.permissions).not.toBe(scopeA.permissions)
    // B's resolvers are empty (fresh coordinator).
    expect(scopeB.permissions.getResolvers().size).toBe(0)

    // Cleanup.
    disposeA.resolve()
    await initB
  })

  it('disposeDetachedScope must not clear new scope projectBranch', async () => {
    const { worker } = createWorker()

    const runtimeA = makeMockRuntime({ tag: 'A' })
    const disposeA = new Deferred<void>()
    runtimeA.engine.dispose = vi.fn(() => disposeA.promise)

    const runtimeB = makeMockRuntime({ tag: 'B' })

    let callCount = 0
    vi.mocked(createAgentRuntime).mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve(runtimeA) as never
      return Promise.resolve(runtimeB) as never
    })

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-a' }),
    } as never)

    // Set A's branch.
    ;(worker as unknown as { projectBranch: string | undefined }).projectBranch = 'feature-a'

    // Init B supersedes A. disposeDetachedScope(A) sets
    // this.projectBranch = undefined SYNCHRONOUSLY.
    const initB = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/project-b' }),
    } as never)

    // disposeDetachedScope must not touch Worker-level fields such as projectBranch (runInit resets it).
    const managerSource = workerSource()
    const disposeDetachedBody = extractMethodBody(managerSource, 'disposeDetachedScope')
    expect(disposeDetachedBody.includes('this.projectBranch')).toBe(false)

    // Cleanup.
    disposeA.resolve()
    await initB
  })

  it('triple concurrent init — only C builds and emits ready', async () => {
    const { worker, emitted } = createWorker()

    const runtimeC = makeMockRuntime({ tag: 'C' })
    const createWinner = new Deferred<unknown>()

    let callCount = 0
    vi.mocked(createAgentRuntime).mockImplementation(() => {
      callCount++
      return createWinner.promise as never
    })

    // Fire all three inits without awaiting.
    const initA = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/a' }),
    } as never)
    const initB = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/b' }),
    } as never)
    const initC = worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/c' }),
    } as never)

    // Superseded inits bail before the expensive runtime build: only the winning scope (C, the last init)
    // reaches createAgentRuntime at all.
    await vi.waitFor(() => expect(callCount).toBe(1))
    createWinner.resolve(runtimeC)
    await Promise.all([initA, initB, initC])
    expect(callCount).toBe(1)

    // Only C should have emitted worker.ready.
    const readyEvents = emitted.filter(m => m.type === 'worker.ready')
    expect(readyEvents.length).toBe(1)

    // Runtime must be C.
    const internalRuntime = (worker as unknown as { runtime: { tag?: string } | null }).runtime
    expect(internalRuntime?.tag).toBe('C')
  })

  it('old catalog promise finally must not clear new catalog promise', async () => {
    const { worker } = createWorker()

    const runtimeA = makeMockRuntime({ tag: 'A' })
    // A's catalog fetch hangs.
    const catalogA = new Deferred<null>()
    runtimeA.hostBridge.getModelCatalog = vi.fn(() => catalogA.promise)

    const runtimeB = makeMockRuntime({ tag: 'B' })

    let callCount = 0
    vi.mocked(createAgentRuntime).mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve(runtimeA) as never
      return Promise.resolve(runtimeB) as never
    })

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/a' }),
    } as never)

    // A's model init promise is now pending (catalog fetch in flight).
    const scopeA = (worker as unknown as { runtimeScope: { models: AgentModelControllerLike } }).runtimeScope
    const promiseA = scopeA.models.getInitPromise()
    expect(promiseA).not.toBeNull()

    // Init B supersedes — creates a NEW scope with its own models controller.
    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/b' }),
    } as never)

    const scopeB = (worker as unknown as { runtimeScope: { models: AgentModelControllerLike } }).runtimeScope
    expect(scopeB).not.toBe(scopeA)

    // B sets its own model init promise on its OWN controller.
    const promiseB = Promise.resolve()
    scopeB.models.setInitPromise(promiseB)

    // Now A's catalog fetch resolves — its .finally() is guarded by
    // isCurrentScope(scopeA) which is false, so it must NOT clear B's promise.
    catalogA.resolve(null)
    await new Promise(r => setTimeout(r, 50))

    // B's promise is untouched.
    expect(scopeB.models.getInitPromise()).toBe(promiseB)
  })
})

// ============================================================================
// TURN RESULT: executeSubmit failures must propagate correctly
// ============================================================================

describe('Turn result: failures must not report as completed', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('submit on uninitialized worker returns failed', async () => {
    const { worker } = createWorker()

    // Do NOT init — submit immediately.
    const result = await worker.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'hello' } } as never,
      'user',
    )

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.code).toBe('worker_not_initialized')
    }
  })

  it('engine throw returns failed, not completed', async () => {
    const { worker } = createWorker()

    const runtime = makeMockRuntime()
    runtime.engine.submitTurn = async function* () {
      throw new Error('provider exploded')
    }
    vi.mocked(createAgentRuntime).mockResolvedValue(runtime as never)

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload(),
    } as never)

    const result = await worker.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'hello' } } as never,
      'user',
    )

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.message).toContain('provider exploded')
    }
  })

  it('user interrupt returns aborted, not completed', async () => {
    const { worker } = createWorker()

    const turnStarted = new Deferred<void>()
    let rejectGenerator!: (err: Error) => void
    const generatorBlocked = new Deferred<void>()

    const runtime = makeMockRuntime()
    runtime.engine.submitTurn = async function* () {
      turnStarted.resolve()
      // Block until interrupted — simulates a long-running model call.
      await new Promise<void>((_, reject) => {
        rejectGenerator = reject
      })
      yield { type: 'assistant', message: { content: [] } }
    }
    runtime.engine.cancelTurn = vi.fn(() => {
      // Simulate what a real interrupt does: reject the in-flight generator.
      rejectGenerator(new Error('AbortError: user interrupted'))
    })
    vi.mocked(createAgentRuntime).mockResolvedValue(runtime as never)

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload(),
    } as never)

    const resultPromise = worker.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'long task' } } as never,
      'user',
    )

    await turnStarted.promise

    // Interrupt the turn.
    await worker.receiveFrame({
      type: 'worker.interrupt',
      payload: {},
    } as never)

    // Wait for the result.
    const result = await Promise.race([
      resultPromise,
      new Promise<{ status: string }>(r => setTimeout(() => r({ status: 'timeout' }), 2000)),
    ])

    expect(result.status).toBe('aborted')
  })

  it('conversation store write failure returns failed', async () => {
    const { worker } = createWorker()

    const runtime = makeMockRuntime()
    runtime.conversationStore.saveToolCallDetail = vi.fn(async () => {
      throw new Error('disk full')
    })
    vi.mocked(createAgentRuntime).mockResolvedValue(runtime as never)

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload(),
    } as never)

    const result = await worker.submitAndWait(
      {
        type: 'worker.submitMessage',
        payload: {
          prompt: 'hello',
          toolCallDetail: { toolCallId: 'tc1', name: 'Bash', input: {} },
        },
      } as never,
      'user',
    )

    expect(result.status).toBe('failed')
  })

  it('completion can only resolve once (no double-resolve)', async () => {
    const { worker } = createWorker()

    const runtime = makeMockRuntime()
    vi.mocked(createAgentRuntime).mockResolvedValue(runtime as never)

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload(),
    } as never)

    const resultPromise = worker.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'hi' } } as never,
      'user',
    )

    const result = await resultPromise
    expect(result.status).toBe('completed')

    // The promise should be settled — calling then again returns the same value.
    const result2 = await resultPromise
    expect(result2).toEqual(result)
  })
})

// ============================================================================
// EVENT IDENTITY: Stale worker events must not affect new workers
// ============================================================================

describe('Event identity: stale events must not finalize new workers', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('Manager handleWorkerEmit has no instance guard', () => {
    // Structural assertion on the Manager source.
    const managerSource = SharedWorkerSessionManagerSource()
    const hasInstanceGuard = managerSource.includes('instanceId') &&
      managerSource.includes('entry.instanceId !== instanceId')

    expect(hasInstanceGuard).toBe(true)
  })

  // Headless completion has one terminal authority: the submitAndWait resolution path holds the single
  // `finalizeHeadlessRun` call site; the emit interceptor only records.
  it('headless run has a single terminal authority (structural)', () => {

    const coordinatorSource = readSource('../browser/worker/RoutineCoordinator.ts')

    // Count how many paths call finalizeHeadlessRun.
    const finalizeCalls = (coordinatorSource.match(/this\.finalizeHeadlessRun\(/g) ?? []).length

    expect(finalizeCalls).toBe(1)
    // And the Manager itself must have NO finalize CALL path left at all
    // (comments may still reference the name).
    const managerCalls =
      (SharedWorkerSessionManagerSource().match(/this\.finalizeHeadlessRun\(/g) ?? []).length
    expect(managerCalls).toBe(0)
  })
})

// ============================================================================
// TEARDOWN: Disposal must be awaited, not fire-and-forget
// ============================================================================

describe('Teardown: disposal must be awaited', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('finalizeHeadlessRun must await worker.dispose', () => {
    // The worker's dispose is async: deleting the session entry before it completes leaves late bridge requests
    // with no session. The sync entry reap (reapSessionEntrySync) is covered by the delete/dispose pairing test.

    const coordinatorSource = readSource('../browser/worker/RoutineCoordinator.ts')

    // Find the finalizeHeadlessRun method body.
    const finalizeIdx = coordinatorSource.indexOf('finalizeHeadlessRun(')
    expect(finalizeIdx).toBeGreaterThan(-1)

    // Extract ~40 lines of the method body.
    const methodBody = coordinatorSource.slice(finalizeIdx, finalizeIdx + 2000)

    // Must await dispose, not `void ... dispose?.()` (fire-and-forget).
    const hasFireAndForget = methodBody.includes('void this.sessions.get(sessionId)?.worker.dispose')
    expect(hasFireAndForget).toBe(false)
  })

  it('finalizeSubAgentRun must await worker.dispose', () => {
    // The sub-agent finalize lifecycle lives on the
    // SubAgentCoordinator; the sync entry reap it delegates to
    // (reapSessionEntrySync, Manager-side) is covered by the
    // delete/dispose pairing invariant.
    const coordinatorSource = readSource('../browser/worker/SubAgentCoordinator.ts')

    const finalizeIdx = coordinatorSource.indexOf('private finalizeSubAgentRun(')
    expect(finalizeIdx).toBeGreaterThan(-1)

    const methodBody = coordinatorSource.slice(finalizeIdx, finalizeIdx + 2000)

    // Must not use `void ... dispose?.()` (fire-and-forget).
    const hasFireAndForget = methodBody.includes('void this.sessions.get(sessionId)?.worker.dispose')
    expect(hasFireAndForget).toBe(false)
  })

  it('every sessions.delete is paired with the shared worker-dispose step', () => {
    const managerSource = SharedWorkerSessionManagerSource()

    // Count all `this.sessions.delete(` occurrences.
    const deleteCalls = (managerSource.match(/this\.sessions\.delete\(/g) ?? []).length

    // Both session-ending paths (the awaited dispose and the sync reap) run ONE
    // shared step, `disposeSessionWorker`, which is the only place the worker
    // is disposed — so whatever that step ends (the session's terminals) is
    // ended on every path, and a later path inherits it.
    const sharedStepCalls = (managerSource.match(/this\.disposeSessionWorker\(/g) ?? []).length
    const disposeCalls = (managerSource.match(/worker\.dispose\?\.\(\)/g) ?? []).length

    expect(sharedStepCalls).toBeGreaterThanOrEqual(2)
    expect(disposeCalls).toBe(1)
    // No more than 3 delete sites (disposeManagedSession, finalizeHeadlessRun, finalizeSubAgentRun).
    expect(deleteCalls).toBeLessThanOrEqual(3)
  })
})

// ============================================================================
// UI PROJECTION: Retry and state deltas
// ============================================================================

describe('UI projection: state change detection', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('AgentTurnController retry tick emits state changes', () => {
    vi.useFakeTimers()

    const stateChanges: number[] = []
    const controller = new AgentTurnController({
      onStateChanged: () => stateChanges.push(Date.now()),
      onTurnReady: () => {},
      onPendingMessageChanged: () => {},
      onPendingMessageCleared: () => {},
    })

    controller.beginRetry({
      retryInMs: 10_000,
      attempt: 1,
      maxRetries: 5,
      errorKind: 'overloaded',
    })

    // Initial state change from beginRetry.
    expect(stateChanges.length).toBe(1)

    // Each second tick should emit a state change (for countdown display).
    vi.advanceTimersByTime(3_000)
    expect(stateChanges.length).toBe(4) // 1 initial + 3 ticks

    controller.endRetry()
    vi.useRealTimers()
  })

  it('retry phase carries countdown info for UI', () => {
    vi.useFakeTimers()

    const controller = new AgentTurnController({
      onStateChanged: () => {},
      onTurnReady: () => {},
      onPendingMessageChanged: () => {},
      onPendingMessageCleared: () => {},
    })

    const now = Date.now()
    controller.beginRetry({
      retryInMs: 10_000,
      attempt: 2,
      maxRetries: 5,
      errorKind: 'rate_limit',
    })

    const phase = controller.getPhase()
    expect(phase.kind).toBe('running')
    if (phase.kind === 'running' && phase.sub.type === 'retry') {
      expect(phase.sub.attempt).toBe(2)
      expect(phase.sub.maxRetries).toBe(5)
      expect(phase.sub.errorKind).toBe('rate_limit')
      expect(phase.sub.deadlineMs).toBeGreaterThanOrEqual(now + 10_000)
    } else {
      expect.unreachable('Expected retry phase')
    }

    controller.endRetry()
    vi.useRealTimers()
  })
})

// ============================================================================
// MODEL SELECTION: tier-only changes must persist
// ============================================================================

describe('Auto-compact window: the composer handle saves through the runtime', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  function autoCompactWindows(save: (...args: unknown[]) => Promise<unknown>) {
    let saved: number | undefined
    return {
      load: vi.fn(async () => {}),
      resolve: vi.fn(async () => ({ enabled: true })),
      current: vi.fn(() => ({
        enabled: true,
        ...(saved !== undefined
          ? { windowTokens: saved, windowSource: 'userSettings', windowScope: 'model' }
          : {}),
      })),
      canSave: true,
      saveForModel: vi.fn(async (...args: unknown[]) => {
        await save(...args)
        saved = args[2] === 'auto' ? undefined : (args[2] as number)
        return { enabled: true }
      }),
    }
  }

  async function bootWith(windows: ReturnType<typeof autoCompactWindows>) {
    const { worker, emitted } = createWorker()
    vi.mocked(createAgentRuntime).mockImplementation(
      () => Promise.resolve(makeMockRuntime({ autoCompactWindows: windows })) as never,
    )
    await worker.receiveFrame({ type: 'worker.init', payload: makeInitPayload() } as never)
    return { worker, emitted }
  }

  const lastAutoCompact = (emitted: Array<{ type: string; payload?: unknown }>) =>
    (emitted.filter(m => m.type === 'worker.state').at(-1)?.payload as {
      autoCompact?: Record<string, unknown>
    }).autoCompact

  it("saves the active model's window and publishes it", async () => {
    const windows = autoCompactWindows(async () => {})
    const { worker, emitted } = await bootWith(windows)
    await worker.receiveFrame({
      type: 'worker.setAutoCompactWindow',
      payload: { value: 300_000 },
    } as never)
    expect(windows.saveForModel).toHaveBeenCalledWith('test-model', 'test-provider', 300_000)
    expect(lastAutoCompact(emitted)).toEqual({ enabled: true, windowTokens: 300_000, canSave: true })
  })

  it('publishes a failed write on the snapshot, not as a session error', async () => {
    const windows = autoCompactWindows(async () => {
      throw new Error('EACCES')
    })
    const { worker, emitted } = await bootWith(windows)
    await worker.receiveFrame({
      type: 'worker.setAutoCompactWindow',
      payload: { value: 'auto' },
    } as never)
    expect(lastAutoCompact(emitted)?.saveError).toBe('EACCES')
    expect(emitted.some(m => m.type === 'worker.error')).toBe(false)
  })

  it('ignores a window outside 100K–1M', async () => {
    const windows = autoCompactWindows(async () => {})
    const { worker } = await bootWith(windows)
    for (const value of [50_000, 2_000_000, 150_000.5]) {
      await worker.receiveFrame({
        type: 'worker.setAutoCompactWindow',
        payload: { value },
      } as never)
    }
    expect(windows.saveForModel).not.toHaveBeenCalled()
  })
})

describe('Model selection: tier persistence', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('a tier-only selection change persists to session metadata', async () => {
    const { worker } = createWorker()

    // Stateful metadata store: updateSessionMetadata records; getSessionMetadata
    // returns the last persisted llmSelection — so the persist gate compares
    // against what actually landed on disk.
    let persisted: Record<string, unknown> = {}
    const runtime = makeMockRuntime()
    runtime.conversationStore.getSessionMetadata = vi.fn(async () => persisted)
    runtime.conversationStore.updateSessionMetadata = vi.fn(
      async (patch: Record<string, unknown>) => {
        persisted = { ...persisted, ...patch }
        return persisted
      },
    ) as never
    vi.mocked(createAgentRuntime).mockImplementation(
      () => Promise.resolve(runtime) as never,
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload(),
    } as never)

    await worker.receiveFrame({
      type: 'worker.setModelSelection',
      payload: { selection: { providerId: 'p1', modelId: 'm1' } },
    } as never)
    expect(
      (persisted.llmSelection as { modelId?: string } | undefined)?.modelId,
    ).toBe('m1')

    // Same model, NEW tier.
    await worker.receiveFrame({
      type: 'worker.setModelSelection',
      payload: {
        selection: { providerId: 'p1', modelId: 'm1', thinkingTier: 'high' },
      },
    } as never)
    expect(
      (persisted.llmSelection as { thinkingTier?: string } | undefined)
        ?.thinkingTier,
    ).toBe('high')
  })

  it("a stale scope's late applySelection cannot commit into the new runtime", async () => {
    const { worker } = createWorker()

    const runtimeA = makeMockRuntime({ tag: 'A' })
    const runtimeB = makeMockRuntime({ tag: 'B' })
    let callCount = 0
    vi.mocked(createAgentRuntime).mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve(runtimeA) as never
      return Promise.resolve(runtimeB) as never
    })

    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/a' }),
    } as never)
    const scopeA = (
      worker as unknown as {
        runtimeScope: {
          models: { applySelection: (s: unknown) => Promise<void> }
        }
      }
    ).runtimeScope

    // B supersedes A.
    await worker.receiveFrame({
      type: 'worker.init',
      payload: makeInitPayload({ projectRoot: '/b' }),
    } as never)

    // A late async continuation on the STALE scope's controller (e.g. its Phase-2 reconcile resolving after the
    // reinit) applies a selection. Bound controllers touch only their own.
    vi.mocked(runtimeB.engine.setModelSelection).mockClear()
    vi.mocked(runtimeB.conversationStore.updateSessionMetadata).mockClear()
    await scopeA.models.applySelection({ providerId: 'px', modelId: 'stale-m' })

    expect(runtimeB.engine.setModelSelection).not.toHaveBeenCalled()
    expect(runtimeB.conversationStore.updateSessionMetadata).not.toHaveBeenCalled()
    // The stale write landed on A's own (disposed) runtime instead — inert.
    expect(runtimeA.engine.setModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'stale-m' }),
    )
  })
})

// ============================================================================
// PROCESS GLOBALS: Concurrent sub-agents corrupt shared state
// ============================================================================

describe('Process globals: concurrent sub-agent hazard', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  // The Manager snapshots a session's globals from the worker's per-runtime report (`worker.getRuntimeGlobals()`),
  // never the shared process slot, so a concurrent sibling runtime build cannot leak into another session.
  it('Manager does not capture process globals on worker.ready (structural)', () => {

    const managerSource = SharedWorkerSessionManagerSource()

    // The store getters must be gone entirely; `processFs()`
    // legitimately remains ONLY for immediate current-global fs I/O (shell
    // output read/write, the team registry's lazy fs getter) — never
    // captured for a later restore.
    expect(managerSource.includes('getConversationStore()')).toBe(false)
    expect(managerSource.includes('getActiveSidechainStore()')).toBe(false)

    const hasGlobalCapture = managerSource.includes('processFs()') &&
      managerSource.includes('getConversationStore()') &&
      managerSource.includes('getActiveSidechainStore()')
    expect(hasGlobalCapture).toBe(false)
  })

  it('fork call sites resolve the sidechain store from their own context (structural)', () => {
    // The realm slot wraps the fs of whichever runtime booted last; a
    // session-scoped fork must persist through its OWN runtime's store
    // (`getContextSidechainStore(context)`), never the slot.
    for (const rel of [
      '../toolkit/builtin/subagentLaunch.ts',
      '../skillLibrary/executeForkedSkill.ts',
      '../lifecycleHooks/hookAgentRunner.ts',
      '../browser/runtime/createAgentRuntime.ts',
    ]) {
      const source = readSource(rel)
      expect(source.length, rel).toBeGreaterThan(0)
      expect(source.includes('getActiveSidechainStore()'), rel).toBe(false)
    }
  })
})

// ============================================================================
// Helpers: read source for structural assertions
// ============================================================================

function readSource(relativePath: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf-8')
  } catch {
    return ''
  }
}

function SharedWorkerSessionManagerSource(): string {
  return readSource('../browser/worker/SharedWorkerSessionManager.ts')
}

function workerSource(): string {
  return readSource('../browser/worker/AgentRuntimeWorker.ts')
}

/** Extract the body of a method by name (from signature to matching close brace). */
function extractMethodBody(source: string, methodName: string): string {
  const idx = source.indexOf(methodName)
  if (idx < 0) return ''
  // Find the opening brace of the method body.
  let braceStart = source.indexOf('{', idx)
  if (braceStart < 0) return ''
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(idx, i + 1)
    }
  }
  return source.slice(idx, idx + 3000)
}
