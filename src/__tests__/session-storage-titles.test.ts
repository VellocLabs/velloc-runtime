import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  AI_TITLE_TYPE,
  CUSTOM_TITLE_TYPE,
  SESSION_META_TYPE,
} from '../runtime/VercelModelConstants'
import {
  BrowserConversationStore,
  extractLatestSessionMetadataFromText,
  extractLatestSessionSummaryFromText,
  type BrowserConversationStorageBackend,
  type BrowserSessionMetadata,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
  type SessionMetaFile,
} from '../sessions/sessionStore'

// ---------------------------------------------------------------------------
// Session titles (F-17): `custom-title` / `ai-title` records, customTitle > aiTitle > legacy inline > derived. The
// first two blocks exercise the legacy extractors (the one-time migration); the store block pins the live contract.
// ---------------------------------------------------------------------------

const SID = 'sess-1'

function userText(text: string): Message {
  return {
    type: 'user',
    uuid: `user-${text.slice(0, 8)}`,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as Message
}

function jsonl(...entries: unknown[]): string {
  return entries.map(entry => JSON.stringify(entry)).join('\n')
}

function metaEntry(metadata: BrowserSessionMetadata, updatedAt = 100): unknown {
  return { type: SESSION_META_TYPE, sessionId: SID, updatedAt, metadata }
}

describe('session title extractors (read precedence)', () => {
  it('a custom-title entry overrides the derived first prompt', () => {
    const text = jsonl(
      metaEntry({ firstPrompt: 'derived label', messageCount: 1 }),
      { type: CUSTOM_TITLE_TYPE, sessionId: SID, customTitle: 'My Name', updatedAt: 101 },
    )
    const summary = extractLatestSessionSummaryFromText(SID, text)
    expect(summary?.customTitle).toBe('My Name')
    // The derived label is preserved separately (not clobbered).
    expect(summary?.firstPrompt).toBe('derived label')
  })

  it('custom-title beats ai-title beats legacy inline customTitle', () => {
    const all = jsonl(
      metaEntry({ firstPrompt: 'derived', customTitle: 'legacy', messageCount: 1 }),
      { type: AI_TITLE_TYPE, sessionId: SID, aiTitle: 'ai-name', updatedAt: 101 },
      { type: CUSTOM_TITLE_TYPE, sessionId: SID, customTitle: 'user-name', updatedAt: 102 },
    )
    expect(extractLatestSessionSummaryFromText(SID, all)?.customTitle).toBe('user-name')

    const noUser = jsonl(
      metaEntry({ firstPrompt: 'derived', customTitle: 'legacy', messageCount: 1 }),
      { type: AI_TITLE_TYPE, sessionId: SID, aiTitle: 'ai-name', updatedAt: 101 },
    )
    expect(extractLatestSessionSummaryFromText(SID, noUser)?.customTitle).toBe('ai-name')

    const legacyOnly = jsonl(
      metaEntry({ firstPrompt: 'derived', customTitle: 'legacy', messageCount: 1 }),
    )
    expect(extractLatestSessionSummaryFromText(SID, legacyOnly)?.customTitle).toBe('legacy')
  })

  it('uses the LATEST custom-title when several are appended', () => {
    const text = jsonl(
      metaEntry({ firstPrompt: 'derived', messageCount: 1 }),
      { type: CUSTOM_TITLE_TYPE, sessionId: SID, customTitle: 'first', updatedAt: 101 },
      { type: CUSTOM_TITLE_TYPE, sessionId: SID, customTitle: 'second', updatedAt: 102 },
    )
    expect(extractLatestSessionSummaryFromText(SID, text)?.customTitle).toBe('second')
  })

  it('returns null when there is no __session_meta record, even with a title entry', () => {
    const text = jsonl({
      type: CUSTOM_TITLE_TYPE,
      sessionId: SID,
      customTitle: 'orphan',
      updatedAt: 101,
    })
    expect(extractLatestSessionSummaryFromText(SID, text)).toBeNull()
  })

  it('extractLatestSessionMetadataFromText folds the resolved title into customTitle', () => {
    const text = jsonl(
      metaEntry({ firstPrompt: 'derived', llmSelection: null, messageCount: 1 }),
      { type: CUSTOM_TITLE_TYPE, sessionId: SID, customTitle: 'kept', updatedAt: 101 },
    )
    const meta = extractLatestSessionMetadataFromText(SID, text)
    expect(meta?.customTitle).toBe('kept')
    // Non-title fields from the meta record survive (not dropped).
    expect(meta?.firstPrompt).toBe('derived')
    expect('llmSelection' in (meta ?? {})).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// A never-messaged session rehydrates into the sidebar from its initial `__session_meta` record.
// ---------------------------------------------------------------------------

describe('empty-session visibility (rehydration)', () => {
  it('a meta record with no messages, label or draft still yields a summary', () => {
    // Exactly what `bindSessionRuntime` leaves on disk for a New Thread click
    // the user never typed into.
    const text = jsonl(
      metaEntry(
        {
          firstPrompt: '',
          previewText: '',
          messageCount: 0,
          leafUuid: null,
        },
        4_242,
      ),
    )

    const summary = extractLatestSessionSummaryFromText(SID, text)
    expect(summary).not.toBeNull()
    expect(summary?.sessionId).toBe(SID)
    // Still reports as EMPTY so `openNewSession` reuses it instead of
    // stacking up another New Thread.
    expect(summary?.messageCount).toBe(0)
    // No fabricated label — the UI's own default shows through.
    expect(summary?.firstPrompt).toBe('')
    expect(summary?.previewText).toBe('')
    expect(summary?.updatedAt).toBe(4_242)
  })

  it('a persisted templateType survives on an empty session', () => {
    const text = jsonl(
      metaEntry({ messageCount: 0, templateType: 'code' }, 7_000),
    )
    expect(extractLatestSessionSummaryFromText(SID, text)?.templateType)
      .toBe('code')
  })
})

// ---------------------------------------------------------------------------

class TestBackend implements BrowserConversationStorageBackend {
  readonly entries = new Map<string, BrowserTranscriptEntry[]>()
  readonly metas = new Map<string, SessionMetaFile>()
  /** When set, `readSessionMeta` REJECTS (a read that failed — not a missing
   *  file), the way the bridge backend does for a sharing violation. */
  metaUnreadable = false
  metaWrites = 0

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
    if (this.metaUnreadable) {
      throw new Error('FS_ERROR: Failed to read file')
    }
    const meta = this.metas.get(sessionId)
    return meta ? (JSON.parse(JSON.stringify(meta)) as SessionMetaFile) : null
  }

  async writeSessionMeta(sessionId: string, meta: SessionMetaFile) {
    this.metaWrites += 1
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

function makeStore(backend: TestBackend): BrowserConversationStore {
  return new BrowserConversationStore({
    runtimeConfig: makeRuntimeConfig(),
    sessionId: SID,
    storageBackend: backend,
  })
}

function titleEntries(backend: TestBackend) {
  const arr = backend.entries.get(SID) ?? []
  return {
    custom: arr.filter(e => (e as { type?: string }).type === CUSTOM_TITLE_TYPE),
    ai: arr.filter(e => (e as { type?: string }).type === AI_TITLE_TYPE),
    legacyMeta: arr.filter(
      e => (e as { type?: string }).type === SESSION_META_TYPE,
    ),
  }
}

// ---------------------------------------------------------------------------
// The contract: `transcript.jsonl` is the ACTION LOG — one `custom-title`
// record per rename, one `ai-title`, never re-appended, never a metadata
// snapshot; `meta.json` is the PROJECTION the sidebar reads, reconciled
// against the log on open.
// ---------------------------------------------------------------------------

describe('BrowserConversationStore title persistence', () => {
  it('storeUserTitle logs ONE custom-title record and projects the title into meta.json', async () => {
    const backend = new TestBackend()
    const store = makeStore(backend)
    await store.saveTranscriptRows([userText('hello world')])
    await store.storeUserTitle('My Title')

    expect((await store.getSessionMetadata())?.customTitle).toBe('My Title')

    const { custom, legacyMeta } = titleEntries(backend)
    expect(custom).toHaveLength(1)
    expect(custom[0]).toMatchObject({ customTitle: 'My Title' })
    // Nothing but actions in the log: no metadata snapshot, ever.
    expect(legacyMeta).toHaveLength(0)
    const meta = backend.metas.get(SID)
    expect(meta?.customTitle).toBe('My Title')
    expect(meta?.customTitleAt).toBe((custom[0] as { updatedAt: number }).updatedAt)
    // The title NEVER rides `metadata` (it has a dedicated field).
    expect('customTitle' in (meta?.metadata ?? {})).toBe(false)
  })

  it('storeAutoTitle never clobbers a user custom-title', async () => {
    const backend = new TestBackend()
    const store = makeStore(backend)
    await store.saveTranscriptRows([userText('hello')])
    await store.storeUserTitle('User Title')
    await store.storeAutoTitle('ai generated title')

    expect((await store.getSessionMetadata())?.customTitle).toBe('User Title')
    // The ai-title is still logged (as a distinct record) and projected, but loses.
    expect(titleEntries(backend).ai).toHaveLength(1)
    expect(titleEntries(backend).ai[0]).toMatchObject({ aiTitle: 'ai generated title' })
    expect(backend.metas.get(SID)?.aiTitle).toBe('ai generated title')
    expect(backend.metas.get(SID)?.customTitle).toBe('User Title')
  })

  it('storeAutoTitle is used when there is no user custom-title', async () => {
    const backend = new TestBackend()
    const store = makeStore(backend)
    await store.saveTranscriptRows([userText('hello')])
    await store.storeAutoTitle('ai only')

    expect((await store.getSessionMetadata())?.customTitle).toBe('ai only')
    expect(backend.metas.get(SID)?.aiTitle).toBe('ai only')
    expect(backend.metas.get(SID)?.customTitle).toBeUndefined()
  })

  it('updateSessionMetadata({ customTitle }) logs the rename like storeUserTitle (back-compat)', async () => {
    const backend = new TestBackend()
    const store = makeStore(backend)
    await store.saveTranscriptRows([userText('hello')])
    await store.updateSessionMetadata({ customTitle: 'Via Update' })

    expect((await store.getSessionMetadata())?.customTitle).toBe('Via Update')
    const { custom } = titleEntries(backend)
    expect(custom).toHaveLength(1)
    expect(custom[0]).toMatchObject({ customTitle: 'Via Update' })
    expect(backend.metas.get(SID)?.customTitle).toBe('Via Update')
    expect('customTitle' in (backend.metas.get(SID)?.metadata ?? {})).toBe(false)
  })

  it('an empty customTitle clears the override — and logs the CLEAR', async () => {
    const backend = new TestBackend()
    const store = makeStore(backend)
    await store.saveTranscriptRows([userText('hello there')])
    await store.storeUserTitle('Temp')
    await store.storeUserTitle('   ')

    expect((await store.getSessionMetadata())?.customTitle).toBeUndefined()
    // Two actions, two records: the name and the clear ('' is the clear).
    const { custom } = titleEntries(backend)
    expect(custom.map(e => (e as { customTitle: string }).customTitle)).toEqual([
      'Temp',
      '',
    ])
    const meta = backend.metas.get(SID)
    expect(meta?.customTitle).toBeUndefined()
    // The clear is stamped so it beats the older record on the next open.
    expect(meta?.customTitleAt).toBe((custom[1] as { updatedAt: number }).updatedAt)
  })

  it('never re-appends a title: later turns add messages only', async () => {
    const backend = new TestBackend()
    const store = makeStore(backend)
    await store.saveTranscriptRows([userText('first turn')])
    await store.storeUserTitle('Sticky')
    await store.storeAutoTitle('AI Sticky')
    await store.saveTranscriptRows([userText('second turn')])
    await store.updateSessionMetadata({ permissionMode: 'plan' })
    await store.saveTerminalState('completed', 5)

    const arr = backend.entries.get(SID) ?? []
    const types = arr.map(e => (e as { type?: string }).type)
    expect(types.filter(t => t === CUSTOM_TITLE_TYPE)).toHaveLength(1)
    expect(types.filter(t => t === AI_TITLE_TYPE)).toHaveLength(1)
    expect(types.filter(t => t === SESSION_META_TYPE)).toHaveLength(0)
    // Both title records sit where they happened — BEFORE the second turn.
    const lastMsgIdx = types.lastIndexOf('user')
    expect(types.lastIndexOf(CUSTOM_TITLE_TYPE)).toBeLessThan(lastMsgIdx)
    expect(types.lastIndexOf(AI_TITLE_TYPE)).toBeLessThan(lastMsgIdx)
    // ...and the projection still carries both.
    expect(backend.metas.get(SID)?.customTitle).toBe('Sticky')
    expect(backend.metas.get(SID)?.aiTitle).toBe('AI Sticky')
    expect(backend.metas.get(SID)?.metadata.permissionMode).toBe('plan')
    expect(backend.metas.get(SID)?.metadata.messageCount).toBe(2)
  })

  it('resolves the title after reload from meta.json', async () => {
    const backend = new TestBackend()
    const first = makeStore(backend)
    await first.saveTranscriptRows([userText('hello')])
    await first.storeUserTitle('Persisted')

    const reloaded = makeStore(backend)
    expect((await reloaded.getSessionMetadata())?.customTitle).toBe('Persisted')
  })

  it('rebuilds a MISSING meta.json from the log on open — titles included', async () => {
    const backend = new TestBackend()
    const first = makeStore(backend)
    await first.saveTranscriptRows([userText('hello')])
    await first.storeUserTitle('From Log')
    await first.storeAutoTitle('AI From Log')
    // Simulate a lost/torn projection.
    backend.metas.delete(SID)

    const reloaded = makeStore(backend)
    expect((await reloaded.getSessionMetadata())?.customTitle).toBe('From Log')
    const rebuilt = backend.metas.get(SID)
    expect(rebuilt?.customTitle).toBe('From Log')
    expect(rebuilt?.aiTitle).toBe('AI From Log')
    expect(rebuilt?.metadata.messageCount).toBe(1)
    expect(rebuilt?.metadata.firstPrompt).toBe('hello')
  })

  it('a rename logged AFTER the last meta write wins on open (crash between the two writes)', async () => {
    const backend = new TestBackend()
    const first = makeStore(backend)
    await first.saveTranscriptRows([userText('hello')])
    await first.storeUserTitle('Old Name')
    // The rename append landed, the meta rewrite did not: append the record
    // by hand with a newer stamp and leave meta.json as it was.
    const staleMeta = backend.metas.get(SID)!
    await backend.append(SID, {
      type: CUSTOM_TITLE_TYPE,
      sessionId: SID,
      customTitle: 'New Name',
      updatedAt: (staleMeta.customTitleAt ?? 0) + 10,
    })

    const reloaded = makeStore(backend)
    expect((await reloaded.getSessionMetadata())?.customTitle).toBe('New Name')
    // ...and the projection is healed on open.
    expect(backend.metas.get(SID)?.customTitle).toBe('New Name')
  })

  it('a meta.json newer than the log keeps its title (an older record does not resurrect)', async () => {
    const backend = new TestBackend()
    const first = makeStore(backend)
    await first.saveTranscriptRows([userText('hello')])
    await first.storeUserTitle('Logged Then Cleared')
    await first.storeUserTitle('')
    // Log: 'Logged Then Cleared'@t1, ''@t2; meta: no title, customTitleAt=t2.
    const reloaded = makeStore(backend)
    expect((await reloaded.getSessionMetadata())?.customTitle).toBeUndefined()
  })

  it('an UNREADABLE meta.json is never rewritten from the log on open (its unlogged fields survive)', async () => {
    const backend = new TestBackend()
    const first = makeStore(backend)
    await first.saveTranscriptRows([userText('hello')])
    await first.updateSessionMetadata({
      llmSelection: { providerId: 'p', modelId: 'm' },
      permissionMode: 'plan',
      composerDraft: 'unsent',
    } as never)
    await first.storeUserTitle('Named')
    const writesBefore = backend.metaWrites

    // The file exists, but the read fails this instant (the host is mid-
    // replace, or a bridge hiccup). That is NOT "no file".
    backend.metaUnreadable = true
    const reloaded = makeStore(backend)
    const meta = await reloaded.getSessionMetadata()
    // The log-derived state is adopted in memory — the session still opens…
    expect(meta?.customTitle).toBe('Named')
    expect(meta?.messageCount).toBe(1)
    // …but nothing is written over the real file, whose unlogged fields are
    // intact once it can be read again.
    expect(backend.metaWrites).toBe(writesBefore)
    backend.metaUnreadable = false
    expect(backend.metas.get(SID)?.metadata.llmSelection).toEqual({
      providerId: 'p',
      modelId: 'm',
    })
    expect(backend.metas.get(SID)?.metadata.permissionMode).toBe('plan')
    expect(backend.metas.get(SID)?.metadata.composerDraft).toBe('unsent')
  })

  it('an unreadable meta.json does not make a restored pointer a phantom', async () => {
    const backend = new TestBackend()
    backend.metas.set(SID, {
      schemaVersion: 1,
      sessionId: SID,
      updatedAt: 5,
      metadata: { messageCount: 0, templateType: 'code' },
    })
    backend.metaUnreadable = true
    const store = new BrowserConversationStore({
      runtimeConfig: makeRuntimeConfig(),
      sessionId: SID,
      storageBackend: backend,
      restoredSessionId: true,
    })
    await store.getSessionMetadata()
    backend.metaUnreadable = false
    // A real write after the read failure still persists (not phantom) — and
    // it first folds in what the file held (the store never saw
    // `templateType`), so the write does not erase it.
    await store.updateSessionMetadata({ permissionMode: 'plan' })
    expect(backend.metas.get(SID)?.metadata.permissionMode).toBe('plan')
    expect(backend.metas.get(SID)?.metadata.templateType).toBe('code')
  })

  it('honors a legacy inline customTitle and migrates it into meta.json on open', async () => {
    const backend = new TestBackend()
    // Pre-seed an OLD-style transcript: title folded into a legacy
    // `__session_meta` line, no meta.json at all.
    backend.entries.set(SID, [
      userText('legacy turn') as unknown as BrowserTranscriptEntry,
      {
        type: SESSION_META_TYPE,
        sessionId: SID,
        updatedAt: 50,
        metadata: { firstPrompt: 'legacy turn', customTitle: 'Legacy', messageCount: 1 },
      },
    ])

    const store = makeStore(backend)
    expect((await store.getSessionMetadata())?.customTitle).toBe('Legacy')

    // Migration-on-open: the projection now exists and carries the title,
    // stripped out of `metadata`.
    const meta = backend.metas.get(SID)
    expect(meta?.customTitle).toBe('Legacy')
    expect('customTitle' in (meta?.metadata ?? {})).toBe(false)
    // A legacy inline title is not a new ACTION — nothing is added to the log
    // for it, now or on the next turn.
    expect(titleEntries(backend).custom).toHaveLength(0)
    await store.saveTranscriptRows([userText('new turn')])
    expect(titleEntries(backend).custom).toHaveLength(0)
    expect(titleEntries(backend).legacyMeta).toHaveLength(1)
    expect(backend.metas.get(SID)?.customTitle).toBe('Legacy')
  })
})

describe('terminal-state write under a locked meta store', () => {
  it('saveTerminalState does not reject when the meta write fails, and the next write carries the reason', async () => {
    // Red-without: the engine awaits this after the model has already
    // answered, so a transient `database is locked` from another writer
    // holding the store failed a finished turn with
    // `worker_submit_failed`.
    const backend = new TestBackend()
    const store = makeStore(backend)
    await store.saveTranscriptRows([userText('hello there')])
    const write = backend.writeSessionMeta.bind(backend)
    backend.writeSessionMeta = async () => {
      throw new Error('SQLITE_ERROR: database is locked')
    }
    await expect(store.saveTerminalState('completed', 7)).resolves.toBeUndefined()

    backend.writeSessionMeta = write
    await store.updateSessionMetadata({ permissionMode: 'plan' })
    expect(backend.metas.get(SID)?.metadata.lastTerminalReason).toBe('completed')
    expect(backend.metas.get(SID)?.metadata.lastTerminalTimestamp).toBe(7)
  })

  describe('with no later write to ride', () => {
    afterEach(() => vi.useRealTimers())

    it('retries the failed terminal-state write on its own, so a finished session still records its reason', async () => {
      // A background sub-agent's LAST turn: nothing writes meta.json after
      // this, so a swallowed failure left `lastTerminalReason` stale forever
      // and the finished run came back as "stopped" after a restart.
      vi.useFakeTimers()
      const backend = new TestBackend()
      const store = makeStore(backend)
      await store.saveTranscriptRows([userText('hello there')])
      const write = backend.writeSessionMeta.bind(backend)
      let failures = 0
      backend.writeSessionMeta = async (sessionId, meta) => {
        if (failures < 2) {
          failures += 1
          throw new Error('SQLITE_ERROR: database is locked')
        }
        await write(sessionId, meta)
      }
      await store.saveTerminalState('completed', 7)
      expect(backend.metas.get(SID)?.metadata.lastTerminalReason).toBeUndefined()

      // Two retries fail too; the third lands — with no other write in between.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(failures).toBe(2)
      expect(backend.metas.get(SID)?.metadata.lastTerminalReason).toBe('completed')
      expect(backend.metas.get(SID)?.metadata.lastTerminalTimestamp).toBe(7)
    })

    it('gives up after a few attempts rather than retrying forever', async () => {
      vi.useFakeTimers()
      const backend = new TestBackend()
      const store = makeStore(backend)
      await store.saveTranscriptRows([userText('hello there')])
      let attempts = 0
      backend.writeSessionMeta = async () => {
        attempts += 1
        throw new Error('SQLITE_ERROR: database is locked')
      }
      await store.saveTerminalState('completed', 7)
      await vi.advanceTimersByTimeAsync(60_000)
      // The write itself plus the retry ladder — bounded.
      expect(attempts).toBe(4)
    })
  })
})

describe('BrowserConversationStore activity time', () => {
  it('storeActivity moves meta.json updatedAt forward, logs nothing, and never moves it back', async () => {
    const backend = new TestBackend()
    const store = makeStore(backend)
    await store.saveTranscriptRows([userText('hello')])
    const before = backend.metas.get(SID)?.updatedAt ?? 0
    const logged = backend.entries.get(SID)?.length
    await store.storeActivity(before + 5_000)
    expect(backend.metas.get(SID)?.updatedAt).toBe(before + 5_000)
    expect(backend.entries.get(SID)?.length).toBe(logged)
    const writes = backend.metaWrites
    await store.storeActivity(before + 1_000)
    expect(backend.metas.get(SID)?.updatedAt).toBe(before + 5_000)
    expect(backend.metaWrites).toBe(writes)
  })
})

