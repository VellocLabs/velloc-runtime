import { describe, expect, it, vi, afterEach } from 'vitest'
import { AgentRuntimeWorker } from '../browser/worker/AgentRuntimeWorker'
import { setModelUploadTraceEnabled } from '../engine/turn/modelTrace'
import { installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'
import {
  isCallModelLogEnabled,
  logCallModelEvent,
  setCallModelEmitter,
  setCallModelLogEnabled,
} from '../engine/turn/callModelTrace'
import type { Message } from '../runtime/RuntimeTypes'
import {
  __resetBundledSkillsForTests,
  __resetFeatureRegistryForTests,
  addStockSkill,
} from '../skillLibrary/builtinSkills'
import {
  __resetInvokedSkillsStoreForTests,
  noteSkillUse,
} from '../skillLibrary/invokedSkillsStore'

vi.mock('../browser/runtime/createAgentRuntime', () => ({
  createAgentRuntime: vi.fn(),
  createBrowserRuntime: vi.fn(),
}))
import { createAgentRuntime } from '../browser/runtime/createAgentRuntime'

/**
 * Seed the worker's runtime. Single-source: `this.runtime`
 * DERIVES from `runtimeScope.runtime` (getter-only), so tests seed a minimal
 * scope instead of writing a standalone field. The scope-delegating accessors
 * (`scopeModels` etc.) fall back to the worker's pre-init fallback controllers
 * when the seeded scope carries no controllers — same as before the seed.
 */
function seedRuntime(worker: AgentRuntimeWorker, runtime: unknown): void {
  const w = worker as unknown as {
    runtimeScope: { runtime: unknown } | null
  }
  if (w.runtimeScope) {
    w.runtimeScope.runtime = runtime
  } else {
    w.runtimeScope = { runtime }
  }
}

describe('AgentRuntimeWorker', () => {
  it('hydrates tool details from in-memory runtime messages when persistence has not stored them yet', async () => {
    const emitted: unknown[] = []
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message)
      },
    })
    const saveToolCallDetail = vi.fn(async () => {})
    const toolResultMessage: Message = {
      type: 'user',
      uuid: 'user-tool-1',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: '{"ok":true}',
            tool_use_id: 'tool-1',
          },
        ],
      },
      toolCallDetailRef: {
        toolCallId: 'tool-1',
        toolName: 'browser_navigate',
      },
      toolCallDetail: {
        toolCallId: 'tool-1',
        toolName: 'browser_navigate',
        args: {
          tab_id: 29,
        },
        result: {
          ok: true,
          result: 'OK',
          resolved_tab_id: 29,
        },
      },
    } as Message

    seedRuntime(worker, {
      conversationStore: {
        getToolCallDetail: vi.fn(async () => null),
        saveToolCallDetail,
      },
      engine: {
        transcriptRows: () => [toolResultMessage],
      },
    })
    // Bind the injected runtime into the scope transcript service (production
    // wiring does this at runtime install).
    const cast = worker as unknown as {
      scopeTranscript: { bindRuntime: (runtime: unknown) => void }
      runtime: unknown
    }
    cast.scopeTranscript.bindRuntime(cast.runtime)

    await worker.receiveFrame({
      type: 'worker.getToolCallDetail',
      payload: {
        toolCallId: 'tool-1',
      },
    })

    expect(saveToolCallDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tool-1',
        toolName: 'browser_navigate',
        args: {
          tab_id: 29,
        },
        result: {
          ok: true,
          result: 'OK',
          resolved_tab_id: 29,
        },
      }),
    )
    expect(emitted.at(-1)).toMatchObject({
      type: 'worker.toolCallDetail',
      payload: {
        toolCallId: 'tool-1',
        detail: expect.objectContaining({
          toolCallId: 'tool-1',
          toolName: 'browser_navigate',
          args: {
            tab_id: 29,
          },
          result: {
            ok: true,
            result: 'OK',
            resolved_tab_id: 29,
          },
        }),
      },
    })
  })

  it('answers worker.getSkillBody from the bundled registry and the session store', async () => {
    // The Skills tab's bundled-skill body request: static skills resolve to
    // their registered content; dynamic skills to the SESSION's last-invoked
    // body (scoped by boundSessionId — another session's invocation must not
    // leak in).
    try {
      addStockSkill({
        name: 'commit-helper',
        description: 'Commits things',
        content: '# Commit helper',
      })
      addStockSkill({
        name: 'debug',
        description: 'Tails logs',
        dynamicContent: async () => 'live',
      })
      noteSkillUse('other-session', 'debug', 'bundled:debug', 'their logs')
      noteSkillUse('s1', 'debug', 'bundled:debug', 'my logs')

      const emitted: unknown[] = []
      const worker = new AgentRuntimeWorker({
        emit: message => {
          emitted.push(message)
        },
      })
      ;(worker as unknown as { boundSessionId: string }).boundSessionId = 's1'

      await worker.receiveFrame({
        type: 'worker.getSkillBody',
        payload: { name: 'commit-helper' },
      })
      expect(emitted.at(-1)).toEqual({
        type: 'worker.skillBody',
        payload: {
          name: 'commit-helper',
          result: { kind: 'static', body: '# Commit helper' },
        },
      })

      await worker.receiveFrame({
        type: 'worker.getSkillBody',
        payload: { name: 'debug' },
      })
      expect(emitted.at(-1)).toMatchObject({
        type: 'worker.skillBody',
        payload: {
          name: 'debug',
          result: { kind: 'invoked', body: 'my logs' },
        },
      })

      await worker.receiveFrame({
        type: 'worker.getSkillBody',
        payload: { name: 'no-such-skill' },
      })
      expect(emitted.at(-1)).toEqual({
        type: 'worker.skillBody',
        payload: { name: 'no-such-skill', result: { kind: 'not_found' } },
      })
    } finally {
      __resetBundledSkillsForTests()
      __resetFeatureRegistryForTests()
      __resetInvokedSkillsStoreForTests()
    }
  })

  it('persists a model-driven permission-mode flip at the turn boundary', async () => {
    // EnterPlanMode/ExitPlanMode flip the mode via the tool's setAppState; the
    // picker persist step never sees it. The turn-boundary reconcile must write
    // the engine's mode to metadata when it differs from what's stored.
    const worker = new AgentRuntimeWorker({ emit: () => {} })
    const updateSessionMetadata = vi.fn(async () => {})
    seedRuntime(worker, {
      conversationStore: {
        // Stored mode is the pre-turn default; the model entered plan mode.
        getSessionMetadata: vi.fn(async () => ({ permissionMode: 'default' })),
        updateSessionMetadata,
      },
      engine: { getCurrentPermissionMode: () => 'plan' },
    })

    const perms = (
      worker as unknown as {
        scopePermissions: {
          bindRuntime: (runtime: unknown) => void
          persistModeIfChanged: () => Promise<void>
        }
        runtime: unknown
      }
    )
    perms.scopePermissions.bindRuntime(perms.runtime)
    await perms.scopePermissions.persistModeIfChanged()

    expect(updateSessionMetadata).toHaveBeenCalledWith({ permissionMode: 'plan' })
  })

  it('does not re-persist when the permission mode is unchanged', async () => {
    const worker = new AgentRuntimeWorker({ emit: () => {} })
    const updateSessionMetadata = vi.fn(async () => {})
    seedRuntime(worker, {
      conversationStore: {
        getSessionMetadata: vi.fn(async () => ({ permissionMode: 'plan' })),
        updateSessionMetadata,
      },
      engine: { getCurrentPermissionMode: () => 'plan' },
    })

    const perms = (
      worker as unknown as {
        scopePermissions: {
          bindRuntime: (runtime: unknown) => void
          persistModeIfChanged: () => Promise<void>
        }
        runtime: unknown
      }
    )
    perms.scopePermissions.bindRuntime(perms.runtime)
    await perms.scopePermissions.persistModeIfChanged()

    expect(updateSessionMetadata).not.toHaveBeenCalled()
  })

  it('worker.interrupt sets isStopping, auto-stops the actor task, and aborts the engine', async () => {
    const emitted: unknown[] = []
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message)
      },
    })

    const engineInterrupt = vi.fn()
    // The worker drives session-stop through `hostBridge.session.onStop`
    // Mock matches the `BrowserHostBridge.session` shape.
    const onStop = vi.fn(async () => ({
      ok: true as const,
      stopped: true,
    }))

    seedRuntime(worker, {
      hostBridge: { session: { onStop } },
      engine: {
        boundSessionId: () => 'test-session-abc',
        getCurrentModel: () => 'test-model',
        getCurrentProviderId: () => undefined,
        transcriptRows: () => [],
        cancelTurn: engineInterrupt,
      },
      options: { cwd: '/workspace' },
      tools: [],
    })
    // Pretend a submit is in flight so interrupt isn't short-circuited by
    // the not-busy guard.
    worker.markStreamStart()

    await worker.receiveFrame({ type: 'worker.interrupt' })

    expect(engineInterrupt).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledWith({
      sessionId: 'test-session-abc',
      reason: 'user_stopped',
    })

    // The emitted state snapshot must already show isStopping=true so the
    // UI can react synchronously on this message round-trip.
    const lastState = emitted.find(
      (m): m is { type: string; payload: Record<string, unknown> } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type?: string }).type === 'worker.state',
    )
    expect(lastState).toBeDefined()
    expect(lastState?.payload.isStopping).toBe(true)

    // A second interrupt while isStopping is already true is a no-op — no
    // additional calls land on the actor-stop or engine-interrupt spies.
    await worker.receiveFrame({ type: 'worker.interrupt' })
    expect(engineInterrupt).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  // A teammate runs on the provider its lead spawned it on; its trust and read boundary were decided for that
  // provider. The page never sends one for a teammate; this pins the worker-side backstop.
  it('worker.setModelSelection leaves a TEAMMATE on the model it was spawned with', async () => {
    const worker = new AgentRuntimeWorker({ emit: () => {} })
    const engineSetModelSelection = vi.fn()
    const updateSessionMetadata = vi.fn(async () => ({}))
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async () =>
        ({
          conversationStore: {
            getSessionMetadata: vi.fn(async () => ({
              llmSelection: { providerId: 'anthropic', modelId: 'claude-test' },
            })),
            updateSessionMetadata,
          },
          engine: {
            boundSessionId: () => 'teammate-lead-1-worker-a-1789000000000',
            getCurrentModel: () => 'claude-test',
            getCurrentProviderId: () => 'anthropic',
            getCurrentThinkingTier: () => undefined,
            transcriptRows: () => [],
            setModelSelection: engineSetModelSelection,
          },
          hostBridge: { getModelCatalog: vi.fn(async () => null) },
          tools: [],
          options: {
            cwd: '/workspace',
            userSpecifiedProviderId: 'anthropic',
            userSpecifiedModel: 'claude-test',
          },
        }) as never,
    )
    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'teammate-lead-1-worker-a-1789000000000',
        cwd: '/workspace',
      } as never,
    })
    engineSetModelSelection.mockClear()
    updateSessionMetadata.mockClear()

    await worker.receiveFrame({
      type: 'worker.setModelSelection',
      payload: { selection: { providerId: 'kimi', modelId: 'k3' } },
    })

    expect(engineSetModelSelection).not.toHaveBeenCalled()
    // Nor recorded as its model: the meta DB named k3 for teammates whose
    // transcripts never used it.
    expect(
      JSON.stringify(updateSessionMetadata.mock.calls),
    ).not.toContain('"k3"')
  })

  it('non-init messages wait for an in-flight worker.init instead of erroring', async () => {
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message as { type: string; payload?: unknown })
      },
    })

    let resolveCreate: ((runtime: unknown) => void) | undefined
    const createPromise = new Promise<unknown>(resolve => {
      resolveCreate = resolve
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      () => createPromise as Promise<never>,
    )

    // Kick off init — it will park on createBrowserRuntime until we
    // resolve `resolveCreate`. Don't await; we want to race.
    const initDone = worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'race-test',
        cwd: '/workspace',
      } as never,
    })

    // Fire a setModelSelection while init is mid-await. Pre-fix this
    // would synchronously emit a worker.error.
    const setSelectionDone = worker.receiveFrame({
      type: 'worker.setModelSelection',
      payload: {
        selection: { providerId: 'anthropic', modelId: 'claude-test' },
      },
    })

    // Yield so any synchronous emits land in `emitted`. The fix
    // guarantees nothing has been emitted yet — both handlers are
    // parked on initPromise.
    await Promise.resolve()
    await Promise.resolve()
    expect(
      emitted.find(
        m =>
          m.type === 'worker.error' &&
          (m.payload as { code?: string })?.code === 'worker_not_initialized',
      ),
    ).toBeUndefined()

    // Resolve init with a minimally-shaped runtime that satisfies the
    // setModelSelection path's reads. After this, both handlers unblock.
    const updateSessionMetadata = vi.fn(async () => ({}))
    const getSessionMetadata = vi.fn(async () => ({
      llmSelection: { providerId: 'anthropic', modelId: 'claude-test' },
    }))
    const engineSetModelSelection = vi.fn()
    resolveCreate!({
      conversationStore: {
        getSessionMetadata,
        updateSessionMetadata,
      },
      engine: {
        boundSessionId: () => 'race-test',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => [],
        setModelSelection: engineSetModelSelection,
      },
      hostBridge: {
        getModelCatalog: vi.fn(async () => null),
      },
      tools: [],
      options: {
        cwd: '/workspace',
        userSpecifiedProviderId: 'anthropic',
        userSpecifiedModel: 'claude-test',
      },
    })

    await Promise.all([initDone, setSelectionDone])

    // Setting actually landed on the engine — proves the second handler
    // didn't bail with worker_not_initialized.
    expect(engineSetModelSelection).toHaveBeenCalled()
    expect(
      emitted.find(
        m =>
          m.type === 'worker.error' &&
          (m.payload as { code?: string })?.code === 'worker_not_initialized',
      ),
    ).toBeUndefined()
  })

  // A never-resolving catalog fetch must not wedge the first submit: the model gate's wait is bounded
  // (MODEL_INIT_SUBMIT_GRACE_MS) and the submit falls through on the engine's default model.
  it('first submit is not wedged by a never-resolving model catalog fetch', async () => {
    vi.useFakeTimers()
    try {
      const worker = new AgentRuntimeWorker({ emit: () => {} })

      // Async-generator engine.submitTurn that yields nothing and returns —
      // reaching it AT ALL is the proof the modelGate didn't block forever.
      const engineSubmit = vi.fn(async function* () {
        // no events — an immediately-completing turn
      })
      // `getModelCatalog` never settles → modelInitPromise stays pending.
      const getModelCatalog = vi.fn(() => new Promise<never>(() => {}))

      vi.mocked(createAgentRuntime).mockResolvedValueOnce({
        conversationStore: {
          // No persisted llmSelection → Phase 1 applies nothing, so
          // hasEngineSelection stays false and the modelGate is exercised.
          getSessionMetadata: vi.fn(async () => ({})),
          updateSessionMetadata: vi.fn(async () => ({})),
          saveToolCallDetail: vi.fn(async () => {}),
        },
        engine: {
          boundSessionId: () => 'catalog-hang',
          getCurrentModel: () => 'inherit',
          getCurrentProviderId: () => undefined,
          getCurrentThinkingTier: () => undefined,
          transcriptRows: () => [],
          setModelSelection: vi.fn(),
          submitTurn: engineSubmit,
        },
        hostBridge: { getModelCatalog },
        tools: [],
        // No prefs-seeded selection in options either — the only path to a
        // selection would be the (hung) catalog fetch.
        options: { cwd: '/workspace' },
      } as never)

      await worker.receiveFrame({
        type: 'worker.init',
        payload: { sessionId: 'catalog-hang', cwd: '/workspace' } as never,
      })

      // Phase 2 (getModelCatalog) is in flight and will never resolve.
      expect(getModelCatalog).toHaveBeenCalled()

      const submitDone = worker.receiveFrame({
        type: 'worker.submitMessage',
        payload: { prompt: 'hello' } as never,
      })

      // Before the grace window elapses the turn is still parked on the gate.
      expect(engineSubmit).not.toHaveBeenCalled()

      // Advancing past the bounded grace lets the gate fall through.
      await vi.advanceTimersByTimeAsync(3_500)
      await submitDone

      expect(engineSubmit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AgentRuntimeWorker — halt backstop at turn start', () => {
  // The dispatch gate keeps a non-answer turn from starting over a halt; if
  // one starts anyway (the gate read "not halted" a tick too early) the
  // question AND the staged plan are dead, and the worker clears both records
  // before the stream opens so the composer / approval control drop. A local
  // slash command is admitted through the gate on purpose and must leave both.
  function makeHaltedRuntime(halted: () => boolean) {
    const clearPendingUserInteraction = vi.fn()
    const clearPendingPlanApproval = vi.fn()
    const engineSubmit = vi.fn(async function* () {})
    return {
      runtime: {
        conversationStore: {
          getSessionMetadata: vi.fn(async () => ({})),
          updateSessionMetadata: vi.fn(async () => ({})),
          saveToolCallDetail: vi.fn(async () => {}),
        },
        engine: {
          boundSessionId: () => 'halt-backstop',
          getCurrentModel: () => 'claude-test',
          getCurrentProviderId: () => 'anthropic',
          getCurrentThinkingTier: () => undefined,
          transcriptRows: () => [],
          setModelSelection: vi.fn(),
          submitTurn: engineSubmit,
          getPendingUserInteraction: () =>
            halted() ? { call_ask: { toolName: 'AskUserQuestion' } } : {},
          getPendingPlanApproval: () =>
            halted() ? { call_plan: { toolName: 'ExitPlanMode' } } : {},
          clearPendingPermission: vi.fn(),
          clearPendingUserInteraction,
          clearPendingPlanApproval,
        },
        hostBridge: { getModelCatalog: vi.fn(async () => null) },
        tools: [],
        options: { cwd: '/workspace', userSpecifiedModel: 'claude-test' },
      },
      spies: { clearPendingUserInteraction, clearPendingPlanApproval, engineSubmit },
    }
  }

  async function submitOverHalt(prompt: string) {
    let halted = false
    const { runtime, spies } = makeHaltedRuntime(() => halted)
    const worker = new AgentRuntimeWorker({ emit: () => {} })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'halt-backstop', cwd: '/workspace' } as never,
    })
    // Dispatch reads "not halted"; the halt lands before the turn's first
    // await returns — the tick the gate cannot see. The submit handler only
    // enqueues (the turn runs on its own), so wait for the engine call.
    await worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt } as never,
    })
    halted = true
    await vi.waitFor(() => expect(spies.engineSubmit).toHaveBeenCalledTimes(1))
    return spies
  }

  it('a non-answer model turn clears BOTH the question and the staged plan', async () => {
    const spies = await submitOverHalt('not an answer')
    expect(spies.clearPendingUserInteraction).toHaveBeenCalledTimes(1)
    expect(spies.clearPendingPlanApproval).toHaveBeenCalledTimes(1)
  })

  it('a local slash command clears neither', async () => {
    const spies = await submitOverHalt('/status')
    expect(spies.clearPendingUserInteraction).not.toHaveBeenCalled()
    expect(spies.clearPendingPlanApproval).not.toHaveBeenCalled()
  })
})

