/**
 * Resume-time trimming in `normalizeConversationState`: a tail of api_error retry records, synthetic
 * `isApiErrorMessage` turns, whitespace-only assistant turns and orphaned interrupt markers is trimmed so
 * "continue" starts from the last real turn.
 */

import { describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_SYSTEM,
  MSG_TYPE_USER,
  PART_TEXT,
  ROLE_ASSISTANT,
  ROLE_USER,
  SESSION_META_TYPE,
} from '../runtime/VercelModelConstants'
import {
  BrowserConversationStore,
  type BrowserConversationStorageBackend,
  type BrowserSessionMetadata,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
  type SessionMetaFile,
} from '../sessions/sessionStore'

const SID = 'sess-resume'

// ---------------------------------------------------------------------------
// Transcript entry builders (raw JSONL shapes as persisted on disk). They
// carry the `transcriptOrdinal` counter that files written by older builds
// have — the loader must tolerate it.
// ---------------------------------------------------------------------------

function userEntry(uuid: string, parentUuid: string | null, text: string, ordinal: number): unknown {
  return {
    type: MSG_TYPE_USER,
    uuid,
    parentUuid,
    sessionId: SID,
    transcriptOrdinal: ordinal,
    timestamp: '2026-07-22T17:35:31.407Z',
    message: { role: ROLE_USER, content: [{ type: PART_TEXT, text }] },
  }
}

function assistantEntry(
  uuid: string,
  parentUuid: string | null,
  text: string,
  ordinal: number,
  extra?: Record<string, unknown>,
): unknown {
  return {
    type: MSG_TYPE_ASSISTANT,
    uuid,
    parentUuid,
    sessionId: SID,
    transcriptOrdinal: ordinal,
    timestamp: '2026-07-22T17:35:32.000Z',
    message: { role: ROLE_ASSISTANT, content: [{ type: PART_TEXT, text }] },
    ...extra,
  }
}

function systemApiErrorEntry(uuid: string, parentUuid: string | null, ordinal: number): unknown {
  return {
    type: MSG_TYPE_SYSTEM,
    subtype: 'api_error',
    uuid,
    parentUuid,
    sessionId: SID,
    transcriptOrdinal: ordinal,
    timestamp: '2026-07-22T17:36:00.000Z',
    message: 'API Error: stream_idle_timeout (attempt 4/10)',
  }
}

function metaEntry(metadata: BrowserSessionMetadata, updatedAt = 100): unknown {
  return { type: SESSION_META_TYPE, sessionId: SID, updatedAt, metadata }
}

// ---------------------------------------------------------------------------
// Test backend + store
// ---------------------------------------------------------------------------

class TestBackend implements BrowserConversationStorageBackend {
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
    return this.metas.get(sessionId) ?? null
  }

  async writeSessionMeta(sessionId: string, meta: SessionMetaFile) {
    this.metas.set(sessionId, JSON.parse(JSON.stringify(meta)))
  }

  async flush(): Promise<void> {}
}

function makeRuntimeConfig(): RuntimeConfig {
  let clock = 1000
  let uuid = 0
  return {
    createUUID: () => `uuid-${uuid++}`,
    createTimestamp: () => '2026-01-01T00:00:00.000Z',
    now: () => ++clock,
  } as unknown as RuntimeConfig
}

async function loadRecordedMessages(rawEntries: unknown[]): Promise<readonly string[]> {
  const backend = new TestBackend()
  backend.entries.set(SID, JSON.parse(JSON.stringify(rawEntries)))
  const store = new BrowserConversationStore({
    runtimeConfig: makeRuntimeConfig(),
    sessionId: SID,
    storageBackend: backend,
  })
  const messages = await store.getRecordedMessages()
  return messages.map(m => m.uuid as string)
}

// ===========================================================================
// Resume trimming
// ===========================================================================

