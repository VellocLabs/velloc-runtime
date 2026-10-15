import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { QueryStopHookParams } from '../runtime/interfaces/QueryRuntimeDeps'
import type { PlatformCapabilities } from '../runtime/interfaces/PlatformCapabilities'
import type { WorkingState } from '../runtime/RuntimeTypes'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import {
  attachInProcessHook,
  attachTransientHook,
} from '../lifecycleHooks/sessionScopedHooks'
import {
  resetMemoryExtractionForTests,
  registerMemoryExtractor,
} from '../memory/extract/extractionRunner'
import * as forkedAgentModule from '../agents/forkedRun'

function makeStopHookParams(sessionId: string): {
  params: QueryStopHookParams
  setAppState: (updater: (prev: WorkingState) => WorkingState) => void
} {
  let appState: WorkingState = createEmptyAppState()
  const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
    appState = updater(appState)
  }
  const context = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState,
    setAppState,
    sessionId,
  })
  context.writeAppState = setAppState
  context.readAppState = () => appState
  // The end-of-turn extract fork is opt-in (autoExtractEnabled default OFF).
  // Enable it so the "fires runMemoryExtraction" tests exercise the fork;
  // the agentId / init-not-called tests bail before this gate anyway. (The
  // sibling periodic-tidy service no-ops here — `registerMemoryConsolidator` is never called in
  // this test, so `runMemoryConsolidation` has no runner.)
  context.options.memorySettings = { autoExtractEnabled: true }
  return {
    params: {
      messages: [],
      assistantMessages: [],
      systemPrompt: {} as QueryStopHookParams['systemPrompt'],
      userContext: {},
      systemContext: {},
      toolUseContext: context,
      querySource: 'sdk',
    },
    setAppState,
  }
}

describe('Stop hook integration via assembleTurnDependencies', () => {
  it('returns no blockerRows when no Stop hooks are registered', async () => {
    const deps = assembleTurnDependencies(new BrowserRuntimeConfig())
    const { params } = makeStopHookParams('sess-empty')
    const result = await deps.runTurnEndHooks(params)
    expect(result.preventContinuation).toBe(false)
    expect(result.blockerRows).toEqual([])
  })

  it('surfaces a blocking function hook as a generated user message', async () => {
    const deps = assembleTurnDependencies(new BrowserRuntimeConfig())
    const { params, setAppState } = makeStopHookParams('sess-block')
    attachInProcessHook(
      setAppState,
      'sess-block',
      'Stop',
      '',
      () => false,
      'You forgot to write the test',
    )
    const result = await deps.runTurnEndHooks(params)
    expect(result.preventContinuation).toBe(false)
    expect(result.blockerRows).toHaveLength(1)
    const msg = result.blockerRows[0]!
    const content =
      typeof msg.message === 'object' &&
      msg.message !== null &&
      'content' in msg.message
        ? (msg.message as { content: string }).content
        : ''
    expect(content).toContain('[Stop hook]:')
    expect(content).toContain('You forgot to write the test')
  })

  it('does NOT run Stop hooks at a fork\'s turn-end (agentId set) — only the main agent\'s', async () => {
    // A sub-agent's end runs SubagentStop, never Stop. A fork shares
    // its parent's sessionId, so without the main-agent gate every skill
    // fork, memory fork and agent-hook verifier fork re-ran the user's Stop
    // hooks — and billed their model calls.
    const deps = assembleTurnDependencies(new BrowserRuntimeConfig())
    const { params, setAppState } = makeStopHookParams('sess-fork-stop')
    attachInProcessHook(
      setAppState,
      'sess-fork-stop',
      'Stop',
      '',
      () => false,
      'blocks every turn-end',
    )
    params.toolUseContext.agentId = 'asubagent-0123456789abcdef'
    const forkEnd = await deps.runTurnEndHooks(params)
    expect(forkEnd.blockerRows).toEqual([])
    // Same hook, main agent → it fires.
    params.toolUseContext.agentId = undefined
    const mainEnd = await deps.runTurnEndHooks(params)
    expect(mainEnd.blockerRows).toHaveLength(1)
  })

  it('routes a fork\'s turn-end (agentId set) to SubagentStop, matched on the agent id', async () => {
    // fireTurnEnd picks SubagentStop when an agentId is passed, and
    // a blocking outcome feeds back into the fork's loop.
    const deps = assembleTurnDependencies(new BrowserRuntimeConfig())
    const { params, setAppState } = makeStopHookParams('sess-subagent-stop')
    const forkId = 'asubagent-fedcba9876543210'
    attachInProcessHook(
      setAppState,
      'sess-subagent-stop',
      'SubagentStop',
      forkId,
      () => false,
      'fork must summarise first',
    )
    attachInProcessHook(
      setAppState,
      'sess-subagent-stop',
      'SubagentStop',
      'asubagent-other',
      () => false,
      'another agent',
    )
    params.toolUseContext.agentId = forkId
    const forkEnd = await deps.runTurnEndHooks(params)
    expect(forkEnd.blockerRows).toHaveLength(1)
    const msg = forkEnd.blockerRows[0]!.message as { content: string }
    expect(msg.content).toContain('fork must summarise first')
    expect(msg.content).not.toContain('another agent')
    // The main agent's turn-end never fires SubagentStop.
    params.toolUseContext.agentId = undefined
    const mainEnd = await deps.runTurnEndHooks(params)
    expect(mainEnd.blockerRows).toEqual([])
  })

  it('skips user hooks when stopHookActive is set (avoids retry-loop refire)', async () => {
    const deps = assembleTurnDependencies(new BrowserRuntimeConfig())
    const { params, setAppState } = makeStopHookParams('sess-retry')
    attachInProcessHook(
      setAppState,
      'sess-retry',
      'Stop',
      '',
      () => false,
      'should be skipped',
    )
    const result = await deps.runTurnEndHooks({
      ...params,
      stopHookActive: true,
    })
    expect(result.blockerRows).toEqual([])
  })

  it('does not block on persistable Stop hooks (not_implemented routing)', async () => {
    const deps = assembleTurnDependencies(new BrowserRuntimeConfig())
    const { params, setAppState } = makeStopHookParams('sess-persistable')
    attachTransientHook(setAppState, 'sess-persistable', 'Stop', '', {
      type: 'http',
      url: 'https://example.com/hook',
    })
    const result = await deps.runTurnEndHooks(params)
    expect(result.preventContinuation).toBe(false)
    expect(result.blockerRows).toEqual([])
  })

  it('aggregates multiple blocking Stop hooks in parallel', async () => {
    const deps = assembleTurnDependencies(new BrowserRuntimeConfig())
    const { params, setAppState } = makeStopHookParams('sess-multi')
    attachInProcessHook(setAppState, 'sess-multi', 'Stop', '', () => false, 'A')
    attachInProcessHook(setAppState, 'sess-multi', 'Stop', '', () => false, 'B')
    const result = await deps.runTurnEndHooks(params)
    expect(result.blockerRows).toHaveLength(2)
    const bodies = result.blockerRows.map(m => {
      const content =
        typeof m.message === 'object' &&
        m.message !== null &&
        'content' in m.message
          ? (m.message as { content: string }).content
          : ''
      return content
    })
    expect(bodies.some(b => b.includes('A'))).toBe(true)
    expect(bodies.some(b => b.includes('B'))).toBe(true)
  })
})

