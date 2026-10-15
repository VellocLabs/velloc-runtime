import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ReadFileLedger, Message } from '../runtime/RuntimeTypes'
import {
  cloneReadFileState,
  captureForkPrefix,
  deriveChildToolContext,
  recallForkPrefix,
  launchFork,
  rememberForkPrefix,
  type ForkPrefixSnapshot,
} from '../agents/forkedRun'
import { DefaultRuntimeConfig } from '../runtime/testing/noopAdapters'
import { runTurnLoop } from '../engine/turnInterpreter'
import { estimateTranscriptTokens } from '../engine/tokenCounts'
import {
  getPinFailureHealth,
  resetPinFailureLog,
} from '../models/pinFailureLog'
import {
  resetSessionModelSettingsSnapshot,
  setSessionModelSettingsSnapshot,
} from '../models/tierSettingsSnapshot'
import { installBuiltinCatalogFigures } from './_helpers/builtinCatalogFigures'
import { resetCatalogFigures } from '../config/nexusModelConfig/catalogFigures'

// Built-in rows read the context window / output cap / image input they
// leave unset from the model catalog: install the runtime's figures, as
// after its first catalog read (catalog/builtinCatalogFill.ts).
beforeAll(installBuiltinCatalogFigures)
afterAll(resetCatalogFigures)

// The launchFork describe drives the fork loop against a mocked query()
// (the real one needs a live transport) and a controllable token estimator
// (the window-fit gate input). Both partial mocks — everything else in each
// module stays real for the other describes in this file.
vi.mock('../engine/turnInterpreter', async importOriginal => ({
  ...(await importOriginal<object>()),
  runTurnLoop: vi.fn(),
}))
vi.mock('../engine/tokenCounts', async importOriginal => ({
  ...(await importOriginal<object>()),
  estimateTranscriptTokens: vi.fn(() => 0),
}))

// ============================================================================
// Helpers
// ============================================================================

