// QueryEngine builds the system prompt with the turn's effective model (after `processUserInput`, which a skill's
// `model:` can change), and only for a turn that reaches the model. Pinned via what `fetchSystemPromptParts`
// receives.

import { describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type {
  FetchSystemPromptPartsParams,
  PromptContextProvider,
} from '../runtime/interfaces/PromptContextProvider'
import type {
  ProcessUserInputParams,
  ProcessUserInputResult,
  UserInputPipeline,
} from '../runtime/interfaces/UserInputPipeline'
import type { WorkingState, Message } from '../runtime/RuntimeTypes'
import {
  DefaultRuntimeConfig,
  MemoryConversationStore,
  NoopPlatformCapabilities,
  NoopSystemInitEmitter,
  createEmptyAppState,
  createMemoryFileStateCache,
} from '../runtime/testing/noopAdapters'
import { MSG_TYPE_ASSISTANT, ROLE_ASSISTANT } from '../runtime/VercelModelConstants'

class RecordingPromptContextProvider implements PromptContextProvider {
  readonly fetches: Array<{ mainLoopModel: string; providerId?: string }> = []
  async gatherSystemPromptSources(params: FetchSystemPromptPartsParams) {
    this.fetches.push({ mainLoopModel: params.mainLoopModel, providerId: params.providerId })
    return { defaultSystemPrompt: ['sys'], userContext: {}, systemContext: {} }
  }
}

/** A pipeline that, like a skill's `model:` frontmatter, may switch the model
 *  for the turn, and either queries (a prompt) or does not (a slash command
 *  that answered locally). */
class SwitchingPipeline implements UserInputPipeline {
  constructor(
    private readonly runtimeConfig: DefaultRuntimeConfig,
    private readonly shouldQuery: boolean,
    private readonly override?: { model: string; providerId?: string },
  ) {}
  async processUserInput(params: ProcessUserInputParams): Promise<ProcessUserInputResult> {
    return {
      messages: [
        {
          type: 'user',
          uuid: params.uuid ?? this.runtimeConfig.createUUID(),
          timestamp: this.runtimeConfig.createTimestamp(),
          message: { role: 'user', content: String(params.input) },
          isMeta: false,
        },
      ],
      shouldQuery: this.shouldQuery,
      resultText: String(params.input),
      ...(this.override ?? {}),
    }
  }
}

function makeEngine(opts: {
  shouldQuery: boolean
  userSpecifiedModel?: string
  userSpecifiedProviderId?: string
  override?: { model: string; providerId?: string }
}) {
  const runtimeConfig = new DefaultRuntimeConfig()
  const provider = new RecordingPromptContextProvider()
  let appState: WorkingState = createEmptyAppState()
  const engine = new ConversationEngine({
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
    // A querying turn needs a model: one plain assistant reply ends it.
    queryRuntimeDeps: assembleTurnDependencies(runtimeConfig, {
      callModel: async function* () {
        yield {
          type: MSG_TYPE_ASSISTANT,
          uuid: 'assistant-1',
          message: {
            role: ROLE_ASSISTANT,
            content: [{ type: 'text', text: 'ok' }],
          },
        } as Message
      },
    }),
    promptContextProvider: provider,
    conversationStore: new MemoryConversationStore('session-prompt-model'),
    userInputPipeline: new SwitchingPipeline(runtimeConfig, opts.shouldQuery, opts.override),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
    pickedModel: opts.userSpecifiedModel,
    userSpecifiedProviderId: opts.userSpecifiedProviderId,
  })
  return { engine, provider }
}

async function drain(engine: ConversationEngine): Promise<void> {
  for await (const _ of engine.submitTurn('hello', { uuid: 'u1' })) {
    // drain
  }
}

describe('QueryEngine — the system prompt is built for the turn\'s effective model', () => {
  it('a model override applied by processUserInput reaches the prompt fetch', async () => {
    const { engine, provider } = makeEngine({
      shouldQuery: true,
      userSpecifiedModel: 'claude-fable-5-1',
      userSpecifiedProviderId: 'anthropic',
      override: { model: 'claude-sonnet-5', providerId: 'anthropic' },
    })
    await drain(engine)
    expect(provider.fetches).toHaveLength(1)
    expect(provider.fetches[0]).toEqual({
      mainLoopModel: 'claude-sonnet-5',
      providerId: 'anthropic',
    })
  })

  it('without an override the session model is used', async () => {
    const { engine, provider } = makeEngine({
      shouldQuery: true,
      userSpecifiedModel: 'claude-fable-5-1',
      userSpecifiedProviderId: 'anthropic',
    })
    await drain(engine)
    expect(provider.fetches.map(f => f.mainLoopModel)).toEqual(['claude-fable-5-1'])
  })

  it('with no model chosen anywhere the fetch sees the literal "inherit" (⇒ the profile default)', async () => {
    const { engine, provider } = makeEngine({ shouldQuery: true })
    await drain(engine)
    expect(provider.fetches.map(f => f.mainLoopModel)).toEqual(['inherit'])
  })
})

describe('QueryEngine — a turn that never reaches the model never builds the prompt', () => {
  it('a no-query turn (a slash command answered locally) fetches no prompt context', async () => {
    // The fetch is bridge + fs I/O whose result nothing before `runQueryLoop`
    // reads; `/help`, `/status`, `/clear`, `/plugins`, … used to pay for it
    // on every invocation.
    const { engine, provider } = makeEngine({
      shouldQuery: false,
      userSpecifiedModel: 'claude-fable-5-1',
      userSpecifiedProviderId: 'anthropic',
    })
    await drain(engine)
    expect(provider.fetches).toEqual([])
  })
})