describe('resume trims broken trailing messages from the active chain', () => {
  it('trims a trailing isApiErrorMessage assistant turn', async () => {
    const uuids = await loadRecordedMessages([
      metaEntry({ firstPrompt: 'hi', messageCount: 1 }),
      userEntry('u1', null, 'hi', 0),
      assistantEntry('a1', 'u1', 'hello', 1),
      userEntry('u2', 'a1', 'do the thing', 2),
      assistantEntry('a-err', 'u2', 'API Error: stream_idle_timeout', 3, {
        isApiErrorMessage: true,
        error: 'server_error',
      }),
    ])
    // The error assistant is trimmed; chain ends at the last real user turn.
    expect(uuids).toEqual(['u1', 'a1', 'u2'])
  })

  it('trims system api_error retry records and the error assistant together', async () => {
    const uuids = await loadRecordedMessages([
      metaEntry({ firstPrompt: 'hi', messageCount: 1 }),
      userEntry('u1', null, 'fix it', 0),
      systemApiErrorEntry('sys1', 'u1', 1),
      systemApiErrorEntry('sys2', 'sys1', 2),
      assistantEntry('a-err', 'sys2', 'API Error: stream_idle_timeout', 3, {
        isApiErrorMessage: true,
      }),
    ])
    expect(uuids).toEqual(['u1'])
  })

  it('trims a whitespace-only assistant turn left by a mid-stream cancel', async () => {
    const uuids = await loadRecordedMessages([
      metaEntry({ firstPrompt: 'hi', messageCount: 1 }),
      userEntry('u1', null, 'hi', 0),
      assistantEntry('a1', 'u1', 'working on it', 1),
      assistantEntry('a-empty', 'a1', '', 2),
    ])
    expect(uuids).toEqual(['u1', 'a1'])
  })

  it('trims an orphaned [Request interrupted by user] marker after a broken assistant', async () => {
    const uuids = await loadRecordedMessages([
      metaEntry({ firstPrompt: 'hi', messageCount: 1 }),
      userEntry('u1', null, 'hi', 0),
      assistantEntry('a-empty', 'u1', '', 1),
      userEntry('u-int', 'a-empty', '[Request interrupted by user]', 2),
    ])
    // Both the empty assistant and its orphaned interrupt marker are trimmed.
    expect(uuids).toEqual(['u1'])
  })

  it('reproduces session 89e78a70 tail: error assistant + interrupt marker', async () => {
    const uuids = await loadRecordedMessages([
      metaEntry({ firstPrompt: 'fix crash', messageCount: 1 }),
      userEntry('u1', null, 'fix the DCHECK crash', 0),
      assistantEntry('a1', 'u1', 'Let me investigate.', 1),
      systemApiErrorEntry('sys1', 'a1', 2),
      assistantEntry('a-err', 'sys1', 'API Error: stream_idle_timeout', 3, {
        isApiErrorMessage: true,
      }),
      userEntry('u-int', 'a-err', '[Request interrupted by user]', 4),
    ])
    // Everything after the last real assistant turn is trimmed.
    expect(uuids).toEqual(['u1', 'a1'])
  })

  it('keeps a legitimate [Request interrupted by user] that follows a real assistant', async () => {
    const uuids = await loadRecordedMessages([
      metaEntry({ firstPrompt: 'hi', messageCount: 1 }),
      userEntry('u1', null, 'hi', 0),
      assistantEntry('a1', 'u1', 'here is a real answer', 1),
      userEntry('u-int', 'a1', '[Request interrupted by user]', 2),
    ])
    // The interrupt marker follows a REAL assistant, so it is NOT orphaned.
    expect(uuids).toEqual(['u1', 'a1', 'u-int'])
  })

  it('leaves a clean conversation untouched', async () => {
    const uuids = await loadRecordedMessages([
      metaEntry({ firstPrompt: 'hi', messageCount: 1 }),
      userEntry('u1', null, 'hi', 0),
      assistantEntry('a1', 'u1', 'hello', 1),
      userEntry('u2', 'a1', 'bye', 2),
      assistantEntry('a2', 'u2', 'goodbye', 3),
    ])
    expect(uuids).toEqual(['u1', 'a1', 'u2', 'a2'])
  })
})

// ===========================================================================
// The load path must NOT fabricate history: no persisted `[Request interrupted by user]` marker for an un-replied
// user turn. Recovery is the "Continue" affordance (browser-runtime-worker.test.ts).
// ===========================================================================

describe('load never rewrites the transcript for an un-replied user turn', () => {
  async function loadAndCount(rawEntries: unknown[]): Promise<{
    uuids: readonly string[]
    persistedCount: number
  }> {
    const backend = new TestBackend()
    backend.entries.set(SID, JSON.parse(JSON.stringify(rawEntries)) as BrowserTranscriptEntry[])
    const store = new BrowserConversationStore({
      runtimeConfig: makeRuntimeConfig(),
      sessionId: SID,
      storageBackend: backend,
    })
    const messages = await store.getRecordedMessages()
    return {
      uuids: messages.map(m => m.uuid as string),
      persistedCount: backend.entries.get(SID)!.length,
    }
  }

  it('leaves a first-prompt kill exactly as the crash left it', async () => {
    // The live repro shape (session c781f742): one prompt, no reply.
    const seeded = [
      metaEntry({ firstPrompt: 'test3', messageCount: 1 }),
      userEntry('u1', null, 'test3', 0),
    ]
    const { uuids, persistedCount } = await loadAndCount(seeded)
    expect(uuids, 'no synthetic marker may be appended').toEqual(['u1'])
    expect(persistedCount, 'the transcript file must not be rewritten').toBe(seeded.length)
  })

  it('leaves a kill whose tail is only api_error retry records as-is', async () => {
    const seeded = [
      metaEntry({ firstPrompt: 'test3', messageCount: 1 }),
      userEntry('u1', null, 'test3', 0),
      systemApiErrorEntry('sys1', 'u1', 1),
      systemApiErrorEntry('sys2', 'sys1', 2),
    ]
    const { uuids, persistedCount } = await loadAndCount(seeded)
    // The api_error records are trimmed from the ACTIVE chain (in memory,
    // pre-existing behavior) but nothing is written back.
    expect(uuids).toEqual(['u1'])
    expect(persistedCount).toBe(seeded.length)
  })
})