describe('AgentRuntimeWorker — permission mode', () => {
  // Minimal runtime mock with a stateful permission mode so the snapshot
  // reflects setPermissionMode calls the same way the real engine would.
  function makeRuntime(
    initialMode: string,
    metadata: Record<string, unknown>,
  ) {
    let mode = initialMode
    const updateSessionMetadata = vi.fn(
      async (patch: Record<string, unknown>) => {
        Object.assign(metadata, patch)
        return {}
      },
    )
    const getSessionMetadata = vi.fn(async () => metadata)
    const setPermissionMode = vi.fn((m: string) => {
      mode = m
    })
    return {
      runtime: {
        conversationStore: { getSessionMetadata, updateSessionMetadata },
        engine: {
          boundSessionId: () => 'mode-test',
          getCurrentModel: () => 'claude-test',
          getCurrentProviderId: () => 'anthropic',
          getCurrentThinkingTier: () => undefined,
          transcriptRows: () => [],
          setModelSelection: vi.fn(),
          getCurrentPermissionMode: () => mode,
          setPermissionMode,
        },
        hostBridge: { getModelCatalog: vi.fn(async () => null) },
        tools: [],
        options: { cwd: '/workspace' },
      },
      spies: { getSessionMetadata, updateSessionMetadata, setPermissionMode },
    }
  }

  async function initWorker(
    emitted: Array<{ type: string; payload?: unknown }>,
    runtime: unknown,
  ): Promise<AgentRuntimeWorker> {
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message as { type: string; payload?: unknown })
      },
    })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'mode-test', cwd: '/workspace' } as never,
    })
    return worker
  }

  it('restores the persisted permission mode at init', async () => {
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const { runtime, spies } = makeRuntime('default', {
      permissionMode: 'plan',
    })
    await initWorker(emitted, runtime)

    // applyPersistedPermissionMode re-applied the saved mode onto the engine.
    expect(spies.setPermissionMode).toHaveBeenCalledWith('plan')
    const ready = emitted.find(m => m.type === 'worker.ready')
    expect(
      (ready?.payload as { currentPermissionMode?: string })
        ?.currentPermissionMode,
    ).toBe('plan')
  })

  it('sets, coerces, persists, and reflects the mode in the snapshot', async () => {
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const { runtime, spies } = makeRuntime('default', {})
    const worker = await initWorker(emitted, runtime)

    emitted.length = 0
    await worker.receiveFrame({
      type: 'worker.setPermissionMode',
      payload: { mode: 'acceptEdits' },
    })

    expect(spies.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
    expect(spies.updateSessionMetadata).toHaveBeenCalledWith({
      permissionMode: 'acceptEdits',
    })
    const state = emitted.find(m => m.type === 'worker.state')
    expect(
      (state?.payload as { currentPermissionMode?: string })
        ?.currentPermissionMode,
    ).toBe('acceptEdits')

    // An unknown mode is coerced to 'default' (coerceSessionMode).
    await worker.receiveFrame({
      type: 'worker.setPermissionMode',
      payload: { mode: 'bogus' },
    })
    expect(spies.setPermissionMode).toHaveBeenLastCalledWith('default')
  })

  it('pushes a worker.state snapshot when a tool flips the mode MID-turn', async () => {
    // Regression: EnterPlanMode/ExitPlanMode change the engine's permission
    // mode via setAppState during a turn, but the submit loop only emitted
    // `worker.stream` — the UI mode picker stayed stale until turn end
    // (`worker.completed`). The fix watches the mode across stream events and
    // pushes `worker.state` the moment it changes.
    const emitted: Array<{ type: string; payload?: unknown }> = []
    let mode = 'default'
    const runtime = {
      conversationStore: {
        getSessionMetadata: vi.fn(async () => ({})),
        updateSessionMetadata: vi.fn(async () => ({})),
        saveToolCallDetail: vi.fn(async () => {}),
      },
      engine: {
        boundSessionId: () => 'mode-test',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => [],
        setModelSelection: vi.fn(),
        getCurrentPermissionMode: () => mode,
        setPermissionMode: vi.fn(),
        submitTurn: async function* () {
          yield { type: 'assistant', message: { content: [] } }
          // The tool (EnterPlanMode) flips the mode inside the turn.
          mode = 'plan'
          yield { type: 'assistant', message: { content: [] } }
        },
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      options: { cwd: '/workspace' },
      getAppState: () => ({ permissionRules: { bypassPermissionsModeDisabled: false } }),
      setAppState: vi.fn(),
    }
    const worker = await initWorker(emitted, runtime)

    emitted.length = 0
    await worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: 'go' } as never,
    })
    // The submit runs asynchronously via the turn queue; wait for completion.
    await new Promise(resolve => setTimeout(resolve, 50))
    // The submit runs asynchronously via the turn queue; wait for completion.
    await new Promise(resolve => setTimeout(resolve, 50))

    const completedIdx = emitted.findIndex(m => m.type === 'worker.completed')
    const planStateIdx = emitted.findIndex(
      m =>
        m.type === 'worker.state' &&
        (m.payload as { currentPermissionMode?: string })
          ?.currentPermissionMode === 'plan',
    )
    expect(planStateIdx, 'a worker.state carrying mode=plan must be pushed')
      .toBeGreaterThanOrEqual(0)
    expect(completedIdx).toBeGreaterThanOrEqual(0)
    expect(
      planStateIdx,
      'the mode snapshot must arrive MID-turn (before worker.completed)',
    ).toBeLessThan(completedIdx)
  })
})

describe('AgentRuntimeWorker — project folder snapshot', () => {
  // Boots a worker whose (mocked) runtime carries the given host mode +
  // project-root resolution result, and returns the `worker.ready` snapshot so
  // we can assert the project-folder gate fields.
  async function snapshotFor(opts: {
    hostMode?: 'nexus' | 'browser'
    projectRoot?: string
    usedSandboxProjectRoot?: boolean
  }): Promise<{
    canPickProjectFolder?: boolean
    needsProjectFolder?: boolean
    projectRoot?: string
  }> {
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message as { type: string; payload?: unknown })
      },
    })
    const runtime = {
      conversationStore: {
        getSessionMetadata: vi.fn(async () => ({})),
        updateSessionMetadata: vi.fn(async () => ({})),
      },
      engine: {
        boundSessionId: () => 'pf-test',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => [],
        getCurrentPermissionMode: () => 'default',
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      usedSandboxProjectRoot: opts.usedSandboxProjectRoot ?? false,
      options: {
        cwd: opts.projectRoot ?? '/workspace',
        projectRoot: opts.projectRoot,
        hostMode: opts.hostMode ?? 'nexus',
      },
    }
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'pf-test', cwd: '/workspace' } as never,
    })
    const ready = emitted.find(m => m.type === 'worker.ready')
    return (ready?.payload ?? {}) as {
      canPickProjectFolder?: boolean
      needsProjectFolder?: boolean
      projectRoot?: string
    }
  }

  it('nexus host + sandbox → forces the picker (both gates true)', async () => {
    const snap = await snapshotFor({
      hostMode: 'nexus',
      usedSandboxProjectRoot: true,
    })
    expect(snap.canPickProjectFolder).toBe(true)
    expect(snap.needsProjectFolder).toBe(true)
  })

  it('nexus host + bound folder → capable but not forced; surfaces projectRoot', async () => {
    const snap = await snapshotFor({
      hostMode: 'nexus',
      projectRoot: '/home/me/repo/',
      usedSandboxProjectRoot: false,
    })
    expect(snap.canPickProjectFolder).toBe(true)
    expect(snap.needsProjectFolder).toBe(false)
    expect(snap.projectRoot).toBe('/home/me/repo/')
  })

  it('mock/dev (browser) host + sandbox → untrapped (both gates false)', async () => {
    const snap = await snapshotFor({
      hostMode: 'browser',
      usedSandboxProjectRoot: true,
    })
    // No capability ⇒ never force the modal, even though it IS on the sandbox.
    expect(snap.canPickProjectFolder).toBe(false)
    expect(snap.needsProjectFolder).toBe(false)
  })

  it('browser host + bound folder → both gates false', async () => {
    const snap = await snapshotFor({
      hostMode: 'browser',
      projectRoot: '/home/me/repo/',
      usedSandboxProjectRoot: false,
    })
    expect(snap.canPickProjectFolder).toBe(false)
    expect(snap.needsProjectFolder).toBe(false)
  })
})

describe('AgentRuntimeWorker — session MCP servers', () => {
  // A runtime whose session pool is a stand-in: the test sets the servers and
  // fires the pool's change listener by hand.
  function bootWithPool(withPool: boolean) {
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message as { type: string; payload?: unknown })
      },
    })
    let servers: Array<{ name: string; status: string }> = [
      { name: 'linear', status: 'connected' },
      { name: 'github', status: 'connected' },
      { name: 'slow', status: 'connecting' },
    ]
    const listeners = new Set<() => void>()
    const pool = {
      listServers: () => servers,
      onServersChanged: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const runtime = {
      conversationStore: {
        getSessionMetadata: vi.fn(async () => ({})),
        updateSessionMetadata: vi.fn(async () => ({})),
      },
      engine: {
        boundSessionId: () => 'mcp-test',
        getCurrentModel: () => 'model-test',
        getCurrentProviderId: () => 'provider-test',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => [],
        getCurrentPermissionMode: () => 'default',
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      usedSandboxProjectRoot: false,
      options: { cwd: '/workspace', hostMode: 'nexus' },
      ...(withPool ? { sessionMcpPool: pool } : {}),
    }
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    const lastServers = () => {
      const states = emitted.filter(m => m.type === 'worker.state' || m.type === 'worker.ready')
      return (states.at(-1)?.payload as { mcpServers?: unknown } | undefined)?.mcpServers
    }
    return {
      worker,
      emitted,
      listeners,
      lastServers,
      setServers: (next: Array<{ name: string; status: string }>) => {
        servers = next
        for (const listener of Array.from(listeners)) listener()
      },
    }
  }

  it('publishes the settled servers by name, and again when the pool changes', async () => {
    const boot = bootWithPool(true)
    await boot.worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'mcp-test', cwd: '/workspace' } as never,
    })
    expect(boot.worker.getSnapshot().mcpServers).toEqual([
      { name: 'github', status: 'connected' },
      { name: 'linear', status: 'connected' },
    ])
    const before = boot.emitted.length
    boot.setServers([
      { name: 'github', status: 'connected' },
      { name: 'slow', status: 'failed' },
    ])
    expect(boot.emitted.length).toBe(before + 1)
    expect(boot.lastServers()).toEqual([
      { name: 'github', status: 'connected' },
      { name: 'slow', status: 'failed' },
    ])
  })

  it('stops hearing the pool once the worker is disposed', async () => {
    const boot = bootWithPool(true)
    await boot.worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'mcp-test', cwd: '/workspace' } as never,
    })
    expect(boot.listeners.size).toBe(1)
    await boot.worker.dispose()
    expect(boot.listeners.size).toBe(0)
  })

  it('leaves the field out for a runtime without a pool', async () => {
    const boot = bootWithPool(false)
    await boot.worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'mcp-test', cwd: '/workspace' } as never,
    })
    expect('mcpServers' in boot.worker.getSnapshot()).toBe(false)
  })
})

