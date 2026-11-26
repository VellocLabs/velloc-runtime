import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import type { TitleServices } from '../engine/autoTitle'
import type { ProviderOutcomeEvent } from '../models/drivers/providerOutcome'
import { registerProviderRequestSeam, resetProviderRequestSeams } from '../models/drivers/providerRequestSeam'
import { driveMachine } from './engine-replay/decisions/driveMachine'
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
function makeEngine(
  callModel: (params: QueryModelCallParams) => AsyncGenerator<Message, void, unknown>,
  titleServices: Partial<TitleServices> = { generateName: async () => null },
) {
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
    titleServices,
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

  it('titles the session through the provider the turn moved to', async () => {
    let titledWith: string | undefined
    let failing!: () => void
    const inRetries = new Promise<void>(resolve => { failing = resolve })
    let titled!: () => void
    const titleAsked = new Promise<void>(resolve => { titled = resolve })
    const engine = makeEngine(
      async function* (params) {
        if (params.providerId === 'dead') {
          failing()
          await fired(params.superseded!)
          return
        }
        yield answer('answer-alive', 'from alive')
      },
      {
        generateName: async (_rows, context) => {
          titledWith = context.options.mainLoopProviderId
          titled()
          return null
        },
      },
    )
    const turn = runTurn(engine, 'question')
    await inRetries
    engine.setModelSelection({ providerId: 'alive', model: 'model-b' })
    await turn
    await titleAsked

    expect(titledWith).toBe('alive')
  })

  it('follows a pick back to a selection the model was switched away from', async () => {
    const sent: Sent[] = []
    let failing!: () => void
    const inRetries = new Promise<void>(resolve => { failing = resolve })
    const engine = makeEngine(async function* (params) {
      sent.push(sentOf(params))
      if (params.callContext.options.mainLoopModel === 'model-b') {
        failing()
        await fired(params.superseded!)
        return
      }
      yield answer('answer-a', 'from model-a')
    })
    engine.setModelSelection({ providerId: 'dead', model: 'model-a' })
    engine.switchModel('model-b')
    const turn = runTurn(engine, 'question')
    await inRetries
    engine.setModelSelection({ providerId: 'dead', model: 'model-a' })
    await turn

    expect(sent.map(call => call.model)).toEqual(['model-b', 'model-a'])
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

describe('a turn that moved takes the new model\'s limits', () => {
  const prompt = { type: 'user', message: { role: 'user', content: 'hello' } } as Message

  it('fits the context to the new window before asking again', () => {
    let asked = 0
    const run = driveMachine({
      model: [],
      state: { messages: [prompt], limits: { blockingLimitTokens: 1_000_000 } },
      other: (effect) => {
        if (effect.kind !== 'requestModel') return undefined
        asked += 1
        return { type: 'modelMoved', limits: { blockingLimitTokens: 0 }, identity: effect.identity }
      },
    })

    expect(asked).toBe(1)
    expect(run.effectKinds.filter(kind => kind === 'summarizeForCompaction')).toHaveLength(2)
    expect(run.conclusion).toMatchObject({ outcome: { reason: 'prompt_too_long' } })
  })

  it('brings a raised output allowance down to the new model\'s ceiling', () => {
    const sent: Array<number | undefined> = []
    driveMachine({
      model: [{ reply: 'answer' }],
      state: { messages: [prompt], outputTokenCapOverride: 64_000, limits: { outputCeilingTokens: 64_000 } },
      other: (effect) => {
        if (effect.kind !== 'requestModel') return undefined
        sent.push(effect.outputTokenCapOverride)
        return sent.length === 1
          ? { type: 'modelMoved', limits: { outputCeilingTokens: 8_000 }, identity: effect.identity }
          : undefined
      },
    })

    expect(sent).toEqual([64_000, 8_000])
  })
})

describe('the retry ladder gives a superseded call up', () => {
  afterEach(() => resetProviderRequestSeams())

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

  it('tells the provider\'s outcome hook the call failed, not that it was cancelled', async () => {
    vi.useFakeTimers()
    try {
      const outcomes: ProviderOutcomeEvent[] = []
      registerProviderRequestSeam('dead', { outcome: event => { outcomes.push(event) } })
      const { deps } = failingBridge()
      const drained = drain(deps.callModel(params(AbortSignal.abort())) as AsyncGenerator<unknown>)
      await vi.runAllTimersAsync()
      await drained

      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]).toMatchObject({ ok: false, finishReason: 'error' })
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
