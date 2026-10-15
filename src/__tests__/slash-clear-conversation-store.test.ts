// `/clear` clears the STORE's conversation, not only the engine's list (every turn hydrates from the store). Runs on
// the production store over the production bridge-fs backend.

import { describe, expect, it } from 'vitest'

import { BridgeFsConversationStorageBackend } from '../browser/storage/BridgeFsSessionStorage'
import { ConversationEngine } from '../engine/conversationEngine'
import type {
  ProcessUserInputParams,
  ProcessUserInputResult,
  UserInputPipeline,
} from '../runtime/interfaces/UserInputPipeline'
import type { WorkingState, Message } from '../runtime/RuntimeTypes'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  NoopPromptContextProvider,
  NoopSystemInitEmitter,
  createEmptyAppState,
  createMemoryFileStateCache,
} from '../runtime/testing/noopAdapters'
import { BrowserConversationStore } from '../sessions/sessionStore'
import { noteSkillUse, skillsUsedBy } from '../skillLibrary/invokedSkillsStore'

// ── An in-memory filesystem behind the bridge transport ──────────────────

const DECODER = new TextDecoder()

function fakeFs() {
  const files = new Map<string, Uint8Array>()
  const transport = {
    async request(request: { id: string; route: { capability: string; action: string }; payload: any }) {
      await Promise.resolve()
      const op = `${request.route.capability}.${request.route.action}`
      const payload = request.payload ?? {}
      const ok = (result: unknown) => ({ id: request.id, ok: true, result })
      const fail = (code: string) => ({ id: request.id, ok: false, error: { code, message: code } })
      switch (op) {
        case 'fs.appendFile': {
          const prev = files.get(payload.path) ?? new Uint8Array(0)
          const next = new Uint8Array(prev.length + payload.data.length)
          next.set(prev)
          next.set(payload.data, prev.length)
          files.set(payload.path, next)
          return ok(null)
        }
        case 'fs.writeFile':
          files.set(payload.path, payload.content)
          return ok(null)
        case 'fs.readFile': {
          const file = files.get(payload.path)
          return file ? ok(file) : fail('NOT_FOUND')
        }
        case 'fs.readBatch':
          return fail('UNKNOWN_ACTION')
        default:
          return ok(null)
      }
    },
  }
  const backend = () => new BridgeFsConversationStorageBackend({ transport: transport as never, basePath: '/p' })
  const transcript = () => {
    const path = [...files.keys()].find(p => p.endsWith('transcript.jsonl'))!
    return DECODER.decode(files.get(path))
  }
  return { backend, transcript }
}

const SID = 'S'

function store(backend: BridgeFsConversationStorageBackend) {
  return new BrowserConversationStore({
    runtimeConfig: new DefaultRuntimeConfig(),
    sessionId: SID,
    storageBackend: backend,
  })
}

const T0 = '2026-10-03T00:00:00.000Z'

const user = (uuid: string, text: string): Message =>
  ({ type: 'user', uuid, timestamp: T0, message: { role: 'user', content: text } }) as unknown as Message

const assistant = (uuid: string, text: string): Message =>
  ({
    type: 'assistant', uuid, timestamp: T0,
    message: { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'text', text }] },
  }) as unknown as Message

const uuids = (messages: readonly Message[]) => messages.map(m => m.uuid)

// ── The store ────────────────────────────────────────────────────────────

describe('BrowserConversationStore.startNewConversation', () => {
  it('drops the recorded conversation; what is recorded next is all the model gets', async () => {
    const fs = fakeFs()
    const s = store(fs.backend())
    await s.saveTranscriptRows([user('p1', 'PROMPT_ONE'), assistant('a1', 'answer 0')])

    await s.startNewConversation()
    expect(await s.hydrateMessagesForModel()).toEqual([])

    await s.saveTranscriptRows([user('c1', '/clear')])
    await s.saveTranscriptRows([user('c1', '/clear'), user('p2', 'PROMPT_TWO')])
    expect(uuids(await s.hydrateMessagesForModel())).toEqual(['c1', 'p2'])
    expect(uuids(await s.getRecordedMessages())).toEqual(['c1', 'p2'])
  })

  it('a message with no uuid after /clear is recorded — not taken for the cleared one at its index', async () => {
    const fs = fakeFs()
    const s = store(fs.backend())
    const bare = (text: string): Message =>
      ({ type: 'user', timestamp: T0, message: { role: 'user', content: text } }) as unknown as Message
    await s.saveTranscriptRows([bare('BEFORE'), assistant('a1', 'answer 0')])
    await s.startNewConversation()
    await s.saveTranscriptRows([bare('AFTER')])
    await s.saveTranscriptRows([bare('AFTER')])
    expect(texts(await s.hydrateMessagesForModel())).toEqual(['AFTER'])
    // …and after a reload, a new one is not taken for one on disk.
    const reopened = store(fs.backend())
    const loaded = await reopened.getRecordedMessages()
    await reopened.saveTranscriptRows([...loaded, bare('LATER')])
    expect(texts(await reopened.hydrateMessagesForModel())).toEqual(['AFTER', 'LATER'])
  })

  it('survives a reload: the cleared messages stay on disk, off the active chain', async () => {
    const fs = fakeFs()
    const s = store(fs.backend())
    await s.saveTranscriptRows([user('p1', 'PROMPT_ONE'), assistant('a1', 'answer 0')])
    await s.startNewConversation()
    await s.saveTranscriptRows([user('c1', '/clear'), user('p2', 'PROMPT_TWO')])

    // The log is append-only — nothing was rewritten.
    expect(fs.transcript()).toContain('PROMPT_ONE')

    const reopened = store(fs.backend())
    expect(uuids(await reopened.hydrateMessagesForModel())).toEqual(['c1', 'p2'])
    // And the reopened store keeps appending to the NEW chain.
    await reopened.saveTranscriptRows([assistant('a2', 'answer 1')])
    const again = store(fs.backend())
    expect(uuids(await again.getRecordedMessages())).toEqual(['c1', 'p2', 'a2'])
  })
})

