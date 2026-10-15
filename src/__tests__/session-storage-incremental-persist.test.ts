import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  BrowserConversationStore,
  type BrowserConversationStorageBackend,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
  type SessionMetaFile,
} from '../sessions/sessionStore'

// ---------------------------------------------------------------------------
// Store-level contract for incremental persistence: messages recorded one at a time each persist, and a fresh
// store loading from the same backend recovers all of them.
// ---------------------------------------------------------------------------

const SID = 'crash-recovery-sess'

function makeRuntimeConfig(): RuntimeConfig {
  let counter = 0
  return {
    createUUID: () => `uuid-${++counter}`,
    createTimestamp: () => new Date(Date.now()).toISOString(),
    now: () => Date.now(),
    flagOn: () => false,
  } as unknown as RuntimeConfig
}

function assistantMsg(id: number): Message {
  return {
    type: 'assistant',
    uuid: `assistant-${id}`,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `tool call ${id}` }],
    },
  } as Message
}

function toolResultMsg(id: number): Message {
  return {
    type: 'user',
    uuid: `tool-result-${id}`,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: `tc-${id}`, result: `ok ${id}` }],
    },
    toolUseResult: {},
  } as Message
}

/** In-memory backend that survives "crash" (store recreation). */
function createSharedBackend(): BrowserConversationStorageBackend {
  const records = new Map<string, BrowserTranscriptEntry[]>()
  const metas = new Map<string, SessionMetaFile>()
  return {
    async append(sessionId: string, entry: BrowserTranscriptWriteEntry) {
      const existing = records.get(sessionId) ?? []
      existing.push(JSON.parse(JSON.stringify(entry)))
      records.set(sessionId, existing)
    },
    async load(sessionId: string) {
      const entries = records.get(sessionId)
      return entries ? JSON.parse(JSON.stringify(entries)) : null
    },
    async readSessionMeta(sessionId: string) {
      return metas.get(sessionId) ?? null
    },
    async writeSessionMeta(sessionId: string, meta: SessionMetaFile) {
      metas.set(sessionId, JSON.parse(JSON.stringify(meta)))
    },
    async flush() {},
  }
}

describe('incremental persistence (crash-recovery regression)', () => {
  it('messages recorded one-at-a-time all survive a store recreation', async () => {
    const backend = createSharedBackend()
    const config = makeRuntimeConfig()

    // Simulate a 50-tool-invocation turn: 50 assistant + 50 tool_result
    // messages, each flushed individually (the fixed behavior).
    const store1 = new BrowserConversationStore({
      runtimeConfig: config,
      sessionId: SID,
      storageBackend: backend,
    })

    const allMessages: Message[] = []
    for (let i = 0; i < 50; i++) {
      const assistant = assistantMsg(i)
      const toolResult = toolResultMsg(i)
      allMessages.push(assistant, toolResult)
      // Incremental flush: record the growing array after each message pair
      // (mimics flushYieldedQueryMessages after each yield).
      await store1.saveTranscriptRows(allMessages)
    }

    // "Crash" — create a fresh store from the same backend (simulates restart).
    const store2 = new BrowserConversationStore({
      runtimeConfig: config,
      sessionId: SID,
      storageBackend: backend,
    })

    const recovered = await store2.getRecordedMessages()
    // All 100 messages (50 assistant + 50 tool_result) must survive.
    expect(recovered.length).toBe(100)
    // Verify the LAST tool result is present (the specific bug: last turn lost).
    const lastMsg = recovered[recovered.length - 1]
    expect(lastMsg?.uuid).toBe('tool-result-49')
  })

  it('deduplication prevents double-recording on incremental flushes', async () => {
    const backend = createSharedBackend()
    const config = makeRuntimeConfig()

    const store = new BrowserConversationStore({
      runtimeConfig: config,
      sessionId: SID,
      storageBackend: backend,
    })

    const msg = assistantMsg(0)
    // Record the same message 3 times (simulates repeated flush calls).
    await store.saveTranscriptRows([msg])
    await store.saveTranscriptRows([msg])
    await store.saveTranscriptRows([msg])

    const recovered = await store.getRecordedMessages()
    // Only one copy should exist.
    expect(recovered.length).toBe(1)
    expect(recovered[0]?.uuid).toBe('assistant-0')
  })

  it('a partial turn (crash mid-stream) recovers exactly what was flushed', async () => {
    const backend = createSharedBackend()
    const config = makeRuntimeConfig()

    const store1 = new BrowserConversationStore({
      runtimeConfig: config,
      sessionId: SID,
      storageBackend: backend,
    })

    // Simulate: 10 messages flushed, then crash before message 11.
    const flushed: Message[] = []
    for (let i = 0; i < 10; i++) {
      flushed.push(assistantMsg(i))
      await store1.saveTranscriptRows(flushed)
    }
    // Messages 10-49 were never flushed (crash).

    const store2 = new BrowserConversationStore({
      runtimeConfig: config,
      sessionId: SID,
      storageBackend: backend,
    })

    const recovered = await store2.getRecordedMessages()
    expect(recovered.length).toBe(10)
    expect(recovered[9]?.uuid).toBe('assistant-9')
  })
})
