import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  BrowserConversationStore,
  SESSION_META_FILE_SCHEMA_VERSION,
  type BrowserConversationStorageBackend,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
  type SessionMetaFile,
} from '../sessions/sessionStore'

// ---------------------------------------------------------------------------
// A stale "last active" pointer (`restoredSessionId`) never re-creates a deleted session on disk, and every other
// session still is created (F-17: an empty New Thread survives a restart).
// ---------------------------------------------------------------------------

const SID = 'restored-session'

function makeRuntimeConfig(): RuntimeConfig {
  let counter = 0
  return {
    createUUID: () => `uuid-${++counter}`,
    createTimestamp: () => new Date(Date.now()).toISOString(),
    now: () => Date.now(),
    flagOn: () => false,
  } as unknown as RuntimeConfig
}

function userMsg(id: number): Message {
  return {
    type: 'user',
    uuid: `user-${id}`,
    message: { role: 'user', content: [{ type: 'text', text: `hello ${id}` }] },
  } as Message
}

/**
 * In-memory backend that records which sessions were WRITTEN to — either the
 * transcript (`append`) or `meta.json` (`writeSessionMeta`). Both mkdir the
 * directory on the real bridge backend, so "did a write run" is exactly "did
 * the session folder come back".
 */
function createBackend(): BrowserConversationStorageBackend & {
  written: string[]
  metas: Map<string, SessionMetaFile>
  seed: (sessionId: string, entries: BrowserTranscriptEntry[]) => void
  seedMeta: (meta: SessionMetaFile) => void
} {
  const records = new Map<string, BrowserTranscriptEntry[]>()
  const metas = new Map<string, SessionMetaFile>()
  const written: string[] = []
  return {
    written,
    metas,
    seed(sessionId, entries) {
      records.set(sessionId, JSON.parse(JSON.stringify(entries)))
    },
    seedMeta(meta) {
      metas.set(meta.sessionId, JSON.parse(JSON.stringify(meta)))
    },
    async append(sessionId: string, entry: BrowserTranscriptWriteEntry) {
      written.push(sessionId)
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
      written.push(sessionId)
      metas.set(sessionId, JSON.parse(JSON.stringify(meta)))
    },
    async flush() {},
  }
}

function metaFile(sessionId: string): SessionMetaFile {
  return {
    schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
    sessionId,
    updatedAt: 1_700_000_000_000,
    metadata: { messageCount: 0 },
  }
}

/** A pre-`meta.json` empty thread: one legacy `__session_meta` line, nothing
 *  else — the commonest boot state right after the upgrade. */
function legacyMetaLine(sessionId: string): BrowserTranscriptEntry {
  return {
    type: '__session_meta',
    sessionId,
    updatedAt: 1_700_000_000_000,
    metadata: { messageCount: 0 },
  } as unknown as BrowserTranscriptEntry
}