// ── The engine, on the production store ──────────────────────────────────

/** Never queries — each turn is a local echo; `/clear` reports the `clear`
 *  action the way the real pipeline does. */
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

function makeEngine(conversationStore: BrowserConversationStore) {
  const runtimeConfig = new DefaultRuntimeConfig()
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
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore,
    userInputPipeline: new EchoPipeline(runtimeConfig),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
  })
}

async function turn(engine: ConversationEngine, input: string, uuid: string): Promise<void> {
  for await (const _ of engine.submitTurn(input, { uuid })) {
    // drain
  }
}

const texts = (messages: readonly Message[]) =>
  messages.map(m => (m as { message?: { content?: unknown } }).message?.content)

describe('QueryEngine /clear on the production conversation store', () => {
  it('the turn after /clear does not get the cleared conversation back', async () => {
    const fs = fakeFs()
    const engine = makeEngine(store(fs.backend()))

    await turn(engine, 'PROMPT_ONE', 'u1')
    await turn(engine, '/clear', 'u-clear')
    expect(texts(engine.transcriptRows())).toEqual(['/clear'])

    // The next submit re-hydrates from the store before anything else.
    await turn(engine, 'PROMPT_TWO', 'u2')
    expect(texts(engine.transcriptRows())).toEqual(['/clear', 'PROMPT_TWO'])

    // A reopened session (fresh store + engine over the same files) agrees.
    const reopened = makeEngine(store(fs.backend()))
    await turn(reopened, 'PROMPT_THREE', 'u3')
    expect(texts(reopened.transcriptRows())).toEqual(['/clear', 'PROMPT_TWO', 'PROMPT_THREE'])
  })

  it('bumps the conversation epoch on /clear only', async () => {
    const engine = makeEngine(store(fakeFs().backend()))
    await turn(engine, 'PROMPT_ONE', 'u1')
    expect(engine.getConversationEpoch()).toBe(0)
    await turn(engine, '/clear', 'u-clear')
    expect(engine.getConversationEpoch()).toBe(1)
    await turn(engine, 'PROMPT_TWO', 'u2')
    expect(engine.getConversationEpoch()).toBe(1)
  })

  it('a store that cannot start the new conversation leaves the engine holding the old one too', async () => {
    const s = store(fakeFs().backend())
    const engine = makeEngine(s)
    await turn(engine, 'PROMPT_ONE', 'u1')
    s.startNewConversation = async () => {
      throw new Error('storage read failed')
    }
    await expect(turn(engine, '/clear', 'u-clear')).rejects.toThrow('storage read failed')
    // Not half-cleared: the engine agrees with the store it hydrates from.
    expect(texts(engine.transcriptRows())).toEqual(['PROMPT_ONE'])
    expect(engine.getConversationEpoch()).toBe(0)
  })

  it("forgets the main loop's invoked skills — a sub-agent's stay", async () => {
    const engine = makeEngine(store(fakeFs().backend()))
    await turn(engine, 'PROMPT_ONE', 'u1')
    const sid = engine.boundSessionId()
    noteSkillUse(sid, 'cleared-skill', '/s/a', 'BODY A')
    noteSkillUse(sid, 'agent-skill', '/s/b', 'BODY B', 'agent-1')
    await turn(engine, '/clear', 'u-clear')
    expect([...skillsUsedBy(sid).keys()]).toEqual([])
    expect(skillsUsedBy(sid, 'agent-1').size).toBe(1)
  })
})
