import { afterEach, describe, expect, it } from 'vitest'

import {
  processFs,
  installProcessFs,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'
import { createBrowserConversationStorageBackend } from '../sessions/sessionStore'
import { SESSION_META_TYPE } from '../runtime/VercelModelConstants'

/**
 * Transcript entries are stamped with the PHYSICAL line they were read from (blank, metadata and unparseable lines
 * count), as the native search host counts; a search jump compares the two. A failure here is not fixed by
 * adjusting the expected numbers.
 */

const SID = 'sess-lines'
const BASE = '/velloc/projects/p'

function fakeFs(transcript: string): RuntimeFs {
  return {
    ...processFs(),
    readFile: async () => transcript,
  } as unknown as RuntimeFs
}

const original = processFs()
afterEach(() => installProcessFs(original))

async function loadEntries(
  transcript: string,
): Promise<Array<Record<string, unknown>>> {
  installProcessFs(fakeFs(transcript))
  const backend = createBrowserConversationStorageBackend({ fsBasePath: BASE })
  const payload = await backend.load(SID)
  const entries = Array.isArray(payload)
    ? payload
    : ((payload?.messages ?? []) as unknown[])
  return entries as Array<Record<string, unknown>>
}

function userLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

function assistantLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

describe('the physical line survives to the renderer', () => {
  it('is still on the messages a session hands to the UI', async () => {
    // The stamp is only useful if it reaches the thread. Normalisation
    // rebuilds each message and `stripTranscriptFields` drops several
    // storage-only fields on the way — this one has to survive both, or
    // rows cannot declare the lines they cover and every search jump is
    // back to guessing.
    installProcessFs(
      fakeFs(
        [
          JSON.stringify({ type: SESSION_META_TYPE, sessionId: SID, updatedAt: 1 }),
          userLine('u-1', 'first ask'),
          '',
          assistantLine('a-1', 'a reply'),
        ].join('\n'),
      ),
    )
    const { normalizeConversationState } = await import('../sessions/sessionStore')
    const backend = createBrowserConversationStorageBackend({ fsBasePath: BASE })
    const payload = await backend.load(SID)
    const state = normalizeConversationState(SID, payload, {
      createTimestamp: () => new Date(0).toISOString(),
      createUuid: () => 'generated',
    } as never)

    expect(
      state.messages.map(m => (m as { transcriptLine?: number }).transcriptLine),
    ).toEqual([1, 3])
    expect(
      state.activeMessages.map(
        m => (m as { transcriptLine?: number }).transcriptLine,
      ),
    ).toEqual([1, 3])
  })

  it('is still on the messages the runtime is seeded with', async () => {
    // One hop further: this is the list `createAgentRuntime` hands the
    // engine, and therefore what the worker pushes to the UI. If the field
    // survives normalisation but not this, the thread never sees it and
    // rows cannot declare their line ranges.
    installProcessFs(
      fakeFs(
        [
          JSON.stringify({ type: SESSION_META_TYPE, sessionId: SID, updatedAt: 1 }),
          userLine('u-1', 'first ask'),
          '',
          assistantLine('a-1', 'a reply'),
        ].join('\n'),
      ),
    )
    const { BrowserConversationStore } = await import('../sessions/sessionStore')
    const store = new BrowserConversationStore({
      sessionId: SID,
      runtimeConfig: {
        createTimestamp: () => new Date(0).toISOString(),
        createUuid: () => 'generated',
      },
      storageBackend: createBrowserConversationStorageBackend({
        fsBasePath: BASE,
      }),
    } as never)
    const recorded = await store.getRecordedMessages()

    expect(
      recorded.map(m => (m as { transcriptLine?: number }).transcriptLine),
    ).toEqual([1, 3])
  })

  it('maps each uuid to its physical line for a search jump', async () => {
    // `getTranscriptLinesByUuid` is what the worker re-attaches to every
    // message so a search hit can find its row. It reads the physical line
    // from the PERSISTED transcript (reusing the loader's counting), not
    // from `storedMessages` — a live-appended message carries no stamp
    // there, so the ACTIVE session (the one most often searched) would map
    // nothing and its jumps could not resolve to a row.
    installProcessFs(
      fakeFs(
        [
          JSON.stringify({ type: SESSION_META_TYPE, sessionId: SID, updatedAt: 1 }),
          userLine('u-1', 'first ask'),
          '',
          assistantLine('a-1', 'a reply'),
        ].join('\n'),
      ),
    )
    const { BrowserConversationStore } = await import('../sessions/sessionStore')
    const store = new BrowserConversationStore({
      sessionId: SID,
      runtimeConfig: {
        createTimestamp: () => new Date(0).toISOString(),
        createUuid: () => 'generated',
      },
      storageBackend: createBrowserConversationStorageBackend({
        fsBasePath: BASE,
      }),
    } as never)
    const lines = await (
      store as unknown as {
        getTranscriptLinesByUuid(): Promise<Record<string, number>>
      }
    ).getTranscriptLinesByUuid()

    // u-1 is physical line 1; a-1 is line 3 (the blank line 2 still counts).
    expect(lines['u-1']).toBe(1)
    expect(lines['a-1']).toBe(3)
  })

  it('a message appended while the map is being read still gets its line', async () => {
    // Regression: the map was cached under the stored-message count read
    // AFTER the disk read. A message recorded during that read made the
    // count current while the map (read from the older file) lacked it, so
    // every later lookup hit the cache and the message never got a line —
    // its bubble could not be flashed by a search jump.
    let content = [
      JSON.stringify({ type: SESSION_META_TYPE, sessionId: SID, updatedAt: 1 }),
      userLine('u-1', 'first ask'),
      assistantLine('a-1', 'a reply'),
    ].join('\n')
    let holdNextRead: Promise<void> | null = null
    installProcessFs({
      ...processFs(),
      readFile: async () => {
        const snapshot = content
        const hold = holdNextRead
        holdNextRead = null
        if (hold) await hold
        return snapshot
      },
      appendFileSync: (_path: string, data: string) => {
        content += `\n${data.replace(/\n$/, '')}`
      },
      writeFile: async () => {},
      renameSync: () => {},
    } as unknown as RuntimeFs)
    const { BrowserConversationStore } = await import('../sessions/sessionStore')
    const store = new BrowserConversationStore({
      sessionId: SID,
      runtimeConfig: {
        createTimestamp: () => new Date(0).toISOString(),
        createUuid: () => 'generated',
        now: () => 0,
      },
      storageBackend: createBrowserConversationStorageBackend({
        fsBasePath: BASE,
      }),
    } as never)
    const linesOf = () =>
      (
        store as unknown as {
          getTranscriptLinesByUuid(): Promise<Record<string, number>>
        }
      ).getTranscriptLinesByUuid()
    await store.getRecordedMessages()

    let release!: () => void
    holdNextRead = new Promise<void>(resolve => {
      release = resolve
    })
    const inFlight = linesOf()
    await store.saveTranscriptRows([
      {
        type: 'user',
        uuid: 'u-2',
        message: { role: 'user', content: [{ type: 'text', text: 'again' }] },
      } as never,
    ])
    release()
    expect((await inFlight)['u-2']).toBeUndefined()

    expect((await linesOf())['u-2']).toBe(3)
  })
})

describe('transcript entries carry their physical line number', () => {
  it('counts every line, so a stamp is the line number in the file', async () => {
    const entries = await loadEntries(
      [
        JSON.stringify({ type: SESSION_META_TYPE, sessionId: SID, updatedAt: 1 }),
        userLine('u-1', 'first ask'),
        assistantLine('a-1', 'first reply'),
      ].join('\n'),
    )

    expect(entries.map(entry => entry.transcriptLine)).toEqual([0, 1, 2])
  })

  it('a BLANK line still consumes a line number', async () => {
    // The regression this file exists for. With `.filter(Boolean)` the
    // assistant below is stamped 2 instead of 3, and every later entry
    // inherits the same off-by-one.
    const entries = await loadEntries(
      [
        JSON.stringify({ type: SESSION_META_TYPE, sessionId: SID, updatedAt: 1 }),
        userLine('u-1', 'first ask'),
        '',
        assistantLine('a-1', 'after the gap'),
      ].join('\n'),
    )

    expect(entries.map(entry => entry.uuid)).toEqual([undefined, 'u-1', 'a-1'])
    expect(entries.map(entry => entry.transcriptLine)).toEqual([0, 1, 3])
  })

  it('an UNPARSABLE line still consumes a line number', async () => {
    const entries = await loadEntries(
      [
        userLine('u-1', 'first ask'),
        '{ this is not json',
        assistantLine('a-1', 'after the junk'),
      ].join('\n'),
    )

    expect(entries.map(entry => entry.transcriptLine)).toEqual([0, 2])
  })

  it('a line the guest DROPS still consumes a line number', async () => {
    // The loader keeps message-like entries, session meta and titles, and
    // drops everything else — but the file still contains those lines and
    // the host counted them, so entries after one must not shift.
    const entries = await loadEntries(
      [
        userLine('u-1', 'first ask'),
        // Valid JSON, but not an entry shape the loader keeps.
        JSON.stringify(42),
        assistantLine('a-1', 'after the dropped line'),
      ].join('\n'),
    )

    expect(entries.map(entry => entry.uuid)).toEqual(['u-1', 'a-1'])
    expect(entries.map(entry => entry.transcriptLine)).toEqual([0, 2])
  })

  it('several blanks in a row do not compound the drift', async () => {
    const entries = await loadEntries(
      [
        userLine('u-1', 'first ask'),
        '',
        '',
        '',
        assistantLine('a-1', 'much later'),
      ].join('\n'),
    )

    expect(entries.map(entry => entry.transcriptLine)).toEqual([0, 4])
  })

  it('a trailing newline does not invent an entry', async () => {
    const entries = await loadEntries(`${userLine('u-1', 'only ask')}\n`)
    expect(entries.map(entry => entry.transcriptLine)).toEqual([0])
  })
})

describe('the legacy transcriptOrdinal entry counter', () => {
  // Transcripts written by older builds stamp every message with a
  // `transcriptOrdinal` — a count of message ENTRIES that skipped metadata
  // and blank lines. It was never an ordering key (order is file order plus
  // the parentUuid chain) and its one reader, the search-jump fallback,
  // compared it with a physical line number and landed late. It is no
  // longer written; these tests keep it out of what the runtime sees and
  // out of what gets written back.
  const legacyTranscript = [
    JSON.stringify({ type: SESSION_META_TYPE, sessionId: SID, updatedAt: 1 }),
    JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      sessionId: SID,
      parentUuid: null,
      transcriptOrdinal: 0,
      message: { role: 'user', content: [{ type: 'text', text: 'ask' }] },
    }),
    '',
    JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      sessionId: SID,
      parentUuid: 'u-1',
      transcriptOrdinal: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    }),
  ].join('\n')

  it('is stripped from what a legacy transcript loads as', async () => {
    installProcessFs(fakeFs(legacyTranscript))
    const { normalizeConversationState } = await import('../sessions/sessionStore')
    const backend = createBrowserConversationStorageBackend({ fsBasePath: BASE })
    const state = normalizeConversationState(SID, await backend.load(SID), {
      createTimestamp: () => new Date(0).toISOString(),
      createUuid: () => 'generated',
    } as never)

    expect(state.messages.map(m => m.uuid)).toEqual(['u-1', 'a-1'])
    expect(state.messages.some(m => 'transcriptOrdinal' in m)).toBe(false)
    expect(state.activeMessages.some(m => 'transcriptOrdinal' in m)).toBe(false)
    // The physical line stamp — the one a search hit is compared with —
    // is unaffected by the legacy field's presence.
    expect(
      state.activeMessages.map(
        m => (m as { transcriptLine?: number }).transcriptLine,
      ),
    ).toEqual([1, 3])
  })

  it('is not written for new messages', async () => {
    const appended: string[] = []
    installProcessFs({
      ...fakeFs(legacyTranscript),
      appendFileSync: (_path: string, data: string) => {
        appended.push(data)
      },
      // The message append is followed by the session's `meta.json` rewrite
      // (write-then-rename on this backend); neither is under test here.
      writeFile: async () => {},
      renameSync: () => {},
    } as unknown as RuntimeFs)
    const { BrowserConversationStore } = await import('../sessions/sessionStore')
    const store = new BrowserConversationStore({
      sessionId: SID,
      runtimeConfig: {
        createTimestamp: () => new Date(0).toISOString(),
        createUuid: () => 'generated',
        now: () => 0,
      },
      storageBackend: createBrowserConversationStorageBackend({
        fsBasePath: BASE,
      }),
    } as never)
    await store.saveTranscriptRows([
      {
        type: 'user',
        uuid: 'u-2',
        message: { role: 'user', content: [{ type: 'text', text: 'again' }] },
      } as never,
    ])

    const written = appended
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(entry => entry.uuid === 'u-2')
    expect(written).toHaveLength(1)
    expect(written[0]).not.toHaveProperty('transcriptOrdinal')
    // The chain stamps still land.
    expect(written[0]?.parentUuid).toBe('a-1')
    expect(written[0]?.sessionId).toBe(SID)
  })
})