function createMockToolUseContext(
  overrides: Partial<ToolCallContext> = {},
): ToolCallContext {
  const fileReadLedger: ReadFileLedger = new Map()
  const cancelSource = new AbortController()
  // Minimal fields needed by deriveChildToolContext. The unused-fields
  // cast is fine: deriveChildToolContext only reads the documented set.
  return {
    options: {
      commands: [],
      cwd: '/test',
      sessionId: 'test-session',
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { enabledAgents: [], allAgents: [] },
    },
    cancelSource,
    fileReadLedger,
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

// ============================================================================
// cloneReadFileState
// ============================================================================

describe('cloneReadFileState', () => {
  it('returns a new Map with the same entries', () => {
    const parent: ReadFileLedger = new Map([
      ['/file/a', { content: 'a', timestamp: 1 }],
      ['/file/b', { content: 'b', timestamp: 2 }],
    ])
    const clone = cloneReadFileState(parent)
    expect(clone).not.toBe(parent)
    expect(clone.size).toBe(2)
    expect(clone.get('/file/a')).toEqual({ content: 'a', timestamp: 1 })
  })

  it('parent mutation after clone does not affect the clone', () => {
    const parent: ReadFileLedger = new Map([
      ['/file/a', { content: 'a', timestamp: 1 }],
    ])
    const clone = cloneReadFileState(parent)
    parent.set('/file/b', { content: 'b', timestamp: 2 })
    expect(clone.has('/file/b')).toBe(false)
  })

  it('clone mutation does not affect the parent', () => {
    const parent: ReadFileLedger = new Map([
      ['/file/a', { content: 'a', timestamp: 1 }],
    ])
    const clone = cloneReadFileState(parent)
    clone.set('/file/c', { content: 'c', timestamp: 3 })
    expect(parent.has('/file/c')).toBe(false)
  })
})

// ============================================================================
// ForkPrefixSnapshot round-trip
// ============================================================================

describe('captureForkPrefix', () => {
  it('packs the documented fields into a ForkPrefixSnapshot envelope', () => {
    const ctx = createMockToolUseContext()
    const messages = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
    ] as unknown as Parameters<typeof captureForkPrefix>[0]['messages']

    const params = captureForkPrefix({
      systemPrompt: 'sys',
      userContext: { date: '2026-05-13' },
      systemContext: { locale: 'en-US' },
      toolUseContext: ctx,
      messages,
    })

    expect(params.systemPrompt).toBe('sys')
    expect(params.userContext).toEqual({ date: '2026-05-13' })
    expect(params.systemContext).toEqual({ locale: 'en-US' })
    expect(params.toolUseContext).toBe(ctx) // shared by reference for cache hit
    expect(params.forkSeedRows).toBe(messages) // shared by reference
  })
})

describe('rememberForkPrefix / recallForkPrefix', () => {
  afterEach(() => {
    rememberForkPrefix(null)
  })

  it('round-trips a saved params object', () => {
    const ctx = createMockToolUseContext()
    const params = captureForkPrefix({
      systemPrompt: 's',
      userContext: {},
      systemContext: {},
      toolUseContext: ctx,
      messages: [],
    })
    rememberForkPrefix(params)
    expect(recallForkPrefix()).toBe(params)
  })

  it('starts null', () => {
    rememberForkPrefix(null) // reset
    expect(recallForkPrefix()).toBeNull()
  })

  it('null clears the slot', () => {
    const ctx = createMockToolUseContext()
    rememberForkPrefix(
      captureForkPrefix({
        systemPrompt: 's',
        userContext: {},
        systemContext: {},
        toolUseContext: ctx,
        messages: [],
      }),
    )
    rememberForkPrefix(null)
    expect(recallForkPrefix()).toBeNull()
  })

  // Per-runtime keying — the SharedWorker hosts every runtime in one realm,
  // so the snapshot is keyed by the runtime's `RuntimeConfig` identity
  // (`context.options.runtimeConfig`); one runtime's fork can never pick up a
  // sibling runtime's conversation. The keyless slot above serves only
  // contexts without a `runtimeConfig` (tests) and is never a fallback for a
  // keyed read.
  describe('per-runtime keying', () => {
    function paramsFor(label: string): ForkPrefixSnapshot {
      return captureForkPrefix({
        systemPrompt: label,
        userContext: {},
        systemContext: {},
        toolUseContext: createMockToolUseContext(),
        messages: [],
      })
    }

    it('isolates snapshots by runtime and never falls back across runtimes', () => {
      const runtimeA = new DefaultRuntimeConfig()
      const runtimeB = new DefaultRuntimeConfig()
      const runtimeC = new DefaultRuntimeConfig()
      const a = paramsFor('runtime-a')
      const b = paramsFor('runtime-b')

      rememberForkPrefix(a, runtimeA)
      rememberForkPrefix(b, runtimeB)

      expect(recallForkPrefix(runtimeA)).toBe(a)
      expect(recallForkPrefix(runtimeB)).toBe(b)
      // A runtime that never captured a snapshot reads NOTHING — not the
      // sibling that wrote last (the realm-shared behavior being removed).
      expect(recallForkPrefix(runtimeC)).toBeNull()

      // A keyed write never touches the keyless slot, and vice versa.
      expect(recallForkPrefix()).toBeNull()
      const keyless = paramsFor('keyless')
      rememberForkPrefix(keyless)
      expect(recallForkPrefix(runtimeA)).toBe(a)
      expect(recallForkPrefix()).toBe(keyless)

      // null clears exactly one runtime's snapshot.
      rememberForkPrefix(null, runtimeA)
      expect(recallForkPrefix(runtimeA)).toBeNull()
      expect(recallForkPrefix(runtimeB)).toBe(b)
    })
  })
})

// ============================================================================
// deriveChildToolContext
// ============================================================================

describe('deriveChildToolContext — isolation', () => {
  it('clones readFileState — fork mutation does not leak to parent', () => {
    const parentRead: ReadFileLedger = new Map([
      ['/file/a', { content: 'a', timestamp: 1 }],
    ])
    const parent = createMockToolUseContext({ fileReadLedger: parentRead })

    const fork = deriveChildToolContext(parent)
    fork.fileReadLedger.set('/file/new', { content: 'new', timestamp: 99 })

    expect(parent.fileReadLedger.has('/file/new')).toBe(false)
    expect(fork.fileReadLedger.has('/file/new')).toBe(true)
  })

  it('stubs setAppState to no-op by default', () => {
    let parentCalled = false
    const parent = createMockToolUseContext({
      writeAppState: () => {
        parentCalled = true
      },
    })
    const fork = deriveChildToolContext(parent)
    fork.writeAppState(s => s)
    expect(parentCalled).toBe(false)
  })

  it('shares setAppState when inheritStateWriter=true', () => {
    let parentCalled = false
    const parent = createMockToolUseContext({
      writeAppState: () => {
        parentCalled = true
      },
    })
    const fork = deriveChildToolContext(parent, { inheritStateWriter: true })
    fork.writeAppState(s => s)
    expect(parentCalled).toBe(true)
  })

  it('stubs setInProgressToolUseIDs to no-op', () => {
    let parentCalled = false
    const parent = createMockToolUseContext({
      markCallsInFlight: () => {
        parentCalled = true
      },
    })
    const fork = deriveChildToolContext(parent)
    fork.markCallsInFlight(s => s)
    expect(parentCalled).toBe(false)
  })

  it('clears addNotification / setSDKStatus side-channels', () => {
    const parent = createMockToolUseContext({
      postNotice: () => {},
      reportHostStatus: () => {},
    })
    const fork = deriveChildToolContext(parent)
    expect(fork.postNotice).toBeUndefined()
    expect(fork.reportHostStatus).toBeUndefined()
  })

  it('gives the fork a fresh discoveredSkillNames Set', () => {
    const parent = createMockToolUseContext({
      skillsFound: new Set(['parent-skill']),
    })
    const fork = deriveChildToolContext(parent)
    expect(fork.skillsFound).toBeDefined()
    expect(fork.skillsFound!.has('parent-skill')).toBe(false)
    expect(fork.skillsFound!.size).toBe(0)
  })
})

describe('deriveChildToolContext — abort signal chaining', () => {
  it('parent abort propagates to the fork by default', () => {
    const parent = createMockToolUseContext()
    const fork = deriveChildToolContext(parent)
    expect(fork.cancelSource.signal.aborted).toBe(false)
    parent.cancelSource.abort('parent-cancel')
    expect(fork.cancelSource.signal.aborted).toBe(true)
    expect(fork.cancelSource.signal.reason).toBe('parent-cancel')
  })

  it('aborting the fork does NOT abort the parent', () => {
    const parent = createMockToolUseContext()
    const fork = deriveChildToolContext(parent)
    fork.cancelSource.abort('fork-only')
    expect(parent.cancelSource.signal.aborted).toBe(false)
  })

  it('if the parent is already aborted, the fork fires synchronously', () => {
    const parent = createMockToolUseContext()
    parent.cancelSource.abort('parent-already-cancelled')
    const fork = deriveChildToolContext(parent)
    expect(fork.cancelSource.signal.aborted).toBe(true)
    expect(fork.cancelSource.signal.reason).toBe('parent-already-cancelled')
  })

  it('inheritAbort=true uses the parent controller directly', () => {
    const parent = createMockToolUseContext()
    const fork = deriveChildToolContext(parent, { inheritAbort: true })
    expect(fork.cancelSource).toBe(parent.cancelSource)
  })

  it('explicit abortController override wins over the share flag', () => {
    const parent = createMockToolUseContext()
    const ownController = new AbortController()
    const fork = deriveChildToolContext(parent, {
      abortController: ownController,
      inheritAbort: true,
    })
    expect(fork.cancelSource).toBe(ownController)
    expect(fork.cancelSource).not.toBe(parent.cancelSource)
  })
})

describe('deriveChildToolContext — queryTracking', () => {
  it('starts depth at parent.depth + 1', () => {
    const parent = createMockToolUseContext({
      turnChain: { chainId: 'parent-chain', depth: 2 },
    })
    const fork = deriveChildToolContext(parent)
    expect(fork.turnChain?.chainId).toBe('parent-chain')
    expect(fork.turnChain?.depth).toBe(3)
  })

  it('starts depth at 0 when parent has no tracking', () => {
    const parent = createMockToolUseContext({ turnChain: undefined })
    const fork = deriveChildToolContext(parent)
    expect(fork.turnChain?.depth).toBe(0)
    expect(fork.turnChain?.chainId).toMatch(/^fork-/)
  })
})

describe('deriveChildToolContext — override slots', () => {
  it('inject custom options (e.g. different tool list)', () => {
    const parent = createMockToolUseContext()
    const customOptions = { ...parent.options, mainLoopModel: 'custom-model' }
    const fork = deriveChildToolContext(parent, { options: customOptions })
    expect(fork.options.mainLoopModel).toBe('custom-model')
  })

  it('inject custom messages', () => {
    const parent = createMockToolUseContext({ messages: [] })
    const customMessages = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'x' } },
    ] as unknown as ToolCallContext['messages']
    const fork = deriveChildToolContext(parent, { messages: customMessages })
    expect(fork.messages).toBe(customMessages)
  })
})

