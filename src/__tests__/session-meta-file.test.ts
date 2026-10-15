import { describe, expect, it, vi } from 'vitest'
import { BridgeFsConversationStorageBackend } from '../browser/storage/BridgeFsSessionStorage'
import {
  MIGRATION_READ_FAILURE_LIMIT,
  type SqliteSessionMetaStore,
} from '../browser/storage/SqliteSessionMetaStore'
import {
  AI_TITLE_TYPE,
  CUSTOM_TITLE_TYPE,
  SESSION_META_TYPE,
} from '../runtime/VercelModelConstants'
import {
  getConversationMetaPath,
  getConversationTranscriptPath,
  getLegacyConversationMetaSidecarPath,
} from '../utils/conversationStoragePaths'
import {
  applyDiskOnlyRename,
  isSessionMetaFile,
  parseSessionMetaFile,
  SESSION_META_FILE_SCHEMA_VERSION,
  SESSION_SUMMARY_TAIL_BYTES,
  type BrowserTranscriptWriteEntry,
  type SessionMetaFile,
} from '../sessions/sessionStore'

/**
 * `meta.json`, the one file the session list reads: `transcript.jsonl` is the action log, `meta.json` the
 * projection. Pins what `writeSessionMeta` writes, what `readSessionMeta` accepts, that the list never opens a
 * transcript once `meta.json` exists, rebuild of a torn or missing file, and the one-time migration (from
 * `meta.jsonl` when present, else the transcript) with the sidecar removed.
 */

const BASE = '/home/.velloc/projects/proj'
const SID = 'sess-1'

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

const transcriptPath = getConversationTranscriptPath(BASE, SID)
const metaPath = getConversationMetaPath(BASE, SID)
const legacyMetaPath = getLegacyConversationMetaSidecarPath(BASE, SID)

type Call = { op: string; path: string | undefined; payload: Record<string, unknown> }

/**
 * A bridge transport backed by an in-memory filesystem, following the fake
 * used by `bridge-fs-session-storage-delete.test.ts` but serving real bytes so
 * the read paths can be exercised. Missing paths THROW on `stat`/`readFile`,
 * matching the host (`nexus_fs_host.cc` errors on a missing file).
 * `holdWrites` lets a test keep every `fs.writeFile` pending until released,
 * to observe queueing.
 */
function makeBackend(
  seed: Record<string, string> = {},
  options: {
    holdWrites?: boolean
    /** Make every `fs.writeFile` fail (disk full, locked dir…). Mutable. */
    failWrites?: { value: boolean }
    /** Make `fs.readFile` of these paths fail with a NON-missing error (a
     *  sharing violation mid-replace). Mutable. */
    unreadable?: Set<string>
  } = {},
) {
  const files = new Map<string, Uint8Array>()
  for (const [path, content] of Object.entries(seed)) {
    files.set(path, TEXT_ENCODER.encode(content))
  }
  const calls: Call[] = []
  const heldWrites: Array<() => void> = []

  const transport = {
    request: async (request: {
      route: { capability: string; action: string }
      payload: Record<string, unknown>
    }) => {
      const op = `${request.route.capability}.${request.route.action}`
      const path = request.payload?.path as string | undefined
      calls.push({ op, path, payload: request.payload })

      const missing = {
        ok: false as const,
        error: { code: 'ENOENT', message: 'File not found' },
      }

      switch (op) {
        case 'fs.mkdir':
          return { ok: true, result: { ok: true } }
        case 'fs.rm': {
          for (const key of [...files.keys()]) {
            if (key === path || key.startsWith(`${path}/`)) files.delete(key)
          }
          return { ok: true, result: { ok: true } }
        }
        case 'fs.appendFile': {
          const data = request.payload.data as Uint8Array
          const previous = files.get(path!) ?? new Uint8Array(0)
          const merged = new Uint8Array(previous.length + data.length)
          merged.set(previous)
          merged.set(data, previous.length)
          files.set(path!, merged)
          return { ok: true, result: { ok: true } }
        }
        case 'fs.writeFile': {
          if (options.holdWrites) {
            await new Promise<void>(resolve => heldWrites.push(resolve))
          }
          if (options.failWrites?.value) {
            return {
              ok: false as const,
              error: { code: 'FS_ERROR', message: 'Failed to write file' },
            }
          }
          files.set(path!, request.payload.content as Uint8Array)
          return { ok: true, result: { ok: true } }
        }
        case 'fs.readFile': {
          if (options.unreadable?.has(path!)) {
            return {
              ok: false as const,
              error: { code: 'FS_ERROR', message: 'Failed to read file' },
            }
          }
          const bytes = files.get(path!)
          if (!bytes) return missing
          return { ok: true, result: bytes }
        }
        case 'fs.stat': {
          const bytes = files.get(path!)
          if (!bytes) return missing
          return {
            ok: true,
            result: {
              size: bytes.length,
              isFile: true,
              isDirectory: false,
              isSymbolicLink: false,
              isFIFO: false,
              isSocket: false,
              isCharacterDevice: false,
              isBlockDevice: false,
            },
          }
        }
        case 'fs.readRange': {
          const bytes = files.get(path!)
          if (!bytes) return missing
          const offset = request.payload.offset as number
          const length = request.payload.length as number
          const slice = bytes.subarray(offset, offset + length)
          return { ok: true, result: { data: slice, bytesRead: slice.length } }
        }
        default:
          return { ok: true, result: undefined }
      }
    },
  }

  const backend = new BridgeFsConversationStorageBackend({
    transport: transport as never,
    basePath: BASE,
    createRequestId: () => 'req-test',
  })

  return {
    backend,
    calls,
    read: (path: string) => {
      const bytes = files.get(path)
      return bytes === undefined ? undefined : TEXT_DECODER.decode(bytes)
    },
    readMeta: (): unknown => {
      const bytes = files.get(metaPath)
      return bytes === undefined ? undefined : JSON.parse(TEXT_DECODER.decode(bytes))
    },
    has: (path: string) => files.has(path),
    write: (path: string, content: string) => {
      files.set(path, TEXT_ENCODER.encode(content))
    },
    ops: (prefix: string) => calls.filter(c => c.op === prefix).map(c => c.path),
    reset: () => {
      calls.length = 0
    },
    releaseWrites: () => {
      const pending = heldWrites.splice(0)
      for (const release of pending) release()
      return pending.length
    },
    pendingWrites: () => heldWrites.length,
  }
}

