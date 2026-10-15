import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContract } from '../toolkit/toolContract'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  resetMemoryExtractionForTests,
  takeSavedMemoryPaths,
  memoryWriterPermissionGate,
  awaitMemoryExtractions,
  runMemoryExtraction,
  registerMemoryExtractor,
  type MemoryExtractionContext,
} from '../memory/extract/extractionRunner'
import * as forkedAgentModule from '../agents/forkedRun'
import { composeExtractionBrief } from '../memory/extract/extractorPrompt'

describe('composeExtractionBrief — daily-log skipIndex variant', () => {
  it('keeps the two-step MEMORY.md save when skipIndex is false', () => {
    const prompt = composeExtractionBrief(5, '', false)
    expect(prompt).toContain('Two steps, every time:')
    expect(prompt).toContain('2. Add one line for it to `MEMORY.md`')
  })

  it('saves useful feedback at its given scope without demanding a stated rule', () => {
    const prompt = composeExtractionBrief(5, '', false)
    expect(prompt).toContain('save corrections and non-obvious approvals that will help later sessions')
    expect(prompt).toContain('do not turn a request made for one task into a standing preference')
    expect(prompt).not.toContain('unless the user said so')
  })

  it('drops the MEMORY.md index step when skipIndex is true (daily-log)', () => {
    const prompt = composeExtractionBrief(5, '', true)
    expect(prompt).toContain('Write each note to its own file')
    expect(prompt).not.toContain('Two steps, every time:')
    expect(prompt).not.toContain('2. Add one line for it to')
  })
})

// ============================================================================
// Test helpers
// ============================================================================

function createMockRuntimeConfig(env: Record<string, string> = {}): RuntimeConfig {
  return {
    getEnv: (name: string) => env[name],
    flagOn: (name: string) => {
      const v = env[name]
      return v === '1' || v === 'true' || v === 'yes'
    },
    now: () => 1_700_000_000_000,
    createUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2, 8),
    createTimestamp: () => '2026-05-13T00:00:00.000Z',
    getMaxStructuredOutputRetries: () => 5,
  }
}

function createMockToolUseContext(
  overrides: Partial<ToolCallContext> = {},
): ToolCallContext {
  return {
    options: {
      commands: [],
      cwd: '/test/cwd',
      sessionId: 'session-1',
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { enabledAgents: [], allAgents: [] },
      // Default the fork ON for the fork-path tests below: the extract fork is
      // opt-in (autoExtractEnabled default OFF), so tests that expect a fork
      // must enable it. Off-by-default behavior is covered by dedicated tests
      // that override this.
      memorySettings: { autoExtractEnabled: true },
    },
    cancelSource: new AbortController(),
    fileReadLedger: new Map(),
    platformCapabilities: {} as ToolCallContext['platformCapabilities'],
    readAppState: () => ({}) as ReturnType<ToolCallContext['readAppState']>,
    writeAppState: () => {},
    markCallsInFlight: () => {},
    noteReplyLength: () => {},
    noteFileHistory: () => {},
    noteAttribution: () => {},
    messages: [],
    ...overrides,
  } as ToolCallContext
}

function userMessage(uuid: string, text = 'hi'): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  } as unknown as Message
}

function assistantMessage(uuid: string, content: unknown): Message {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content },
  } as unknown as Message
}

function createBaseContext(
  messages: Message[],
  overrides?: Partial<MemoryExtractionContext>,
): MemoryExtractionContext {
  return {
    messages,
    systemPrompt: 'test-system-prompt',
    userContext: { currentDate: '2026-05-13' },
    systemContext: { locale: 'en-US' },
    toolUseContext: createMockToolUseContext({ messages }),
    ...overrides,
  }
}

// ============================================================================
// memoryWriterPermissionGate (the permission gate)
// ============================================================================

