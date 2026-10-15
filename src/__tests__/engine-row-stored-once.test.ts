import { describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
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

/** Every row a turn stores appears in the stored transcript, and in the
 *  engine's rows, exactly once: the per-row store, the end-of-turn store and
 *  the next turn's start from the store never add a second copy. */

function makeEngine(store: MemoryConversationStore) {
  const runtimeConfig = new DefaultRuntimeConfig()
  let appState: WorkingState = createEmptyAppState()
  let n = 0
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
    queryRuntimeDeps: assembleTurnDependencies(runtimeConfig, {
      callModel: (async function* () {
        n += 1
        yield {
          type: MSG_TYPE_ASSISTANT,
          uuid: `answer-${n}`,
          message: { role: ROLE_ASSISTANT, content: [{ type: PART_TEXT, text: `Answer ${n}.` }] },
        } as Message
      }) as never,
    }),
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: store,
    userInputPipeline: new NoopUserInputPipeline(runtimeConfig, true),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
    titleServices: { generateName: async () => null },
  })
}

function copiesByUuid(rows: readonly Message[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.uuid as string, (counts.get(row.uuid as string) ?? 0) + 1)
  return counts
}

describe('stored rows', () => {
  it('a row is stored exactly once across consecutive turns', async () => {
    const store = new MemoryConversationStore('stored-once')
    const engine = makeEngine(store)
    for (const uuid of ['prompt-1', 'prompt-2']) {
      for await (const _row of engine.submitTurn(`question ${uuid}`, { uuid })) {
        // run to the result row
      }
    }
    const stored = store.getRecordedMessages()
    for (const uuid of ['prompt-1', 'answer-1', 'prompt-2', 'answer-2']) {
      expect(copiesByUuid(stored).get(uuid), `${uuid} in the store`).toBe(1)
      expect(copiesByUuid(engine.transcriptRows()).get(uuid), `${uuid} in the engine`).toBe(1)
    }
    expect([...copiesByUuid(stored).values()].every(count => count === 1)).toBe(true)
  })
})