describe('extract-memories trigger via Stop hook', () => {
  let runForkedAgentSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetMemoryExtractionForTests()
    runForkedAgentSpy = vi.spyOn(forkedAgentModule, 'launchFork')
    runForkedAgentSpy.mockReset()
    runForkedAgentSpy.mockResolvedValue({
      messages: [],
      agentId: 'extract_memories_test',
    })
  })

  afterEach(() => {
    resetMemoryExtractionForTests()
    runForkedAgentSpy.mockRestore()
  })

  it('fires runMemoryExtraction fire-and-forget at end-of-turn', async () => {
    const runtimeConfig = new BrowserRuntimeConfig()
    registerMemoryExtractor({ runtimeConfig })
    const deps = assembleTurnDependencies(runtimeConfig)
    const { params } = makeStopHookParams('sess-extract')

    const result = await deps.runTurnEndHooks(params)

    // Stop hook returns immediately; the fork runs fire-and-forget.
    expect(result.preventContinuation).toBe(false)
    expect(result.blockerRows).toEqual([])

    // Let the void-awaited extraction microtask run so the spy registers.
    await new Promise(r => setTimeout(r, 0))
    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)
    const callArg = runForkedAgentSpy.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >
    expect(callArg.forkLabel).toBe('extract_memories')
  })

  it('a crashing extract fork does not affect the Stop hook return value', async () => {
    runForkedAgentSpy.mockRejectedValueOnce(new Error('fork blew up'))
    const runtimeConfig = new BrowserRuntimeConfig()
    registerMemoryExtractor({ runtimeConfig })
    const deps = assembleTurnDependencies(runtimeConfig)
    const { params } = makeStopHookParams('sess-extract-crash')

    const result = await deps.runTurnEndHooks(params)

    expect(result.preventContinuation).toBe(false)
    expect(result.blockerRows).toEqual([])
  })

  it('does not fire when registerMemoryExtractor was never called', async () => {
    // Reset already happened in beforeEach; do not init.
    const deps = assembleTurnDependencies(new BrowserRuntimeConfig())
    const { params } = makeStopHookParams('sess-no-init')

    await deps.runTurnEndHooks(params)
    await new Promise(r => setTimeout(r, 0))

    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('does NOT fire when toolUseContext.agentId is set (sub-agent fork)', async () => {
    // Regression for the session.onStop loop: pre-fix, every fork's
    // runTurnEndHooks fired runMemoryExtraction against the parent's
    // sessionId, spawning another fork → another stop hook → recursion.
    // The fix is the `!toolUseContext.agentId` gate in runTurnEndHooks
    // (deps.ts) AND the matching fresh-agentId mint in deriveChildToolContext
    // (forkedAgent.ts).
    const runtimeConfig = new BrowserRuntimeConfig()
    registerMemoryExtractor({ runtimeConfig })
    const deps = assembleTurnDependencies(runtimeConfig)
    const { params } = makeStopHookParams('sess-subagent')
    // Simulate sub-agent context: deriveChildToolContext mints a fresh
    // agentId on real forks; we set one here to exercise the gate.
    params.toolUseContext.agentId = 'asubagent-deadbeefcafef00d'

    const result = await deps.runTurnEndHooks(params)

    expect(result.preventContinuation).toBe(false)
    expect(result.blockerRows).toEqual([])

    await new Promise(r => setTimeout(r, 0))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })
})

