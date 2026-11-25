import { describe, expect, it, vi } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import type { QueryModelCallParams } from '../engine/turn/modelCallTypes'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type { WorkingState, Message } from '../runtime/RuntimeTypes'
import {
  DefaultRuntimeConfig,
  MemoryConversationStore,
  NoopPlatformCapabilities,
  NoopPromptContextProvider,
  NoopSystemInitEmitter,
  NoopUserInputPipeline,
  createEmptyAppState,
  createMemoryFileStateCache,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { MSG_TYPE_ASSISTANT, PART_TEXT, ROLE_ASSISTANT } from '../runtime/VercelModelConstants'

/**
 * A request that is being retried follows the session's selection: once the
 * selection moves, the failing provider is not sent to again and the request
 * goes where the selection points.
 */

const runtimeConfig = new DefaultRuntimeConfig()

type Sent = { providerId: string | undefined; model: string; thinkingTier: string | undefined }

const sentOf = (params: QueryModelCallParams): Sent => ({
  providerId: params.providerId,
  model: params.callContext.options.mainLoopModel,
  thinkingTier: params.thinkingTier,
})

/** An engine whose model call is `callModel`, on provider `dead`, model `model-a`. */
function makeEngine(callModel: (params: QueryModelCallParams) => AsyncGenerator<Message, void, unknown>) {
  let appState: WorkingState = createEmptyAppState()
  return new ConversationEngine({
    cwd: '/workspace',
    projectRoot: '/workspace',
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    decidePermission: async () => ({ behavior: 'allow' }),
    readAppState: () => appState,
    writeAppState: updater => {
      appState = updater(appState)
    },
    fileReadSeed: createMemoryFileStateCache(),
    platformCapabilities: new NoopPlatformCapabilities(),
    queryRuntimeDeps: assembleTurnDependencies(runtimeConfig, { callModel: callModel as never }),
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: new MemoryConversationStore('retry-follows-switch'),
    userInputPipeline: new NoopUserInputPipeline(runtimeConfig, true),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
    titleServices: { generateName: async () => null },
    userSpecifiedProviderId: 'dead',
    pickedModel: 'model-a',
  })
}

const answer = (uuid: string, text: string): Message =>
  ({
    type: MSG_TYPE_ASSISTANT,
    uuid,
    message: { role: ROLE_ASSISTANT, content: [{ type: PART_TEXT, text }] },
  }) as Message

/** Resolves when `signal` fires. */
const fired = (signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })

async function runTurn(engine: ConversationEngine, text: string): Promise<void> {
  for await (const _row of engine.submitTurn(text, { uuid: `prompt-${text}` })) {
    // run to the result row
  }
}

