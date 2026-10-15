import { describe, expect, it, vi } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import type { TitleServices } from '../engine/autoTitle'
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
} from '../runtime/testing/noopAdapters'
import { MSG_TYPE_ASSISTANT, PART_TEXT, ROLE_ASSISTANT } from '../runtime/VercelModelConstants'

/**
 * The background session title, driven through the engine's `titleServices`
 * injection point: which turns start an attempt, what a rename does to an
 * attempt in flight, and whose transport the attempt uses.
 */

type ModelCall = (...args: unknown[]) => AsyncGenerator<Message, void, unknown>

function makeEngine(
  runtimeConfig: DefaultRuntimeConfig,
  store: MemoryConversationStore,
  callModel: ModelCall,
  extra: { titleServices?: Partial<TitleServices>; runtimeScopeSignal?: AbortSignal } = {},
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
    conversationStore: store,
    userInputPipeline: new NoopUserInputPipeline(runtimeConfig, true),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
    ...extra,
  })
}

function reply(uuid: string, text: string, extra: Record<string, unknown> = {}): Message {
  return {
    type: MSG_TYPE_ASSISTANT,
    uuid,
    message: { role: ROLE_ASSISTANT, content: [{ type: PART_TEXT, text }] },
    ...extra,
  } as Message
}

async function drain(engine: ConversationEngine, uuid: string): Promise<void> {
  for await (const _row of engine.submitTurn('test prompt', { uuid })) {
    // the turn runs to its result row
  }
}

/** The attempt is never awaited by the turn: let a few macrotasks pass. */
async function letBackgroundRun(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('session title: which turns start an attempt', () => {
  it('a turn whose model call failed starts none', async () => {
    const generateName = vi.fn(async () => null)
    const engine = makeEngine(
      new DefaultRuntimeConfig(),
      new MemoryConversationStore('title-after-error'),
      async function* () {
        yield reply('a-err', 'API Error: connection refused', { isApiErrorMessage: true, error: 'server_error' })
      },
      { titleServices: { generateName } },
    )
    await drain(engine, 'user-fail')
    await letBackgroundRun()
    expect(generateName).not.toHaveBeenCalled()
  })

  it('a completed turn starts one', async () => {
    const generateName = vi.fn(async () => null)
    const engine = makeEngine(
      new DefaultRuntimeConfig(),
      new MemoryConversationStore('title-after-answer'),
      async function* () {
        yield reply('a-ok', 'Here is a helpful answer.')
      },
      { titleServices: { generateName } },
    )
    await drain(engine, 'user-ok')
    await letBackgroundRun()
    expect(generateName).toHaveBeenCalledTimes(1)
  })
})

describe('session title: a rename during an attempt', () => {
  it('drops a name that arrives after the cancel, though the store shows no title yet', async () => {
    let handName: (name: string) => void = () => {}
    const held = new Promise<string>(resolve => {
      handName = resolve
    })
    const saveTitle = vi.fn(async () => undefined)
    const engine = makeEngine(
      new DefaultRuntimeConfig(),
      new MemoryConversationStore('title-cancelled'),
      async function* () {
        yield reply('a-cancel', 'Here is a helpful answer.')
      },
      { titleServices: { generateName: () => held, readMetadata: async () => ({}), saveTitle } },
    )
    await drain(engine, 'user-cancel')
    await letBackgroundRun()
    engine.cancelAutoTitleGeneration()
    handName('A Generated Title')
    await letBackgroundRun()
    expect(saveTitle, 'a cancelled attempt never writes').not.toHaveBeenCalled()
  })
})

describe('session title: the transport an attempt uses', () => {
  it('goes through its own engine after a sibling engine in the same realm was disposed', async () => {
    const saveTitle = vi.fn(async () => undefined)
    let openA: () => void = () => {}
    const gateA = new Promise<void>(resolve => {
      openA = resolve
    })
    let markAtModel: () => void = () => {}
    const atModel = new Promise<void>(resolve => {
      markAtModel = resolve
    })
    let servedByA = 0
    const callModelA = async function* (params: { querySource: string }) {
      if (params.querySource === 'rename_generate_name') {
        servedByA += 1
        yield reply('a-title', 'Fix Search Popup Hit Detection')
        return
      }
      markAtModel()
      await gateA
      yield reply('a-answer', 'Here is a helpful answer.')
    }
    let disposedB = false
    let refusedByB = 0
    const callModelB = async function* (params: { querySource: string }) {
      if (disposedB) {
        refusedByB += 1
        throw new DOMException('Runtime scope was disposed.', 'AbortError')
      }
      yield reply('b-row', params.querySource === 'rename_generate_name' ? 'Background Research' : 'background result')
    }
    const storeA = new MemoryConversationStore('title-engine-a')
    const engineA = makeEngine(new DefaultRuntimeConfig(), storeA, callModelA as never, { titleServices: { saveTitle } })
    const engineB = makeEngine(new DefaultRuntimeConfig(), new MemoryConversationStore('title-engine-b'), callModelB as never, {
      titleServices: { saveTitle: async () => undefined },
    })

    const turnA = drain(engineA, 'user-a')
    await atModel
    await drain(engineB, 'user-b')
    await letBackgroundRun()
    disposedB = true
    openA()
    await turnA
    await letBackgroundRun()

    expect(refusedByB, 'no call of A reaches the disposed transport').toBe(0)
    expect(servedByA).toBe(1)
    expect(saveTitle).toHaveBeenCalledWith('Fix Search Popup Hit Detection', storeA)
  })
})

describe('runtime scope signal', () => {
  it('reaches the call context the model call sees', async () => {
    const scope = new AbortController()
    let seen: AbortSignal | undefined
    const engine = makeEngine(
      new DefaultRuntimeConfig(),
      new MemoryConversationStore(),
      (async function* (params: { callContext: { options: { runtimeScopeSignal?: AbortSignal } } }) {
        seen = params.callContext.options.runtimeScopeSignal
        yield reply('a1', 'ok')
      }) as never,
      { runtimeScopeSignal: scope.signal, titleServices: { generateName: async () => null } },
    )
    await drain(engine, 'scope-signal-1')
    expect(seen).toBe(scope.signal)
  })
})