describe('AgentRuntimeWorker — resume projectRoot restore', () => {
  function fakeRuntime(projectRoot?: string) {
    return {
      conversationStore: {
        getSessionMetadata: vi.fn(async () => ({})),
        updateSessionMetadata: vi.fn(async () => ({})),
      },
      engine: {
        boundSessionId: () => 'resume-1',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => [],
        getCurrentPermissionMode: () => 'default',
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      usedSandboxProjectRoot: false,
      options: {
        cwd: projectRoot ?? '/workspace',
        projectRoot,
        hostMode: 'browser',
        templateType: 'code',
      },
    }
  }

  it('binds a resumed code session to its persisted projectRoot from the transcript', async () => {
    // Reproduces the real "always shows workspace after restart": the init
    // payload carries NO projectRoot (the page lagged the async broadcast and
    // localStorage recents were empty, and the manager's fsSummaries preload
    // was still in flight). The worker must read the bound folder straight from
    // this session's persisted summary and bind it.
    const loadSessionSummary = vi.fn(async () => ({
      sessionId: 'resume-1',
      projectRoot: '/home/me/projA',
    }))
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      conversationStorageBackend: { loadSessionSummary } as never,
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async (opts: { projectRoot?: string }) =>
        fakeRuntime(opts.projectRoot) as never,
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'resume-1',
        cwd: '/workspace',
        templateType: 'code',
      } as never,
    })

    expect(loadSessionSummary).toHaveBeenCalledWith('resume-1')
    expect(vi.mocked(createAgentRuntime)).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/home/me/projA' }),
    )
  })

  it('does not query the transcript when the payload already carries a projectRoot', async () => {
    const loadSessionSummary = vi.fn(async () => ({
      sessionId: 'x',
      projectRoot: '/stale',
    }))
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      conversationStorageBackend: { loadSessionSummary } as never,
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async (opts: { projectRoot?: string }) =>
        fakeRuntime(opts.projectRoot) as never,
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'x',
        cwd: '/workspace',
        projectRoot: '/home/me/projB',
        templateType: 'code',
      } as never,
    })

    expect(loadSessionSummary).not.toHaveBeenCalled()
    expect(vi.mocked(createAgentRuntime)).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/home/me/projB' }),
    )
  })

  it('resolves the git branch for a resumed code session bound from its transcript', async () => {
    // The branch chip is gated on a real, non-sandbox folder. While
    // the resume bug resolved to the `workspace` sandbox the gate failed and no
    // branch showed; binding the persisted folder must let the worker resolve
    // and surface the branch so the second chip appears on resume.
    const emitted: Array<{ type: string; payload?: { projectBranch?: string } }> =
      []
    const loadSessionSummary = vi.fn(async () => ({
      sessionId: 'resume-1',
      projectRoot: '/home/me/projA',
    }))
    const callTool = vi.fn(async () => 'feature/login\n')
    const worker = new AgentRuntimeWorker({
      emit: m =>
        emitted.push(m as { type: string; payload?: { projectBranch?: string } }),
      conversationStorageBackend: { loadSessionSummary } as never,
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async (opts: { projectRoot?: string }) => {
        const rt = fakeRuntime(opts.projectRoot)
        rt.hostBridge = {
          ...rt.hostBridge,
          browser: { callTool },
        } as never
        return rt as never
      },
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'resume-1',
        cwd: '/workspace',
        templateType: 'code',
      } as never,
    })
    // refreshProjectBranch is fire-and-forget; let its awaited callTool settle.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(callTool).toHaveBeenCalled()
    const branches = emitted
      .filter(m => m.type === 'worker.state')
      .map(m => m.payload?.projectBranch)
      .filter(Boolean)
    expect(branches).toContain('feature/login')
  })

  it('resolves the branch for every folder-bound type, not only `code` (review)', async () => {
    // `review` binds a real repository like `code` (FORCED_FOLDER_TEMPLATE_TYPES),
    // so it gets the branch chip. The gate keyed on the literal `'code'`
    // before, leaving the other folder-bound types picking a repository and
    // never showing its branch.
    const loadSessionSummary = vi.fn(async () => ({
      sessionId: 'resume-1',
      projectRoot: '/home/me/projA',
    }))
    const callTool = vi.fn(async () => 'main\n')
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      conversationStorageBackend: { loadSessionSummary } as never,
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async (opts: { projectRoot?: string }) => {
        const rt = fakeRuntime(opts.projectRoot)
        rt.options.templateType = 'code'
        rt.hostBridge = { ...rt.hostBridge, browser: { callTool } } as never
        return rt as never
      },
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'resume-1',
        cwd: '/workspace',
        templateType: 'code',
      } as never,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(callTool).toHaveBeenCalled()
    expect(worker.getSnapshot().projectBranch).toBe('main')
  })

  it('does not resolve a branch for a type that never binds a folder (chat)', async () => {
    const loadSessionSummary = vi.fn(async () => ({
      sessionId: 'resume-1',
      projectRoot: '/home/me/projA',
    }))
    const callTool = vi.fn(async () => 'main\n')
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      conversationStorageBackend: { loadSessionSummary } as never,
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async (opts: { projectRoot?: string }) => {
        const rt = fakeRuntime(opts.projectRoot)
        rt.options.templateType = 'chat'
        rt.hostBridge = { ...rt.hostBridge, browser: { callTool } } as never
        return rt as never
      },
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'resume-1',
        cwd: '/workspace',
        templateType: 'chat',
      } as never,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(callTool).not.toHaveBeenCalled()
    expect(worker.getSnapshot().projectBranch).toBeUndefined()
  })

  it('retries the init branch resolve until the host shell answers', async () => {
    // The "branch chip sometimes doesn't show" bug. The init resolve is
    // fire-and-forget and the only other trigger is `worker.getState`, which the
    // UI sends on user actions — not on a timer. So when the boot-time callTool
    // rejected (host-bridge ports / C++ tool catalog still coming up) the chip
    // stayed EMPTY for the rest of the session. It must retry itself.
    const loadSessionSummary = vi.fn(async () => ({
      sessionId: 'resume-1',
      projectRoot: '/home/me/projA',
    }))
    // readProjectBranch tries Bash then PowerShell within a single pass.
    const SHELL_CANDIDATES = 2
    let attempts = 0
    const callTool = vi.fn(async () => {
      attempts += 1
      // Both shell candidates fail on the first pass (nothing answered at all).
      if (attempts <= SHELL_CANDIDATES) {
        throw new Error('bridge capability "browser" is not available')
      }
      return 'main\n'
    })
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      conversationStorageBackend: { loadSessionSummary } as never,
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async (opts: { projectRoot?: string }) => {
        const rt = fakeRuntime(opts.projectRoot)
        rt.hostBridge = { ...rt.hostBridge, browser: { callTool } } as never
        return rt as never
      },
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'resume-1',
        cwd: '/workspace',
        templateType: 'code',
      } as never,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    // First pass failed — nothing to show yet.
    expect(worker.getSnapshot().projectBranch).toBeUndefined()

    // The first retry is scheduled ~150ms out (PROJECT_BRANCH_RETRY_DELAYS_MS);
    // no `worker.getState` is sent, so only the retry can fill the chip.
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(worker.getSnapshot().projectBranch).toBe('main')
  })

  it('stops retrying once a shell answers that the folder has no branch', async () => {
    // A non-git folder is a SETTLED answer, not a transport failure: git ran and
    // said no. Retrying would re-spawn a shell four more times for nothing.
    const loadSessionSummary = vi.fn(async () => ({
      sessionId: 'resume-1',
      projectRoot: '/home/me/not-a-repo',
    }))
    const callTool = vi.fn(
      async () =>
        'fatal: not a git repository (or any of the parent directories)',
    )
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      conversationStorageBackend: { loadSessionSummary } as never,
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async (opts: { projectRoot?: string }) => {
        const rt = fakeRuntime(opts.projectRoot)
        rt.hostBridge = { ...rt.hostBridge, browser: { callTool } } as never
        return rt as never
      },
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'resume-1',
        cwd: '/workspace',
        templateType: 'code',
      } as never,
    })
    await new Promise(resolve => setTimeout(resolve, 350))

    // Exactly one pass — both shell candidates, then stop. (Both are still
    // tried within a pass: a host-level rejection surfaced as TEXT by one shell
    // can still succeed on the other.) No retry pass is scheduled.
    expect(callTool).toHaveBeenCalledTimes(2)
    expect(worker.getSnapshot().projectBranch).toBeUndefined()
  })

  it('keeps the branch when a re-resolve fails on reload (does not wipe the chip)', async () => {
    // The "branch disappears on reload" bug: a page reload tears down + re-opens
    // the host-bridge ports; if the getState re-resolve fires mid-reconnect,
    // callTool rejects and readProjectBranch returns undefined. That must NOT
    // clear an already-shown branch.
    const loadSessionSummary = vi.fn(async () => ({
      sessionId: 'resume-1',
      projectRoot: '/home/me/projA',
    }))
    let failResolve = false
    const callTool = vi.fn(async () => {
      if (failResolve) throw new Error('host bridge not ready (reload)')
      return 'main\n'
    })
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      conversationStorageBackend: { loadSessionSummary } as never,
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async (opts: { projectRoot?: string }) => {
        const rt = fakeRuntime(opts.projectRoot)
        rt.hostBridge = { ...rt.hostBridge, browser: { callTool } } as never
        return rt as never
      },
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'resume-1',
        cwd: '/workspace',
        templateType: 'code',
      } as never,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(worker.getSnapshot().projectBranch).toBe('main')

    // Simulate a reload: the bridge is mid-reconnect, so the re-resolve fails.
    failResolve = true
    await worker.receiveFrame({ type: 'worker.getState' } as never)
    await new Promise(resolve => setTimeout(resolve, 0))

    // The failed re-resolve left the previously-resolved branch intact.
    expect(worker.getSnapshot().projectBranch).toBe('main')
  })

  it('clears the chip when git ANSWERS that HEAD is detached', async () => {
    // The other half of the reload guard, and a bug of its own: the guard only
    // ever accepted a truthy branch, so `git checkout --detach` (rev-parse
    // prints the literal `HEAD`, which readProjectBranch reports as no branch)
    // left the chip showing the branch the user had just left — for the rest of
    // the session. `shellResponded` distinguishes this SETTLED answer from the
    // reload race above, so the stale name can go without reopening that bug.
    const loadSessionSummary = vi.fn(async () => ({
      sessionId: 'resume-1',
      projectRoot: '/home/me/projA',
    }))
    let detached = false
    const callTool = vi.fn(async () => (detached ? 'HEAD\n' : 'main\n'))
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      conversationStorageBackend: { loadSessionSummary } as never,
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async (opts: { projectRoot?: string }) => {
        const rt = fakeRuntime(opts.projectRoot)
        rt.hostBridge = { ...rt.hostBridge, browser: { callTool } } as never
        return rt as never
      },
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'resume-1',
        cwd: '/workspace',
        templateType: 'code',
      } as never,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(worker.getSnapshot().projectBranch).toBe('main')

    detached = true
    await worker.receiveFrame({ type: 'worker.getState' } as never)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(worker.getSnapshot().projectBranch).toBeUndefined()
  })

  it('re-resolves the branch after a turn in which the AGENT ran git checkout', async () => {
    // The "agent switched the branch" half of the stale-chip bug. Before this,
    // `refreshProjectBranch` ran only at init and on `worker.getState` — which
    // the UI sends on user actions (model pick, permission change), never on a
    // turn boundary. So an agent that checked out a branch mid-turn left the
    // chip on the OLD branch until the user happened to do one of those.
    const loadSessionSummary = vi.fn(async () => ({
      sessionId: 'resume-1',
      projectRoot: '/home/me/projA',
    }))
    let branch = 'main'
    const callTool = vi.fn(async () => `${branch}\n`)
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      conversationStorageBackend: { loadSessionSummary } as never,
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async (opts: { projectRoot?: string }) => {
        const rt = fakeRuntime(opts.projectRoot)
        rt.hostBridge = { ...rt.hostBridge, browser: { callTool } } as never
        rt.conversationStore = {
          ...rt.conversationStore,
          saveToolCallDetail: vi.fn(async () => {}),
        } as never
        rt.engine = {
          ...rt.engine,
          // The turn: the model asks for a Bash `git checkout`, and the branch
          // has moved by the time the stream drains — exactly the ordering the
          // worker relies on (the tool-use part is the REQUEST, so resolving on
          // the part itself would still read `main`).
          submitTurn: async function* () {
            yield {
              type: 'assistant',
              message: {
                content: [
                  {
                    type: 'tool-call',
                    toolName: 'Bash',
                    args: { command: 'git checkout release-1' },
                  },
                ],
              },
            }
            branch = 'release-1'
          },
        } as never
        return rt as never
      },
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'resume-1',
        cwd: '/workspace',
        templateType: 'code',
      } as never,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(worker.getSnapshot().projectBranch).toBe('main')

    await worker.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'switch branch' } } as never,
      'user',
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(worker.getSnapshot().projectBranch).toBe('release-1')
  })

  it('does not re-resolve after a turn that ran no HEAD-moving command', async () => {
    // The detection must stay narrow: a turn of ordinary tool calls costs no
    // extra host shell spawn. `git status` is the canary — a prefix-ish or
    // over-broad match would fire on it.
    const loadSessionSummary = vi.fn(async () => ({
      sessionId: 'resume-1',
      projectRoot: '/home/me/projA',
    }))
    const callTool = vi.fn(async () => 'main\n')
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      conversationStorageBackend: { loadSessionSummary } as never,
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(
      async (opts: { projectRoot?: string }) => {
        const rt = fakeRuntime(opts.projectRoot)
        rt.hostBridge = { ...rt.hostBridge, browser: { callTool } } as never
        rt.conversationStore = {
          ...rt.conversationStore,
          saveToolCallDetail: vi.fn(async () => {}),
        } as never
        rt.engine = {
          ...rt.engine,
          submitTurn: async function* () {
            yield {
              type: 'assistant',
              message: {
                content: [
                  {
                    type: 'tool-call',
                    toolName: 'Bash',
                    args: { command: 'git status --short' },
                  },
                ],
              },
            }
          },
        } as never
        return rt as never
      },
    )

    await worker.receiveFrame({
      type: 'worker.init',
      payload: {
        sessionId: 'resume-1',
        cwd: '/workspace',
        templateType: 'code',
      } as never,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const callsAfterInit = callTool.mock.calls.length

    await worker.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: 'check status' } } as never,
      'user',
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(callTool.mock.calls.length).toBe(callsAfterInit)
  })

  // Regression: a transient empty/null catalog from a refresh must NOT wipe a
  // previously-loaded one. Background refreshes (window focus, providers.changed)
  // re-fetch getModelCatalog; if the host broker is mid-init it can resolve with
  // null or an empty-providers catalog. Overwriting blanked BOTH the topbar
  // model picker AND the settings provider list, and tripped the "set up a model
  // provider" dialog on the next Send, until a later refresh restored it.
  const POPULATED_CATALOG = {
    providers: [
      {
        id: 'openai',
        label: 'OpenAI',
        iconSvg: '',
        enabled: true,
        defaultModelId: 'gpt-x',
        models: [{ id: 'gpt-x', label: 'GPT X', enabled: true }],
      },
    ],
  }

  function makeWorkerWithCatalog(getModelCatalog: () => Promise<unknown>) {
    const emitted: unknown[] = []
    const worker = new AgentRuntimeWorker({
      emit: message => emitted.push(message),
    })
    const w = worker as unknown as {
      scopeModels: {
        setCatalog(catalog: unknown): void
        getCatalog(): unknown
        setHasEngineSelection(value: boolean): void
      }
      runtime: unknown
    }
    seedRuntime(worker, {
      hostBridge: { getModelCatalog: vi.fn(getModelCatalog) },
      engine: {
        getCurrentModel: () => 'gpt-x',
        getCurrentProviderId: () => 'openai',
        boundSessionId: () => 's1',
        transcriptRows: () => [],
      },
      options: { hostMode: 'browser', commands: [] },
      tools: [],
    })
    w.scopeModels.setCatalog(POPULATED_CATALOG)
    // Skip the post-refresh re-resolve branch (it needs a conversationStore).
    w.scopeModels.setHasEngineSelection(true)
    return { worker, emitted, w }
  }

  const lastStateCatalog = (emitted: unknown[]) => {
    const states = emitted.filter(
      (m): m is { type: string; payload: { modelCatalog: unknown } } =>
        (m as { type?: string }).type === 'worker.state',
    )
    return states.at(-1)?.payload.modelCatalog
  }

  it('worker.refreshModelCatalog keeps the existing catalog when the host returns null', async () => {
    const { worker, emitted, w } = makeWorkerWithCatalog(async () => null)
    await worker.receiveFrame({ type: 'worker.refreshModelCatalog' } as never)
    expect(w.scopeModels.getCatalog()).toBe(POPULATED_CATALOG)
    expect(lastStateCatalog(emitted)).toBe(POPULATED_CATALOG)
  })

  it('worker.refreshModelCatalog keeps the existing catalog when the host returns an empty provider list', async () => {
    const { worker, emitted, w } = makeWorkerWithCatalog(async () => ({
      providers: [],
    }))
    await worker.receiveFrame({ type: 'worker.refreshModelCatalog' } as never)
    expect(w.scopeModels.getCatalog()).toBe(POPULATED_CATALOG)
    expect(lastStateCatalog(emitted)).toBe(POPULATED_CATALOG)
  })

  it('worker.refreshModelCatalog adopts a freshly fetched populated catalog', async () => {
    const NEXT_CATALOG = {
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          iconSvg: '',
          enabled: true,
          defaultModelId: 'claude-x',
          models: [{ id: 'claude-x', label: 'Claude X', enabled: true }],
        },
      ],
    }
    const { worker, emitted, w } = makeWorkerWithCatalog(
      async () => NEXT_CATALOG,
    )
    await worker.receiveFrame({ type: 'worker.refreshModelCatalog' } as never)
    expect(w.scopeModels.getCatalog()).toBe(NEXT_CATALOG)
    expect(lastStateCatalog(emitted)).toBe(NEXT_CATALOG)
  })

  // Regression: the [NexusModelCatalog] catalog-adoption log is a
  // diagnostic and must follow the trace opt-in — with the model-upload
  // trace flag off (the default), adopting a fetched catalog emits NO
  // worker.debugLog; with it on, the info line (online vs catalog model
  // lists) goes out.
  const catalogDebugLogs = (emitted: unknown[]) =>
    emitted.filter(
      (m): m is { type: string; payload: { message?: string } } =>
        (m as { type?: string }).type === 'worker.debugLog'
        && String(
          (m as { payload?: { message?: string } }).payload?.message ?? '',
        ).startsWith('[NexusModelCatalog]'),
    )

  it('does NOT emit the [NexusModelCatalog] debug log when tracing is off', async () => {
    setModelUploadTraceEnabled(false)
    const { worker, emitted } = makeWorkerWithCatalog(async () => ({
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          iconSvg: '',
          enabled: true,
          models: [{ id: 'claude-x', label: 'Claude X', enabled: true }],
        },
      ],
    }))
    await worker.receiveFrame({ type: 'worker.refreshModelCatalog' } as never)
    expect(catalogDebugLogs(emitted)).toEqual([])
  })

  it('emits the [NexusModelCatalog] debug log with online/catalog lists when tracing is on', async () => {
    setModelUploadTraceEnabled(true)
    try {
      const { worker, emitted } = makeWorkerWithCatalog(async () => ({
        providers: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            iconSvg: '',
            enabled: true,
            models: [
              { id: 'claude-x', label: 'Claude X', enabled: true },
              { id: 'claude-curated', label: 'Curated', enabled: true },
            ],
          },
        ],
        rawCatalogs: {
          anthropic: JSON.stringify({ data: [{ id: 'claude-x' }] }),
        },
      }))
      await worker.receiveFrame(
        { type: 'worker.refreshModelCatalog' } as never,
      )
      const logs = catalogDebugLogs(emitted)
      expect(logs).toHaveLength(1)
      // Online list comes from rawCatalogs, catalog list from the grafted
      // provider models — the curated-only id appears in catalog, not online.
      expect(logs[0]!.payload.message).toContain('online=[claude-x]')
      expect(logs[0]!.payload.message).toContain(
        'catalog=[claude-x, claude-curated]',
      )
    } finally {
      setModelUploadTraceEnabled(false)
    }
  })

  // Regression (init Phase 2): fetchAndReconcileCatalog must ALSO not clobber a
  // catalog a concurrent refresh already adopted. Phase 2 is fire-and-forget
  // (waitForInit doesn't await it) and getModelCatalog has no single-flight, so
  // a late null/empty/throwing init fetch could otherwise overwrite a good
  // catalog — re-blanking the picker + settings list from the init path.
  function makeWorkerForInit(getModelCatalog: () => Promise<unknown>) {
    const emitted: unknown[] = []
    const worker = new AgentRuntimeWorker({ emit: m => emitted.push(m) })
    const w = worker as unknown as {
      modelCatalog: unknown
      runtime: unknown
      scopeModels: { fetchAndReconcileCatalog: (payload: unknown) => Promise<void> }
    }
    // Simulate "a concurrent refresh already adopted a good catalog".
    w.modelCatalog = POPULATED_CATALOG
    seedRuntime(worker, {
      hostBridge: { getModelCatalog: vi.fn(getModelCatalog) },
      conversationStore: { getSessionMetadata: vi.fn(async () => null) },
      // Match the catalog's resolved selection so the reconcile finds the
      // selection already current and skips applyModelSelection.
      options: {
        userSpecifiedProviderId: 'openai',
        userSpecifiedModel: 'gpt-x',
        hostMode: 'browser',
        commands: [],
      },
      engine: {
        getCurrentModel: () => 'gpt-x',
        getCurrentProviderId: () => 'openai',
        boundSessionId: () => 's1',
        transcriptRows: () => [],
      },
      tools: [],
    })
    return { w }
  }

  const INIT_PAYLOAD = {
    sessionId: 's1',
    userSpecifiedProviderId: 'openai',
    userSpecifiedModel: 'gpt-x',
  }

  it('init catalog fetch keeps an already-adopted catalog when the host resolves null', async () => {
    const { w } = makeWorkerForInit(async () => null)
    await w.scopeModels.fetchAndReconcileCatalog(INIT_PAYLOAD)
    expect(w.modelCatalog).toBe(POPULATED_CATALOG)
  })

  it('init catalog fetch keeps an already-adopted catalog when the host resolves empty', async () => {
    const { w } = makeWorkerForInit(async () => ({ providers: [] }))
    await w.scopeModels.fetchAndReconcileCatalog(INIT_PAYLOAD)
    expect(w.modelCatalog).toBe(POPULATED_CATALOG)
  })

  it('init catalog fetch keeps an already-adopted catalog when the host throws', async () => {
    const { w } = makeWorkerForInit(async () => {
      throw new Error('host not ready')
    })
    await w.scopeModels.fetchAndReconcileCatalog(INIT_PAYLOAD)
    expect(w.modelCatalog).toBe(POPULATED_CATALOG)
  })

  // Sub-agent tier spawns (Agent tool model:'fast'|'balanced'|'best') ride a
  // (providerId, modelId) pair + the parent's live selection as
  // `modelFallbackSelection`. When the requested pair is NOT enabled in the
  // live catalog, resolution must land on that parent selection — never
  // `catalog.defaultSelection` (a tier request must not run on a third,
  // unrelated model).
  it('falls back to modelFallbackSelection (parent model) when the requested pair is not enabled — not defaultSelection', async () => {
    const TIER_CATALOG = {
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          iconSvg: '',
          enabled: true,
          models: [
            { id: 'gpt-default', label: 'Default', enabled: true },
            { id: 'gpt-parent', label: 'Parent', enabled: true },
          ],
        },
      ],
      // The trap: without the fallback step, resolution lands here.
      defaultSelection: { providerId: 'openai', modelId: 'gpt-default' },
    }
    const worker = new AgentRuntimeWorker({ emit: () => {} })
    const setModelSelection = vi.fn()
    const w = worker as unknown as {
      runtime: unknown
      scopeModels: { fetchAndReconcileCatalog: (payload: unknown) => Promise<void> }
    }
    seedRuntime(worker, {
      hostBridge: { getModelCatalog: vi.fn(async () => TIER_CATALOG) },
      conversationStore: {
        getSessionMetadata: vi.fn(async () => null),
        updateSessionMetadata: vi.fn(async () => ({})),
      },
      options: { hostMode: 'browser', commands: [] },
      engine: {
        getCurrentModel: () => 'gpt-old',
        getCurrentProviderId: () => 'openai',
        boundSessionId: () => 's1',
        transcriptRows: () => [],
        setModelSelection,
      },
      tools: [],
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await w.scopeModels.fetchAndReconcileCatalog({
        sessionId: 's1',
        // The tier spawn requested a pair the live catalog does NOT enable…
        userSpecifiedProviderId: 'openai',
        userSpecifiedModel: 'gpt-nope',
        // …so resolution lands on the parent's selection, NOT gpt-default.
        modelFallbackSelection: { providerId: 'openai', modelId: 'gpt-parent' },
      })
      expect(setModelSelection).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'openai', model: 'gpt-parent' }),
      )
      // The engaged fallback is surfaced (console breadcrumb + tracer event).
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  // A tier-resolved sub-agent spawn carries NO userSpecifiedThinkingTier, so
  // the selected model must run on ITS OWN curated defaultThinkingTier — not
  // the parent's effort (which may be a vocabulary the new model rejects).
  // claude-sonnet-5's curated default is 'high' (providers/anthropic/config.ts).
  it('tier-selected model boots on its own catalog default thinking tier, not the parent effort', async () => {
    const CATALOG = {
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          iconSvg: '',
          enabled: true,
          models: [{ id: 'claude-sonnet-5', label: 'Sonnet 5', enabled: true }],
        },
      ],
    }
    const worker = new AgentRuntimeWorker({ emit: () => {} })
    const setModelSelection = vi.fn()
    const w = worker as unknown as {
      runtime: unknown
      scopeModels: { fetchAndReconcileCatalog: (payload: unknown) => Promise<void> }
    }
    seedRuntime(worker, {
      hostBridge: { getModelCatalog: vi.fn(async () => CATALOG) },
      conversationStore: {
        getSessionMetadata: vi.fn(async () => null),
        updateSessionMetadata: vi.fn(async () => ({})),
      },
      options: { hostMode: 'browser', commands: [] },
      engine: {
        getCurrentModel: () => 'claude-fable-5',
        getCurrentProviderId: () => 'anthropic',
        boundSessionId: () => 's1',
        transcriptRows: () => [],
        setModelSelection,
      },
      tools: [],
    })
    await w.scopeModels.fetchAndReconcileCatalog({
      sessionId: 's1',
      // A tier spawn: the pair only, NO userSpecifiedThinkingTier (the parent
      // ran e.g. Fable 5 at 'max' — that must not leak onto Sonnet).
      userSpecifiedProviderId: 'anthropic',
      userSpecifiedModel: 'claude-sonnet-5',
    })
    expect(setModelSelection).toHaveBeenCalledWith({
      providerId: 'anthropic',
      model: 'claude-sonnet-5',
      thinkingTier: 'high',
    })
  })
})

