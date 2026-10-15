import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import { SessionSummaryRepository } from '../browser/worker/SessionSummaryRepository'
import { projectSessionInfo } from '../browser/worker/sessionInfoProjection'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  CUSTOM_TITLE_TYPE,
  SESSION_META_TYPE,
} from '../runtime/VercelModelConstants'
import {
  BrowserConversationStore,
  buildSessionSummaryFromMeta,
  extractLatestSessionSummaryFromText,
  type BrowserConversationStorageBackend,
  type BrowserSessionMetadata,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
  type SessionMetaFile,
} from '../sessions/sessionStore'

// ---------------------------------------------------------------------------
// The sidebar's `updatedAt` is an ACTIVITY clock (last message), not a write clock: metadata writes on opening a
// session must not move its row. The first block exercises the legacy tail extractor (the one-time migration's
// parser); the store block pins the same rule on `meta.json`.
// ---------------------------------------------------------------------------

const SID = 'sess-activity'

const T_MSG = Date.parse('2026-06-01T10:00:00.000Z')
const T_OPEN = Date.parse('2026-07-30T00:29:56.000Z') // a much later "visit"

function jsonl(...entries: unknown[]): string {
  return entries.map(entry => JSON.stringify(entry)).join('\n')
}

function msgEntryFor(
  sessionId: string,
  text: string,
  timestamp: number,
): unknown {
  return {
    type: 'user',
    uuid: `u-${text}`,
    sessionId,
    parentUuid: null,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function msgEntry(text: string, timestamp: number): unknown {
  return msgEntryFor(SID, text, timestamp)
}

function metaEntry(updatedAt: number, metadata: BrowserSessionMetadata): unknown {
  return { type: SESSION_META_TYPE, sessionId: SID, updatedAt, metadata }
}

const BASE_META: BrowserSessionMetadata = {
  firstPrompt: 'hello',
  previewText: 'hello',
  messageCount: 1,
}

describe('persisted summary updatedAt (fs tail read)', () => {
  it('ignores a metadata-only write that lands long after the last message', () => {
    // Exactly the on-disk shape a visit produces: the message, its meta
    // record, then a second meta record written weeks later when the session
    // was merely OPENED (model selection re-persisted at init).
    const text = jsonl(
      msgEntry('hello', T_MSG),
      metaEntry(T_MSG, BASE_META),
      metaEntry(T_OPEN, { ...BASE_META, llmSelection: { providerId: 'kimi', modelId: 'k3' } }),
    )

    const summary = extractLatestSessionSummaryFromText(SID, text)

    expect(summary?.updatedAt).toBe(T_MSG)
    // ...and the newest metadata still wins for everything else.
    expect(summary?.messageCount).toBe(1)
  })

  it('advances when a NEW message arrives', () => {
    const later = T_MSG + 60_000
    const text = jsonl(
      msgEntry('hello', T_MSG),
      metaEntry(T_MSG, BASE_META),
      msgEntry('again', later),
      metaEntry(later, { ...BASE_META, messageCount: 2 }),
    )

    expect(extractLatestSessionSummaryFromText(SID, text)?.updatedAt).toBe(later)
  })

  it('a manual rename still floats the row (custom-title time wins)', () => {
    const renamedAt = T_MSG + 3_600_000
    const text = jsonl(
      msgEntry('hello', T_MSG),
      metaEntry(T_MSG, BASE_META),
      { type: CUSTOM_TITLE_TYPE, sessionId: SID, customTitle: 'Pinned', updatedAt: renamedAt },
      metaEntry(renamedAt, BASE_META),
    )

    const summary = extractLatestSessionSummaryFromText(SID, text)
    expect(summary?.customTitle).toBe('Pinned')
    expect(summary?.updatedAt).toBe(renamedAt)
  })

  it('falls back to the meta record for a draft-only session (no messages)', () => {
    const text = jsonl(
      metaEntry(T_OPEN, {
        messageCount: 0,
        composerDraft: 'unsent thought',
        lastComposerEditAt: T_OPEN,
      }),
    )

    expect(extractLatestSessionSummaryFromText(SID, text)?.updatedAt).toBe(T_OPEN)
  })

  it('falls back to the meta record when messages carry no timestamp (legacy transcripts)', () => {
    const text = jsonl(
      { type: 'user', uuid: 'u-legacy', sessionId: SID, message: { role: 'user', content: 'hi' } },
      metaEntry(T_OPEN, BASE_META),
    )

    expect(extractLatestSessionSummaryFromText(SID, text)?.updatedAt).toBe(T_OPEN)
  })
})

// ---------------------------------------------------------------------------

class TestBackend implements BrowserConversationStorageBackend {
  readonly entries = new Map<string, BrowserTranscriptEntry[]>()
  readonly metas = new Map<string, SessionMetaFile>()
  /** Every `meta.json` write, in order — the persisted clock's history. */
  readonly metaWrites: SessionMetaFile[] = []

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
    const copy = JSON.parse(JSON.stringify(meta)) as SessionMetaFile
    this.metas.set(sessionId, copy)
    this.metaWrites.push(copy)
  }

  async flush(): Promise<void> {}

  /** The sidebar row as the list path builds it — from `meta.json`. */
  summary(sessionId: string) {
    const meta = this.metas.get(sessionId)
    return meta ? buildSessionSummaryFromMeta(meta) : null
  }

  metaUpdatedAts(sessionId: string): number[] {
    return this.metaWrites
      .filter(meta => meta.sessionId === sessionId)
      .map(meta => meta.updatedAt)
  }
}

/** Wall clock the store reads through `now()` / `createTimestamp()`. */
function makeStore(backend: TestBackend, clock: { value: number }) {
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

describe('BrowserConversationStore activity clock', () => {
  it('a metadata write does NOT advance updatedAt — opening a session cannot reorder the sidebar', async () => {
    const backend = new TestBackend()
    const clock = { value: T_MSG }
    const store = makeStore(backend, clock)
    await store.saveTranscriptRows([userText('hello')])

    // Weeks later the session is merely OPENED: the model controller finds the
    // persisted selection disabled and re-persists, the permission coordinator
    // seeds a mode, the manager backfills templateType.
    clock.value = T_OPEN
    await store.updateSessionMetadata({
      llmSelection: { providerId: 'kimi', modelId: 'k3' },
    })
    await store.updateSessionMetadata({ permissionMode: 'default' })
    await store.updateSessionMetadata({ templateType: 'code' })

    // Every `meta.json` written carries the ACTIVITY time, not the visit time.
    for (const updatedAt of backend.metaUpdatedAts(SID)) {
      expect(updatedAt).toBe(T_MSG)
    }
    // ...and the sidebar reads it back unchanged.
    expect(backend.summary(SID)?.updatedAt).toBe(T_MSG)
    // The metadata itself did land.
    expect((await store.getSessionMetadata())?.templateType).toBe('code')
  })

  it('a new message DOES advance updatedAt', async () => {
    const backend = new TestBackend()
    const clock = { value: T_MSG }
    const store = makeStore(backend, clock)
    await store.saveTranscriptRows([userText('hello')])

    clock.value = T_OPEN
    await store.saveTranscriptRows([userText('again')])

    expect(backend.summary(SID)?.updatedAt).toBe(T_OPEN)
  })

  it('a rename DOES advance updatedAt (row floats)', async () => {
    const backend = new TestBackend()
    const clock = { value: T_MSG }
    const store = makeStore(backend, clock)
    await store.saveTranscriptRows([userText('hello')])

    clock.value = T_OPEN
    await store.storeUserTitle('Pinned')

    const summary = backend.summary(SID)
    expect(summary?.customTitle).toBe('Pinned')
    expect(summary?.updatedAt).toBe(T_OPEN)
  })

  it('seeds the clock for a session that has no activity yet (draft-only row)', async () => {
    const backend = new TestBackend()
    const clock = { value: T_OPEN }
    const store = makeStore(backend, clock)

    // No transcript at all — just a persisted composer draft.
    await store.updateSessionMetadata({
      composerDraft: 'unsent',
      lastComposerEditAt: T_OPEN,
    })

    // Not 0: a never-messaged session must still sort somewhere sane.
    expect(backend.metaUpdatedAts(SID)).toEqual([T_OPEN])
    expect(backend.summary(SID)?.updatedAt).toBe(T_OPEN)
  })

  it('a reloaded store keeps the activity clock — later writes do not resurrect the visit time', async () => {
    const backend = new TestBackend()
    const clock = { value: T_MSG }
    await makeStore(backend, clock).saveTranscriptRows([userText('hello')])

    // Fresh process (new tab / relaunch) opens the session and writes metadata.
    clock.value = T_OPEN
    const reloaded = makeStore(backend, clock)
    await reloaded.updateSessionMetadata({ permissionMode: 'plan' })

    expect(backend.metaUpdatedAts(SID).at(-1)).toBe(T_MSG)
    expect(backend.summary(SID)?.updatedAt).toBe(T_MSG)
  })

  it('a message the projection never saw moves the clock on open (log wins)', async () => {
    const backend = new TestBackend()
    const clock = { value: T_MSG }
    await makeStore(backend, clock).saveTranscriptRows([userText('hello')])

    // The transcript append landed; the meta rewrite did not (crash between
    // the two). On the next open the log is authoritative and the projection
    // is healed — the row moves to where the message says it belongs.
    const T_LATE = T_OPEN + 1
    await backend.append(SID, {
      type: 'user',
      uuid: 'user-late',
      sessionId: SID,
      parentUuid: 'user-hello',
      transcriptOrdinal: 1,
      timestamp: new Date(T_LATE).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'late' }] },
    } as unknown as BrowserTranscriptWriteEntry)
    expect(backend.summary(SID)?.updatedAt).toBe(T_MSG)

    clock.value = T_OPEN + 60_000
    const reloaded = makeStore(backend, clock)
    await reloaded.getSessionMetadata()

    expect(backend.summary(SID)?.updatedAt).toBe(T_LATE)
    expect(backend.summary(SID)?.messageCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------

/**
 * The end-to-end invariant behind the reported bug: for ONE transcript, the row
 * the sidebar shows for a CLOSED session (persisted summary) and the row it
 * broadcasts once the session is OPEN (live overlay, fed by the streamed
 * transcript) must carry the SAME `updatedAt` — otherwise clicking a session
 * re-sorts the list under the cursor.
 */
describe('sidebar row identity across an open', () => {
  const SESSION = 'S-open'
  // Written by an EARLIER visit: the message, then a metadata-only write weeks
  // later (persisted model selection at init) that used to become the row's
  // sort key.
  const TRANSCRIPT = jsonl(
    msgEntryFor(SESSION, 'hi', T_MSG),
    { type: SESSION_META_TYPE, sessionId: SESSION, updatedAt: T_MSG, metadata: BASE_META },
    {
      type: SESSION_META_TYPE,
      sessionId: SESSION,
      updatedAt: T_OPEN,
      metadata: { ...BASE_META, llmSelection: { providerId: 'kimi', modelId: 'k3' } },
    },
  )

  function makeRepo() {
    const host = {
      tracer: { span: () => ({ traceId: '', spanId: '', end: () => {} }) },
      onPreloadComplete: vi.fn(),
      notifySessionUpserted: vi.fn(),
    }
    const storageCoordinator = { getStorage: () => undefined }
    return new SessionSummaryRepository(
      storageCoordinator as never,
      host as never,
    )
  }

  it('the closed row and the opened row agree on updatedAt', () => {
    const repo = makeRepo()
    const fs = extractLatestSessionSummaryFromText(SESSION, TRANSCRIPT)!
    expect(fs).not.toBeNull()

    // CLOSED: nothing live, the sidebar sorts by the persisted summary.
    const closed = projectSessionInfo({
      sessionId: SESSION,
      entry: undefined,
      live: undefined,
      fs,
    })

    // OPEN: the worker boots and streams the transcript into the live overlay
    // (`worker.messages`), which then wins in the projection.
    repo.updateSessionMeta(SESSION, [
      {
        type: 'user',
        timestamp: new Date(T_MSG).toISOString(),
        message: { content: [{ type: 'text', text: 'hi' }] },
      },
    ])
    const opened = projectSessionInfo({
      sessionId: SESSION,
      entry: {
        snapshot: { initialized: true, messageCount: 1 },
      } as never,
      live: repo.liveMeta.get(SESSION),
      fs,
    })

    // Red-without-fix: `closed` carried the visit time (T_OPEN) while `opened`
    // carried the message time (T_MSG) — a 2-month jump in list position.
    expect(closed?.updatedAt).toBe(T_MSG)
    expect(opened?.updatedAt).toBe(closed?.updatedAt)
  })

  // The same invariant for a RENAMED session — the half the live overlay
  // cannot compute on its own. The persisted clock folds the `custom-title`
  // time in (a rename floats the row); the live overlay only sees the
  // streamed transcript, so it reports the last MESSAGE time. With `live ??
  // fs`, opening the session used to swap the rename time back out for the
  // (older) message time and the row dropped down the list under the cursor.
  const RENAMED = 'S-renamed'
  const RENAMED_TRANSCRIPT = jsonl(
    msgEntryFor(RENAMED, 'hi', T_MSG),
    { type: SESSION_META_TYPE, sessionId: RENAMED, updatedAt: T_MSG, metadata: BASE_META },
    // The user renamed the thread long after its last message.
    {
      type: CUSTOM_TITLE_TYPE,
      sessionId: RENAMED,
      customTitle: 'Pinned thread',
      updatedAt: T_OPEN,
    },
    { type: SESSION_META_TYPE, sessionId: RENAMED, updatedAt: T_OPEN, metadata: BASE_META },
  )

  it('a renamed session keeps its rename-time sort key when it is opened', () => {
    const repo = makeRepo()
    const fs = extractLatestSessionSummaryFromText(RENAMED, RENAMED_TRANSCRIPT)!
    expect(fs.customTitle).toBe('Pinned thread')

    const closed = projectSessionInfo({
      sessionId: RENAMED,
      entry: undefined,
      live: undefined,
      fs,
    })

    // Opening it: the worker streams the transcript, so the live overlay learns
    // the last MESSAGE time (T_MSG) and knows nothing about the rename.
    repo.updateSessionMeta(RENAMED, [
      {
        type: 'user',
        timestamp: new Date(T_MSG).toISOString(),
        message: { content: [{ type: 'text', text: 'hi' }] },
      },
    ])
    expect(repo.liveMeta.get(RENAMED)?.updatedAt).toBe(T_MSG)

    const opened = projectSessionInfo({
      sessionId: RENAMED,
      entry: { snapshot: { initialized: true, messageCount: 1 } } as never,
      live: repo.liveMeta.get(RENAMED),
      fs,
    })

    // Red-without-fix: `opened.updatedAt` was T_MSG — two months earlier than
    // the row the user clicked, so the row jumped down the sidebar.
    expect(closed?.updatedAt).toBe(T_OPEN)
    expect(opened?.updatedAt).toBe(closed?.updatedAt)
  })

  it('a live turn still wins while the fs summary lags behind it', () => {
    const repo = makeRepo()
    // The persisted summary is still the pre-turn one (refreshFsSummary has
    // not landed yet) — the streamed message must still float the row.
    const fs = extractLatestSessionSummaryFromText(SESSION, TRANSCRIPT)!
    const T_NEW_MSG = T_OPEN + 60_000

    repo.updateSessionMeta(SESSION, [
      {
        type: 'user',
        timestamp: new Date(T_NEW_MSG).toISOString(),
        message: { content: [{ type: 'text', text: 'another one' }] },
      },
    ])

    const streaming = projectSessionInfo({
      sessionId: SESSION,
      entry: { snapshot: { initialized: true, messageCount: 2 } } as never,
      live: repo.liveMeta.get(SESSION),
      fs,
    })

    expect(streaming?.updatedAt).toBe(T_NEW_MSG)
  })
})