describe('a restored session pointer cannot re-create a deleted session', () => {
  it('writes nothing for a restored id with nothing on disk', async () => {
    const backend = createBackend()
    const store = new BrowserConversationStore({
      runtimeConfig: makeRuntimeConfig(),
      sessionId: SID,
      storageBackend: backend,
      restoredSessionId: true,
    })

    // The two writes that actually fired at boot in the reported bug: the
    // model-selection persist and the manager's bind-time backfill.
    await store.updateSessionMetadata({
      llmSelection: { providerId: 'openai', modelId: 'gpt-5.4-mini' },
    } as never)
    await store.updateSessionMetadata({ templateType: 'agent' })

    // Red without the fix: `written` holds two entries and the real backend
    // has mkdir'd the deleted session's folder.
    expect(backend.written, 'a stale pointer must not touch disk').toEqual([])
  })

  it('still persists a session the pointer names that DOES exist', async () => {
    const backend = createBackend()
    backend.seedMeta(metaFile(SID))
    const store = new BrowserConversationStore({
      runtimeConfig: makeRuntimeConfig(),
      sessionId: SID,
      storageBackend: backend,
      restoredSessionId: true,
    })

    await store.updateSessionMetadata({ templateType: 'agent' })

    // The pointer was current — this is an ordinary resume and its metadata
    // must keep persisting.
    expect(backend.written).toEqual([SID])
    expect(backend.metas.get(SID)?.metadata.templateType).toBe('agent')
  })

  it('a pre-meta.json empty thread is a real session, not a phantom', async () => {
    const backend = createBackend()
    // No `meta.json` yet, but the transcript carries the legacy metadata line
    // every pre-upgrade session has. Treating this as a phantom would drop its
    // model/permission/draft writes until the first message AND skip its
    // migration — so it must migrate on open and keep persisting.
    backend.seed(SID, [legacyMetaLine(SID)])
    const store = new BrowserConversationStore({
      runtimeConfig: makeRuntimeConfig(),
      sessionId: SID,
      storageBackend: backend,
      restoredSessionId: true,
    })

    await store.updateSessionMetadata({ templateType: 'agent' })

    expect(backend.metas.get(SID)?.metadata.templateType).toBe('agent')
    expect(backend.written.length).toBeGreaterThan(0)
  })

  it('still persists a session id this document minted', async () => {
    const backend = createBackend()
    const store = new BrowserConversationStore({
      runtimeConfig: makeRuntimeConfig(),
      sessionId: SID,
      storageBackend: backend,
      // No `restoredSessionId` — a New Thread, or the first-ever boot.
    })

    await store.updateSessionMetadata({ templateType: 'agent' })

    // An empty New Thread the user never typed into must survive a
    // restart, and this write is what makes that true.
    expect(backend.written).toEqual([SID])
    expect(backend.metas.has(SID)).toBe(true)
  })

  it('the first message makes a phantom real, metadata included', async () => {
    const backend = createBackend()
    const store = new BrowserConversationStore({
      runtimeConfig: makeRuntimeConfig(),
      sessionId: SID,
      storageBackend: backend,
      restoredSessionId: true,
    })

    // Suppressed while empty — and the in-memory value is still kept, so the
    // selection is not lost, only unwritten.
    await store.updateSessionMetadata({
      llmSelection: { providerId: 'openai', modelId: 'gpt-5.4-mini' },
    } as never)
    expect(backend.written).toEqual([])

    await store.saveTranscriptRows([userMsg(1)])

    // The message reopens the session for business: the transcript entry AND
    // the `meta.json` both land. Without the file the sidebar never lists it.
    const meta = await store.getSessionMetadata()
    expect(meta?.llmSelection).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.4-mini',
    })
    expect(
      backend.metas.get(SID)?.metadata.llmSelection,
      'a materialized session must carry a meta.json',
    ).toEqual({ providerId: 'openai', modelId: 'gpt-5.4-mini' })
    const stored = (await backend.load(SID)) as BrowserTranscriptEntry[]
    expect(stored.some(e => (e as { uuid?: string }).uuid === 'user-1')).toBe(
      true,
    )
    // And the log holds ONLY the message — metadata never rides the transcript.
    expect(
      stored.some(e => (e as { type?: string }).type === '__session_meta'),
    ).toBe(false)
  })

  it('a rename makes a phantom real — the user asked to keep it', async () => {
    const backend = createBackend()
    const store = new BrowserConversationStore({
      runtimeConfig: makeRuntimeConfig(),
      sessionId: SID,
      storageBackend: backend,
      restoredSessionId: true,
    })

    await store.updateSessionMetadata({ templateType: 'agent' })
    expect(backend.written).toEqual([])

    await store.storeUserTitle('keep me')

    const stored = (await backend.load(SID)) as BrowserTranscriptEntry[]
    expect(
      stored.some(e => (e as { customTitle?: string }).customTitle === 'keep me'),
      'a rename must not be silently dropped',
    ).toBe(true)
    expect(backend.metas.get(SID)?.customTitle).toBe('keep me')
  })
})