describe('session.onStop gate for sub-agents', () => {
  // Regression: pre-fix, every fork's turn-end fired
  // session.onStop({reason:'completed'}) against the parent's sessionId,
  // producing a sustained C++ log cascade once `ToolsAdapter::OnSessionStopped`
  // started keeping ToolSessions warm (typed-OnStop refactor). The fix gates
  // on `!toolUseContext.agentId`, the same gate the Stop hooks use.

  function makePlatformWithSpy(): {
    platform: PlatformCapabilities
    onStop: ReturnType<typeof vi.fn>
  } {
    const onStop = vi.fn(async () => ({ ok: true as const, stopped: false }))
    const platform: PlatformCapabilities = {
      session: {
        onStop,
      },
    }
    return { platform, onStop }
  }

  function makeParamsWith(
    sessionId: string,
    platform: PlatformCapabilities,
  ): QueryStopHookParams {
    let appState: WorkingState = createEmptyAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    }
    const context = createNoopToolUseContext({
      tools: [],
      platformCapabilities: platform,
      appState,
      setAppState,
      sessionId,
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    return {
      messages: [],
      assistantMessages: [],
      systemPrompt: {} as QueryStopHookParams['systemPrompt'],
      userContext: {},
      systemContext: {},
      toolUseContext: context,
      querySource: 'sdk',
    }
  }

  it('fires session.onStop when context.agentId is undefined (main agent)', async () => {
    const deps = assembleTurnDependencies(new BrowserRuntimeConfig())
    const { platform, onStop } = makePlatformWithSpy()
    const params = makeParamsWith('sess-main', platform)

    await deps.runTurnEndHooks(params)

    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onStop).toHaveBeenCalledWith({
      sessionId: 'sess-main',
      reason: 'completed',
    })
  })

  it('does NOT fire session.onStop when context.agentId is set (sub-agent fork)', async () => {
    const deps = assembleTurnDependencies(new BrowserRuntimeConfig())
    const { platform, onStop } = makePlatformWithSpy()
    const params = makeParamsWith('sess-parent', platform)
    params.toolUseContext.agentId = 'asubagent-cafef00ddeadbeef'

    await deps.runTurnEndHooks(params)

    expect(onStop).not.toHaveBeenCalled()
  })

  it('does NOT fire session.onStop for fast-model side-call querySources', async () => {
    // Side-calls (session-title generation, memory-recall selector, generic
    // fast-model calls) reuse the main context (no fresh agentId), so the
    // agentId gate alone doesn't catch them. A side-call completing WHILE a
    // main-loop tool is mid-flight must NOT fire session.onStop — C++ would
    // drop the in-flight tool (`tool_dropped`), the engine would retry the
    // turn, and e2e fake-server FIFOs desync into queue exhaustion.
    const deps = assembleTurnDependencies(new BrowserRuntimeConfig())
    for (const querySource of
         ['rename_generate_name', 'memory_recall', 'fast_model_call']) {
      const { platform, onStop } = makePlatformWithSpy()
      const params = makeParamsWith('sess-main', platform)
      ;(params as { querySource: string }).querySource = querySource
      await deps.runTurnEndHooks(params)
      expect(onStop, `querySource=${querySource} must not stop the session`)
          .not.toHaveBeenCalled()
    }
  })
})