describe('AgentRuntimeWorker — restorePendingPlanApproval', () => {
  afterEach(() => {
    resetProcessFs()
  })

  function makePlanRuntime(opts: {
    messages?: Message[]
    planFileContent?: string
    metadata?: Record<string, unknown>
    appState?: Record<string, unknown>
  }) {
    const appState: Record<string, unknown> = opts.appState ?? {}
    const setAppState = vi.fn(
      (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
        Object.assign(appState, updater(appState))
      },
    )
    const readFile = vi.fn(async () => {
      if (opts.planFileContent === undefined) throw new Error('ENOENT')
      return opts.planFileContent
    })
    // The plan is read through THIS runtime's own fs (`installedFs`), never
    // the realm-global slot — which here holds a disposed sibling's fs.
    const installedFs = {
      readFile,
      stat: vi.fn(async () => ({})),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    }
    installProcessFs({
      readFile: vi.fn(async () => {
        throw new Error('Runtime scope was disposed.')
      }),
    } as never)
    const updateSessionMetadata = vi.fn(async () => ({}))
    const runtime = {
      conversationStore: {
        getSessionMetadata: vi.fn(async () => opts.metadata ?? {}),
        updateSessionMetadata,
      },
      engine: {
        boundSessionId: () => 'plan-session',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => opts.messages ?? [],
        setModelSelection: vi.fn(),
        getCurrentPermissionMode: () => 'plan',
        setPermissionMode: vi.fn(),
        getPendingPlanApproval: () => appState.pendingPlanApproval,
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      options: { cwd: '/workspace' },
      installedFs,
      setAppState,
      getAppState: () => appState,
    }
    return { runtime, setAppState, readFile, updateSessionMetadata }
  }

  async function initWorker(
    emitted: Array<{ type: string; payload?: unknown }>,
    runtime: unknown,
  ): Promise<AgentRuntimeWorker> {
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message as { type: string; payload?: unknown })
      },
    })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'plan-session', cwd: '/workspace' } as never,
    })
    return worker
  }

  it('restores pendingPlanApproval from the metadata marker + plan file', async () => {
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const { runtime, setAppState } = makePlanRuntime({
      metadata: { pendingPlanApprovalToolCallId: 'tool-exit-1' },
      planFileContent: '## My Plan\nStep 1\nStep 2',
      appState: {
        permissionRules: { mode: 'plan', modeBeforePlan: 'default' },
      },
    })
    await initWorker(emitted, runtime)

    expect(setAppState).toHaveBeenCalled()
    const lastCall = setAppState.mock.calls.at(-1)![0] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>
    const result = lastCall({})
    expect(result.pendingPlanApproval).toEqual({
      'tool-exit-1': {
        toolName: 'ExitPlanMode',
        planText: '## My Plan\nStep 1\nStep 2',
        planFilePath: expect.stringContaining('plan-session'),
        restoreMode: 'default',
      },
    })

    // The worker.ready snapshot should carry the restored approval.
    const ready = emitted.find(m => m.type === 'worker.ready')
    expect(
      (ready?.payload as { pendingPlanApproval?: Record<string, unknown> })
        ?.pendingPlanApproval,
    ).toHaveProperty('tool-exit-1')
  })

  it('does NOT restore pendingPlanApproval when no metadata marker exists', async () => {
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const { runtime, setAppState } = makePlanRuntime({
      metadata: {}, // no pendingPlanApprovalToolCallId
      planFileContent: '## Plan',
      appState: {
        permissionRules: { mode: 'plan', modeBeforePlan: 'default' },
      },
    })
    await initWorker(emitted, runtime)

    for (const call of setAppState.mock.calls) {
      const updater = call[0] as (
        prev: Record<string, unknown>,
      ) => Record<string, unknown>
      const result = updater({})
      expect(result.pendingPlanApproval).toBeUndefined()
    }
  })

  it('does NOT restore and clears the marker when no plan file exists on disk', async () => {
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const { runtime, setAppState, updateSessionMetadata } = makePlanRuntime({
      metadata: { pendingPlanApprovalToolCallId: 'tool-exit-3' },
      planFileContent: undefined, // readFile throws ENOENT
      appState: {
        permissionRules: { mode: 'plan', modeBeforePlan: 'default' },
      },
    })
    await initWorker(emitted, runtime)

    for (const call of setAppState.mock.calls) {
      const updater = call[0] as (
        prev: Record<string, unknown>,
      ) => Record<string, unknown>
      const result = updater({})
      expect(result.pendingPlanApproval).toBeUndefined()
    }
    // The stale marker should be cleared.
    expect(updateSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ pendingPlanApprovalToolCallId: undefined }),
    )
  })

  it('persists the metadata marker when ExitPlanMode is queued for confirmation', async () => {
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const { runtime, updateSessionMetadata } = makePlanRuntime({
      metadata: {},
      appState: {
        permissionRules: { mode: 'plan', modeBeforePlan: 'default' },
      },
    })
    const worker = await initWorker(emitted, runtime)

    // Simulate the runtime calling requestToolUseConfirm for ExitPlanMode.
    const confirmPromise = (
      worker as unknown as {
        scopePermissions: { request: (item: unknown) => Promise<unknown> }
      }
    ).scopePermissions.request({
      toolName: 'ExitPlanMode',
      approvalCallId: 'tool-exit-99',
      description: 'Exit plan mode?',
      input: { plan: 'test' },
      permissionResult: { behavior: 'ask' },
      askedAtMs: Date.now(),
      assistantMessage: { uuid: 'a1' },
    })

    // The marker should be persisted.
    expect(updateSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ pendingPlanApprovalToolCallId: 'tool-exit-99' }),
    )

    // Resolve the confirm to avoid a dangling promise.
    await worker.receiveFrame({
      type: 'worker.resolveToolUseConfirm',
      payload: { approvalCallId: 'tool-exit-99', behavior: 'allow' },
    })
    await confirmPromise
  })

  it('clears the metadata marker when the approval is resolved', async () => {
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const { runtime, updateSessionMetadata } = makePlanRuntime({
      metadata: { pendingPlanApprovalToolCallId: 'tool-exit-50' },
      planFileContent: '## Plan',
      appState: {
        permissionRules: { mode: 'plan', modeBeforePlan: 'default' },
      },
    })
    const worker = await initWorker(emitted, runtime)

    // First, queue the confirm so the resolver exists.
    const confirmPromise = (
      worker as unknown as {
        scopePermissions: { request: (item: unknown) => Promise<unknown> }
      }
    ).scopePermissions.request({
      toolName: 'ExitPlanMode',
      approvalCallId: 'tool-exit-50',
      description: 'Exit plan mode?',
      input: { plan: 'test' },
      permissionResult: { behavior: 'ask' },
      askedAtMs: Date.now(),
      assistantMessage: { uuid: 'a1' },
    })

    // Resolve it — should clear the marker.
    await worker.receiveFrame({
      type: 'worker.resolveToolUseConfirm',
      payload: { approvalCallId: 'tool-exit-50', behavior: 'allow' },
    })
    await confirmPromise

    expect(updateSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ pendingPlanApprovalToolCallId: undefined }),
    )
  })
})