// ============================================================================
// launchFork — sub-session model selection (dictionary/router candidates)
// ============================================================================

describe('launchFork — sub-session model selection', () => {
  const queryMock = vi.mocked(runTurnLoop)
  const tokensMock = vi.mocked(estimateTranscriptTokens)

  const ALLOW_ALL = (async () => ({
    behavior: 'allow',
  })) as unknown as Parameters<typeof launchFork>[0]['canUseTool']

  let uuidSeq = 0
  const assistantOk = (text = 'done'): Message =>
    ({
      type: 'assistant',
      uuid: `fa-a-${uuidSeq++}`,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) as unknown as Message

  const assistantApiError = (): Message =>
    ({
      type: 'assistant',
      uuid: `fa-e-${uuidSeq++}`,
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'API error' }],
      },
    }) as unknown as Message

  const userPrompt = (): Message =>
    ({
      type: 'user',
      uuid: `fa-u-${uuidSeq++}`,
      message: { role: 'user', content: 'do the thing' },
    }) as unknown as Message

  const yieldOnce = (...messages: Message[]) => {
    queryMock.mockImplementationOnce((async function* () {
      for (const m of messages) yield m
    }) as never)
  }

  /** The envelope every test forks from: anthropic parent on sonnet @ max. */
  const makeParams = () => {
    const ctx = createMockToolUseContext()
    return captureForkPrefix({
      systemPrompt: 'sys',
      userContext: {},
      systemContext: {},
      toolUseContext: ctx,
      messages: [],
      providerId: 'anthropic',
      thinkingTier: 'max',
    })
  }

  const queryArg = (call: number) =>
    queryMock.mock.calls[call]![0] as unknown as {
      providerId?: string
      thinkingTier?: string
      callContext: ToolCallContext
    }

  beforeEach(() => {
    queryMock.mockReset()
    tokensMock.mockReset()
    tokensMock.mockReturnValue(0)
  })

  it('forwards the parent provider + thinking tier when the fork inherits (tier-drop fix)', async () => {
    yieldOnce(assistantOk())
    await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: makeParams(),
      canUseTool: ALLOW_ALL,
      querySource: 'extract_memories',
      forkLabel: 'tier-drop-fix',
    })
    expect(queryMock).toHaveBeenCalledTimes(1)
    const args = queryArg(0)
    expect(args.providerId).toBe('anthropic')
    expect(args.thinkingTier).toBe('max')
    expect(args.callContext.options.mainLoopModel).toBe('claude-sonnet-4-6')
  })

  it('applies the modelLadder head (model + provider + its own pinned tier, never the parent tier)', async () => {
    yieldOnce(assistantOk())
    await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: makeParams(),
      canUseTool: ALLOW_ALL,
      modelLadder: [
        { providerId: 'deepseek', modelId: 'ds-flash', thinkingTier: 'high' },
        { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      ],
      querySource: 'extract_memories',
      forkLabel: 'override',
    })
    const args = queryArg(0)
    expect(args.providerId).toBe('deepseek')
    expect(args.thinkingTier).toBe('high')
    expect(args.callContext.options.mainLoopModel).toBe('ds-flash')
    expect(args.callContext.options.mainLoopProviderId).toBe('deepseek')
  })

  it('a head on the parent model naming an effort (an Auto tier, no ladder) inherits the fork but runs that effort', async () => {
    yieldOnce(assistantOk())
    await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: makeParams(),
      canUseTool: ALLOW_ALL,
      modelLadder: [
        { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', thinkingTier: 'low' },
      ],
      querySource: 'extract_memories',
      forkLabel: 'auto-tier-effort',
    })
    const args = queryArg(0)
    expect(args.providerId).toBe('anthropic')
    expect(args.thinkingTier).toBe('low')
    expect(args.callContext.options.mainLoopModel).toBe('claude-sonnet-4-6')
  })

  it('an overridden fork without a pinned tier runs the model default — not the parent tier', async () => {
    yieldOnce(assistantOk())
    await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: makeParams(),
      canUseTool: ALLOW_ALL,
      modelLadder: [
        { providerId: 'deepseek', modelId: 'ds-flash' },
        { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      ],
      querySource: 'extract_memories',
      forkLabel: 'no-tier',
    })
    expect(queryArg(0).thinkingTier).toBeUndefined()
  })

  it('window gate: a known-window head that cannot fit the inherited prefix degrades to the parent', async () => {
    // claude-haiku-4-5 is catalogued (200K window) → the gate ENGAGES; the
    // estimated prefix (999_999 tokens) exceeds its blocking limit.
    tokensMock.mockReturnValue(999_999)
    yieldOnce(assistantOk())
    const appended: unknown[] = []
    await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: makeParams(),
      canUseTool: ALLOW_ALL,
      modelLadder: [
        { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
        { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      ],
      querySource: 'extract_memories',
      forkLabel: 'window-gate',
      sidechainStore: {
        append: async (_s: string, _a: string, entry: unknown) => {
          appended.push(entry)
        },
      } as never,
      spawnerSessionId: 'parent-1',
    })
    expect(queryMock).toHaveBeenCalledTimes(1)
    const args = queryArg(0)
    expect(args.callContext.options.mainLoopModel).toBe('claude-sonnet-4-6')
    // Back on the parent model ⇒ the parent tier is preserved.
    expect(args.thinkingTier).toBe('max')
    const meta = appended[0] as { modelSource?: string }
    expect(meta.modelSource).toBe('window-fallback')
  })

  it('window gate is SKIPPED for unknown-window models (the 200K default must not lie)', async () => {
    tokensMock.mockReturnValue(999_999)
    yieldOnce(assistantOk())
    await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: makeParams(),
      canUseTool: ALLOW_ALL,
      modelLadder: [
        { providerId: 'custom-openai', modelId: 'mystery-model' },
        { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      ],
      querySource: 'extract_memories',
      forkLabel: 'unknown-window',
    })
    expect(queryArg(0).callContext.options.mainLoopModel).toBe('mystery-model')
  })

  it('an overridden fork renders the system prompt for ITS model; an inheriting fork keeps the parent prompt', async () => {
    // The prompt profile (lean vs standard prose) is a property of the model
    // that answers. Replaying the parent's rendering on a policy-moved fork
    // sent e.g. Fable's lean `# Harness` prompt to Sonnet.
    const render = vi.fn(async (sel: { providerId?: string; modelId: string }) =>
      `sys-for-${sel.providerId}/${sel.modelId}`)
    const withRenderer = () => ({ ...makeParams(), renderSystemPromptForModel: render })

    yieldOnce(assistantOk())
    await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: withRenderer(),
      canUseTool: ALLOW_ALL,
      modelLadder: [
        { providerId: 'deepseek', modelId: 'ds-flash' },
        { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      ],
      querySource: 'extract_memories',
      forkLabel: 'render-override',
    })
    expect(render).toHaveBeenCalledWith({ providerId: 'deepseek', modelId: 'ds-flash' })
    expect((queryArg(0) as { baseInstructions?: unknown }).baseInstructions).toBe(
      'sys-for-deepseek/ds-flash',
    )

    // Inherit: the parent prompt IS the shared cache — never re-rendered.
    render.mockClear()
    yieldOnce(assistantOk())
    await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: withRenderer(),
      canUseTool: ALLOW_ALL,
      querySource: 'extract_memories',
      forkLabel: 'render-inherit',
    })
    expect(render).not.toHaveBeenCalled()
    expect((queryArg(1) as { baseInstructions?: unknown }).baseInstructions).toBe('sys')

    // A caller's explicit override (extract-memories / periodic tidy) wins over
    // both — that directive is the fork's whole prompt.
    yieldOnce(assistantOk())
    await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: withRenderer(),
      canUseTool: ALLOW_ALL,
      systemPromptOverride: 'directive',
      modelLadder: [
        { providerId: 'deepseek', modelId: 'ds-flash' },
        { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      ],
      querySource: 'extract_memories',
      forkLabel: 'render-directive',
    })
    expect(render).not.toHaveBeenCalled()
    expect((queryArg(2) as { baseInstructions?: unknown }).baseInstructions).toBe('directive')
  })

  it('the parent-model retry drives with the parent prompt again', async () => {
    const render = vi.fn(async () => 'sys-for-override')
    queryMock.mockImplementationOnce((async function* () {
      throw new Error('provider down')
    }) as never)
    yieldOnce(assistantOk('recovered'))
    await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: { ...makeParams(), renderSystemPromptForModel: render },
      canUseTool: ALLOW_ALL,
      modelLadder: [
        { providerId: 'deepseek', modelId: 'ds-flash' },
        { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      ],
      querySource: 'extract_memories',
      forkLabel: 'render-retry',
    })
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect((queryArg(0) as { baseInstructions?: unknown }).baseInstructions).toBe('sys-for-override')
    // Back on the parent model ⇒ back on the parent's rendering.
    expect((queryArg(1) as { baseInstructions?: unknown }).baseInstructions).toBe('sys')
  })

  it('retries ONCE on the parent tail when the overridden head throws', async () => {
    queryMock.mockImplementationOnce((async function* () {
      throw new Error('provider down')
    }) as never)
    yieldOnce(assistantOk('recovered'))
    const result = await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: makeParams(),
      canUseTool: ALLOW_ALL,
      modelLadder: [
        { providerId: 'deepseek', modelId: 'ds-flash' },
        { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      ],
      querySource: 'extract_memories',
      forkLabel: 'retry',
    })
    expect(queryMock).toHaveBeenCalledTimes(2)
    const second = queryArg(1)
    expect(second.providerId).toBe('anthropic')
    expect(second.thinkingTier).toBe('max')
    expect(second.callContext.options.mainLoopModel).toBe(
      'claude-sonnet-4-6',
    )
    const texts = result.messages.map(m =>
      JSON.stringify((m as { message?: unknown }).message),
    )
    expect(texts.some(t => t.includes('recovered'))).toBe(true)
  })

  it('a failed override records pin health for the matching dictionary pin', async () => {
    // The realm snapshot holds a `fast` pin naming the head that will fail —
    // the retry path must mark it so the Settings page can surface the rot.
    setSessionModelSettingsSnapshot({
      modelTiers: { fast: { providerId: 'deepseek', modelId: 'ds-flash' } },
    })
    queryMock.mockImplementationOnce((async function* () {
      throw new Error('invalid api key')
    }) as never)
    yieldOnce(assistantOk('recovered'))
    try {
      await launchFork({
        openingRows: [userPrompt()],
        forkPrefix: makeParams(),
        canUseTool: ALLOW_ALL,
        modelLadder: [
          { providerId: 'deepseek', modelId: 'ds-flash' },
          { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
        ],
        querySource: 'extract_memories',
        forkLabel: 'pin-health',
      })
      const rec = getPinFailureHealth().modelTiers.fast
      expect(rec).toMatchObject({
        count: 1,
        providerId: 'deepseek',
        modelId: 'ds-flash',
        lastError: 'invalid api key',
      })
    } finally {
      resetPinFailureLog()
      resetSessionModelSettingsSnapshot()
    }
  })

  it('retries when the first drive yields ONLY API-error assistants (terminal errors do not throw)', async () => {
    yieldOnce(assistantApiError())
    yieldOnce(assistantOk('second try'))
    const result = await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: makeParams(),
      canUseTool: ALLOW_ALL,
      modelLadder: [
        { providerId: 'deepseek', modelId: 'ds-flash' },
        { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      ],
      querySource: 'extract_memories',
      forkLabel: 'api-error-retry',
    })
    expect(queryMock).toHaveBeenCalledTimes(2)
    // The failed attempt's API-error message is dropped from the RESULT: a
    // consumer scanning every message (not just last-wins final text) sees
    // ONLY the successful retry, never the superseded error.
    const returned = result.messages as Array<{
      isApiErrorMessage?: boolean
      message?: { content?: Array<{ text?: string }> }
    }>
    expect(returned.some(m => m.isApiErrorMessage === true)).toBe(false)
    expect(
      returned.some(m =>
        m.message?.content?.some(c => c.text === 'second try'),
      ),
    ).toBe(true)
  })

  it('the fork\'s context carries the id it is recorded under (the SubagentStop agent_id)', async () => {
    // The fork's context and its sidechain transcript share ONE agentId. A
    // second `subagent_<rand>_<ts>` id once minted for the context meant a
    // SubagentStop hook's `agent_id` named no fork the user
    // could find in the transcript or the Background Tasks drawer.
    yieldOnce(assistantOk())
    const appended: Array<{ agentId: string }> = []
    const sidechainStore = {
      append: async (_parent: string, agentId: string) => {
        appended.push({ agentId })
      },
    } as unknown as Parameters<typeof launchFork>[0]['sidechainStore']
    const result = await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: makeParams(),
      canUseTool: ALLOW_ALL,
      querySource: 'skill_fork',
      forkLabel: 'e2esubstop',
      sidechainStore,
      spawnerSessionId: 'parent-1',
    })
    expect(result.agentId).toMatch(/^e2esubstop_/)
    expect(queryArg(0).callContext.agentId).toBe(result.agentId)
    expect(appended.length).toBeGreaterThan(0)
    expect(new Set(appended.map(a => a.agentId))).toEqual(new Set([result.agentId]))

    // An explicit id (a resumed fork) is the context's id too.
    yieldOnce(assistantOk())
    const resumed = await launchFork({
      openingRows: [userPrompt()],
      forkPrefix: makeParams(),
      canUseTool: ALLOW_ALL,
      querySource: 'skill_fork',
      forkLabel: 'e2esubstop',
      agentId: 'e2esubstop_resumed_1',
    })
    expect(resumed.agentId).toBe('e2esubstop_resumed_1')
    expect(queryArg(1).callContext.agentId).toBe('e2esubstop_resumed_1')
  })

  it('does NOT retry an inherit fork — the throw propagates unchanged', async () => {
    queryMock.mockImplementationOnce((async function* () {
      throw new Error('boom')
    }) as never)
    await expect(
      launchFork({
        openingRows: [userPrompt()],
        forkPrefix: makeParams(),
        canUseTool: ALLOW_ALL,
        querySource: 'extract_memories',
        forkLabel: 'no-retry',
      }),
    ).rejects.toThrow('boom')
    expect(queryMock).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// SubagentStart — the user's hooks see a sub-agent begin
// ============================================================================

describe('launchFork — SubagentStart', () => {
  const queryMock = vi.mocked(runTurnLoop)

  beforeEach(() => {
    queryMock.mockReset()
    queryMock.mockImplementation((async function* () {
      yield {
        type: 'assistant',
        uuid: 'sa-a',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      } as unknown as Message
    }) as never)
  })

  /** A parent whose mods hook `classic.SubagentStart` and answer it with
   *  context, recording what they were raised with. */
  const forkFrom = () => {
    const raised: Array<Record<string, unknown>> = []
    const ctx = createMockToolUseContext()
    ctx.options = {
      ...ctx.options,
      mods: {
        hasClassicHooks: (event: string) => event === 'SubagentStart',
        classic: async (_event: string, e: Record<string, unknown>) => {
          raised.push(e)
          return {
            settled: true,
            aggregate: { blocked: false, errors: [], warnings: [], additionalContext: ['FORK_CONTEXT'], systemMessages: [] },
          }
        },
      } as never,
    }
    const forkPrefix = captureForkPrefix({
      systemPrompt: 'sys',
      userContext: {},
      systemContext: {},
      toolUseContext: ctx,
      messages: [],
    })
    return { raised, forkPrefix }
  }

  const prompt = { type: 'user', uuid: 'sa-u', message: { role: 'user', content: 'go' } } as unknown as Message
  const sentTexts = () =>
    ((queryMock.mock.calls[0]![0] as unknown as { messages: Message[] }).messages).map(
      m => (m as { message?: { content?: unknown } }).message?.content,
    )

  it('a skill fork raises it with its agent id and type; the context follows the prompt', async () => {
    const { raised, forkPrefix } = forkFrom()
    const result = await launchFork({
      openingRows: [prompt],
      forkPrefix,
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
      querySource: 'skill_fork',
      forkLabel: 'skill',
      agentType: 'reviewer',
    })
    expect(raised).toEqual([
      expect.objectContaining({ hook_event_name: 'SubagentStart', agent_id: result.agentId, agent_type: 'reviewer' }),
    ])
    expect(sentTexts()).toEqual(['go', 'FORK_CONTEXT'])
  })

  it('an internal fork (memory extraction) raises nothing', async () => {
    const { raised, forkPrefix } = forkFrom()
    await launchFork({
      openingRows: [prompt],
      forkPrefix,
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
      querySource: 'extract_memories',
      forkLabel: 'extract',
    })
    expect(raised).toEqual([])
    expect(sentTexts()).toEqual(['go'])
  })
})