describe('a turn follows the selection while its request is retried', () => {
  it('sends the request again to the newly selected provider and model', async () => {
    const sent: Sent[] = []
    let failing!: () => void
    const inRetries = new Promise<void>(resolve => { failing = resolve })
    const engine = makeEngine(async function* (params) {
      sent.push(sentOf(params))
      if (params.providerId === 'dead') {
        // The ladder's contract: a failing call ends with no message once
        // the selection it was built for is gone.
        failing()
        await fired(params.superseded!)
        return
      }
      yield answer('answer-alive', 'from alive')
    })
    const turn = runTurn(engine, 'question')
    await inRetries
    engine.setModelSelection({ providerId: 'alive', model: 'model-b', thinkingTier: 'high' })
    await turn

    expect(sent).toEqual([
      { providerId: 'dead', model: 'model-a', thinkingTier: undefined },
      { providerId: 'alive', model: 'model-b', thinkingTier: 'high' },
    ])
    expect(engine.transcriptRows().map(row => row.uuid)).toContain('answer-alive')
  })

  it('keeps the rest of the turn on the provider it moved to', async () => {
    const sent: Sent[] = []
    let failing!: () => void
    const inRetries = new Promise<void>(resolve => { failing = resolve })
    let answers = 0
    const engine = makeEngine(async function* (params) {
      sent.push(sentOf(params))
      if (params.providerId === 'dead') {
        failing()
        await fired(params.superseded!)
        return
      }
      answers += 1
      yield answer(`answer-${answers}`, `answer ${answers}`)
    })
    const turn = runTurn(engine, 'first')
    await inRetries
    engine.setModelSelection({ providerId: 'alive', model: 'model-b' })
    await turn
    await runTurn(engine, 'second')

    expect(sent.map(call => call.providerId)).toEqual(['dead', 'alive', 'alive'])
  })

  it('leaves a request that does not fail where it was sent', async () => {
    const sent: Sent[] = []
    let streaming!: () => void
    const started = new Promise<void>(resolve => { streaming = resolve })
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const engine = makeEngine(async function* (params) {
      sent.push(sentOf(params))
      streaming()
      await gate
      yield answer('answer-a', 'from the first provider')
    })
    const turn = runTurn(engine, 'question')
    await started
    engine.setModelSelection({ providerId: 'alive', model: 'model-b' })
    finish()
    await turn

    expect(sent).toEqual([{ providerId: 'dead', model: 'model-a', thinkingTier: undefined }])
  })

  it('does not give a request up when the selection is set to what it already is', async () => {
    let signal: AbortSignal | undefined
    let asked!: () => void
    const calling = new Promise<void>(resolve => { asked = resolve })
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const engine = makeEngine(async function* (params) {
      signal = params.superseded
      asked()
      await gate
      yield answer('answer-a', 'answered')
    })
    const turn = runTurn(engine, 'question')
    await calling
    engine.setModelSelection({ providerId: 'dead', model: 'model-a' })
    expect(signal?.aborted).toBe(false)
    engine.setModelSelection({ providerId: 'alive', model: 'model-a' })
    expect(signal?.aborted).toBe(true)
    finish()
    await turn
  })
})

describe('the retry ladder gives a superseded call up', () => {
  /** A bridge whose every stream fails with a retryable 503. */
  function failingBridge() {
    const starts: number[] = []
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string } }) => {
        switch (req.route.action) {
          case 'streamStart':
            starts.push(Date.now())
            return { ok: true as const, result: { streamId: `s-${starts.length}` } }
          case 'streamRead':
            return {
              ok: true as const,
              result: {
                done: true,
                chunks: [{ type: 'error', error: { type: 'provider_error', message: 'HTTP 503 service unavailable' } }],
              },
            }
          default:
            return { ok: false as const, error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` } }
        }
      },
    }
    const deps = assembleTurnDependencies(runtimeConfig, {}, { bridgeTransport: transport as never, runtimeConfig })
    return { deps, starts }
  }

  function params(superseded: AbortSignal): QueryModelCallParams {
    return {
      messages: [{ type: 'user', uuid: 'user-1', message: { role: 'user', content: 'hello' } } as Message],
      baseInstructions: 'test',
      userContext: {},
      systemAmbient: {},
      callContext: createNoopToolUseContext({
        tools: [],
        platformCapabilities: new NoopPlatformCapabilities(),
        appState: createEmptyAppState(),
        setAppState: () => {},
      }),
      querySource: 'test',
      providerId: 'dead',
      superseded,
    } as QueryModelCallParams
  }

  async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
    const out: unknown[] = []
    for await (const value of gen) out.push(value)
    return out
  }

  const assistants = (values: unknown[]) =>
    values.filter(value => (value as { type?: string } | null)?.type === MSG_TYPE_ASSISTANT)

  it('ends a backoff at once and sends nothing more', async () => {
    vi.useFakeTimers()
    try {
      const { deps, starts } = failingBridge()
      const moved = new AbortController()
      const drained = drain(deps.callModel(params(moved.signal)) as AsyncGenerator<unknown>)
      await vi.advanceTimersByTimeAsync(0)
      expect(starts).toHaveLength(1)
      moved.abort()
      await vi.advanceTimersByTimeAsync(0)
      const values = await drained
      await vi.runAllTimersAsync()

      expect(starts).toHaveLength(1)
      expect(assistants(values)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry an attempt that fails after the selection moved', async () => {
    vi.useFakeTimers()
    try {
      const { deps, starts } = failingBridge()
      const drained = drain(deps.callModel(params(AbortSignal.abort())) as AsyncGenerator<unknown>)
      await vi.runAllTimersAsync()
      const values = await drained

      expect(starts).toHaveLength(1)
      expect(assistants(values)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