describe('AgentRuntimeWorker — lastTerminalReason refresh after turn', () => {
  // Regression: the worker loaded lastTerminalReason from persisted metadata
  // only once at init. After a turn completed normally (engine persists
  // 'completed'), the snapshot kept reporting the stale init-time value
  // (e.g. 'aborted_streaming'), so the "Conversation was cancelled / Continue"
  // banner never cleared. The fix re-reads metadata after each turn.

  async function initWorker(
    emitted: Array<{ type: string; payload?: unknown }>,
    runtime: unknown,
  ): Promise<AgentRuntimeWorker> {
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message as { type: string; payload?: unknown })
      },
    })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'terminal-test', cwd: '/workspace' } as never,
    })
    return worker
  }

  it('refreshes lastTerminalReason from metadata after a turn completes', async () => {
    // Metadata starts with a stale 'aborted_streaming' (loaded at init), then
    // the engine's saveTerminalState updates it to 'completed' during the turn.
    let storedReason = 'aborted_streaming'
    const getSessionMetadata = vi.fn(async () => ({
      lastTerminalReason: storedReason,
      lastTerminalTimestamp: 1000,
    }))
    const runtime = {
      conversationStore: {
        getSessionMetadata,
        updateSessionMetadata: vi.fn(async () => ({})),
        saveToolCallDetail: vi.fn(async () => {}),
      },
      engine: {
        boundSessionId: () => 'terminal-test',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => [],
        setModelSelection: vi.fn(),
        getCurrentPermissionMode: () => 'default',
        setPermissionMode: vi.fn(),
        submitTurn: async function* () {
          // Simulate the engine persisting the new terminal reason mid-turn
          // (saveTerminalState runs inside the query loop, before the worker's
          // post-loop metadata re-read).
          storedReason = 'completed'
          yield { type: 'assistant', message: { content: [] } }
        },
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      options: { cwd: '/workspace' },
    }

    const emitted: Array<{ type: string; payload?: unknown }> = []
    const worker = await initWorker(emitted, runtime)

    // worker.ready snapshot carries the stale init-time value.
    const ready = emitted.find(m => m.type === 'worker.ready')
    expect(
      (ready?.payload as { lastTerminalReason?: string })?.lastTerminalReason,
    ).toBe('aborted_streaming')

    emitted.length = 0
    await worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: 'hello' } as never,
    })
    // The submit runs asynchronously via the turn queue; wait for completion.
    await new Promise(resolve => setTimeout(resolve, 50))

    // worker.completed must carry the REFRESHED value, not the stale one.
    const completed = emitted.find(m => m.type === 'worker.completed')
    expect(completed).toBeDefined()
    expect(
      (completed?.payload as { lastTerminalReason?: string })?.lastTerminalReason,
      'worker.completed must carry the refreshed terminal reason',
    ).toBe('completed')
  })
})

describe('turn gate resilience + scope guards', () => {
  type Emitted = Array<{ type: string; payload?: unknown }>

  function makeTurnRuntime(overrides?: {
    getSessionMetadata?: () => Promise<unknown>
    getModelCatalog?: () => Promise<unknown>
    submitTurn?: () => AsyncGenerator<unknown>
  }) {
    return {
      conversationStore: {
        getSessionMetadata:
          overrides?.getSessionMetadata ?? vi.fn(async () => ({})),
        updateSessionMetadata: vi.fn(async () => ({})),
        saveToolCallDetail: vi.fn(async () => {}),
      },
      engine: {
        boundSessionId: () => 'round4-test',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => [],
        setModelSelection: vi.fn(),
        getCurrentPermissionMode: () => 'default',
        setPermissionMode: vi.fn(),
        submitTurn:
          overrides?.submitTurn ??
          (async function* () {
            yield { type: 'assistant', message: { content: [] } }
          }),
      },
      hostBridge: {
        getModelCatalog: overrides?.getModelCatalog ?? vi.fn(async () => null),
      },
      tools: [],
      options: { cwd: '/workspace' },
      getAppState: () => ({
        permissionRules: { bypassPermissionsModeDisabled: false },
      }),
      setAppState: vi.fn(),
    }
  }

  async function initRound4Worker(
    emitted: Emitted,
    runtime: unknown,
    host?: {
      broadcastBootStage?: (stage: string, sessionId: string) => void
      bindSessionRuntime?: (sessionId: string, store: unknown) => void
      setModel?: (sessionId: string, selection: unknown) => void
    },
  ): Promise<AgentRuntimeWorker> {
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message as { type: string; payload?: unknown })
      },
      ...(host
        ? {
            host: {
              broadcastBootStage: host.broadcastBootStage ?? (() => {}),
              bindSessionRuntime: host.bindSessionRuntime ?? (() => {}),
              setModel: host.setModel ?? (() => {}),
            } as never,
          }
        : {}),
    })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'round4-test', cwd: '/workspace' } as never,
    })
    return worker
  }

  it('a rejecting modelInitPromise neither fails the turn nor wedges the queue', async () => {
    // Red-without: the model-grace race lived OUTSIDE executeSubmit's
    // try/finally, so a rejecting init promise skipped the finally that
    // clears `executingTurn` — turn 1 reported failed and every later turn
    // died on the worker_busy guard.
    const emitted: Emitted = []
    const worker = await initRound4Worker(emitted, makeTurnRuntime())

    const internals = worker as unknown as {
      scopeModels: {
        setHasEngineSelection(v: boolean): void
        setInitPromise(p: Promise<void> | null): void
      }
      executingTurn: boolean
    }
    const rejected = Promise.reject(new Error('metadata boom'))
    // Pre-attach a handler so the injected rejection can never trip the
    // process-level unhandled-rejection hook before the race consumes it.
    rejected.catch(() => {})
    internals.scopeModels.setHasEngineSelection(false)
    internals.scopeModels.setInitPromise(rejected as Promise<void>)

    const first = await worker.submitAndWait({
      type: 'worker.submitMessage',
      payload: { prompt: 'one' },
    } as never)
    expect(first.status, 'turn 1 must survive the rejecting gate').toBe(
      'completed',
    )

    const second = await worker.submitAndWait({
      type: 'worker.submitMessage',
      payload: { prompt: 'two' },
    } as never)
    expect(second.status, 'turn 2 must not hit the worker_busy guard').toBe(
      'completed',
    )
    expect(internals.executingTurn).toBe(false)
  })

  it('a reconcile failure after the catalog fetch leaves modelInitPromise non-rejecting', async () => {
    // fetchAndReconcileCatalog only catches the FETCH; the metadata read /
    // applySelection afterwards can reject. The stored promise must absorb
    // that (debug warning instead), or every waiter — the submit gate, the
    // finally-clear chain — sees an unhandled rejection.
    const emitted: Emitted = []
    let releaseCatalog: (() => void) | undefined
    let rejectMetadata = false
    const catalog = {
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          enabled: true,
          models: [{ id: 'claude-test', label: 'Claude Test' }],
        },
      ],
    }
    const runtime = makeTurnRuntime({
      getSessionMetadata: () =>
        rejectMetadata
          ? Promise.reject(new Error('metadata read failed'))
          : Promise.resolve({}),
      getModelCatalog: () =>
        new Promise(resolve => {
          releaseCatalog = () => resolve(catalog)
        }),
    })
    const worker = await initRound4Worker(emitted, runtime)

    const internals = worker as unknown as {
      scopeModels: { getInitPromise(): Promise<void> | null }
    }
    const initPromise = internals.scopeModels.getInitPromise()
    expect(initPromise, 'phase-2 catalog promise must be in flight').not.toBeNull()

    // Fail the post-fetch reconcile (the metadata read), then release the fetch.
    rejectMetadata = true
    releaseCatalog?.()

    await expect(initPromise).resolves.toBeUndefined()
    const warning = emitted.find(
      m =>
        m.type === 'worker.debugLog' &&
        typeof (m.payload as { message?: string })?.message === 'string' &&
        (m.payload as { message: string }).message.includes(
          'background reconcile failed',
        ),
    )
    expect(warning, 'the failure must surface as a debug warning').toBeDefined()
  })

  it('worker.completed never carries a busy snapshot when tool bookkeeping is unbalanced', async () => {
    // markStreamEnd skips the idle transition while tools are in flight, so
    // an unbalanced markToolStart used to pin the phase — worker.completed
    // went out with isBusy=true and the finally normalized it SILENTLY (no
    // worker.state), leaving feeds stuck busy.
    const emitted: Emitted = []
    let workerRef: AgentRuntimeWorker | undefined
    const runtime = makeTurnRuntime({
      submitTurn: async function* () {
        workerRef!.markToolStart('Bash', 'local')
        yield { type: 'assistant', message: { content: [] } }
        // Deliberately no markToolEnd — simulates lost tool bookkeeping.
      },
    })
    workerRef = await initRound4Worker(emitted, runtime)

    const result = await workerRef.submitAndWait({
      type: 'worker.submitMessage',
      payload: { prompt: 'go' },
    } as never)
    expect(result.status).toBe('completed')

    const completed = emitted.find(m => m.type === 'worker.completed')
    expect(completed).toBeDefined()
    expect(
      (completed?.payload as { isBusy?: boolean })?.isBusy,
      'worker.completed must snapshot an idle session',
    ).toBe(false)
    expect(workerRef.isBusy()).toBe(false)
    expect(workerRef.getPhase().kind).toBe('idle')
  })

  it('a superseded scope cannot bind its conversation store late', async () => {
    // Scope 1 parks inside the recovery block (copyForkedPlanIfNeeded's
    // metadata read); scope 2 fully initializes meanwhile. When scope 1
    // resumes, the per-await guards must stop it before bindSessionRuntime
    // — otherwise the Manager's store binding flips back to the STALE store.
    const emitted: Emitted = []
    const bindCalls: Array<{ sessionId: string; store: unknown }> = []
    let releaseMetadata: (() => void) | undefined
    let metadataCalls = 0
    const store1 = {
      getSessionMetadata: () => {
        metadataCalls += 1
        // Call 1: applyImmediateSelection. Call 2: applyPersistedMode.
        // Call 3 (copyForkedPlanIfNeeded) parks until released.
        if (metadataCalls === 3) {
          return new Promise(resolve => {
            releaseMetadata = () => resolve({})
          })
        }
        return Promise.resolve({})
      },
      updateSessionMetadata: vi.fn(async () => ({})),
      saveToolCallDetail: vi.fn(async () => {}),
    }
    const runtime1 = { ...makeTurnRuntime(), conversationStore: store1 }
    const runtime2 = makeTurnRuntime()

    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message as { type: string; payload?: unknown })
      },
      host: {
        broadcastBootStage: () => {},
        bindSessionRuntime: (sessionId: string, store: unknown) => {
          bindCalls.push({ sessionId, store })
        },
        setModel: () => {},
      } as never,
    })

    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime1 as never)
    const init1 = worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'round4-test', cwd: '/workspace' } as never,
    })
    // Drain macrotasks until scope 1 parks in the recovery block.
    for (let i = 0; i < 50 && !releaseMetadata; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(releaseMetadata, 'scope 1 must be parked in recovery').toBeDefined()

    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime2 as never)
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'round4-test', cwd: '/workspace' } as never,
    })
    const bindsAfterInit2 = bindCalls.length
    expect(bindsAfterInit2, 'scope 2 must have bound its store').toBeGreaterThan(0)
    expect(bindCalls.at(-1)?.store).toBe(runtime2.conversationStore)

    // Un-park scope 1 — the guards must stop it from binding store1.
    releaseMetadata?.()
    await init1.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(
      bindCalls.length,
      'the stale scope must not have added a late bind',
    ).toBe(bindsAfterInit2)
    expect(bindCalls.at(-1)?.store).toBe(runtime2.conversationStore)
  })

  it("a superseded scope's model controller cannot report into the current feed", async () => {
    const emitted: Emitted = []
    const setModelCalls: Array<{ sessionId: string; selection: unknown }> = []
    const host = {
      setModel: (sessionId: string, selection: unknown) => {
        setModelCalls.push({ sessionId, selection })
      },
    }
    const worker = await initRound4Worker(emitted, makeTurnRuntime(), host)

    const scope1Models = (
      worker as unknown as {
        runtimeScope: { models: { applySelection(s: unknown): Promise<void> } }
      }
    ).runtimeScope.models

    // Supersede scope 1 with a fresh init.
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeTurnRuntime() as never,
    )
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'round4-test', cwd: '/workspace' } as never,
    })
    setModelCalls.length = 0

    // A late async continuation on the STALE scope's controller commits into
    // its own (dead) runtime — fine — but must not reach the Manager host.
    await scope1Models.applySelection({
      providerId: 'openai',
      modelId: 'stale-model',
    })

    expect(
      setModelCalls,
      'stale-scope selection must not reach host.setModel',
    ).toHaveLength(0)
  })
})

describe('turn finalization side effects + init failure', () => {
  type Emitted = Array<{ type: string; payload?: unknown }>

  function makeRound5Runtime(
    submitTurn: (prompt: string, opts?: unknown) => AsyncGenerator<unknown>,
  ) {
    return {
      conversationStore: {
        getSessionMetadata: vi.fn(async () => ({})),
        updateSessionMetadata: vi.fn(async () => ({})),
        saveToolCallDetail: vi.fn(async () => {}),
      },
      engine: {
        boundSessionId: () => 'round5-test',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => [],
        setModelSelection: vi.fn(),
        getCurrentPermissionMode: () => 'default',
        setPermissionMode: vi.fn(),
        submitTurn,
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      options: { cwd: '/workspace' },
      getAppState: () => ({
        permissionRules: { bypassPermissionsModeDisabled: false },
      }),
      setAppState: vi.fn(),
    }
  }

  it('a pending user message survives a pre-stream turn failure', async () => {
    // Red-without: consumePendingAsNextSubmit only ran from markStreamEnd /
    // markToolEnd. A turn that died before its stream opened left the
    // message the user typed meanwhile stranded in pendingUserMessage until
    // some FUTURE turn's stream end.
    const emitted: Emitted = []
    const engineSubmit = vi.fn((prompt: string) => {
      if (prompt === 'one') {
        // Pre-stream failure: throws at generator-construction time.
        throw new Error('pre-stream failure')
      }
      return (async function* () {
        yield { type: 'assistant', message: { content: [] } }
      })()
    })
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message as { type: string; payload?: unknown })
      },
    })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound5Runtime(engineSubmit as never) as never,
    )
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'round5-test', cwd: '/workspace' } as never,
    })

    const p1 = worker.submitAndWait({
      type: 'worker.submitMessage',
      payload: { prompt: 'one' },
    } as never)
    // Turn 1 is dispatched (phase busy at dequeue) — this second submit
    // rides pendingUserMessage, not the queue.
    void worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: 'two' },
    } as never)

    const r1 = await p1
    expect(r1.status).toBe('failed')

    // The settle boundary must consume the pending message into a
    // follow-up turn.
    for (let i = 0; i < 50 && engineSubmit.mock.calls.length < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(
      engineSubmit.mock.calls.length,
      'the pending message must become the next turn',
    ).toBe(2)
    expect(engineSubmit.mock.calls[1]![0]).toBe('two')
    const pending = (
      worker as unknown as {
        turns: { getPendingMessage(): string | undefined }
      }
    ).turns.getPendingMessage()
    expect(pending).toBeUndefined()
  })

  it('a failing init reports worker_init_failed, keeps waiters unpoisoned, and stays recoverable', async () => {
    const emitted: Emitted = []
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message as { type: string; payload?: unknown })
      },
    })

    // Red-without: the rejection escaped as an unhandled rejection in the
    // Manager's fire-and-forget dispatch, no worker_init_failed was ever
    // reported, and the half-built scope was never disposed.
    vi.mocked(createAgentRuntime).mockRejectedValueOnce(
      new Error('boot failed'),
    )
    await expect(
      worker.receiveFrame({
        type: 'worker.init',
        payload: { sessionId: 'round5-init', cwd: '/workspace' } as never,
      }),
    ).rejects.toThrow('boot failed')
    const initError = emitted.find(
      m =>
        m.type === 'worker.error' &&
        (m.payload as { code?: string })?.code === 'worker_init_failed',
    )
    expect(initError, 'init failure must be reported').toBeDefined()

    // waitForInit parkers see the DEFINED not-initialized state, not a
    // rejected initPromise.
    const failedTurn = await worker.submitAndWait({
      type: 'worker.submitMessage',
      payload: { prompt: 'x' },
    } as never)
    expect(failedTurn.status).toBe('failed')
    expect(
      (failedTurn as { code?: string }).code,
      'submits against the failed init see worker_not_initialized',
    ).toBe('worker_not_initialized')

    // A later init recovers the worker.
    const engineSubmit = vi.fn(async function* () {
      yield { type: 'assistant', message: { content: [] } }
    })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound5Runtime(engineSubmit as never) as never,
    )
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'round5-init', cwd: '/workspace' } as never,
    })
    expect(emitted.some(m => m.type === 'worker.ready')).toBe(true)
    const recovered = await worker.submitAndWait({
      type: 'worker.submitMessage',
      payload: { prompt: 'y' },
    } as never)
    expect(recovered.status).toBe('completed')
  })
})

