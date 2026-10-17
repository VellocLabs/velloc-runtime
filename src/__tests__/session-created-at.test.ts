import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { projectSessionInfo } from '../browser/worker/sessionInfoProjection'
import {
  BrowserConversationStore,
  buildForkedTranscriptEntries,
  buildSessionSummaryFromMeta,
  SESSION_META_FILE_SCHEMA_VERSION,
  type BrowserConversationStorageBackend,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
  type SessionMetaFile,
} from '../sessions/sessionStore'

// A session's creation time is recorded once, by the runtime, and carried to
// the sidebar card: the "Date created" sort reads it. (F-17)

const SID = 'sess-created'
const T_CREATE = Date.parse('2026-09-01T08:00:00.000Z')
const T_LATER = Date.parse('2026-10-01T08:00:00.000Z')

class MemoryBackend implements BrowserConversationStorageBackend {
  readonly entries = new Map<string, BrowserTranscriptEntry[]>()
  readonly metas = new Map<string, SessionMetaFile>()

  async append(sessionId: string, entry: BrowserTranscriptWriteEntry): Promise<void> {
    const arr = this.entries.get(sessionId) ?? []
    arr.push(JSON.parse(JSON.stringify(entry)))
    this.entries.set(sessionId, arr)
  }

  async load(sessionId: string) {
    const arr = this.entries.get(sessionId)
    return arr ? (JSON.parse(JSON.stringify(arr)) as BrowserTranscriptEntry[]) : null
  }

  async readSessionMeta(sessionId: string) {
    const meta = this.metas.get(sessionId)
    return meta ? (JSON.parse(JSON.stringify(meta)) as SessionMetaFile) : null
  }

  async writeSessionMeta(sessionId: string, meta: SessionMetaFile) {
    this.metas.set(sessionId, JSON.parse(JSON.stringify(meta)) as SessionMetaFile)
  }

  async flush(): Promise<void> {}

  summary(sessionId: string) {
    const meta = this.metas.get(sessionId)
    return meta ? buildSessionSummaryFromMeta(meta) : null
  }
}

function makeStore(backend: MemoryBackend, clock: { value: number }) {
  let uuid = 0
  const runtimeConfig = {
    createUUID: () => `uuid-${uuid++}`,
    createTimestamp: () => new Date(clock.value).toISOString(),
    now: () => clock.value,
  } as unknown as RuntimeConfig
  return new BrowserConversationStore({
    runtimeConfig,
    sessionId: SID,
    storageBackend: backend,
  })
}

function userText(text: string): Message {
  return {
    type: 'user',
    uuid: `user-${text}`,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as Message
}

describe('session creation time', () => {
  it('a new session records its creation time on its first persist', async () => {
    const backend = new MemoryBackend()
    const clock = { value: T_CREATE }
    const store = makeStore(backend, clock)
    await store.saveTranscriptRows([userText('hello')])

    expect(backend.metas.get(SID)?.metadata.createdAt).toBe(T_CREATE)
    expect(backend.summary(SID)?.createdAt).toBe(T_CREATE)
  })

  it('later writes and a reload never move it', async () => {
    const backend = new MemoryBackend()
    const clock = { value: T_CREATE }
    await makeStore(backend, clock).saveTranscriptRows([userText('hello')])

    clock.value = T_LATER
    const reloaded = makeStore(backend, clock)
    await reloaded.saveTranscriptRows([userText('again')])
    await reloaded.updateSessionMetadata({ permissionMode: 'plan' })

    expect(backend.summary(SID)?.createdAt).toBe(T_CREATE)
    expect(backend.summary(SID)?.updatedAt).toBe(T_LATER)
  })

  it('a session persisted without one stays unknown — never stamped with a later visit', async () => {
    const backend = new MemoryBackend()
    const clock = { value: T_CREATE }
    await makeStore(backend, clock).saveTranscriptRows([userText('hello')])
    const legacy = backend.metas.get(SID)!
    delete legacy.metadata.createdAt

    clock.value = T_LATER
    const reopened = makeStore(backend, clock)
    await reopened.saveTranscriptRows([userText('again')])

    expect(backend.metas.get(SID)?.metadata.createdAt).toBeUndefined()
    expect(backend.summary(SID)?.createdAt).toBeUndefined()
  })

  it('a fork is created when it is forked, not when its source was', () => {
    const source: BrowserTranscriptEntry[] = [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 'old',
        parentUuid: null,
        timestamp: new Date(T_CREATE).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      } as unknown as BrowserTranscriptEntry,
    ]
    const built = buildForkedTranscriptEntries(source, 'u1', 'new', T_LATER, {
      createdAt: T_CREATE,
      templateType: 'code',
    })

    expect(built?.meta.metadata.createdAt).toBe(T_LATER)
  })

  const oneMessage: BrowserTranscriptEntry[] = [
    {
      type: 'user',
      uuid: 'u1',
      sessionId: 'old',
      parentUuid: null,
      timestamp: new Date(T_CREATE).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    } as unknown as BrowserTranscriptEntry,
  ]

  it('a rewind replaces its source: it keeps the source creation time and pin', () => {
    const built = buildForkedTranscriptEntries(
      oneMessage,
      'u1',
      'new',
      T_LATER,
      { createdAt: T_CREATE, pinned: true },
      undefined,
      { as: 'rewind' },
    )
    expect(built?.meta.metadata.createdAt).toBe(T_CREATE)
    expect(built?.meta.metadata.pinned).toBe(true)
  })

  it('a plain fork is not pinned, and an import has no creation time', () => {
    const fork = buildForkedTranscriptEntries(oneMessage, 'u1', 'new', T_LATER, {
      pinned: true,
    })
    expect(fork?.meta.metadata.pinned).toBeUndefined()
    const imported = buildForkedTranscriptEntries(
      oneMessage,
      'u1',
      'new',
      T_LATER,
      undefined,
      undefined,
      { as: 'import' },
    )
    expect(imported?.meta.metadata.createdAt).toBeUndefined()
  })

  it('ignores a malformed stored value', () => {
    const summary = buildSessionSummaryFromMeta({
      schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
      sessionId: SID,
      updatedAt: T_LATER,
      metadata: { createdAt: 'yesterday' as unknown as number },
    })
    expect(summary?.createdAt).toBeUndefined()
  })

  it('the sidebar card carries the persisted creation time', () => {
    const fs = buildSessionSummaryFromMeta({
      schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
      sessionId: SID,
      updatedAt: T_LATER,
      metadata: { createdAt: T_CREATE, firstPrompt: 'hello' },
    })!
    const card = projectSessionInfo({ sessionId: SID, entry: undefined, live: undefined, fs })

    expect(card?.createdAt).toBe(T_CREATE)
  })
})