describe('memoryWriterPermissionGate', () => {
  const memoryDir = '/test/cwd/.velloc/memory/'

  function asTool(name: string, isReadOnly?: (input: unknown) => boolean): ToolContract {
    return { name, readsOnly: isReadOnly } as unknown as ToolContract
  }

  it('allows Read / Grep / Glob unconditionally', async () => {
    const gate = memoryWriterPermissionGate(memoryDir)
    for (const name of ['Read', 'Grep', 'Glob']) {
      const result = (await gate(asTool(name), {})) as { behavior: string }
      expect(result.behavior).toBe('allow')
    }
  })

  it('allows Bash only when the tool reports read-only', async () => {
    const gate = memoryWriterPermissionGate(memoryDir)
    const readOnly = asTool('Bash', () => true)
    const writable = asTool('Bash', () => false)
    expect(((await gate(readOnly, { command: 'ls' })) as { behavior: string }).behavior).toBe(
      'allow',
    )
    expect(((await gate(writable, { command: 'rm -rf' })) as { behavior: string }).behavior).toBe(
      'deny',
    )
  })

  it('allows Write / Edit only for paths under memoryDir', async () => {
    const gate = memoryWriterPermissionGate(memoryDir)
    const inside = await gate(asTool('Write'), {
      file_path: '/test/cwd/.velloc/memory/user_role.md',
    })
    expect((inside as { behavior: string }).behavior).toBe('allow')

    const outside = await gate(asTool('Write'), {
      file_path: '/test/cwd/src/index.ts',
    })
    expect((outside as { behavior: string }).behavior).toBe('deny')
  })

  it('path comparison ignores slash style and Windows drive case', async () => {
    // memoryDir given with forward slashes but model writes with
    // backslashes. The gate normalizes both.
    const gate = memoryWriterPermissionGate('C:/test/cwd/.velloc/memory/')
    const result = await gate(asTool('Write'), {
      file_path: 'C:\\test\\cwd\\.velloc\\memory\\user_role.md',
    })
    expect((result as { behavior: string }).behavior).toBe('allow')
  })

  it('denies tools outside the read-only / memory-write allowlist', async () => {
    const gate = memoryWriterPermissionGate(memoryDir)
    for (const name of ['Skill', 'BrowserClick', 'mcp__custom__tool']) {
      const result = (await gate(asTool(name), {})) as { behavior: string }
      expect(result.behavior).toBe('deny')
    }
  })

  it('denies an unknown tool with no name', async () => {
    const gate = memoryWriterPermissionGate(memoryDir)
    const result = (await gate({}, {})) as { behavior: string }
    expect(result.behavior).toBe('deny')
  })
})

// ============================================================================
// runMemoryExtraction: gating + coalescing + cursor advancement
// ============================================================================