describe('explicit reinitialize results', () => {
  function makeRound6Runtime(overrides?: {
    getSessionMetadata?: () => Promise<unknown>
    messages?: unknown[]
  }) {
    return {
      conversationStore: {
        getSessionMetadata:
          overrides?.getSessionMetadata ?? vi.fn(async () => ({})),
        updateSessionMetadata: vi.fn(async () => ({})),
        saveToolCallDetail: vi.fn(async () => {}),
      },
      engine: {
        boundSessionId: () => 'round6-test',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => overrides?.messages ?? [],
        setModelSelection: vi.fn(),
        getCurrentPermissionMode: () => 'default',
        setPermissionMode: vi.fn(),
        submitTurn: async function* () {
          yield { type: 'assistant', message: { content: [] } }
        },
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      options: { cwd: '/workspace' },
      getAppState: () => ({
        permissionRules: { bypassPermissionsModeDisabled: false },
      }),
      setAppState: vi.fn(),
    }
  }

  it('reports ready on success, failed on a build throw, rejected on the busy/non-empty preflight', async () => {
    const worker = new AgentRuntimeWorker({ emit: () => {} })

    // Ready.
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound6Runtime() as never,
    )
    const ready = await worker.reinitialize({
      sessionId: 'round6-test',
      cwd: '/workspace',
    } as never)
    expect(ready.status).toBe('ready')

    // Rejected: a forceReinit against a NON-EMPTY session must not rebuild.
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound6Runtime({ messages: [{ type: 'user' }] }) as never,
    )
    await worker.reinitialize({
      sessionId: 'round6-test',
      cwd: '/workspace',
    } as never)
    const rejected = await worker.reinitialize({
      sessionId: 'round6-test',
      cwd: '/workspace',
      forceReinit: true,
    } as never)
    expect(rejected.status).toBe('rejected')

    // Failed: the runtime build throws. (The non-empty runtime above blocks
    // forceReinit, so this failure run is a PLAIN init.)
    vi.mocked(createAgentRuntime).mockRejectedValueOnce(
      new Error('boot failed'),
    )
    const failed = await worker.reinitialize({
      sessionId: 'round6-test',
      cwd: '/workspace',
    } as never)
    expect(failed.status).toBe('failed')
    expect((failed as { message?: string }).message).toBe('boot failed')
  })

  it('a superseded init reports superseded, never ready', async () => {
    const worker = new AgentRuntimeWorker({ emit: () => {} })

    // Init 1 parks inside its recovery block (metadata call 3 defers);
    // init 2 supersedes and completes. Init 1's runInit guards return
    // NORMALLY — the naive void resolve looked identical to success.
    let releaseMetadata: (() => void) | undefined
    let metadataCalls = 0
    const runtime1 = makeRound6Runtime({
      getSessionMetadata: () => {
        metadataCalls += 1
        if (metadataCalls === 3) {
          return new Promise(resolve => {
            releaseMetadata = () => resolve({})
          })
        }
        return Promise.resolve({})
      },
    })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime1 as never)
    const first = worker.reinitialize({
      sessionId: 'round6-test',
      cwd: '/workspace',
    } as never)
    for (let i = 0; i < 50 && !releaseMetadata; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(releaseMetadata, 'init 1 must be parked in recovery').toBeDefined()

    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound6Runtime() as never,
    )
    const second = await worker.reinitialize({
      sessionId: 'round6-test',
      cwd: '/workspace',
    } as never)
    expect(second.status).toBe('ready')

    releaseMetadata?.()
    const firstResult = await first
    expect(
      firstResult.status,
      'the superseded init must not report ready',
    ).toBe('superseded')
  })
})

describe('bind metadata from the effective payload', () => {
  function makeRound7Runtime() {
    return {
      conversationStore: {
        getSessionMetadata: vi.fn(async () => ({})),
        updateSessionMetadata: vi.fn(async () => ({})),
        saveToolCallDetail: vi.fn(async () => {}),
      },
      engine: {
        boundSessionId: () => 'round7-test',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => [],
        setModelSelection: vi.fn(),
        getCurrentPermissionMode: () => 'default',
        setPermissionMode: vi.fn(),
        submitTurn: async function* () {
          yield { type: 'assistant', message: { content: [] } }
        },
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      options: { cwd: '/workspace' },
      getAppState: () => ({
        permissionRules: { bypassPermissionsModeDisabled: false },
      }),
      setAppState: vi.fn(),
    }
  }

  it('binds the resume-restored projectRoot, not the raw payload value', async () => {
    // resolveResumeProjectRoot recovers the bound folder from the persisted
    // summary when the page's payload lost it — the runtime is BUILT from
    // that effective payload, so the host bind must persist the same value.
    // Red-without: the bind passed the RAW payload's (undefined) projectRoot
    // while the runtime ran in the restored folder — recreating the exact
    // Manager-says-A-store-says-B split the init metadata exists to close.
    const bindMetas: Array<
      { templateType?: string; projectRoot?: string } | undefined
    > = []
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      host: {
        broadcastBootStage: () => {},
        bindSessionRuntime: (
          _sessionId: string,
          _store: unknown,
          initMeta?: { templateType?: string; projectRoot?: string },
        ) => {
          bindMetas.push(initMeta)
        },
        setModel: () => {},
      } as never,
      conversationStorageBackend: {
        loadSessionSummary: async () => ({
          sessionId: 'round7-test',
          updatedAt: 1,
          messageCount: 1,
          firstPrompt: 'hi',
          previewText: 'hi',
          projectRoot: '/resumed/folder',
        }),
      } as never,
    })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound7Runtime() as never,
    )
    const result = await worker.reinitialize({
      sessionId: 'round7-test',
      cwd: '/workspace',
      templateType: 'code',
    } as never)
    expect(result.status).toBe('ready')
    expect(bindMetas).toHaveLength(1)
    expect(bindMetas[0]?.projectRoot).toBe('/resumed/folder')
    expect(bindMetas[0]?.templateType).toBe('code')
  })
})

describe('bridge generation ownership + sidecar best-effort', () => {
  function makeRound8Runtime(overrides?: {
    saveToolCallDetail?: () => Promise<void>
    submitTurn?: () => AsyncGenerator<unknown>
  }) {
    return {
      conversationStore: {
        getSessionMetadata: vi.fn(async () => ({})),
        updateSessionMetadata: vi.fn(async () => ({})),
        saveToolCallDetail:
          overrides?.saveToolCallDetail ?? vi.fn(async () => {}),
      },
      engine: {
        boundSessionId: () => 'round8-test',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => [],
        setModelSelection: vi.fn(),
        getCurrentPermissionMode: () => 'default',
        setPermissionMode: vi.fn(),
        submitTurn:
          overrides?.submitTurn ??
          (async function* () {
            yield { type: 'assistant', message: { content: [] } }
          }),
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      options: { cwd: '/workspace' },
      getAppState: () => ({
        permissionRules: { bypassPermissionsModeDisabled: false },
      }),
      setAppState: vi.fn(),
    }
  }

  it('a superseded scope teardown settles ITS pending bridge requests; the new scope keeps its own', async () => {
    const worker = new AgentRuntimeWorker({ emit: () => {} })
    const transport = (
      worker as unknown as {
        bridgeTransport: {
          request(req: unknown): Promise<unknown>
          settleReply(res: unknown): void
        }
      }
    ).bridgeTransport

    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound8Runtime() as never,
    )
    await worker.reinitialize({
      sessionId: 'round8-test',
      cwd: '/workspace',
    } as never)

    // Issued while generation 1 is current → belongs to generation 1.
    const staleRequest = transport.request({
      id: 'r8-gen1-req',
      route: { namespace: 'nexus', capability: 'fs', action: 'cwd' },
      payload: {},
    })
    // Pre-attach so the sweep's rejection can't hit the process-level
    // unhandled hook before the assertion consumes it.
    const staleOutcome = staleRequest.then(
      () => 'resolved' as const,
      (error: unknown) => (error as { name?: string }).name ?? 'rejected',
    )

    // Reinit → generation 2. The detached generation-1 scope's dispose must
    // settle the parked request.
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound8Runtime() as never,
    )
    await worker.reinitialize({
      sessionId: 'round8-test',
      cwd: '/workspace',
    } as never)
    expect(await staleOutcome).toBe('AbortError')

    // A generation-2 request survives that sweep and resolves normally.
    const liveRequest = transport.request({
      id: 'r8-gen2-req',
      route: { namespace: 'nexus', capability: 'fs', action: 'cwd' },
      payload: {},
    })
    transport.settleReply({ id: 'r8-gen2-req', ok: true, result: {} })
    await expect(liveRequest).resolves.toMatchObject({ ok: true })

    // Worker dispose settles everything still pending.
    const finalRequest = transport.request({
      id: 'r8-final-req',
      route: { namespace: 'nexus', capability: 'fs', action: 'cwd' },
      payload: {},
    })
    const finalOutcome = finalRequest.then(
      () => 'resolved' as const,
      (error: unknown) => (error as { name?: string }).name ?? 'rejected',
    )
    await worker.dispose()
    expect(await finalOutcome).toBe('AbortError')
  })

  it('a failing tool-detail sidecar write does not fail the model turn', async () => {
    // Red-without: the stream loop AWAITS persistStreamDetails inside the
    // turn's try — one rejected sidecar write became worker_submit_failed
    // and the whole turn reported failed.
    const runtime = makeRound8Runtime({
      saveToolCallDetail: async () => {
        throw new Error('sidecar disk full')
      },
      submitTurn: async function* () {
        yield {
          type: 'assistant',
          message: { content: [] },
          toolCallDetail: { toolCallId: 'tc-r8', toolName: 'Read' },
        }
      },
    })
    const worker = new AgentRuntimeWorker({ emit: () => {} })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    await worker.reinitialize({
      sessionId: 'round8-test',
      cwd: '/workspace',
    } as never)

    const result = await worker.submitAndWait({
      type: 'worker.submitMessage',
      payload: { prompt: 'hello' },
    } as never)
    expect(
      result.status,
      'a display-aid persistence failure must not fail the turn',
    ).toBe('completed')
    await worker.dispose()
  })

  it('a turn that cleared the conversation and then failed still sends the page the transcript as it stands', async () => {
    let epoch = 0
    const runtime = makeRound8Runtime({
      submitTurn: (async function* (prompt: unknown) {
        // `/clear` went through, then something after it threw.
        if (prompt === '/clear') epoch += 1
        yield { type: 'assistant', message: { content: [] } }
        throw new Error('persist failed')
      }) as () => AsyncGenerator<unknown>,
    })
    const engine = runtime.engine as Record<string, unknown>
    engine.getConversationEpoch = () => epoch
    const emitted: Array<{ type: string }> = []
    const worker = new AgentRuntimeWorker({ emit: m => emitted.push(m as { type: string }) })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    await worker.reinitialize({ sessionId: 'round8-test', cwd: '/workspace' } as never)
    const pushes = () => emitted.filter(m => m.type === 'worker.messages').length
    const before = pushes()

    const result = await worker.submitAndWait({
      type: 'worker.submitMessage',
      payload: { prompt: '/clear' },
    } as never)
    expect(result.status).toBe('failed')
    await vi.waitFor(() => expect(pushes()).toBe(before + 1))

    // A failed turn that did not clear sends nothing extra.
    const again = await worker.submitAndWait({
      type: 'worker.submitMessage',
      payload: { prompt: 'hello' },
    } as never)
    expect(again.status).toBe('failed')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(pushes()).toBe(before + 1)
    await worker.dispose()
  })

  it('marks only a mailbox-delivered turn with origin mailbox', async () => {
    // Red-without: nothing told a delivered team frame apart from a user turn
    // with the same text, so the transcript rendered any user-typed
    // `[message from X]: …` as a teammate's card. The marker comes from the
    // queue source the runtime chose, never from the submit payload.
    const seen: Array<{ origin?: unknown } | undefined> = []
    const runtime = makeRound8Runtime({
      submitTurn: async function* (_prompt?: unknown, options?: { origin?: unknown }) {
        seen.push(options)
        yield { type: 'assistant', message: { content: [] } }
      },
    })
    const worker = new AgentRuntimeWorker({ emit: () => {} })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    await worker.reinitialize({
      sessionId: 'round8-test',
      cwd: '/workspace',
    } as never)

    await worker.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: '[message from a]: hi' } } as never,
      'mailbox',
    )
    await worker.submitAndWait(
      { type: 'worker.submitMessage', payload: { prompt: '[message from a]: hi' } } as never,
    )
    expect(seen.map(options => options?.origin)).toEqual(['mailbox', undefined])
    await worker.dispose()
  })

  it('publishes a settled (not busy) snapshot to its clients', async () => {
    // Red-without: the only non-busy snapshot a client ever gets for a turn
    // is `worker.completed`. A turn that failed AFTER its stream had ended
    // (the engine's terminal-state meta write rejecting under
    // load) found the phase already idle, so nothing else was emitted either:
    // the page kept `isBusy: true` from the turn's start - Stop showing and
    // the composer locked - until some unrelated later turn.
    const emitted: Array<{ type: string; payload?: { isBusy?: boolean } }> = []
    let worker!: AgentRuntimeWorker
    const runtime = makeRound8Runtime({
      submitTurn: async function* () {
        worker.markStreamStart()
        yield { type: 'assistant', message: { content: [] } }
        worker.markStreamEnd()
        throw new Error('SQLITE_ERROR: database is locked')
      },
    })
    worker = new AgentRuntimeWorker({ emit: m => emitted.push(m as never) })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    await worker.reinitialize({
      sessionId: 'round8-test',
      cwd: '/workspace',
    } as never)
    emitted.length = 0

    const result = await worker.submitAndWait({
      type: 'worker.submitMessage',
      payload: { prompt: 'hello' },
    } as never)
    await Promise.resolve()
    expect(result.status).toBe('failed')
    const snapshots = emitted.filter(
      m => m.type === 'worker.state' || m.type === 'worker.completed',
    )
    expect(snapshots.some(m => m.payload?.isBusy === true)).toBe(true)
    expect(
      snapshots.at(-1)?.payload?.isBusy,
      'the last snapshot a client sees after the failure is not busy',
    ).toBe(false)
    await worker.dispose()
  })
})