// --- record builders -------------------------------------------------------

function metaFile(
  overrides: Partial<SessionMetaFile> = {},
  metadata: Record<string, unknown> = {},
): SessionMetaFile {
  return {
    schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
    sessionId: SID,
    updatedAt: 500,
    metadata: { firstPrompt: 'hello', previewText: 'hello', messageCount: 1, ...metadata },
    ...overrides,
  }
}

/** A LEGACY `__session_meta` line — pre-`meta.json` transcripts and the
 *  retired `meta.jsonl` sidecar carry them. */
function legacyMetaRecord(metadata: Record<string, unknown>, updatedAt = 500): unknown {
  return { type: SESSION_META_TYPE, sessionId: SID, updatedAt, metadata }
}

function customTitleRecord(customTitle: string, updatedAt = 500): unknown {
  return { type: CUSTOM_TITLE_TYPE, sessionId: SID, customTitle, updatedAt }
}

function aiTitleRecord(aiTitle: string, updatedAt = 500): unknown {
  return { type: AI_TITLE_TYPE, sessionId: SID, aiTitle, updatedAt }
}

function userRecord(
  text: string,
  at = 500,
  chain: { uuid?: string; parentUuid?: string | null; ordinal?: number } = {},
): unknown {
  return {
    type: 'user',
    uuid: chain.uuid ?? `u-${text.slice(0, 12)}`,
    sessionId: SID,
    parentUuid: chain.parentUuid ?? null,
    transcriptOrdinal: chain.ordinal ?? 0,
    timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function jsonl(...records: unknown[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

// ===========================================================================

describe('meta.json — shape and validation', () => {
  it('writeSessionMeta puts ONE JSON object on disk, atomically, and reads it back', async () => {
    const { backend, read, ops, calls } = makeBackend()
    const meta = metaFile({ customTitle: 'Named', customTitleAt: 600, aiTitle: 'AI' })

    await backend.writeSessionMeta(SID, meta)

    const onDisk = read(metaPath)!
    expect(JSON.parse(onDisk)).toEqual(meta)
    // A single object — no trailing newline-delimited records.
    expect(onDisk.trim().split('\n')).toHaveLength(1)
    // The write asked the host for an atomic replace (additive flag; an older
    // host ignores it and writes in place — today's behaviour).
    const write = calls.find(c => c.op === 'fs.writeFile' && c.path === metaPath)!
    expect(write.payload.atomic).toBe(true)
    // ...and it created the session dir first — the one write that does.
    expect(ops('fs.mkdir')).toContain(`${BASE}/${SID}`)

    expect(await backend.readSessionMeta(SID)).toEqual(meta)
  })

  it('readSessionMeta returns null for missing / torn / foreign files and never mkdirs', async () => {
    const { backend, write, ops } = makeBackend()
    expect(await backend.readSessionMeta(SID)).toBeNull()

    write(metaPath, '{"schemaVersion":1,"sessionId":"sess-1","upd')
    expect(await backend.readSessionMeta(SID)).toBeNull()

    write(metaPath, JSON.stringify(metaFile({ sessionId: 'someone-else' })))
    expect(await backend.readSessionMeta(SID)).toBeNull()

    write(metaPath, JSON.stringify({ ...metaFile(), schemaVersion: 99 }))
    expect(await backend.readSessionMeta(SID)).toBeNull()

    // A speculative read (the sidebar probes project dirs a session may not
    // live in) must never plant a directory.
    expect(ops('fs.mkdir')).toEqual([])
  })

  it('readSessionMeta REJECTS on a read failure that is not "missing" — never a false null', async () => {
    // A sharing violation while the host replaces the file, or a bridge
    // error, must not read as "no file": the store would rebuild the
    // projection over a good one and erase every unlogged field.
    const unreadable = new Set([metaPath])
    const { backend, write } = makeBackend({}, { unreadable })
    write(metaPath, JSON.stringify(metaFile({ customTitle: 'Keep' })))
    await expect(backend.readSessionMeta(SID)).rejects.toThrow(/Failed to read/)
    unreadable.clear()
    expect((await backend.readSessionMeta(SID))?.customTitle).toBe('Keep')
  })

  it('isSessionMetaFile / parseSessionMetaFile are strict on identity, lenient on metadata', () => {
    expect(isSessionMetaFile(metaFile(), SID)).toBe(true)
    expect(isSessionMetaFile(metaFile({}, { llmSelection: 'garbage' }), SID)).toBe(true)
    expect(isSessionMetaFile(metaFile(), 'other')).toBe(false)
    expect(isSessionMetaFile({ ...metaFile(), metadata: null }, SID)).toBe(false)
    expect(isSessionMetaFile({ ...metaFile(), customTitle: 3 }, SID)).toBe(false)
    expect(parseSessionMetaFile('not json', SID)).toBeNull()
    expect(parseSessionMetaFile(JSON.stringify(metaFile()), SID)).toEqual(metaFile())
  })
})

// ===========================================================================

describe('meta.json — the write queue', () => {
  it('coalesces a queued write (latest wins) and every caller gets the landing promise', async () => {
    const { backend, readMeta, releaseWrites, pendingWrites, calls } = makeBackend(
      {},
      { holdWrites: true },
    )

    const first = backend.writeSessionMeta(SID, metaFile({ updatedAt: 1 }))
    // Let the first job start (it is now awaiting the held fs.writeFile).
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(pendingWrites()).toBe(1)

    // Two more arrive while it is in flight: they fold into ONE queued job.
    const second = backend.writeSessionMeta(SID, metaFile({ updatedAt: 2 }))
    const third = backend.writeSessionMeta(SID, metaFile({ updatedAt: 3 }))
    let secondLanded = false
    let thirdLanded = false
    void second.then(() => {
      secondLanded = true
    })
    void third.then(() => {
      thirdLanded = true
    })

    // Release the first write; the queued job runs next.
    expect(releaseWrites()).toBe(1)
    await first
    await new Promise(resolve => setTimeout(resolve, 0))
    // Neither the second nor the third has resolved: their state is not on
    // disk yet — resolving early would let `refreshSessionSummary` read stale.
    expect(secondLanded).toBe(false)
    expect(thirdLanded).toBe(false)
    expect((readMeta() as SessionMetaFile).updatedAt).toBe(1)

    expect(releaseWrites()).toBe(1)
    await Promise.all([second, third])
    expect(secondLanded).toBe(true)
    expect(thirdLanded).toBe(true)
    // The write that landed carried the LATEST state, and there were exactly
    // two fs writes for three requests.
    expect((readMeta() as SessionMetaFile).updatedAt).toBe(3)
    expect(calls.filter(c => c.op === 'fs.writeFile' && c.path === metaPath)).toHaveLength(2)
  })

  it('a deleted session drops queued and later meta writes (no resurrection)', async () => {
    const { backend, has, ops, reset } = makeBackend()
    await backend.writeSessionMeta(SID, metaFile())
    expect(has(metaPath)).toBe(true)

    await backend.deleteSession(SID)
    reset()
    await backend.writeSessionMeta(SID, metaFile({ updatedAt: 9 }))

    expect(has(metaPath)).toBe(false)
    expect(ops('fs.mkdir')).toEqual([])
    expect(ops('fs.writeFile')).toEqual([])
  })
})

// ===========================================================================

describe('the list path reads meta.json and nothing else', () => {
  it('loadSessionSummary is one whole-file read of meta.json — the transcript is never opened', async () => {
    const { backend, ops, reset } = makeBackend({
      [metaPath]: JSON.stringify(
        metaFile({ customTitle: 'Named', aiTitle: 'AI', updatedAt: 777 }, { messageCount: 3 }),
      ),
      // A big transcript with a title-changing record deep inside — must be
      // irrelevant to the list.
      [transcriptPath]: jsonl(userRecord('hello'), customTitleRecord('Stale', 1)),
    })
    reset()

    const summary = await backend.loadSessionSummary(SID)
    expect(summary).toMatchObject({
      sessionId: SID,
      customTitle: 'Named',
      updatedAt: 777,
      messageCount: 3,
    })
    expect(ops('fs.readFile')).toEqual([metaPath])
    expect(ops('fs.stat')).toEqual([])
    expect(ops('fs.readRange')).toEqual([])
  })

  it('a meta.json-only session (an empty New Thread) is listed and summarised', async () => {
    const { backend } = makeBackend({
      [metaPath]: JSON.stringify(
        metaFile({ updatedAt: 42 }, { messageCount: 0, firstPrompt: '', previewText: '' }),
      ),
    })
    // `listSessions` stats meta.json first; the fake has no readdir so exercise
    // the summary directly.
    const summary = await backend.loadSessionSummary(SID)
    expect(summary).toMatchObject({ sessionId: SID, messageCount: 0, updatedAt: 42 })
    expect(summary?.firstPrompt).toBe('')
  })

  it('ai-title precedence: customTitle wins, aiTitle otherwise, never metadata.customTitle', async () => {
    const { backend, write } = makeBackend()
    write(metaPath, JSON.stringify(metaFile({ aiTitle: 'AI Name' })))
    expect((await backend.loadSessionSummary(SID))?.customTitle).toBe('AI Name')
    write(metaPath, JSON.stringify(metaFile({ customTitle: 'User', aiTitle: 'AI Name' })))
    expect((await backend.loadSessionSummary(SID))?.customTitle).toBe('User')
    // `loadSessionMetadata` folds the same way for the fork flow.
    expect((await backend.loadSessionMetadata(SID))?.customTitle).toBe('User')
    expect((await backend.loadSessionMetadata(SID))?.messageCount).toBe(1)
  })

  it('a torn meta.json is rebuilt from the transcript, titles included', async () => {
    const { backend, write, readMeta } = makeBackend({
      [transcriptPath]: jsonl(
        userRecord('first', 100),
        customTitleRecord('From The Log', 200),
        aiTitleRecord('AI From The Log', 150),
        userRecord('second', 300, { uuid: 'u-second', parentUuid: 'u-first', ordinal: 1 }),
      ),
    })
    write(metaPath, '{"schemaVersion":1,"sessionId":"sess-1","updatedAt":30')

    const summary = await backend.loadSessionSummary(SID)
    expect(summary?.customTitle).toBe('From The Log')
    expect(summary?.messageCount).toBe(2)
    expect(summary?.updatedAt).toBe(300)
    // ...and written back so the next list is a single meta.json read again.
    const rebuilt = readMeta() as SessionMetaFile
    expect(rebuilt.customTitle).toBe('From The Log')
    expect(rebuilt.aiTitle).toBe('AI From The Log')
    expect(rebuilt.metadata.messageCount).toBe(2)
  })
})

// ===========================================================================

describe('one-time migration of a pre-meta.json session', () => {
  it('prefers the retired meta.jsonl sidecar, writes meta.json, and removes the sidecar', async () => {
    const { backend, has, readMeta, ops, reset } = makeBackend({
      [legacyMetaPath]: jsonl(
        customTitleRecord('Sidecar Title', 700),
        aiTitleRecord('Sidecar AI', 600),
        legacyMetaRecord(
          { firstPrompt: 'hello', messageCount: 5, llmSelection: { providerId: 'p', modelId: 'm' } },
          650,
        ),
      ),
      [transcriptPath]: 'x'.repeat(200_000),
    })
    reset()

    const summary = await backend.loadSessionSummary(SID)
    expect(summary).toMatchObject({
      customTitle: 'Sidecar Title',
      messageCount: 5,
      // No message timestamps in the sidecar: the rename time is the activity.
      updatedAt: 700,
    })
    const migrated = readMeta() as SessionMetaFile
    expect(migrated.schemaVersion).toBe(SESSION_META_FILE_SCHEMA_VERSION)
    expect(migrated.customTitle).toBe('Sidecar Title')
    expect(migrated.customTitleAt).toBe(700)
    expect(migrated.aiTitle).toBe('Sidecar AI')
    expect(migrated.metadata.llmSelection).toEqual({ providerId: 'p', modelId: 'm' })
    expect('customTitle' in migrated.metadata).toBe(false)
    expect(has(legacyMetaPath)).toBe(false)
    // The transcript was not opened: the sidecar answered.
    expect(ops('fs.readRange')).toEqual([])
    expect(ops('fs.stat')).toEqual([])

    // Second read: meta.json only.
    reset()
    await backend.loadSessionSummary(SID)
    expect(ops('fs.readFile')).toEqual([metaPath])
  })

  it('falls back to the transcript tail when there is no sidecar', async () => {
    const { backend, readMeta, ops, has } = makeBackend({
      [transcriptPath]: jsonl(
        userRecord('hello', 100),
        legacyMetaRecord({ firstPrompt: 'hello', messageCount: 1, permissionMode: 'plan' }, 100),
        aiTitleRecord('Old AI', 120),
        legacyMetaRecord({ firstPrompt: 'hello', messageCount: 1, permissionMode: 'plan' }, 120),
      ),
    })

    const summary = await backend.loadSessionSummary(SID)
    expect(summary?.customTitle).toBe('Old AI')
    expect(summary?.messageCount).toBe(1)
    expect(ops('fs.readRange')).toEqual([transcriptPath])
    const migrated = readMeta() as SessionMetaFile
    expect(migrated.aiTitle).toBe('Old AI')
    expect(migrated.metadata.permissionMode).toBe('plan')
    expect(has(legacyMetaPath)).toBe(false)
  })

  it('reads only the last 64KB of a big legacy transcript for the tail pass', async () => {
    const tailRecords = jsonl(
      userRecord('late', 900),
      legacyMetaRecord({ firstPrompt: 'early', messageCount: 40 }, 900),
    )
    const padding = 'x'.repeat(200_000) + '\n'
    const { backend, calls } = makeBackend({
      [transcriptPath]: padding + tailRecords,
    })
    const summary = await backend.loadSessionSummary(SID)
    expect(summary?.messageCount).toBe(40)
    const range = calls.find(c => c.op === 'fs.readRange')!
    expect(range.payload.length).toBe(SESSION_SUMMARY_TAIL_BYTES)
    expect(range.payload.offset).toBe(
      padding.length + tailRecords.length - SESSION_SUMMARY_TAIL_BYTES,
    )
  })

  it('a transcript with messages but no legacy metadata line still becomes a session (full load)', async () => {
    // Written by something that never appended `__session_meta` — the tail has
    // nothing to seed from, but the messages describe a session.
    const { backend, readMeta } = makeBackend({
      [transcriptPath]: jsonl(userRecord('only messages', 300)),
    })
    const summary = await backend.loadSessionSummary(SID)
    expect(summary?.messageCount).toBe(1)
    expect(summary?.firstPrompt).toBe('only messages')
    expect((readMeta() as SessionMetaFile).metadata.firstPrompt).toBe('only messages')
  })

  it('a title-only or empty transcript is not a session — nothing is written', async () => {
    const { backend, has, ops } = makeBackend({
      [transcriptPath]: jsonl(customTitleRecord('orphan')),
    })
    expect(await backend.loadSessionSummary(SID)).toBeNull()
    expect(has(metaPath)).toBe(false)
    expect(ops('fs.mkdir')).toEqual([])
  })

  it('does not clobber a meta.json another writer landed during the migration', async () => {
    const { backend, write, readMeta } = makeBackend({
      [legacyMetaPath]: jsonl(legacyMetaRecord({ firstPrompt: 'stale', messageCount: 1 }, 100)),
    })
    // Simulate the session's own store winning the race: by the time the
    // migration re-reads, a fresher file exists.
    const original = backend.readSessionMeta.bind(backend)
    let reads = 0
    backend.readSessionMeta = async (sessionId: string) => {
      reads += 1
      if (reads === 2) {
        write(metaPath, JSON.stringify(metaFile({ updatedAt: 999 }, { firstPrompt: 'fresh' })))
      }
      return original(sessionId)
    }
    const summary = await backend.loadSessionSummary(SID)
    expect(summary?.firstPrompt).toBe('fresh')
    expect((readMeta() as SessionMetaFile).metadata.firstPrompt).toBe('fresh')
  })

  it('a migration whose write failed is NOT memoized — the next read probes again', async () => {
    const failWrites = { value: true }
    const { backend, has, ops, reset } = makeBackend(
      { [legacyMetaPath]: jsonl(legacyMetaRecord({ firstPrompt: 'hello', messageCount: 1 }, 10)) },
      { failWrites },
    )
    // The summary is still derived (read side), but nothing landed.
    await expect(backend.loadSessionSummary(SID)).rejects.toThrow()
    expect(has(metaPath)).toBe(false)

    // Disk healthy again: the session must NOT be stuck at null for this
    // instance's life — the legacy sources are probed again and the file lands.
    failWrites.value = false
    reset()
    const summary = await backend.loadSessionSummary(SID)
    expect(summary?.firstPrompt).toBe('hello')
    expect(has(metaPath)).toBe(true)
    expect(ops('fs.readFile')).toContain(legacyMetaPath)
  })

  it('loadSessionSummary({migrate: false}) derives for a live session WITHOUT writing', async () => {
    // A session with a bound runtime owns its meta.json; a manager-side
    // migration write would race the store's first persist.
    const { backend, has, ops } = makeBackend({
      [legacyMetaPath]: jsonl(legacyMetaRecord({ firstPrompt: 'live', messageCount: 1 }, 10)),
    })
    const summary = await backend.loadSessionSummary(SID, { migrate: false })
    expect(summary?.firstPrompt).toBe('live')
    expect(has(metaPath)).toBe(false)
    expect(has(legacyMetaPath)).toBe(true)
    expect(ops('fs.writeFile')).toEqual([])
    expect(ops('fs.mkdir')).toEqual([])
  })

  it('probes the legacy sources once per session, but re-reads meta.json every time', async () => {
    const { backend, write, ops, reset } = makeBackend({
      [transcriptPath]: jsonl(customTitleRecord('orphan')),
    })
    expect(await backend.loadSessionSummary(SID)).toBeNull()
    reset()
    // Not a session — but another instance may write its meta.json later, and
    // this instance must see it without re-probing the transcript.
    write(metaPath, JSON.stringify(metaFile()))
    expect(await backend.loadSessionSummary(SID)).not.toBeNull()
    expect(ops('fs.readFile')).toEqual([metaPath])
    expect(ops('fs.stat')).toEqual([])
  })

  it('ingestSummarySource (the batched preload) migrates a legacy source it was handed', async () => {
    const { backend, has, readMeta } = makeBackend({
      [legacyMetaPath]: 'stale',
    })
    const summary = backend.ingestSummarySource(SID, {
      kind: 'legacy-sidecar',
      text: jsonl(
        customTitleRecord('Batch Title', 10),
        legacyMetaRecord({ firstPrompt: 'hi', messageCount: 2 }, 5),
      ),
      tailOffset: 0,
    })
    expect(summary?.customTitle).toBe('Batch Title')
    // The write is off the batch's critical path; let it land.
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((readMeta() as SessionMetaFile).customTitle).toBe('Batch Title')
    expect(has(legacyMetaPath)).toBe(false)

    // `commit: false` (a live session's read, or a duplicate-copy tiebreak)
    // derives the summary but writes nothing and removes nothing.
    const readOnly = makeBackend({ [legacyMetaPath]: 'stale' })
    expect(
      readOnly.backend.ingestSummarySource(SID, {
        kind: 'legacy-sidecar',
        text: jsonl(legacyMetaRecord({ firstPrompt: 'ro', messageCount: 1 }, 5)),
        tailOffset: 0,
        commit: false,
      })?.firstPrompt,
    ).toBe('ro')
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(readOnly.has(metaPath)).toBe(false)
    expect(readOnly.has(legacyMetaPath)).toBe(true)

    // A `meta` source is parsed as the file itself; a torn one yields null so
    // the caller retries on the legacy sources.
    expect(
      backend.ingestSummarySource(SID, {
        kind: 'meta',
        text: JSON.stringify(metaFile({ customTitle: 'Direct' })),
        tailOffset: 0,
      })?.customTitle,
    ).toBe('Direct')
    expect(
      backend.ingestSummarySource(SID, { kind: 'meta', text: '{"torn', tailOffset: 0 }),
    ).toBeNull()
    expect(
      backend.ingestSummarySource(SID, { kind: 'meta', text: '', tailOffset: 0 }),
    ).toBeNull()
  })
})

// ===========================================================================

describe('the batched migration is throttled', () => {
  it('writes from ingestSummarySource land one at a time per backend instance', async () => {
    const { backend, pendingWrites, releaseWrites, readMeta, has } = makeBackend(
      {},
      { holdWrites: true },
    )
    const ids = ['a', 'b', 'c']
    for (const id of ids) {
      backend.ingestSummarySource(id, {
        kind: 'tail',
        text: jsonl({ type: SESSION_META_TYPE, sessionId: id, updatedAt: 1, metadata: { messageCount: 1 } }),
        tailOffset: 0,
      })
    }
    // Let the first commit reach its fs.writeFile (readSessionMeta + mkdir
    // precede it); the others must be QUEUED behind it, not in flight.
    for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(pendingWrites()).toBe(1)
    expect(releaseWrites()).toBe(1)
    for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(pendingWrites()).toBe(1)
    expect(releaseWrites()).toBe(1)
    for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(releaseWrites()).toBe(1)
    for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0))
    for (const id of ids) {
      expect(has(getConversationMetaPath(BASE, id))).toBe(true)
    }
    void readMeta
  })
})

describe('the log stays an action log', () => {
  it('append writes exactly the record it was given and touches no other file', async () => {
    const { backend, read, has, ops } = makeBackend()
    const record = customTitleRecord('One Rename', 5) as BrowserTranscriptWriteEntry
    await backend.append(SID, record)
    await backend.append(SID, aiTitleRecord('One AI', 6) as BrowserTranscriptWriteEntry)

    expect(read(transcriptPath)).toBe(jsonl(record, aiTitleRecord('One AI', 6)))
    expect(has(metaPath)).toBe(false)
    expect(has(legacyMetaPath)).toBe(false)
    expect(ops('fs.writeFile')).toEqual([])
  })

  it('applyDiskOnlyRename: one custom-title record + a fresh read-modify-write of meta.json', async () => {
    const { backend, read, readMeta } = makeBackend({
      [metaPath]: JSON.stringify(
        metaFile({ customTitle: 'Before', customTitleAt: 100, updatedAt: 100 }, {
          llmSelection: { providerId: 'p', modelId: 'm' },
        }),
      ),
    })

    expect(await applyDiskOnlyRename(backend, SID, '  After  ', 900)).toBe(true)

    expect(read(transcriptPath)).toBe(jsonl(customTitleRecord('After', 900)))
    const meta = readMeta() as SessionMetaFile
    expect(meta.customTitle).toBe('After')
    expect(meta.customTitleAt).toBe(900)
    expect(meta.updatedAt).toBe(900)
    // Fields the rename does not own survive the read-modify-write.
    expect(meta.metadata.llmSelection).toEqual({ providerId: 'p', modelId: 'm' })

    // A clear is an action too — logged as '' and removed from the projection.
    expect(await applyDiskOnlyRename(backend, SID, '', 950)).toBe(true)
    expect(read(transcriptPath)).toBe(
      jsonl(customTitleRecord('After', 900), customTitleRecord('', 950)),
    )
    const cleared = readMeta() as SessionMetaFile
    expect(cleared.customTitle).toBeUndefined()
    expect(cleared.customTitleAt).toBe(950)
  })

  it('applyDiskOnlyRename migrates a legacy session first, and refuses to create one from nothing', async () => {
    const legacy = makeBackend({
      [legacyMetaPath]: jsonl(legacyMetaRecord({ firstPrompt: 'hello', messageCount: 1 }, 10)),
    })
    expect(await applyDiskOnlyRename(legacy.backend, SID, 'Now Named', 20)).toBe(true)
    expect((legacy.readMeta() as SessionMetaFile).customTitle).toBe('Now Named')
    expect(legacy.has(legacyMetaPath)).toBe(false)

    const empty = makeBackend()
    expect(await applyDiskOnlyRename(empty.backend, SID, 'Ghost', 20)).toBe(false)
    expect(empty.has(metaPath)).toBe(false)
    expect(empty.has(transcriptPath)).toBe(false)
  })

  it('load keeps legacy meta lines and title records (stamped with their physical line) for the store', async () => {
    const { backend } = makeBackend({
      [transcriptPath]: jsonl(
        userRecord('hello', 100),
        legacyMetaRecord({ firstPrompt: 'hello', messageCount: 1 }, 100),
        customTitleRecord('Named', 200),
      ),
    })
    const payload = (await backend.load(SID)) as Array<Record<string, unknown>>
    expect(payload.map(e => e.type)).toEqual(['user', SESSION_META_TYPE, CUSTOM_TITLE_TYPE])
    expect(payload.map(e => e.transcriptLine)).toEqual([0, 1, 2])
  })
})

// ===========================================================================

describe('flat meta.json → sqlite migration converges', () => {
  /**
   * One session dir whose `meta.json` read FAILS (not missing) on every boot,
   * or — with `missing` — whose `meta.json` is absent and has no transcript.
   * The store (marker + per-path failure counts) is shared across `boot()`s,
   * the way the real sqlite file outlives a worker.
   */
  function makeFlat(opts: { missing?: boolean } = {}) {
    const failures = new Map<string, number>()
    let migrated = false
    const store = {
      hasMigration: vi.fn(async () => migrated),
      markMigration: vi.fn(async () => {
        migrated = true
      }),
      seedMeta: vi.fn(async () => {}),
      listAll: vi.fn(async () => []),
      noteMigrationReadFailures: vi.fn(
        async (_name: string, paths: Iterable<string>) => {
          const pending: string[] = []
          const skipped: string[] = []
          for (const path of new Set(paths)) {
            const n = (failures.get(path) ?? 0) + 1
            failures.set(path, n)
            ;(n >= MIGRATION_READ_FAILURE_LIMIT ? skipped : pending).push(path)
          }
          return { pending, skipped }
        },
      ),
    }
    const transport = {
      request: async (request: {
        route: { capability: string; action: string }
        payload: Record<string, unknown>
      }) => {
        const op = `${request.route.capability}.${request.route.action}`
        const path = request.payload?.path as string | undefined
        if (op === 'fs.readdir') {
          return {
            ok: true,
            result: [{ name: SID, isFile: false, isDirectory: true, isSymbolicLink: false }],
          }
        }
        if (op === 'fs.statBatch') {
          const paths = request.payload.paths as string[]
          return {
            ok: true,
            result: paths.map(p => ({
              path: p,
              stat: p === metaPath ? { isFile: true, size: 10 } : null,
            })),
          }
        }
        if (op === 'fs.readFile' && path === metaPath && !opts.missing) {
          return {
            ok: false as const,
            error: { code: 'FS_ERROR', message: 'Failed to read file' },
          }
        }
        return {
          ok: false as const,
          error: { code: 'ENOENT', message: 'File not found' },
        }
      },
    }
    const boot = () =>
      new BridgeFsConversationStorageBackend({
        transport: transport as never,
        basePath: BASE,
        createRequestId: () => 'req-test',
        metaStore: store as unknown as SqliteSessionMetaStore,
      })
    return { boot, store, failures }
  }

  it('a meta.json that fails on every boot holds the marker, then is skipped (recorded + warned) on the 3rd', async () => {
    const { boot, store, failures } = makeFlat()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (let n = 1; n < MIGRATION_READ_FAILURE_LIMIT; n += 1) {
        await boot().listSessions()
        expect(store.markMigration).not.toHaveBeenCalled()
        expect(failures.get(metaPath)).toBe(n)
      }
      await boot().listSessions()
      expect(store.markMigration).toHaveBeenCalledTimes(1)
      expect(failures.get(metaPath)).toBe(MIGRATION_READ_FAILURE_LIMIT)
      expect(
        warn.mock.calls.some(
          call => String(call[0]).includes('SKIPPED') && String(call[0]).includes(metaPath),
        ),
      ).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('a MISSING meta.json is not a failure — the first boot marks done', async () => {
    const { boot, store, failures } = makeFlat({ missing: true })
    await boot().listSessions()
    expect(store.markMigration).toHaveBeenCalledTimes(1)
    expect(failures.size).toBe(0)
  })
})