describe('runMemoryExtraction', () => {
  let runForkedAgentSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetMemoryExtractionForTests()
    // Stub launchFork so we don't actually run query(). Reset the
    // spy between tests — `vi.spyOn` returns the same spy instance for
    // the same prop, so `mock.calls` accumulates without an explicit
    // reset.
    runForkedAgentSpy = vi.spyOn(forkedAgentModule, 'launchFork')
    runForkedAgentSpy.mockReset()
    runForkedAgentSpy.mockResolvedValue({
      messages: [],
      agentId: 'extract_memories_test',
    })
  })

  it('no-ops when the extractor closure has not been initialized', async () => {
    resetMemoryExtractionForTests()
    await runMemoryExtraction(createBaseContext([userMessage('u1')]))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('no-ops when called from a sub-agent (agentId set)', async () => {
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig() })
    const ctx = createBaseContext([userMessage('u1')], {
      toolUseContext: createMockToolUseContext({ agentId: 'sub-agent-id' }),
    })
    await runMemoryExtraction(ctx)
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('no-ops when auto-memory is disabled via env', async () => {
    registerMemoryExtractor({
      runtimeConfig: createMockRuntimeConfig({
        VELLOC_MEMORY: 'off',
      }),
    })
    await runMemoryExtraction(createBaseContext([userMessage('u1')]))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('no-ops when autoExtractEnabled is unset (fork is opt-in, default OFF)', async () => {
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig() })
    const ctx = createBaseContext([userMessage('u1')])
    // Override the mock's extract-on default with an empty snapshot — the fork
    // must NOT run unless background extraction is explicitly enabled.
    ;(ctx.toolUseContext.options as Record<string, unknown>).memorySettings = {}
    await runMemoryExtraction(ctx)
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('no-ops when autoExtractEnabled is explicitly false', async () => {
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig() })
    const ctx = createBaseContext([userMessage('u1')])
    ;(ctx.toolUseContext.options as Record<string, unknown>).memorySettings = {
      autoExtractEnabled: false,
    }
    await runMemoryExtraction(ctx)
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('no-ops when only memoryMaintenance is set — extract keys off autoExtractEnabled (gate split)', async () => {
    // The consolidation service (memoryMaintenance) and the extract fork
    // (autoExtractEnabled) have SEPARATE gates. Enabling periodic tidy must NOT
    // turn on the extract fork.
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig() })
    const ctx = createBaseContext([userMessage('u1')])
    ;(ctx.toolUseContext.options as Record<string, unknown>).memorySettings = {
      memoryMaintenance: 'periodic',
    }
    await runMemoryExtraction(ctx)
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('no-ops when autoMemoryEnabled is false even with autoExtractEnabled true', async () => {
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig() })
    const ctx = createBaseContext([userMessage('u1')])
    ;(ctx.toolUseContext.options as Record<string, unknown>).memorySettings = {
      autoMemoryEnabled: false,
      autoExtractEnabled: true,
    }
    await runMemoryExtraction(ctx)
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('forks a sub-agent on the happy path', async () => {
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig() })
    await runMemoryExtraction(createBaseContext([userMessage('u1')]))
    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)
    const callArg = runForkedAgentSpy.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >
    expect(callArg.forkLabel).toBe('extract_memories')
    expect(callArg.querySource).toBe('extract_memories')
    expect(callArg.maxTurns).toBe(5)
    expect(callArg.skipCacheWrite).toBe(true)
  })

  // Regression (multi-tab realm): two BrowserRuntimes share ONE SharedWorker
  // realm. Runtime B initializes AFTER A — pre-fix B clobbered the module-global
  // extractor, so A's end-of-turn forked against B's frozen deps (B's logEvent /
  // sidechainStore / runtimeConfig) and shared B's cursor. The extractor is now
  // keyed by the runtime's RuntimeConfig, so A's turn extracts with A's deps.
  // (The per-runtime logEvent spies prove which runtime's closure ran.)
  it('isolates per-runtime deps: a turn extracts with ITS runtime, not the last-initialized one', async () => {
    const rcA = createMockRuntimeConfig()
    const rcB = createMockRuntimeConfig()
    const logA = vi.fn()
    const logB = vi.fn()
    registerMemoryExtractor({ runtimeConfig: rcA, logEvent: logA })
    registerMemoryExtractor({ runtimeConfig: rcB, logEvent: logB })

    // Runtime A's turn (its RuntimeConfig rides the tool-use context).
    const ctx = createBaseContext([userMessage('u1')])
    ;(ctx.toolUseContext.options as Record<string, unknown>).runtimeConfig = rcA
    await runMemoryExtraction(ctx)

    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)
    // A's telemetry sink saw the extraction; B's saw nothing — A's deps ran.
    expect(
      logA.mock.calls.some(c => c[0] === 'nexus_extract_memories_extraction'),
    ).toBe(true)
    expect(logB).not.toHaveBeenCalled()
  })

  it('skips when the main agent already wrote to memory this turn', async () => {
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig() })
    // Construct an assistant message containing a tool_use that
    // writes to the memory dir. The default memoryDir for cwd
    // /test/cwd is /test/cwd/.velloc/memory/.
    const messages: Message[] = [
      userMessage('u1', 'remember peijun'),
      assistantMessage('a1', [
        {
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/test/cwd/.velloc/memory/user_role.md', content: '...' },
        },
      ]),
    ]
    await runMemoryExtraction(createBaseContext(messages))
    expect(runForkedAgentSpy).not.toHaveBeenCalled()
  })

  it('coalesces overlapping calls — the second is stashed, fires after the first completes', async () => {
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig() })
    let resolveFirst: () => void = () => {}
    // First call: hangs until we resolve it manually. Subsequent
    // calls (the trailing run) resolve immediately so the test can
    // assert on the call count without hanging.
    runForkedAgentSpy.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirst = () =>
            resolve({ messages: [], agentId: 'fake_extract' })
        }),
    )
    runForkedAgentSpy.mockResolvedValue({
      messages: [],
      agentId: 'fake_extract_trailing',
    })

    const ctxA = createBaseContext([userMessage('u1')])
    const ctxB = createBaseContext([userMessage('u1'), userMessage('u2')])

    // Start the first; it hangs in-flight on `resolveFirst`.
    const first = runMemoryExtraction(ctxA)

    // Yield long enough for runExtraction(ctxA)'s body to reach its
    // `await launchFork(...)` line — without this, the spy hasn't
    // been called yet when we check below. `setTimeout(0)` flushes
    // the microtask queue completely (multiple microtask hops),
    // which is what we need since runExtraction awaits listMemoryFiles
    // before hitting launchFork.
    await new Promise(r => setTimeout(r, 0))

    // While the first is in-flight (its mock implementation is hung
    // on `resolveFirst`), fire the second. Should be stashed, NOT
    // spawn a parallel call.
    await runMemoryExtraction(ctxB)
    expect(runForkedAgentSpy).toHaveBeenCalledTimes(1)

    // Resolve the first run. The trailing run should now fire.
    resolveFirst()
    await first
    // Microtask flush so the extractor's `while (pendingContext)`
    // loop runs the trailing extraction before we check.
    await new Promise(r => setTimeout(r, 0))
    expect(runForkedAgentSpy).toHaveBeenCalledTimes(2)
  })

  it('passes the sidechainStore through to launchFork', async () => {
    const fakeStore = {
      append: vi.fn(),
      load: vi.fn(),
      loadMetadata: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    } as unknown as Parameters<typeof registerMemoryExtractor>[0]['sidechainStore']
    registerMemoryExtractor({
      runtimeConfig: createMockRuntimeConfig(),
      sidechainStore: fakeStore,
    })
    await runMemoryExtraction(createBaseContext([userMessage('u1')]))
    const callArg = runForkedAgentSpy.mock.calls[0]?.[0] as {
      sidechainStore?: unknown
      spawnerSessionId?: unknown
    }
    expect(callArg.sidechainStore).toBe(fakeStore)
    expect(callArg.spawnerSessionId).toBe('session-1')
  })

  // --- memory_saved notice (deferred) ---

  it('stashes topic files the fork wrote for the memory_saved notice; MEMORY.md is filtered', async () => {
    const rc = createMockRuntimeConfig()
    registerMemoryExtractor({ runtimeConfig: rc })
    runForkedAgentSpy.mockResolvedValue({
      messages: [
        assistantMessage('fa1', [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/mem/user_role.md', content: '...' },
          },
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/mem/MEMORY.md', old_string: 'a', new_string: 'b' },
          },
        ]),
      ],
      agentId: 'extract_memories_test',
    })
    const ctx = createBaseContext([userMessage('u1')])
    ;(ctx.toolUseContext.options as Record<string, unknown>).runtimeConfig = rc
    await runMemoryExtraction(ctx)

    const saved = takeSavedMemoryPaths(rc)
    expect(saved).toEqual(['/mem/user_role.md'])
    // Consume pops — a second read returns nothing.
    expect(takeSavedMemoryPaths(rc)).toBeNull()
  })

  it('stashes writes in the canonical tool-call block shape (toolName/args) too', async () => {
    // The fork's in-memory assistant messages carry PART_TOOL_CALL blocks
    // (`tool-call` + toolName/args), not the Anthropic `tool_use` shape —
    // the e2e regression that surfaced this used the real fork transport.
    const rc = createMockRuntimeConfig()
    registerMemoryExtractor({ runtimeConfig: rc })
    runForkedAgentSpy.mockResolvedValue({
      messages: [
        assistantMessage('fa1', [
          {
            type: 'tool-call',
            toolCallId: 'tc1',
            toolName: 'Write',
            args: { file_path: '/mem/user_role.md', content: '...' },
          },
        ]),
      ],
      agentId: 'extract_memories_test',
    })
    const ctx = createBaseContext([userMessage('u1')])
    ;(ctx.toolUseContext.options as Record<string, unknown>).runtimeConfig = rc
    await runMemoryExtraction(ctx)
    expect(takeSavedMemoryPaths(rc)).toEqual(['/mem/user_role.md'])
  })

  it('stashes nothing when the fork wrote no files', async () => {
    const rc = createMockRuntimeConfig()
    registerMemoryExtractor({ runtimeConfig: rc })
    const ctx = createBaseContext([userMessage('u1')])
    ;(ctx.toolUseContext.options as Record<string, unknown>).runtimeConfig = rc
    await runMemoryExtraction(ctx)
    expect(takeSavedMemoryPaths(rc)).toBeNull()
  })

  // --- awaitMemoryExtractions (pre-shutdown drain) ---

  it('awaitMemoryExtractions awaits an in-flight extraction', async () => {
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig() })
    let resolveFork: () => void = () => {}
    runForkedAgentSpy.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFork = () => resolve({ messages: [], agentId: 'hung' })
        }),
    )
    const inFlight = runMemoryExtraction(createBaseContext([userMessage('u1')]))
    await new Promise(r => setTimeout(r, 0))

    let drained = false
    const drain = awaitMemoryExtractions(60_000).then(() => {
      drained = true
    })
    await new Promise(r => setTimeout(r, 0))
    expect(drained).toBe(false)

    resolveFork()
    await inFlight
    await drain
    expect(drained).toBe(true)
  })

  it('awaitMemoryExtractions returns on timeout while a fork hangs', async () => {
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig() })
    runForkedAgentSpy.mockImplementationOnce(() => new Promise(() => {}))
    void runMemoryExtraction(createBaseContext([userMessage('u1')]))
    await new Promise(r => setTimeout(r, 0))
    // 10ms soft timeout: resolves even though the fork never settles.
    await expect(awaitMemoryExtractions(10)).resolves.toBeUndefined()
  })

  it('awaitMemoryExtractions is a no-op with nothing in flight', async () => {
    await expect(awaitMemoryExtractions(10)).resolves.toBeUndefined()
  })

  it('logs telemetry on successful extraction', async () => {
    const logEvent = vi.fn()
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig(), logEvent })
    await runMemoryExtraction(createBaseContext([userMessage('u1')]))
    const event = logEvent.mock.calls.find(
      c => c[0] === 'nexus_extract_memories_extraction',
    )
    expect(event).toBeDefined()
  })

  it('logs telemetry on failure and stays silent (does not throw)', async () => {
    runForkedAgentSpy.mockRejectedValueOnce(new Error('fork crashed'))
    const logEvent = vi.fn()
    registerMemoryExtractor({ runtimeConfig: createMockRuntimeConfig(), logEvent })
    // Must not throw.
    await runMemoryExtraction(createBaseContext([userMessage('u1')]))
    const event = logEvent.mock.calls.find(
      c => c[0] === 'nexus_extract_memories_error',
    )
    expect(event).toBeDefined()
    expect((event?.[1] as { message?: string }).message).toContain('fork crashed')
  })
})