describe('init commit barrier', () => {
  function makeRound9Runtime() {
    return {
      conversationStore: {
        getSessionMetadata: vi.fn(async () => ({})),
        updateSessionMetadata: vi.fn(async () => ({})),
        saveToolCallDetail: vi.fn(async () => {}),
      },
      engine: {
        boundSessionId: () => 'round9-test',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => [],
        setModelSelection: vi.fn(),
        getCurrentPermissionMode: () => 'default',
        setPermissionMode: vi.fn(),
        submitTurn: async function* () {
          yield { type: 'assistant', message: { content: [] } }
        },
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      options: { cwd: '/workspace' },
      getAppState: () => ({
        permissionRules: { bypassPermissionsModeDisabled: false },
      }),
      setAppState: vi.fn(),
    }
  }

  it('ready WAITS for the critical bind and reports bindPersisted + effectiveInit', async () => {
    // Red-without: the bind was fire-and-forget — reinitialize resolved
    // ready while the host's critical metadata write was still an
    // in-flight best-effort background task, so the Manager committed
    // routing (and deleted the old-dir stub) against a store that might
    // never record its projectRoot.
    let releaseBind: ((persisted: boolean) => void) | undefined
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      host: {
        broadcastBootStage: () => {},
        bindSessionRuntime: () =>
          new Promise<boolean>(resolve => {
            releaseBind = resolve
          }),
        setModel: () => {},
      } as never,
      conversationStorageBackend: {
        loadSessionSummary: async () => ({
          sessionId: 'round9-test',
          updatedAt: 1,
          messageCount: 1,
          firstPrompt: 'hi',
          previewText: 'hi',
          projectRoot: '/resumed/folder',
        }),
      } as never,
    })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound9Runtime() as never,
    )
    const pending = worker.reinitialize({
      sessionId: 'round9-test',
      cwd: '/workspace',
      templateType: 'code',
    } as never)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    for (let i = 0; i < 50 && !releaseBind; i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(releaseBind, 'the init must reach the bind').toBeDefined()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled, 'ready must wait for the critical bind').toBe(false)

    // The host reports the critical write FAILED — ready still returns
    // (the runtime is live) but carries the outcome, plus the effective
    // init slice the runtime was actually built from.
    releaseBind!(false)
    const result = await pending
    expect(result.status).toBe('ready')
    expect(
      (result as { bindPersisted?: boolean }).bindPersisted,
      'a failed critical write must be reported on ready',
    ).toBe(false)
    expect(
      (result as { effectiveInit?: { projectRoot?: string } }).effectiveInit
        ?.projectRoot,
    ).toBe('/resumed/folder')
    await worker.dispose()
  })

  it('a stale scope late bridge request cannot ride the successor generation', async () => {
    const worker = new AgentRuntimeWorker({ emit: () => {} })

    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound9Runtime() as never,
    )
    await worker.reinitialize({
      sessionId: 'round10-test',
      cwd: '/workspace',
    } as never)
    // The transport view scope 1's runtime was built with — the exact
    // handle a stale closure inside that scope would still hold.
    const staleScopedTransport = (
      vi.mocked(createAgentRuntime).mock.calls.at(-1)![0] as {
        bridgeTransport: {
          request(req: unknown): Promise<unknown>
        }
      }
    ).bridgeTransport

    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound9Runtime() as never,
    )
    await worker.reinitialize({
      sessionId: 'round10-test',
      cwd: '/workspace',
    } as never)

    // A late continuation of the DISPOSED scope 1 issues a request. Red-
    // without: the shared transport tagged it with the AMBIENT generation
    // (now 2), so scope 1's sweep missed it and it parked forever — the
    // race below reported 'pending'.
    const staleRequest = staleScopedTransport.request({
      id: 'r10-stale-req',
      route: { namespace: 'nexus', capability: 'fs', action: 'cwd' },
      payload: {},
    })
    const outcome = await Promise.race([
      staleRequest.then(
        () => 'resolved' as const,
        (error: unknown) => (error as { name?: string }).name ?? 'rejected',
      ),
      new Promise<string>(resolve =>
        setTimeout(() => resolve('pending'), 50),
      ),
    ])
    expect(outcome).toBe('AbortError')

    // The live scope's view still works.
    const liveScopedTransport = (
      vi.mocked(createAgentRuntime).mock.calls.at(-1)![0] as {
        bridgeTransport: { request(req: unknown): Promise<unknown> }
      }
    ).bridgeTransport
    const liveRequest = liveScopedTransport.request({
      id: 'r10-live-req',
      route: { namespace: 'nexus', capability: 'fs', action: 'cwd' },
      payload: {},
    })
    const core = (
      worker as unknown as {
        bridgeTransport: { settleReply(res: unknown): void }
      }
    ).bridgeTransport
    core.settleReply({ id: 'r10-live-req', ok: true, result: {} })
    await expect(liveRequest).resolves.toMatchObject({ ok: true })
    await worker.dispose()
  })

  it('a bind that resolves void (legacy hosts, mocks) counts as persisted', async () => {
    const worker = new AgentRuntimeWorker({
      emit: () => {},
      host: {
        broadcastBootStage: () => {},
        bindSessionRuntime: () => {},
        setModel: () => {},
      } as never,
    })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(
      makeRound9Runtime() as never,
    )
    const result = await worker.reinitialize({
      sessionId: 'round9-test',
      cwd: '/workspace',
    } as never)
    expect(result.status).toBe('ready')
    expect(
      (result as { bindPersisted?: boolean }).bindPersisted,
    ).not.toBe(false)
    await worker.dispose()
  })

  describe('reconnect call-model gate', () => {
    afterEach(() => {
      setCallModelEmitter(undefined)
      setCallModelLogEnabled(false)
    })

    it('applyDiagnosticGates toggles the call-model lease on a REUSED worker', async () => {
      const debugLines: string[] = []
      const worker = new AgentRuntimeWorker({
        emit: message => {
          if (message.type === 'worker.debugLog') {
            debugLines.push(
              (message.payload as { message: string }).message,
            )
          }
        },
      })
      // First boot WITHOUT the flag.
      vi.mocked(createAgentRuntime).mockResolvedValueOnce(
        makeRound9Runtime() as never,
      )
      await worker.reinitialize({
        sessionId: 'round12-test',
        cwd: '/workspace',
      } as never)
      expect(isCallModelLogEnabled()).toBe(false)

      // Reload adds ?logCallModel=1 → the Manager's reuse path only calls
      // applyDiagnosticGates (runInit never re-runs). Red-without: the
      // gate handled traceModelRequests only, so the flag was silently
      // ignored and no call-model logs ever flowed.
      worker.applyDiagnosticGates({
        cwd: '/workspace',
        logCallModel: true,
      } as never)
      expect(isCallModelLogEnabled()).toBe(true)
      logCallModelEvent('reuse-evt', { n: 1 })
      expect(debugLines.some(line => line.includes('reuse-evt'))).toBe(true)

      // The reverse reload (flag removed) releases the lease.
      worker.applyDiagnosticGates({ cwd: '/workspace' } as never)
      expect(isCallModelLogEnabled()).toBe(false)

      // And a scope teardown releases a still-held lease.
      worker.applyDiagnosticGates({
        cwd: '/workspace',
        logCallModel: true,
      } as never)
      expect(isCallModelLogEnabled()).toBe(true)
      await worker.dispose()
      expect(isCallModelLogEnabled()).toBe(false)
    })
  })
})

// ============================================================================
// UI-ready split (worker.uiReady): the provisional boot feed published from
// inside createAgentRuntime BEFORE the MCP connect + engine build, so the
// page can render the restored transcript while the build finishes.
// ============================================================================

describe('AgentRuntimeWorker — UI-ready split', () => {
  afterEach(() => vi.restoreAllMocks())

  function transcriptOf(n: number): Message[] {
    return Array.from({ length: n }, (_unused, i) => ({
      type: 'user',
      uuid: `u${i}`,
      message: { role: 'user', content: `msg ${i}` },
    })) as unknown as Message[]
  }

  function uiReadyInfo(messages: Message[]) {
    return {
      sessionId: 'split-1',
      cwd: '/workspace',
      projectRoot: '/workspace',
      usedSandboxProjectRoot: false,
      hostMode: 'nexus',
      messages,
    }
  }

  function splitFakeRuntime(messages: Message[]) {
    return {
      engine: {
        boundSessionId: () => 'split-1',
        getCurrentModel: () => 'test-model',
        getCurrentProviderId: () => 'test-provider',
        transcriptRows: () => messages,
        getCurrentPermissionMode: () => 'default',
        applyRuntimeSettings: vi.fn(),
        dispose: vi.fn(async () => {}),
      },
      conversationStore: {
        getSessionMetadata: vi.fn(async () => ({})),
        updateSessionMetadata: vi.fn(async () => {}),
        saveToolCallDetail: vi.fn(async () => {}),
        getToolCallDetail: vi.fn(async () => null),
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      usedSandboxProjectRoot: false,
      options: { cwd: '/workspace', hostMode: 'nexus' },
      getAppState: () => ({}),
      setAppState: vi.fn(),
    }
  }

  type Emitted = { type: string; payload?: Record<string, unknown> }

  it('a rewrite outside the stream (a plugin compacting or appending) republishes the whole transcript: at once when idle, held while a submission runs', async () => {
    const emitted: Emitted[] = []
    const worker = new AgentRuntimeWorker({
      emit: m => emitted.push(m as Emitted),
    })
    const messages = transcriptOf(3)
    let rewritten: (() => void) | undefined
    vi.mocked(createAgentRuntime).mockImplementationOnce(async () => {
      const runtime = splitFakeRuntime(messages)
      return {
        ...runtime,
        engine: {
          ...runtime.engine,
          setConversationRewrittenListener: (listener: () => void) => {
            rewritten = listener
          },
        },
      } as never
    })
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'split-1', cwd: '/workspace' } as never,
    })
    expect(rewritten).toBeDefined()

    const pushes = () => emitted.filter(m => m.type === 'worker.messages').length
    const before = pushes()
    rewritten!()
    await vi.waitFor(() => expect(pushes()).toBe(before + 1))
    expect((emitted.filter(m => m.type === 'worker.messages').at(-1)!.payload as { messages: unknown[] }).messages).toHaveLength(3)

    // Mid-submission the stream's end owes it: nothing goes out now.
    const cast = worker as unknown as { executingTurn: boolean; transcriptRewrittenInTurn: boolean }
    cast.executingTurn = true
    rewritten!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(pushes()).toBe(before + 1)
    expect(cast.transcriptRewrittenInTurn).toBe(true)
  })

  it('publishes worker.uiReady + a worker.messages push before worker.ready, and mid-build snapshots carry the provisional feed', async () => {
    const emitted: Emitted[] = []
    const worker = new AgentRuntimeWorker({
      emit: m => emitted.push(m as Emitted),
    })
    const messages = transcriptOf(2)

    // Gate the build AFTER onUiReady fires (simulating the MCP connect +
    // engine build window) so the mid-build state is observable.
    let releaseBuild!: () => void
    const buildGate = new Promise<void>(resolve => {
      releaseBuild = resolve
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(async opts => {
      const options = opts as unknown as {
        onUiReady?: (info: ReturnType<typeof uiReadyInfo>) => void
      }
      options.onUiReady?.(uiReadyInfo(messages))
      await buildGate
      return splitFakeRuntime(messages) as never
    })

    const init = worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'split-1', cwd: '/workspace' } as never,
    })

    // The one-shot pair lands while the build is still parked on the gate.
    await vi.waitFor(() => {
      expect(emitted.some(m => m.type === 'worker.uiReady')).toBe(true)
    })
    const uiReadyIndex = emitted.findIndex(m => m.type === 'worker.uiReady')
    const messagesIndex = emitted.findIndex(m => m.type === 'worker.messages')
    expect(messagesIndex).toBeGreaterThan(uiReadyIndex)
    expect(emitted.some(m => m.type === 'worker.ready')).toBe(false)

    const uiReadySnapshot = emitted[uiReadyIndex]!.payload as {
      initialized: boolean
      uiReady?: boolean
      sessionId?: string
      cwd?: string
      projectRoot?: string
      messageCount: number
      canPickProjectFolder?: boolean
    }
    expect(uiReadySnapshot.initialized).toBe(false)
    expect(uiReadySnapshot.uiReady).toBe(true)
    expect(uiReadySnapshot.sessionId).toBe('split-1')
    expect(uiReadySnapshot.cwd).toBe('/workspace')
    expect(uiReadySnapshot.projectRoot).toBe('/workspace')
    expect(uiReadySnapshot.messageCount).toBe(2)
    expect(uiReadySnapshot.canPickProjectFolder).toBe(true)
    expect(
      (emitted[messagesIndex]!.payload as { messages: unknown[] }).messages,
    ).toHaveLength(2)

    // A snapshot built DURING the window (any worker.state emission would use
    // this) still carries the provisional feed — this is what prevents the
    // skeleton regression when e.g. a parked submit flips the phase.
    const midBuild = worker.getSnapshot()
    expect(midBuild.uiReady).toBe(true)
    expect(midBuild.messageCount).toBe(2)

    // The replay feed for a port attaching mid-build.
    const feed = worker.getProvisionalBootFeed()
    expect(feed).not.toBeNull()
    expect(feed!.messages).toHaveLength(2)
    expect(feed!.snapshot.uiReady).toBe(true)

    // Build completes: worker.ready is the commit barrier; the provisional
    // feed is dropped and the real snapshot takes over.
    releaseBuild()
    await init
    const ready = emitted.find(m => m.type === 'worker.ready')
    expect(ready).toBeDefined()
    const readySnapshot = ready!.payload as {
      initialized: boolean
      uiReady?: boolean
    }
    expect(readySnapshot.initialized).toBe(true)
    expect(readySnapshot.uiReady).toBeUndefined()
    expect(worker.getProvisionalBootFeed()).toBeNull()
    expect(worker.getSnapshot().uiReady).toBeUndefined()
  })

  it("stamps transcript lines from the session's OWN store, not the process-global slot", async () => {
    // The global `getConversationStore()` slot names whichever runtime was
    // built LAST in the shared realm. Another session built after this one
    // left it pointing at a store that knows none of these uuids, so every
    // message went out without `transcriptLine` and a search jump to the
    // user bubble ended `quiet`.
    const { setConversationStore, clearConversationStore } = await import(
      '../sessions/sessionStore'
    )
    const otherSessionStore = {
      getTranscriptLinesByUuid: vi.fn(async () => ({})),
    }
    const ownStore = {
      getTranscriptLinesByUuid: vi.fn(async () => ({ u0: 3, u1: 7 })),
    }
    const emitted: Emitted[] = []
    const worker = new AgentRuntimeWorker({
      emit: m => emitted.push(m as Emitted),
    })
    const messages = transcriptOf(2)
    vi.mocked(createAgentRuntime).mockImplementationOnce(async opts => {
      const options = opts as unknown as {
        onUiReady?: (info: Record<string, unknown>) => void
      }
      // Another session's build takes the global slot first.
      setConversationStore(otherSessionStore as never)
      options.onUiReady?.({
        ...uiReadyInfo(messages),
        conversationStore: ownStore,
      })
      const runtime = splitFakeRuntime(messages)
      return {
        ...runtime,
        conversationStore: { ...runtime.conversationStore, ...ownStore },
      } as never
    })
    try {
      await worker.receiveFrame({
        type: 'worker.init',
        payload: { sessionId: 'split-1', cwd: '/workspace' } as never,
      })
      const linesOf = () =>
        emitted
          .filter(m => m.type === 'worker.messages')
          .map(m =>
            (m.payload as { messages: { transcriptLine?: number }[] }).messages
              .map(message => message.transcriptLine ?? null),
          )
      // The provisional boot push.
      await vi.waitFor(() => expect(linesOf()).toContainEqual([3, 7]))

      emitted.length = 0
      await worker.receiveFrame({ type: 'worker.getMessages' } as never)
      expect(linesOf()).toEqual([[3, 7]])
      expect(otherSessionStore.getTranscriptLinesByUuid).not.toHaveBeenCalled()
    } finally {
      clearConversationStore()
      await worker.dispose()
    }
  })

  it('does not wire onUiReady for sub-agent or headless builds', async () => {
    for (const extra of [{ isSubAgent: true }, { isHeadless: true }]) {
      const worker = new AgentRuntimeWorker({ emit: () => {} })
      let seenOnUiReady: unknown = 'unset'
      vi.mocked(createAgentRuntime).mockImplementationOnce(async opts => {
        seenOnUiReady = (opts as unknown as { onUiReady?: unknown }).onUiReady
        return splitFakeRuntime([]) as never
      })
      await worker.receiveFrame({
        type: 'worker.init',
        payload: { sessionId: 's', cwd: '/workspace', ...extra } as never,
      })
      expect(seenOnUiReady).toBeUndefined()
    }
  })

  it('a superseded build cannot publish a provisional feed into the successor scope', async () => {
    const emitted: Emitted[] = []
    const worker = new AgentRuntimeWorker({
      emit: m => emitted.push(m as Emitted),
    })

    // Build A parks BEFORE calling onUiReady; build B (the successor)
    // completes first. When A finally fires its stale onUiReady, the scope
    // guard must drop it.
    let releaseA!: () => void
    const gateA = new Promise<void>(resolve => {
      releaseA = resolve
    })
    let staleOnUiReady:
      | ((info: ReturnType<typeof uiReadyInfo>) => void)
      | undefined
    vi.mocked(createAgentRuntime)
      .mockImplementationOnce(async opts => {
        staleOnUiReady = (
          opts as unknown as {
            onUiReady?: (info: ReturnType<typeof uiReadyInfo>) => void
          }
        ).onUiReady
        await gateA
        return splitFakeRuntime([]) as never
      })
      .mockImplementationOnce(async () => splitFakeRuntime([]) as never)

    const initA = worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'split-1', cwd: '/workspace' } as never,
    })
    await vi.waitFor(() => expect(staleOnUiReady).toBeDefined())
    const initB = worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'split-1', cwd: '/workspace' } as never,
    })
    await initB

    emitted.length = 0
    staleOnUiReady!(uiReadyInfo(transcriptOf(3)))
    expect(emitted.some(m => m.type === 'worker.uiReady')).toBe(false)
    // The successor's (initialized) snapshot is untouched.
    expect(worker.getSnapshot().initialized).toBe(true)
    expect(worker.getSnapshot().uiReady).toBeUndefined()

    releaseA()
    await initA
  })

  it('a submit during the provisional window is HELD and runs once the build lands', async () => {
    // The user can type and send the moment the splash is gone — while the
    // MCP connect + engine build are still running. The turn must park on
    // waitForInit (never fail with worker_not_initialized, never race a
    // half-built engine) and execute when the runtime installs. The
    // Continue button and the error card's Retry ride this same
    // worker.submitMessage route, so this pins the whole family.
    const emitted: Emitted[] = []
    const worker = new AgentRuntimeWorker({
      emit: m => emitted.push(m as Emitted),
    })
    const messages = transcriptOf(1)
    const engineSubmit = vi.fn(async function* () {
      // no events — an immediately-completing turn
    })
    let releaseBuild!: () => void
    const buildGate = new Promise<void>(resolve => {
      releaseBuild = resolve
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(async opts => {
      const options = opts as unknown as {
        onUiReady?: (info: ReturnType<typeof uiReadyInfo>) => void
      }
      options.onUiReady?.(uiReadyInfo(messages))
      await buildGate
      const runtime = splitFakeRuntime(messages)
      ;(runtime.engine as Record<string, unknown>).submitTurn = engineSubmit
      return runtime as never
    })

    const init = worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'split-1', cwd: '/workspace' } as never,
    })
    await vi.waitFor(() => {
      expect(emitted.some(m => m.type === 'worker.uiReady')).toBe(true)
    })

    // Submit while the build is parked on the gate.
    void worker.receiveFrame({
      type: 'worker.submitMessage',
      payload: { prompt: 'held hello' } as never,
    })
    // Give the queue/pump microtasks room: the turn must be parked, not run.
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(engineSubmit).not.toHaveBeenCalled()
    expect(
      emitted.some(
        m =>
          m.type === 'worker.error' &&
          (m.payload as { code?: string }).code === 'worker_not_initialized',
      ),
    ).toBe(false)

    releaseBuild()
    await init
    await vi.waitFor(() => expect(engineSubmit).toHaveBeenCalledTimes(1))
    expect(
      emitted.some(
        m =>
          m.type === 'worker.error' &&
          (m.payload as { code?: string }).code === 'worker_not_initialized',
      ),
    ).toBe(false)
  })

  it('a tool-detail fetch during the provisional window is answered from the early store', async () => {
    const emitted: Emitted[] = []
    const worker = new AgentRuntimeWorker({
      emit: m => emitted.push(m as Emitted),
    })
    const detail = {
      toolCallId: 'tc-1',
      toolName: 'Bash',
      args: { command: 'ls' },
      result: { ok: true },
    }
    const earlyStore = splitFakeRuntime(transcriptOf(1)).conversationStore
    earlyStore.getToolCallDetail = vi.fn(async () => detail) as never
    let releaseBuild!: () => void
    const buildGate = new Promise<void>(resolve => {
      releaseBuild = resolve
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(async opts => {
      const options = opts as unknown as {
        onUiReady?: (info: ReturnType<typeof uiReadyInfo> & { conversationStore: unknown }) => void
      }
      options.onUiReady?.({ ...uiReadyInfo(transcriptOf(1)), conversationStore: earlyStore })
      await buildGate
      return splitFakeRuntime(transcriptOf(1)) as never
    })

    const init = worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'split-1', cwd: '/workspace' } as never,
    })
    await vi.waitFor(() => {
      expect(emitted.some(m => m.type === 'worker.uiReady')).toBe(true)
    })

    await worker.receiveFrame({
      type: 'worker.getToolCallDetail',
      payload: { toolCallId: 'tc-1' } as never,
    })
    // Answered while the build is still held.
    expect(emitted.some(m => m.type === 'worker.ready')).toBe(false)
    const reply = emitted.find(m => m.type === 'worker.toolCallDetail')
    expect(
      (reply!.payload as { detail: { toolCallId?: string } | null }).detail
        ?.toolCallId,
    ).toBe('tc-1')

    releaseBuild()
    await init
  })

  describe('change digest under the early transcript view', () => {
    const snapshotTurn = (finalized: boolean) => ({
      turnSeq: 1,
      promptPreview: 'write it',
      startedAt: 1_000,
      finalized,
      files: [
        {
          displayPath: '/ws/new.ts',
          kind: 'text',
          hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }],
          fileWasCreated: true,
          isDeleted: false,
          plusLines: 1,
          minusLines: 0,
        },
      ],
    })

    function digestStore() {
      let metadata: Record<string, unknown> = {}
      const updateSessionMetadata = vi.fn(async (patch: Record<string, unknown>) => {
        metadata = { ...metadata, ...patch }
        return metadata
      })
      return {
        store: {
          getSessionId: () => 'split-1',
          getSessionMetadata: vi.fn(async () => metadata),
          updateSessionMetadata,
          saveToolCallDetail: vi.fn(async () => {}),
          getToolCallDetail: vi.fn(async () => null),
        },
        digest: () => metadata.sessionChanges,
        updateSessionMetadata,
      }
    }

    async function bootHeld(
      store: ReturnType<typeof digestStore>['store'],
      recorder: unknown,
    ) {
      const emitted: Emitted[] = []
      const worker = new AgentRuntimeWorker({
        emit: m => emitted.push(m as Emitted),
      })
      let releaseBuild!: () => void
      const buildGate = new Promise<void>(resolve => {
        releaseBuild = resolve
      })
      vi.mocked(createAgentRuntime).mockImplementationOnce(async opts => {
        const options = opts as unknown as {
          onUiReady?: (info: Record<string, unknown>) => void
        }
        options.onUiReady?.({
          ...uiReadyInfo(transcriptOf(2)),
          conversationStore: store,
          fileSnapshotRecorder: recorder,
        })
        await buildGate
        // The built runtime carries the same store and recorder instances.
        return {
          ...splitFakeRuntime(transcriptOf(2)),
          conversationStore: store,
          fileSnapshotRecorder: recorder,
        } as never
      })
      const init = worker.receiveFrame({
        type: 'worker.init',
        payload: { sessionId: 'split-1', cwd: '/workspace' } as never,
      })
      await vi.waitFor(() => {
        expect(emitted.some(m => m.type === 'worker.uiReady')).toBe(true)
      })
      return { worker, emitted, init, releaseBuild }
    }

    const settle = async () => {
      for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0))
    }

    it('a digest stored before the build is the one the built runtime keeps', async () => {
      const { store, digest, updateSessionMetadata } = digestStore()
      const recorder = {
        getTurnDiffs: vi.fn(async () => [snapshotTurn(true)]),
        getSessionTotalDiffs: async () => [],
        recoverUnfinalized: vi.fn(async () => {}),
      }
      const { worker, emitted, init, releaseBuild } = await bootHeld(store, recorder)

      await worker.receiveFrame({ type: 'worker.getTurnDiffHistory' } as never)
      await settle()
      expect(emitted.some(m => m.type === 'worker.ready')).toBe(false)
      const early = digest()
      expect(early).toMatchObject({ sessionId: 'split-1', fingerprint: '2:u1' })
      expect(updateSessionMetadata).toHaveBeenCalledTimes(1)

      releaseBuild()
      await init
      await worker.receiveFrame({ type: 'worker.getTurnDiffHistory' } as never)
      await worker.receiveFrame({ type: 'worker.getMessages' } as never)
      await settle()
      // Built, the same transcript and snapshots describe the same digest:
      // nothing is rewritten.
      expect(digest()).toEqual(early)
      expect(updateSessionMetadata).toHaveBeenCalledTimes(1)
    })

    it('an unrecovered snapshot turn stores no digest before the build', async () => {
      const { store, updateSessionMetadata } = digestStore()
      let finalized = false
      const recorder = {
        getTurnDiffs: vi.fn(async () => [snapshotTurn(finalized)]),
        getSessionTotalDiffs: async () => [],
        recoverUnfinalized: vi.fn(async () => {
          finalized = true
        }),
      }
      const { worker, emitted, init, releaseBuild } = await bootHeld(store, recorder)

      await worker.receiveFrame({ type: 'worker.getTurnDiffHistory' } as never)
      await settle()
      expect(emitted.some(m => m.type === 'worker.turnDiffHistory')).toBe(true)
      expect(updateSessionMetadata).not.toHaveBeenCalled()

      releaseBuild()
      await init
      await settle()
      expect(recorder.recoverUnfinalized).toHaveBeenCalledTimes(1)
      // Recovery recomputes the history it changed, which stores the digest.
      await vi.waitFor(() => {
        expect(updateSessionMetadata).toHaveBeenCalledTimes(1)
      })
    })
  })

  it('getMessages and getMessagesSince during the provisional window answer from the early transcript', async () => {
    const emitted: Emitted[] = []
    const worker = new AgentRuntimeWorker({
      emit: m => emitted.push(m as Emitted),
    })
    const earlyStore = splitFakeRuntime(transcriptOf(3)).conversationStore
    let releaseBuild!: () => void
    const buildGate = new Promise<void>(resolve => {
      releaseBuild = resolve
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(async opts => {
      const options = opts as unknown as {
        onUiReady?: (info: ReturnType<typeof uiReadyInfo> & { conversationStore: unknown }) => void
      }
      options.onUiReady?.({ ...uiReadyInfo(transcriptOf(3)), conversationStore: earlyStore })
      await buildGate
      return splitFakeRuntime(transcriptOf(3)) as never
    })

    const init = worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'split-1', cwd: '/workspace' } as never,
    })
    await vi.waitFor(() => {
      expect(emitted.some(m => m.type === 'worker.uiReady')).toBe(true)
    })
    emitted.length = 0

    await worker.receiveFrame({ type: 'worker.getMessages' } as never)
    await worker.receiveFrame({
      type: 'worker.getMessagesSince',
      payload: { sinceOrdinal: 2 },
    } as never)
    const replies = emitted.filter(m => m.type === 'worker.messages')
    const counts = replies.map(
      m => (m.payload as { messages: unknown[] }).messages.length,
    )
    expect(counts).toEqual([3, 1])
    expect(emitted.some(m => m.type === 'worker.ready')).toBe(false)

    releaseBuild()
    await init
  })

  it('a transcript read sent before the provisional publish waits for it, not for the build', async () => {
    const emitted: Emitted[] = []
    const worker = new AgentRuntimeWorker({
      emit: m => emitted.push(m as Emitted),
    })
    let publish!: () => void
    const publishGate = new Promise<void>(resolve => {
      publish = resolve
    })
    let releaseBuild!: () => void
    const buildGate = new Promise<void>(resolve => {
      releaseBuild = resolve
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(async opts => {
      const options = opts as unknown as {
        onUiReady?: (info: ReturnType<typeof uiReadyInfo>) => void
      }
      await publishGate
      options.onUiReady?.(uiReadyInfo(transcriptOf(2)))
      await buildGate
      return splitFakeRuntime(transcriptOf(2)) as never
    })

    const init = worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'split-1', cwd: '/workspace' } as never,
    })
    const read = worker.receiveFrame({ type: 'worker.getMessages' } as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(emitted.some(m => m.type === 'worker.messages')).toBe(false)

    publish()
    await read
    expect(emitted.some(m => m.type === 'worker.ready')).toBe(false)
    const lengths = emitted
      .filter(m => m.type === 'worker.messages')
      .map(m => (m.payload as { messages: unknown[] }).messages.length)
    expect(lengths).toContain(2)

    releaseBuild()
    await init
  })

  it('an init failure after uiReady clears the provisional feed (no dead uiReady snapshot)', async () => {
    const emitted: Emitted[] = []
    const worker = new AgentRuntimeWorker({
      emit: m => emitted.push(m as Emitted),
    })
    vi.mocked(createAgentRuntime).mockImplementationOnce(async opts => {
      const options = opts as unknown as {
        onUiReady?: (info: ReturnType<typeof uiReadyInfo>) => void
      }
      options.onUiReady?.(uiReadyInfo(transcriptOf(1)))
      throw new Error('engine build failed')
    })

    // receiveFrame(worker.init) re-throws the build failure to its caller
    // — the contained view still emits worker.error.
    await expect(
      worker.receiveFrame({
        type: 'worker.init',
        payload: { sessionId: 'split-1', cwd: '/workspace' } as never,
      }),
    ).rejects.toThrow('engine build failed')

    expect(emitted.some(m => m.type === 'worker.uiReady')).toBe(true)
    expect(
      emitted.some(
        m =>
          m.type === 'worker.error' &&
          (m.payload as { code?: string }).code === 'worker_init_failed',
      ),
    ).toBe(true)
    expect(worker.getSnapshot().uiReady).toBeUndefined()
    expect(worker.getProvisionalBootFeed()).toBeNull()
  })
})

