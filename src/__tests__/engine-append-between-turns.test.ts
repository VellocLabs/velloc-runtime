import { describe, expect, it, vi } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type { WorkingState, Message } from '../runtime/RuntimeTypes'
import { makeNoticeRow } from '../messages/messageFactories'
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

/** Rows a runtime service adds outside the stream land between turns: at once when idle, after the turn in flight otherwise. */

const runtimeConfig = new DefaultRuntimeConfig()

function makeEngine(store: MemoryConversationStore, beforeAnswer: () => Promise<void> = async () => {}) {
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
        await beforeAnswer()
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

const uuids = (rows: readonly Message[]) => rows.map(row => row.uuid)

describe('rows appended between turns', () => {
  it('appends and stores at once while idle, and tells open pages', async () => {
    const store = new MemoryConversationStore('between-idle')
    const engine = makeEngine(store)
    const rewritten = vi.fn()
    engine.setConversationRewrittenListener(rewritten)
    const note = makeNoticeRow(runtimeConfig, 'note')
    await engine.appendBetweenTurns([note])
    expect(uuids(engine.transcriptRows())).toEqual([note.uuid])
    expect(uuids(store.getRecordedMessages())).toContain(note.uuid)
    expect(rewritten).toHaveBeenCalledTimes(1)
  })

  it('holds rows until the turn in flight ends, then appends them after its answer, in call order', async () => {
    const store = new MemoryConversationStore('between-turn')
    let entered!: () => void
    let release!: () => void
    const answering = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const engine = makeEngine(store, async () => { entered(); await gate })
    const turn = (async () => {
      for await (const _row of engine.submitTurn('question', { uuid: 'prompt-1' })) {
        // run to the result row
      }
    })()
    await answering
    const first = makeNoticeRow(runtimeConfig, 'first')
    const second = makeNoticeRow(runtimeConfig, 'second')
    const appended = Promise.all([engine.appendBetweenTurns([first]), engine.appendBetweenTurns([second])])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(uuids(engine.transcriptRows())).not.toContain(first.uuid)
    release()
    await turn
    await appended
    const rows = uuids(engine.transcriptRows())
    expect(rows.indexOf('answer-1')).toBeGreaterThan(-1)
    expect(rows.slice(rows.indexOf('answer-1') + 1)).toEqual([first.uuid, second.uuid])
    expect(uuids(store.getRecordedMessages())).toEqual(expect.arrayContaining([first.uuid, second.uuid]))
  })
})
