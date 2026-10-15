// `/plugins` reload swaps the engine's command registry — and the
// `deniedSkillNames` that describe it. A boot-time denied list left in place
// after a reload called a newly loaded, allowlist-denied plugin skill
// "unknown" (and kept calling a removed one "denied"): exactly the typo-hunt
// the field exists to prevent. The next turn's ToolUseContext must carry
// the reloaded list.

import { describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import type {
  ProcessUserInputParams,
  ProcessUserInputResult,
  UserInputPipeline,
} from '../runtime/interfaces/UserInputPipeline'
import type { WorkingState } from '../runtime/RuntimeTypes'
import {
  DefaultRuntimeConfig,
  MemoryConversationStore,
  NoopPlatformCapabilities,
  NoopPromptContextProvider,
  NoopSystemInitEmitter,
  createEmptyAppState,
  createMemoryFileStateCache,
} from '../runtime/testing/noopAdapters'

/** Records the `deniedSkillNames` each turn's context carried; never queries. */
class RecordingPipeline implements UserInputPipeline {
  readonly seen: Array<readonly string[] | undefined> = []
  constructor(private readonly runtimeConfig: DefaultRuntimeConfig) {}
  async processUserInput(params: ProcessUserInputParams): Promise<ProcessUserInputResult> {
    this.seen.push(params.context.options.deniedSkillNames)
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
      shouldQuery: false,
      resultText: String(params.input),
    }
  }
}

function makeEngine(
  reloaded: { deniedSkillNames?: readonly string[] } | null,
  extra: { plugins?: Array<{ name: string }>; allowlists?: Array<string[] | undefined> } = {},
) {
  const runtimeConfig = new DefaultRuntimeConfig()
  const pipeline = new RecordingPipeline(runtimeConfig)
  let appState: WorkingState = createEmptyAppState()
  const engine = new ConversationEngine({
    cwd: '/workspace',
    projectRoot: '/workspace',
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    deniedSkillNames: ['boot-denied'],
    ...(extra.plugins ? { plugins: extra.plugins } : {}),
    onReloadPlugins: async (allowlist?: string[]) => {
      extra.allowlists?.push(allowlist)
      return reloaded === null ? null : { commands: [], agents: [], plugins: [], ...reloaded }
    },
    decidePermission: async () => ({ behavior: 'allow' }),
    readAppState: () => appState,
    writeAppState: updater => {
      appState = updater(appState)
    },
    fileReadSeed: createMemoryFileStateCache(),
    platformCapabilities: new NoopPlatformCapabilities(),
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: new MemoryConversationStore('session-reload-denied'),
    userInputPipeline: pipeline,
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
  })
  return { engine, pipeline }
}

async function turn(engine: ConversationEngine, uuid: string): Promise<void> {
  for await (const _ of engine.submitTurn('hello', { uuid })) {
    // drain
  }
}

describe('QueryEngine.reloadPlugins — deniedSkillNames follow the reloaded registry', () => {
  it('the next turn carries the reloaded denied list, not the boot-time one', async () => {
    const { engine, pipeline } = makeEngine({ deniedSkillNames: ['plugin-denied'] })
    await turn(engine, 'u1')
    expect(await engine.refreshPluginSet([])).toBe(true)
    await turn(engine, 'u2')
    expect(pipeline.seen).toEqual([['boot-denied'], ['plugin-denied']])
  })

  it('a reload that denied nothing clears the boot-time list', async () => {
    const { engine, pipeline } = makeEngine({})
    await turn(engine, 'u1')
    await engine.refreshPluginSet([])
    await turn(engine, 'u2')
    expect(pipeline.seen).toEqual([['boot-denied'], []])
  })

  it('a failed reload leaves the list alone', async () => {
    const { engine, pipeline } = makeEngine(null)
    await turn(engine, 'u1')
    expect(await engine.refreshPluginSet([])).toBe(false)
    await turn(engine, 'u2')
    expect(pipeline.seen).toEqual([['boot-denied'], ['boot-denied']])
  })
})

// A reload with no list (every Settings write) used to pass the loaded
// plugins' MANIFEST names as the directory-walk allowlist, which matches
// FOLDER names: `compact-on-idle/` holds `idle-compact`, so it unloaded on
// any Settings write and a Settings enable of it never reached the walk. No
// list now reaches the runtime as none, which re-reads the enabled files.
describe('QueryEngine.reloadPlugins — no list is passed on as none', () => {
  it('hands the runtime no allowlist rather than the loaded plugins\' names', async () => {
    const allowlists: Array<string[] | undefined> = []
    const { engine } = makeEngine({}, { plugins: [{ name: 'idle-compact' }], allowlists })
    await engine.refreshPluginSet()
    await engine.refreshPluginSet(['compact-on-idle'])
    expect(allowlists).toEqual([undefined, ['compact-on-idle']])
  })
})