describe('AgentRuntimeWorker — interrupted-turn detection at restore', () => {
  // A session killed mid-run has a stale or absent persisted reason; `restoreTerminalState` infers
  // 'aborted_streaming' from the transcript shape, including an unanswered first user turn.

  async function initWithTranscript(
    messages: unknown[],
    metadata: Record<string, unknown> | null = null,
  ): Promise<{ lastTerminalReason?: string }> {
    const runtime = {
      conversationStore: {
        getSessionMetadata: vi.fn(async () => metadata),
        updateSessionMetadata: vi.fn(async () => ({})),
        saveToolCallDetail: vi.fn(async () => {}),
      },
      engine: {
        boundSessionId: () => 'interrupted-test',
        getCurrentModel: () => 'claude-test',
        getCurrentProviderId: () => 'anthropic',
        getCurrentThinkingTier: () => undefined,
        transcriptRows: () => messages,
        setModelSelection: vi.fn(),
        getCurrentPermissionMode: () => 'default',
        setPermissionMode: vi.fn(),
        submitTurn: async function* () {},
      },
      hostBridge: { getModelCatalog: vi.fn(async () => null) },
      tools: [],
      options: { cwd: '/workspace' },
    }
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const worker = new AgentRuntimeWorker({
      emit: message => {
        emitted.push(message as { type: string; payload?: unknown })
      },
    })
    vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
    await worker.receiveFrame({
      type: 'worker.init',
      payload: { sessionId: 'interrupted-test', cwd: '/workspace' } as never,
    })
    const ready = emitted.find(m => m.type === 'worker.ready')
    return (ready?.payload ?? {}) as { lastTerminalReason?: string }
  }

  const userText = (text: string, extra: Record<string, unknown> = {}) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  })
  const assistantText = (text: string) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })

  it('reports aborted for a turn killed before the first token (unanswered user prompt)', async () => {
    // The reported shape: one prompt, no reply, no persisted terminal reason.
    const snapshot = await initWithTranscript([userText('test3')])
    expect(
      snapshot.lastTerminalReason,
      'a session killed during its first prompt must restore as resumable',
    ).toBe('aborted_streaming')
  })

  it('reports aborted for an unanswered prompt even when metadata carries a stale completed', async () => {
    // Killed on a LATER turn: the stale reason is the previous turn's.
    const snapshot = await initWithTranscript(
      [userText('first'), assistantText('answered'), userText('second')],
      { lastTerminalReason: 'completed', lastTerminalTimestamp: 1000 },
    )
    expect(snapshot.lastTerminalReason).toBe('aborted_streaming')
  })

  it('leaves an answered conversation alone', async () => {
    const snapshot = await initWithTranscript(
      [userText('hi'), assistantText('hello')],
      { lastTerminalReason: 'completed', lastTerminalTimestamp: 1000 },
    )
    expect(snapshot.lastTerminalReason).toBe('completed')
  })

  it('ignores an isMeta user tail — internal context, not an unanswered prompt', async () => {
    // Continuations and compact summaries ride isMeta user turns; treating
    // them as interrupted would show "Continue" on a healthy conversation.
    const snapshot = await initWithTranscript(
      [
        userText('hi'),
        assistantText('hello'),
        userText('Continue from where you left off.', { isMeta: true }),
      ],
      { lastTerminalReason: 'completed', lastTerminalTimestamp: 1000 },
    )
    expect(snapshot.lastTerminalReason).toBe('completed')
  })

  it('reports aborted for a tool_result tail — killed during a post-tool streaming round', async () => {
    // Kill point C, and the widest window of the three in a tool-heavy
    // session: the tool ran and its result persisted, but the assistant
    // message that would consume it never landed. Signature 1 cannot claim
    // this shape — its `hasSubsequentUser` check reads the tool_result as
    // "the tool calls were resolved" — so it must be signature 2's, or it
    // falls through both and restores as `completed` with no Continue.
    const snapshot = await initWithTranscript(
      [
        userText('run it'),
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }],
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }],
          },
        },
      ],
      { lastTerminalReason: 'completed', lastTerminalTimestamp: 1000 },
    )
    expect(
      snapshot.lastTerminalReason,
      'a turn killed after its tool ran must still offer Continue',
    ).toBe('aborted_streaming')
  })

  it('reports aborted for a toolUseResult-property tail (the persisted tool-output shape)', async () => {
    // Same kill point, the other on-disk shape: tool output rides a
    // `toolUseResult` property rather than a tool_result content block.
    const snapshot = await initWithTranscript(
      [
        userText('run it'),
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }],
          },
        },
        { ...userText('tool output'), toolUseResult: { stdout: 'ok' } },
      ],
      { lastTerminalReason: 'completed', lastTerminalTimestamp: 1000 },
    )
    expect(snapshot.lastTerminalReason).toBe('aborted_streaming')
  })

  it('still detects the original signature: an assistant left with unresolved tool_use', async () => {
    const snapshot = await initWithTranscript(
      [
        userText('run it'),
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }],
          },
        },
      ],
      { lastTerminalReason: 'completed', lastTerminalTimestamp: 1000 },
    )
    expect(snapshot.lastTerminalReason).toBe('aborted_streaming')
  })
})
