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
// Parallel tool results survive a resume: `saveTranscriptRows` chains every message sequentially and ignores
// `sourceToolAssistantUUID`, so both parallel shapes form one linear chain and reload with zero message loss.
// ---------------------------------------------------------------------------

const SID = 'parallel-tr-sess'

function makeRuntimeConfig(): RuntimeConfig {
  let counter = 0
  return {
    createUUID: () => `uuid-${++counter}`,
    createTimestamp: () => new Date(Date.now()).toISOString(),
    now: () => Date.now(),
    flagOn: () => false,
  } as unknown as RuntimeConfig
}

function assistantWithToolCall(uuid: string, toolCallId: string): Message {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId, toolName: 'Read', args: {} },
      ],
    },
  } as unknown as Message
}

function toolResult(uuid: string, toolCallId: string, sourceAssistantUuid: string): Message {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId, result: `ok-${toolCallId}` },
      ],
    },
    toolUseResult: `ok-${toolCallId}`,
    // Nexus persistence IGNORES this field (sequential chaining). Stamped
    // here to mirror the real runtime shape (query.ts:374).
    sourceToolAssistantUUID: sourceAssistantUuid,
  } as unknown as Message
}

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

describe('parallel-tool resume orphaning (6-4-4 / 6-6-10)', () => {
  it('single assistant with N parallel tool-call blocks: all results survive reload', async () => {
    const backend = createSharedBackend()
    const config = makeRuntimeConfig()
    const store = new BrowserConversationStore({
      runtimeConfig: config,
      sessionId: SID,
      storageBackend: backend,
    })

    // ONE assistant message carrying 3 parallel tool-call blocks, then 3
    // tool_result user messages (the common Nexus shape).
    const assistant = {
      type: 'assistant',
      uuid: 'asst-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc-a', toolName: 'Read', args: {} },
          { type: 'tool-call', toolCallId: 'tc-b', toolName: 'Read', args: {} },
          { type: 'tool-call', toolCallId: 'tc-c', toolName: 'Read', args: {} },
        ],
      },
    } as unknown as Message
    const messages = [
      assistant,
      toolResult('tr-a', 'tc-a', 'asst-1'),
      toolResult('tr-b', 'tc-b', 'asst-1'),
      toolResult('tr-c', 'tc-c', 'asst-1'),
    ]
    await store.saveTranscriptRows(messages)

    // Reload from a fresh store (simulates resume).
    const reloaded = new BrowserConversationStore({
      runtimeConfig: config,
      sessionId: SID,
      storageBackend: backend,
    })
    const recovered = await reloaded.getRecordedMessages()
    // All 4 messages survive — nothing orphaned.
    expect(recovered.map(m => m.uuid)).toEqual(['asst-1', 'tr-a', 'tr-b', 'tr-c'])
  })

  it('MULTI-assistant parallel shape (N assistants sharing the turn): all survive reload', async () => {
    const backend = createSharedBackend()
    const config = makeRuntimeConfig()
    const store = new BrowserConversationStore({
      runtimeConfig: config,
      sessionId: SID,
      storageBackend: backend,
    })

    // The multi-assistant shape: 2 separate assistant messages (a single
    // stream yielding N envelopes, query.ts:944-947), each with its own
    // tool_use, each tool_result pointing (via sourceToolAssistantUUID) at its
    // own assistant. Persistence still chains it linearly.
    const messages = [
      assistantWithToolCall('asst-1', 'tc-1'),
      assistantWithToolCall('asst-2', 'tc-2'),
      toolResult('tr-1', 'tc-1', 'asst-1'),
      toolResult('tr-2', 'tc-2', 'asst-2'),
    ]
    await store.saveTranscriptRows(messages)

    const reloaded = new BrowserConversationStore({
      runtimeConfig: config,
      sessionId: SID,
      storageBackend: backend,
    })
    const recovered = await reloaded.getRecordedMessages()
    // The crux: even though tr-1/tr-2 carry sourceToolAssistantUUID pointing
    // at DIFFERENT assistants (which a parent-linked DAG would orphan), the
    // linear chain recovers ALL of them — no orphans.
    expect(recovered.map(m => m.uuid)).toEqual([
      'asst-1',
      'asst-2',
      'tr-1',
      'tr-2',
    ])
  })

  it('interleaved assistant/tool-result turns across many rounds: full chain survives', async () => {
    const backend = createSharedBackend()
    const config = makeRuntimeConfig()
    const store = new BrowserConversationStore({
      runtimeConfig: config,
      sessionId: SID,
      storageBackend: backend,
    })

    // 10 rounds of (assistant tool-call → tool result), recorded incrementally
    // as the query loop would. Proves a long multi-tool turn keeps a single
    // intact chain.
    const expected: string[] = []
    const running: Message[] = []
    for (let i = 0; i < 10; i++) {
      const asst = assistantWithToolCall(`asst-${i}`, `tc-${i}`)
      const tr = toolResult(`tr-${i}`, `tc-${i}`, `asst-${i}`)
      running.push(asst, tr)
      expected.push(`asst-${i}`, `tr-${i}`)
      await store.saveTranscriptRows(running)
    }

    const reloaded = new BrowserConversationStore({
      runtimeConfig: config,
      sessionId: SID,
      storageBackend: backend,
    })
    const recovered = await reloaded.getRecordedMessages()
    expect(recovered.length).toBe(20)
    expect(recovered.map(m => m.uuid)).toEqual(expected)
  })
})
