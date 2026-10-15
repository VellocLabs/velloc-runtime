// T0-c browser observation short-circuit — the guest-side invalidation
// contract. The C++ ToolSession keeps a "last full observation the model
// received" baseline keyed by session id; a QueryEngine is constructed per
// session open (fresh / restored / forked) while that ToolSession may still
// be warm from an earlier guest lifetime, so the engine's FIRST settings push
// must clear the baseline. Later pushes must NOT clear it unless the caller
// asked (/clear, /compact, autocompact do; an ordinary next turn does not),
// otherwise every turn would throw away the stub's savings.

import { describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import type { PlatformCapabilities } from '../runtime/interfaces/PlatformCapabilities'
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

type SettingsPush = {
  browserObservationDiffOptIn?: boolean
  clearBrowserObservationCache?: boolean
  clearReadState?: boolean
}

/**
 * Never queries — each turn is a local echo, so only the settings push
 * matters. `/clear` is reported as the `clear` action the way the real
 * pipeline does, so the engine runs its clear path.
 */
class EchoPipeline implements UserInputPipeline {
  constructor(private readonly runtimeConfig: DefaultRuntimeConfig) {}
  async processUserInput(params: ProcessUserInputParams): Promise<ProcessUserInputResult> {
    return {
      ...(String(params.input) === '/clear' ? { action: 'clear' as const } : {}),
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

class RecordingPlatformCapabilities extends NoopPlatformCapabilities {
  readonly pushes: SettingsPush[] = []
  readonly session: PlatformCapabilities['session'] = {
    onStop: async () => ({ ok: true as const, stopped: false }),
    setAgentLoopSettings: async (params: SettingsPush) => {
      this.pushes.push({
        browserObservationDiffOptIn: params.browserObservationDiffOptIn,
        clearBrowserObservationCache: params.clearBrowserObservationCache,
        clearReadState: params.clearReadState,
      })
      return { ok: true as const }
    },
  } as PlatformCapabilities['session']
}

function makeEngine() {
  const runtimeConfig = new DefaultRuntimeConfig()
  const platformCapabilities = new RecordingPlatformCapabilities()
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
    platformCapabilities,
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: new MemoryConversationStore('session-obs-cache'),
    userInputPipeline: new EchoPipeline(runtimeConfig),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
  })
  return { engine, platformCapabilities }
}

async function turn(engine: ConversationEngine, uuid: string): Promise<void> {
  for await (const _ of engine.submitTurn('hello', { uuid })) {
    // drain
  }
}

describe('QueryEngine — browser observation cache invalidation (T0-c)', () => {
  it('the first settings push of an engine clears the host baseline; a later plain turn does not', async () => {
    const { engine, platformCapabilities } = makeEngine()
    await turn(engine, 'u1')
    await turn(engine, 'u2')
    const pushes = platformCapabilities.pushes
    expect(pushes.length).toBeGreaterThanOrEqual(2)
    // Boot push: opt-in handshake + cache clear ride together.
    expect(pushes[0]).toMatchObject({
      browserObservationDiffOptIn: true,
      clearBrowserObservationCache: true,
    })
    // Every later push still opts in, but leaves the baseline alone.
    for (const p of pushes.slice(1)) {
      expect(p.browserObservationDiffOptIn).toBe(true)
      expect(p.clearBrowserObservationCache).toBeUndefined()
    }
  })

  it('/clear pushes the cache clear again after boot', async () => {
    const { engine, platformCapabilities } = makeEngine()
    await turn(engine, 'u1')
    const before = platformCapabilities.pushes.length
    for await (const _ of engine.submitTurn('/clear', { uuid: 'u-clear' })) {
      // drain
    }
    const after = platformCapabilities.pushes.slice(before)
    expect(after.some(p => p.clearBrowserObservationCache === true && p.clearReadState === true)).toBe(
      true,
    )
  })

  it('a second engine over the same session id clears again (restore / fork)', async () => {
    const a = makeEngine()
    await turn(a.engine, 'u1')
    const b = makeEngine()
    await turn(b.engine, 'u1')
    expect(b.platformCapabilities.pushes[0]?.clearBrowserObservationCache).toBe(true)
  })
})
