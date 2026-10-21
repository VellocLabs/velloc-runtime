import { describe, expect, it, vi } from 'vitest'
import {
  SessionSnapshotStore,
  SQL_INSERT_SESSION_FILE,
  SQL_INSERT_SNAPSHOT,
  SQL_INSERT_TURN,
  SQL_INSERT_TURN_FILE,
  SQL_LIST_SESSION_FILES,
  SQL_LIST_TURN_FILES,
  SQL_LIST_TURN_FILES_FROM,
  SQL_LIST_TURN_FILES_FOR_PATH,
  SQL_LIST_TURNS,
  SQL_LIST_UNFINALIZED_TURNS,
  SQL_MARK_TURN_FINALIZED,
  SQL_MAX_SNAPSHOT_ID,
  SQL_SELECT_NEXT_TURN_FILE,
  SQL_SELECT_PRIOR_TURN_FILE,
  SQL_SELECT_TURN_FILE,
  SQL_UPDATE_TURN_FILE_AFTER,
  SQL_SELECT_SESSION_FILE,
  SQL_DELETE_TURN_FILE,
  SQL_COUNT_TURN_FILES_FOR_PATH,
  SQL_DELETE_SESSION_FILE,
  SQL_COUNT_SNAPSHOT_TURN_REFS,
  SQL_COUNT_SNAPSHOT_SESSION_REFS,
  SQL_DELETE_SNAPSHOT,
} from '../sessions/fileSnapshots/snapshotStore'
import {
  FileSnapshotRecorder,
  SnapshotCaptureError,
  MAX_DIR_REMOVAL_CAPTURE_FILES,
} from '../sessions/fileSnapshots/snapshotRecorder'
import {
  computeSnapshotFileDiff,
  decodeSnapshotBytes,
  formatUnifiedDiffText,
} from '../sessions/fileSnapshots/snapshotDiff'
import {
  beginShellMutationProbe,
  holdShellMutationProbe,
  resetHeldShellMutationProbes,
  settleHeldShellMutationProbe,
} from '../sessions/fileSnapshots/shellMutationProbe'
import { deriveSnapshotTurnInfo, isTurnBoundary } from '../utils/turnDiffs'
import { normalizePathKey } from '../utils/paths'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { Message } from '../runtime/RuntimeTypes'

// ---------------------------------------------------------------------------
// Fakes. The store exports its exact SQL statements, so the sqlite fake
// dispatches by strict string equality — no SQL engine, and a store edit
// that changes a statement fails loudly here instead of silently matching.
// NOTE: node's sqlite is NOT used on purpose — the real binary runs
// chromium's bundled SQLite (no UPSERT/json()); the dialect itself is e2e
// territory (see the feature doc), unit tests only pin the store's protocol.
// ---------------------------------------------------------------------------

type SqlValue = unknown

function makeFakeFs(initial?: Record<string, string>) {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const enc = new TextEncoder()
  const key = (p: string) => normalizePathKey(p).replace(/\/+$/, '')
  for (const [p, content] of Object.entries(initial ?? {})) {
    files.set(key(p), enc.encode(content))
  }
  const isDir = (k: string): boolean => {
    if (dirs.has(k)) return true
    for (const f of files.keys()) {
      if (f.startsWith(`${k}/`)) return true
    }
    return false
  }
  const fs = {
    async stat(p: string) {
      const k = key(p)
      const bytes = files.get(k)
      if (bytes) {
        return { size: bytes.length, isDirectory: () => false } as never
      }
      if (isDir(k)) {
        return { size: 0, isDirectory: () => true } as never
      }
      throw new Error(`ENOENT: ${p}`)
    },
    async readFileBytes(p: string) {
      const bytes = files.get(key(p))
      if (!bytes) throw new Error(`ENOENT: ${p}`)
      return bytes.slice()
    },
    async writeFile(p: string, data: string | Uint8Array) {
      files.set(key(p), typeof data === 'string' ? enc.encode(data) : data.slice())
    },
    async mkdir(p: string) {
      dirs.add(key(p))
    },
    async readdir(p: string) {
      const k = key(p)
      const names = new Map<string, boolean>()
      for (const f of files.keys()) {
        if (!f.startsWith(`${k}/`)) continue
        const rest = f.slice(k.length + 1)
        const slash = rest.indexOf('/')
        if (slash === -1) names.set(rest, false)
        else names.set(rest.slice(0, slash), true)
      }
      for (const d of dirs) {
        if (!d.startsWith(`${k}/`)) continue
        const rest = d.slice(k.length + 1)
        const slash = rest.indexOf('/')
        names.set(slash === -1 ? rest : rest.slice(0, slash), true)
      }
      return [...names.entries()].map(([name, dir]) => ({
        name,
        isDirectory: () => dir,
      })) as never
    },
    async unlink(p: string) {
      if (!files.delete(key(p))) throw new Error(`ENOENT: ${p}`)
    },
    async rm(p: string) {
      const k = key(p)
      files.delete(k)
      for (const f of [...files.keys()]) {
        if (f.startsWith(`${k}/`)) files.delete(f)
      }
      dirs.delete(k)
    },
  } as unknown as RuntimeFs
  return {
    fs,
    /** Raw content by path, or null. */
    read(p: string): string | null {
      const bytes = files.get(key(p))
      return bytes ? new TextDecoder().decode(bytes) : null
    },
    write(p: string, content: string) {
      files.set(key(p), enc.encode(content))
    },
    delete(p: string) {
      files.delete(key(p))
    },
    has(p: string) {
      return files.has(key(p))
    },
    listUnder(prefix: string): string[] {
      const k = key(prefix)
      return [...files.keys()].filter(f => f.startsWith(`${k}/`))
    },
  }
}

function makeFakeSqlite(opts?: {
  failWrites?: boolean
  onWrite?: () => void
}) {
  const snapshots = new Map<number, SqlValue[]>() // id → [id, size, createdAt]
  const sessionFiles = new Map<string, SqlValue[]>()
  const turns = new Map<number, SqlValue[]>()
  const turnFiles = new Map<string, SqlValue[]>()
  const tfKey = (seq: unknown, path: unknown) => `${seq}|${path}`

  const ok = (result: unknown) => ({ ok: true as const, result })
  const err = (code: string) => ({
    ok: false as const,
    error: { code, message: code },
  })

  const applyWrite = (sql: string, params: SqlValue[]) => {
    if (sql.startsWith('CREATE TABLE') || sql.startsWith('INSERT OR IGNORE INTO snapshot_meta')) {
      return ok({ rowsAffected: 0 })
    }
    if (sql === SQL_INSERT_SNAPSHOT) {
      snapshots.set(params[0] as number, [...params])
      return ok({ rowsAffected: 1 })
    }
    if (sql === SQL_INSERT_TURN) {
      const seq = params[0] as number
      if (!turns.has(seq)) turns.set(seq, [...params, 0])
      return ok({ rowsAffected: 1 })
    }
    if (sql === SQL_INSERT_SESSION_FILE) {
      const path = params[0] as string
      if (!sessionFiles.has(path)) sessionFiles.set(path, [...params])
      return ok({ rowsAffected: 1 })
    }
    if (sql === SQL_INSERT_TURN_FILE) {
      const k = tfKey(params[0], params[1])
      if (!turnFiles.has(k)) turnFiles.set(k, [...params, null, null, 0])
      return ok({ rowsAffected: 1 })
    }
    if (sql === SQL_UPDATE_TURN_FILE_AFTER) {
      const [ae, aid, ask, seq, path] = params
      const row = turnFiles.get(tfKey(seq, path))
      if (row) {
        row[6] = ae
        row[7] = aid
        row[8] = ask
      }
      return ok({ rowsAffected: row ? 1 : 0 })
    }
    if (sql === SQL_MARK_TURN_FINALIZED) {
      const row = turns.get(params[0] as number)
      if (row) row[4] = 1
      return ok({ rowsAffected: row ? 1 : 0 })
    }
    if (sql === SQL_DELETE_TURN_FILE) {
      return ok({ rowsAffected: turnFiles.delete(tfKey(params[0], params[1])) ? 1 : 0 })
    }
    if (sql === SQL_DELETE_SESSION_FILE) {
      return ok({ rowsAffected: sessionFiles.delete(params[0] as string) ? 1 : 0 })
    }
    if (sql === SQL_DELETE_SNAPSHOT) {
      return ok({ rowsAffected: snapshots.delete(params[0] as number) ? 1 : 0 })
    }
    return err(`UNEXPECTED_SQL:${sql}`)
  }

  const runQuery = (sql: string, params: SqlValue[]): SqlValue[][] => {
    const sortedTurnFiles = () =>
      [...turnFiles.values()].sort((a, b) =>
        (a[0] as number) - (b[0] as number) ||
        String(a[1]).localeCompare(String(b[1])),
      )
    if (sql === SQL_MAX_SNAPSHOT_ID) {
      const ids = [...snapshots.keys()]
      return [[ids.length ? Math.max(...ids) : null]]
    }
    if (sql === SQL_SELECT_TURN_FILE) {
      const row = turnFiles.get(tfKey(params[0], params[1]))
      return row ? [row] : []
    }
    if (sql === SQL_SELECT_PRIOR_TURN_FILE) {
      const [path, seq] = params
      const rows = sortedTurnFiles().filter(
        r => r[1] === path && (r[0] as number) < (seq as number),
      )
      return rows.length ? [rows[rows.length - 1]!] : []
    }
    if (sql === SQL_SELECT_NEXT_TURN_FILE) {
      const [path, seq] = params
      const rows = sortedTurnFiles().filter(
        r => r[1] === path && (r[0] as number) > (seq as number),
      )
      return rows.length ? [rows[0]!] : []
    }
    if (sql === SQL_LIST_TURN_FILES) {
      return sortedTurnFiles().filter(r => r[0] === params[0])
    }
    if (sql === SQL_LIST_TURN_FILES_FROM) {
      return sortedTurnFiles().filter(r => (r[0] as number) >= (params[0] as number))
    }
    if (sql === SQL_LIST_TURN_FILES_FOR_PATH) {
      return sortedTurnFiles().filter(r => r[1] === params[0])
    }
    if (sql === SQL_LIST_TURNS) {
      return [...turns.values()].sort((a, b) => (a[0] as number) - (b[0] as number))
    }
    if (sql === SQL_LIST_UNFINALIZED_TURNS) {
      return [...turns.values()]
        .filter(r => r[4] === 0)
        .sort((a, b) => (a[0] as number) - (b[0] as number))
    }
    if (sql === SQL_LIST_SESSION_FILES) {
      return [...sessionFiles.values()].sort((a, b) =>
        String(a[0]).localeCompare(String(b[0])),
      )
    }
    if (sql === SQL_SELECT_SESSION_FILE) {
      const row = sessionFiles.get(params[0] as string)
      return row ? [row] : []
    }
    if (sql === SQL_COUNT_TURN_FILES_FOR_PATH) {
      return [[sortedTurnFiles().filter(r => r[1] === params[0]).length]]
    }
    if (sql === SQL_COUNT_SNAPSHOT_TURN_REFS) {
      return [[sortedTurnFiles().filter(r => r[4] === params[0] || r[7] === params[1]).length]]
    }
    if (sql === SQL_COUNT_SNAPSHOT_SESSION_REFS) {
      return [[[...sessionFiles.values()].filter(r => r[3] === params[0]).length]]
    }
    throw new Error(`UNEXPECTED_QUERY:${sql}`)
  }

  const transport = {
    request: vi.fn(
      async (req: {
        route: { capability: string; action: string }
        payload: {
          sql?: string
          params?: SqlValue[]
          statements?: Array<{ sql: string; params?: SqlValue[] }>
        }
      }) => {
        const { capability, action } = req.route
        if (capability !== 'sqlite') return err('UNKNOWN_CAPABILITY')
        const p = req.payload
        if (action === 'query') {
          return ok({
            rows: runQuery(p.sql!, p.params ?? []),
            rowCount: 0,
            truncated: false,
          })
        }
        if (opts?.failWrites) return err('SQLITE_ERROR')
        opts?.onWrite?.()
        if (action === 'execute') {
          return applyWrite(p.sql!, p.params ?? [])
        }
        if (action === 'batch') {
          for (const stmt of p.statements ?? []) {
            const res = applyWrite(stmt.sql, stmt.params ?? [])
            if (!res.ok) return res
          }
          return ok({ results: [] })
        }
        return err('UNKNOWN_ACTION')
      },
    ),
  }
  return { transport, snapshots, sessionFiles, turns, turnFiles }
}

const SESSION_DIR = '/home/.velloc/projects/D--proj/sess1'
const STORAGE_BASE = '/home/.velloc/projects/D--proj'
const DB_PATH = `${SESSION_DIR}/snapshots.sqlite`

function makeHarness(opts?: {
  initialFiles?: Record<string, string>
  failWrites?: boolean
  maxSnapshotBytes?: number
}) {
  const disk = makeFakeFs(opts?.initialFiles)
  // The real DB file is created by the sqlite HOST, not through fs — mirror
  // that: the first sqlite write materializes the db file in the fake fs
  // (hasPersistedState() stat-probes it).
  const fake = makeFakeSqlite({
    failWrites: opts?.failWrites,
    onWrite: () => disk.write(DB_PATH, 'db'),
  })
  const store = new SessionSnapshotStore({
    transport: fake.transport as never,
    fs: disk.fs,
    sessionDir: SESSION_DIR,
    createRequestId: () => 'req',
    now: () => 1000,
  })
  const recorder = new FileSnapshotRecorder({
    store,
    fs: disk.fs,
    excludeRoots: [STORAGE_BASE],
    maxSnapshotBytes: opts?.maxSnapshotBytes,
  })
  return { disk, fake, store, recorder }
}

const T1 = { seq: 1, uuid: 'u1', preview: 'first turn' }
const T2 = { seq: 2, uuid: 'u2', preview: 'second turn' }
const T3 = { seq: 3, uuid: 'u3', preview: 'third turn' }

// ---------------------------------------------------------------------------

describe('SessionSnapshotStore', () => {
  it('seeds the id counter from MAX(snapshot_id) so a reopened store continues, never reuses', async () => {
    const { disk, fake, store } = makeHarness({ initialFiles: { '/ws/a.txt': 'A' } })
    const id1 = await store.writeSnapshotBlob(new TextEncoder().encode('one'))
    const id2 = await store.writeSnapshotBlob(new TextEncoder().encode('two'))
    expect([id1, id2]).toEqual([1, 2])
    // blob file + row both exist
    expect(disk.read(store.blobPath(id2))).toBe('two')
    expect(fake.snapshots.get(2)).toEqual([2, 3, 1000])

    // A NEW store over the same DB continues after the max.
    const store2 = new SessionSnapshotStore({
      transport: fake.transport as never,
      fs: disk.fs,
      sessionDir: SESSION_DIR,
      createRequestId: () => 'req',
      now: () => 1000,
    })
    const id3 = await store2.writeSnapshotBlob(new TextEncoder().encode('three'))
    expect(id3).toBe(3)
  })

  it('hasPersistedState is false before any write and true after', async () => {
    const { store } = makeHarness()
    expect(await store.hasPersistedState()).toBe(false)
    await store.writeSnapshotBlob(new Uint8Array([1]))
    expect(await store.hasPersistedState()).toBe(true)
  })
})

describe('FileSnapshotRecorder — before-capture', () => {
  it('a transient stat failure at capture THROWS; it never records exists:false', async () => {
    // exists:false DRIVES A DELETE on revert and is permanent for the session
    // (INSERT OR IGNORE), so only a genuinely-absent path may produce it —
    // an EBUSY/EACCES capture must fail loudly ("mutated but unsnapshotted"
    // is the state the safety net refuses to create).
    const { disk, fake, recorder } = makeHarness({
      initialFiles: { '/ws/a.txt': 'original' },
    })
    const realStat = disk.fs.stat.bind(disk.fs)
    let failOnce = true
    ;(disk.fs as { stat: unknown }).stat = async (p: string) => {
      if (failOnce) {
        failOnce = false
        throw new Error('FS_ERROR: EBUSY: file is in use or locked')
      }
      return realStat(p)
    }
    await expect(recorder.trackBeforeMutation('/ws/a.txt', T1)).rejects.toThrow(
      /EBUSY/,
    )
    // Nothing poisoned: no session-original row was written for the path.
    expect(fake.sessionFiles.has('/ws/a.txt')).toBe(false)
    // The transient cleared — the next capture records the REAL before-image.
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    expect(fake.sessionFiles.get('/ws/a.txt')?.[4]).toBe(0)
  })

  it('captures before-image, session original, and turn row on first mutation of a path', async () => {
    const { fake, recorder } = makeHarness({
      initialFiles: { '/ws/a.txt': 'original' },
    })
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    // one blob (id 1) referenced by BOTH the session original and the turn before
    expect(fake.sessionFiles.get('/ws/a.txt')).toEqual([
      '/ws/a.txt',
      '/ws/a.txt',
      1,
      1,
      0,
    ])
    expect(fake.turnFiles.get('1|/ws/a.txt')).toEqual([
      1,
      '/ws/a.txt',
      '/ws/a.txt',
      1,
      1,
      0,
      null,
      null,
      0,
    ])
    expect(fake.turns.get(1)).toEqual([1, 'u1', 'first turn', 1000, 0])
  })

  it('is idempotent per (turn, path): a script writing one file in a loop captures once', async () => {
    const { fake, recorder, disk } = makeHarness({
      initialFiles: { '/ws/a.txt': 'original' },
    })
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    disk.write('/ws/a.txt', 'mutated once')
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    expect(fake.snapshots.size).toBe(1)
    // before still holds the ORIGINAL content's blob, not the mid-turn state
    expect(fake.turnFiles.get('1|/ws/a.txt')![4]).toBe(1)
  })

  it('records a nonexistent file as before_exists=0 with no blob (the create case)', async () => {
    const { fake, recorder } = makeHarness()
    await recorder.trackBeforeMutation('/ws/new.txt', T1)
    expect(fake.snapshots.size).toBe(0)
    expect(fake.turnFiles.get('1|/ws/new.txt')!.slice(3, 6)).toEqual([0, null, 0])
    expect(fake.sessionFiles.get('/ws/new.txt')!.slice(2, 5)).toEqual([0, null, 0])
  })

  it('record-and-skip over the size cap: row marked skipped, no blob, no throw', async () => {
    const { fake, recorder } = makeHarness({
      initialFiles: { '/ws/big.bin': 'x'.repeat(100) },
      maxSnapshotBytes: 10,
    })
    await recorder.trackBeforeMutation('/ws/big.bin', T1)
    expect(fake.snapshots.size).toBe(0)
    expect(fake.turnFiles.get('1|/ws/big.bin')!.slice(3, 6)).toEqual([1, null, 1])
  })

  it('never captures inside the session-storage tree (self-recursion guard)', async () => {
    const { fake, recorder } = makeHarness({
      initialFiles: { [`${STORAGE_BASE}/other-sess/transcript.jsonl`]: '{}' },
    })
    await recorder.trackBeforeMutation(
      `${STORAGE_BASE}/other-sess/transcript.jsonl`,
      T1,
    )
    expect(fake.turnFiles.size).toBe(0)
    expect(fake.sessionFiles.size).toBe(0)
  })

  it('throws SnapshotCaptureError when the store write fails — caller must not mutate', async () => {
    const { recorder } = makeHarness({
      initialFiles: { '/ws/a.txt': 'original' },
      failWrites: true,
    })
    await expect(recorder.trackBeforeMutation('/ws/a.txt', T1)).rejects.toThrow(
      SnapshotCaptureError,
    )
  })

  it('a failed capture does not wedge the serial chain — later ops still run (and fail loudly, not hang)', async () => {
    const { recorder } = makeHarness({ failWrites: true })
    await expect(recorder.trackBeforeMutation('/ws/a.txt', T1)).rejects.toThrow()
    await expect(
      recorder.trackBeforeMutation('/ws/missing.txt', T1),
    ).rejects.toThrow(SnapshotCaptureError)
  })
})

describe('FileSnapshotRecorder — finalize + dedup', () => {
  it('finalize stamps a changed file with a NEW after blob and marks the turn finalized', async () => {
    const { fake, recorder, disk } = makeHarness({
      initialFiles: { '/ws/a.txt': 'v1' },
    })
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    disk.write('/ws/a.txt', 'v2')
    await recorder.finalizeOpenTurns()
    const row = fake.turnFiles.get('1|/ws/a.txt')!
    expect(row.slice(6, 9)).toEqual([1, 2, 0]) // after: exists, blob 2, not skipped
    expect(fake.turns.get(1)![4]).toBe(1)
    expect(disk.read(`${SESSION_DIR}/snapshots/2`)).toBe('v2')
  })

  it('finalize reuses the before snapshot id when the file is unchanged (no second blob)', async () => {
    const { fake, recorder } = makeHarness({
      initialFiles: { '/ws/a.txt': 'same' },
    })
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    await recorder.finalizeOpenTurns()
    const row = fake.turnFiles.get('1|/ws/a.txt')!
    expect(row.slice(6, 9)).toEqual([1, 1, 0]) // after id === before id
    expect(fake.snapshots.size).toBe(1)
  })

  it('finalize records a deletion as after_exists=0', async () => {
    const { fake, recorder, disk } = makeHarness({
      initialFiles: { '/ws/a.txt': 'doomed' },
    })
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    disk.delete('/ws/a.txt')
    await recorder.finalizeOpenTurns()
    expect(fake.turnFiles.get('1|/ws/a.txt')!.slice(6, 9)).toEqual([0, null, 0])
  })

  it("turn N+1's before reuses turn N's after blob when the disk is unchanged between turns", async () => {
    const { fake, recorder, disk } = makeHarness({
      initialFiles: { '/ws/a.txt': 'v1' },
    })
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    disk.write('/ws/a.txt', 'v2')
    await recorder.finalizeOpenTurns() // after(T1) = blob 2
    await recorder.trackBeforeMutation('/ws/a.txt', T2)
    const t2 = fake.turnFiles.get('2|/ws/a.txt')!
    expect(t2.slice(3, 6)).toEqual([1, 2, 0]) // before(T2) reuses blob 2
    expect(fake.snapshots.size).toBe(2) // v1, v2 — nothing new
  })

  it('finalizing an older turn takes its after from the NEXT turn touching the path, never the live disk', async () => {
    const { fake, store, disk } = makeHarness({
      initialFiles: { '/ws/a.txt': 'v1' },
    })
    // Simulate the crash shape directly through the store: turn 1 and turn 2
    // both hold before rows, neither finalized, and the disk has moved on.
    const id1 = await store.writeSnapshotBlob(new TextEncoder().encode('v1'))
    await store.recordBeforeCapture({
      turn: T1,
      path: '/ws/a.txt',
      displayPath: '/ws/a.txt',
      before: { exists: true, snapshotId: id1, skipped: false },
    })
    const id2 = await store.writeSnapshotBlob(new TextEncoder().encode('v2'))
    await store.recordBeforeCapture({
      turn: T2,
      path: '/ws/a.txt',
      displayPath: '/ws/a.txt',
      before: { exists: true, snapshotId: id2, skipped: false },
    })
    disk.write('/ws/a.txt', 'v3')
    const recorder = new FileSnapshotRecorder({ store, fs: disk.fs })
    await recorder.recoverUnfinalized()
    // after(T1) = before(T2) = blob 2 — NOT v3
    expect(fake.turnFiles.get('1|/ws/a.txt')!.slice(6, 9)).toEqual([1, 2, 0])
    // after(T2) = v3 (a fresh blob)
    const t2After = fake.turnFiles.get('2|/ws/a.txt')!.slice(6, 9)
    expect(t2After[0]).toBe(1)
    expect(disk.read(`${SESSION_DIR}/snapshots/${t2After[1] as number}`)).toBe('v3')
    expect(fake.turns.get(1)![4]).toBe(1)
    expect(fake.turns.get(2)![4]).toBe(1)
  })

  it('finalize with no snapshot DB is a no-op (never creates state for a no-edit session)', async () => {
    const { fake, recorder } = makeHarness()
    await recorder.finalizeOpenTurns()
    expect(fake.transport.request).not.toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({ action: 'batch' }),
      }),
    )
  })
})

describe('FileSnapshotRecorder — directory removal', () => {
  it('captures every file under a removed directory (bounded walk)', async () => {
    const { fake, recorder } = makeHarness({
      initialFiles: {
        '/ws/dir/one.txt': '1',
        '/ws/dir/sub/two.txt': '2',
      },
    })
    await recorder.trackBeforeDirectoryRemoval('/ws/dir', T1)
    expect(fake.turnFiles.has('1|/ws/dir/one.txt')).toBe(true)
    expect(fake.turnFiles.has('1|/ws/dir/sub/two.txt')).toBe(true)
    expect(fake.snapshots.size).toBe(2)
  })

  it('records one skipped placeholder row when the tree exceeds the walk cap', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i <= MAX_DIR_REMOVAL_CAPTURE_FILES; i++) {
      files[`/ws/huge/f${i}.txt`] = String(i)
    }
    const { fake, recorder } = makeHarness({ initialFiles: files })
    await recorder.trackBeforeDirectoryRemoval('/ws/huge', T1)
    expect(fake.snapshots.size).toBe(0)
    expect(fake.turnFiles.get('1|/ws/huge')!.slice(3, 6)).toEqual([1, null, 1])
  })
})

describe('FileSnapshotRecorder — session diff', () => {
  it('reports edits, creates, and deletes against the session original; unchanged files are filtered', async () => {
    const { recorder, disk } = makeHarness({
      initialFiles: { '/ws/edit.txt': 'old', '/ws/del.txt': 'bye', '/ws/same.txt': 'same' },
    })
    await recorder.trackBeforeMutation('/ws/edit.txt', T1)
    await recorder.trackBeforeMutation('/ws/del.txt', T1)
    await recorder.trackBeforeMutation('/ws/same.txt', T1)
    await recorder.trackBeforeMutation('/ws/new.txt', T1)
    disk.write('/ws/edit.txt', 'new content')
    disk.delete('/ws/del.txt')
    disk.write('/ws/new.txt', 'created')
    // /ws/same.txt untouched

    const changes = await recorder.getSessionDiff()
    const paths = changes.map(c => c.path).sort()
    expect(paths).toEqual(['/ws/del.txt', '/ws/edit.txt', '/ws/new.txt'])
    const edit = changes.find(c => c.path === '/ws/edit.txt')!
    expect(new TextDecoder().decode(edit.original.bytes!)).toBe('old')
    expect(new TextDecoder().decode(edit.current.bytes!)).toBe('new content')
    const del = changes.find(c => c.path === '/ws/del.txt')!
    expect(del.current.exists).toBe(false)
    const created = changes.find(c => c.path === '/ws/new.txt')!
    expect(created.original.exists).toBe(false)
  })

  it('returns [] with no persisted state', async () => {
    const { recorder } = makeHarness()
    expect(await recorder.getSessionDiff()).toEqual([])
  })
})

describe('FileSnapshotRecorder — computed diffs (Diff-panel sources)', () => {
  it('getTurnDiffs: a finalized turn diffs before → after; unchanged files are dropped', async () => {
    const { recorder, disk } = makeHarness({
      initialFiles: { '/ws/a.txt': 'one\n', '/ws/same.txt': 'same' },
    })
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    await recorder.trackBeforeMutation('/ws/same.txt', T1)
    disk.write('/ws/a.txt', 'one\ntwo\n')
    // /ws/same.txt untouched
    await recorder.finalizeOpenTurns()

    const turns = await recorder.getTurnDiffs()
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      turnSeq: 1,
      promptPreview: 'first turn',
      finalized: true,
    })
    expect(turns[0]!.files).toHaveLength(1)
    expect(turns[0]!.files[0]).toMatchObject({
      displayPath: '/ws/a.txt',
      kind: 'text',
      plusLines: 1,
      minusLines: 0,
    })
    expect(turns[0]!.files[0]!.hunks.length).toBeGreaterThan(0)
  })

  it('getTurnDiffs: a still-open turn diffs against CURRENT disk (the live turn is never invisible)', async () => {
    const { recorder, disk } = makeHarness({
      initialFiles: { '/ws/a.txt': 'one\n' },
    })
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    disk.write('/ws/a.txt', 'one\nlive\n')
    // No finalize — the turn is mid-run.
    const turns = await recorder.getTurnDiffs()
    expect(turns).toHaveLength(1)
    expect(turns[0]!.finalized).toBe(false)
    expect(turns[0]!.files[0]).toMatchObject({ plusLines: 1, minusLines: 0 })
  })

  it('getSessionFileDiffs: per-file original → current-disk diffs, create flagged as new', async () => {
    const { recorder, disk } = makeHarness({
      initialFiles: { '/ws/edit.txt': 'old\n' },
    })
    await recorder.trackBeforeMutation('/ws/edit.txt', T1)
    await recorder.trackBeforeMutation('/ws/new.txt', T1)
    disk.write('/ws/edit.txt', 'new\n')
    disk.write('/ws/new.txt', 'created\n')

    const diffs = await recorder.getSessionFileDiffs()
    const byPath = new Map(diffs.map(d => [d.displayPath, d]))
    expect([...byPath.keys()].sort()).toEqual(['/ws/edit.txt', '/ws/new.txt'])
    expect(byPath.get('/ws/new.txt')).toMatchObject({ fileWasCreated: true })
    expect(byPath.get('/ws/edit.txt')).toMatchObject({
      kind: 'text',
      plusLines: 1,
      minusLines: 1,
    })
  })

  it('both return [] with no persisted state', async () => {
    const { recorder } = makeHarness()
    expect(await recorder.getTurnDiffs()).toEqual([])
    expect(await recorder.getSessionFileDiffs()).toEqual([])
  })
})

describe('FileSnapshotRecorder — session total diff (continuity)', () => {
  it('CLEAN chain: two turns editing one file → one snapshot-anchored diff (original → last after), no external mark', async () => {
    const { recorder, disk } = makeHarness({
      initialFiles: { '/ws/a.txt': 'v1\n' },
    })
    // Turn 1: v1 → v2, finalize (after(T1) captured from disk = clean v2).
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    disk.write('/ws/a.txt', 'v2\n')
    await recorder.finalizeOpenTurns()
    // Turn 2: v2 → v3 with NO external change in the gap — before(T2) reuses
    // after(T1)'s blob, so the link is continuous by construction.
    await recorder.trackBeforeMutation('/ws/a.txt', T2)
    disk.write('/ws/a.txt', 'v3\n')
    await recorder.finalizeOpenTurns()

    const totals = await recorder.getSessionTotalDiffs()
    expect(totals).toHaveLength(1)
    expect(totals[0]!.provenance).toBe('clean')
    expect(totals[0]!.externalBetween).toBeUndefined()
    // The diff is the ENDPOINTS (v1 → v3), not a stack of per-turn hunks.
    expect(totals[0]!.diff).toMatchObject({
      displayPath: '/ws/a.txt',
      kind: 'text',
      plusLines: 1,
      minusLines: 1,
    })
  })

  it('EXTERNAL change between turns → diff still shown, flagged external with the break boundary', async () => {
    const { recorder, disk } = makeHarness({
      initialFiles: { '/ws/a.txt': 'v1\n' },
    })
    // Turn 1: v1 → v2, finalize (clean after(T1) = v2).
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    disk.write('/ws/a.txt', 'v2\n')
    await recorder.finalizeOpenTurns()
    // ANOTHER SESSION edits the file on disk between our turns (unrecorded).
    disk.write('/ws/a.txt', 'v2\nexternal\n')
    // Turn 3: our next edit — before(T3) captures the polluted disk, so the
    // after(T1) → before(T3) link is broken.
    await recorder.trackBeforeMutation('/ws/a.txt', T3)
    disk.write('/ws/a.txt', 'v2\nexternal\nours\n')
    await recorder.finalizeOpenTurns()

    const totals = await recorder.getSessionTotalDiffs()
    expect(totals).toHaveLength(1)
    // The diff renders (both endpoints are real captured states)...
    expect(totals[0]!.diff.kind).toBe('text')
    // ...but is flagged as not purely this session's work, at turn 1 → turn 3.
    expect(totals[0]!.provenance).toBe('external')
    expect(totals[0]!.externalBetween).toEqual({ afterTurn: 1, beforeTurn: 3 })
  })

  it('EXTERNAL stays flagged when a chain blob is UNREADABLE (fail-loud, not silently clean)', async () => {
    const { recorder, disk, fake } = makeHarness({
      initialFiles: { '/ws/a.txt': 'v0\n' },
    })
    // Turn 1: v0 → v1, finalize (after(T1) = a distinct blob, id != before(T2)).
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    disk.write('/ws/a.txt', 'v1\n')
    await recorder.finalizeOpenTurns()
    // Another session edits the file, so before(T2) differs from after(T1) —
    // the continuity link reaches the BLOB comparison (ids differ).
    disk.write('/ws/a.txt', 'EXT\n')
    await recorder.trackBeforeMutation('/ws/a.txt', T2)
    disk.write('/ws/a.txt', 'v2\n')
    await recorder.finalizeOpenTurns()
    // Evict the after(T1) blob so its continuity read fails (torn/missing blob).
    const afterT1Id = fake.turnFiles.get('1|/ws/a.txt')![7] as number
    disk.delete(`${SESSION_DIR}/snapshots/${afterT1Id}`)

    const totals = await recorder.getSessionTotalDiffs()
    expect(totals).toHaveLength(1)
    // Red-without: an unreadable link blob returned 'continuous', HIDING the
    // real external change; now an unprovable link fails toward the warning.
    expect(totals[0]!.provenance).toBe('external')
    expect(totals[0]!.externalBetween).toEqual({ afterTurn: 1, beforeTurn: 2 })
  })

  it('ROUND-TRIP: a file edited then restored to its original bytes nets to unchanged → dropped', async () => {
    const { recorder, disk } = makeHarness({
      initialFiles: { '/ws/a.txt': 'orig\n' },
    })
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    disk.write('/ws/a.txt', 'changed\n')
    await recorder.finalizeOpenTurns()
    await recorder.trackBeforeMutation('/ws/a.txt', T2)
    disk.write('/ws/a.txt', 'orig\n') // back to the session original
    await recorder.finalizeOpenTurns()

    expect(await recorder.getSessionTotalDiffs()).toEqual([])
  })

  it('NOT-CAPTURED: an over-cap file is listed with kind notCaptured (no hunks to total)', async () => {
    const { recorder, disk } = makeHarness({
      initialFiles: { '/ws/big.bin': 'x'.repeat(100) },
      maxSnapshotBytes: 10,
    })
    await recorder.trackBeforeMutation('/ws/big.bin', T1)
    disk.write('/ws/big.bin', 'y'.repeat(100))
    await recorder.finalizeOpenTurns()

    const totals = await recorder.getSessionTotalDiffs()
    expect(totals).toHaveLength(1)
    expect(totals[0]!.diff.kind).toBe('notCaptured')
    expect(totals[0]!.provenance).toBe('clean')
  })

  it('returns [] with no persisted state', async () => {
    const { recorder } = makeHarness()
    expect(await recorder.getSessionTotalDiffs()).toEqual([])
  })
})

describe('FileSnapshotRecorder — revert', () => {
  it('revertSession restores originals, deletes created files, skips not-captured rows', async () => {
    const { recorder, disk } = makeHarness({
      initialFiles: { '/ws/edit.txt': 'old', '/ws/big.bin': 'x'.repeat(100) },
      maxSnapshotBytes: 10,
    })
    await recorder.trackBeforeMutation('/ws/edit.txt', T1)
    await recorder.trackBeforeMutation('/ws/new.txt', T1)
    await recorder.trackBeforeMutation('/ws/big.bin', T1)
    disk.write('/ws/edit.txt', 'changed')
    disk.write('/ws/new.txt', 'created')
    disk.write('/ws/big.bin', 'y'.repeat(100))

    const result = await recorder.revertSession()
    expect(disk.read('/ws/edit.txt')).toBe('old')
    expect(disk.has('/ws/new.txt')).toBe(false)
    expect(disk.read('/ws/big.bin')).toBe('y'.repeat(100)) // untouched
    expect(result.restored.sort()).toEqual(['/ws/edit.txt', '/ws/new.txt'])
    expect(result.skipped).toEqual(['/ws/big.bin'])
    expect(result.failed).toEqual([])
  })

  it('revertToTurnStart(N) restores each path to the before-state of the SMALLEST turn ≥ N that touched it', async () => {
    const { recorder, disk } = makeHarness({
      initialFiles: { '/ws/a.txt': 'v1' },
    })
    // turn 1: v1 → v2, turn 2: v2 → v3, turn 3: v3 → v4
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    disk.write('/ws/a.txt', 'v2')
    await recorder.finalizeOpenTurns()
    await recorder.trackBeforeMutation('/ws/a.txt', T2)
    disk.write('/ws/a.txt', 'v3')
    await recorder.finalizeOpenTurns()
    await recorder.trackBeforeMutation('/ws/a.txt', T3)
    disk.write('/ws/a.txt', 'v4')
    await recorder.finalizeOpenTurns()

    const result = await recorder.revertToTurnStart(2)
    expect(disk.read('/ws/a.txt')).toBe('v2') // the state BEFORE turn 2
    expect(result.restored).toEqual(['/ws/a.txt'])
  })

  it('revert is restore-only-if-changed: an already-matching file is not rewritten', async () => {
    const { recorder } = makeHarness({ initialFiles: { '/ws/a.txt': 'same' } })
    await recorder.trackBeforeMutation('/ws/a.txt', T1)
    const result = await recorder.revertSession()
    expect(result.restored).toEqual([])
  })
})

describe('FileSnapshotRecorder — shell probes (speculative capture + discard)', () => {
  it('probeBeforeMutation reports a fresh capture once; an unchanged probe is discarded with its session row and blob', async () => {
    const h = makeHarness({ initialFiles: { '/proj/a.txt': 'A' } })
    expect(await h.recorder.probeBeforeMutation('/proj/a.txt', T1)).toBe(true)
    expect(await h.recorder.probeBeforeMutation('/proj/a.txt', T1)).toBe(false)
    expect(h.fake.turnFiles.size).toBe(1)
    expect(h.fake.snapshots.size).toBe(1)
    expect(h.disk.listUnder(`${SESSION_DIR}/snapshots`)).toHaveLength(1)

    // A second probe shared the row: nothing may discard it now.
    expect(await h.recorder.discardUnchangedProbe('/proj/a.txt', 1)).toBe(false)
    expect(h.fake.turnFiles.size).toBe(1)

    const fresh = makeHarness({ initialFiles: { '/proj/a.txt': 'A' } })
    expect(await fresh.recorder.probeBeforeMutation('/proj/a.txt', T1)).toBe(true)
    expect(await fresh.recorder.discardUnchangedProbe('/proj/a.txt', 1)).toBe(true)
    expect(fresh.fake.turnFiles.size).toBe(0)
    expect(fresh.fake.sessionFiles.size).toBe(0)
    expect(fresh.fake.snapshots.size).toBe(0)
    expect(fresh.disk.listUnder(`${SESSION_DIR}/snapshots`)).toHaveLength(0)
    // The path is free again: a later real mutation this turn captures anew.
    expect(await fresh.recorder.probeBeforeMutation('/proj/a.txt', T1)).toBe(true)
  })

  it('keeps the row when the file changed, and the turn then diffs it', async () => {
    const h = makeHarness({ initialFiles: { '/proj/a.txt': 'A\n' } })
    await h.recorder.probeBeforeMutation('/proj/a.txt', T1)
    h.disk.write('/proj/a.txt', 'B\n')
    expect(await h.recorder.discardUnchangedProbe('/proj/a.txt', 1)).toBe(false)
    await h.recorder.finalizeOpenTurns()
    const turns = await h.recorder.getTurnDiffs()
    expect(turns[0]?.files.map(f => f.displayPath)).toEqual(['/proj/a.txt'])
  })

  it('refuses to discard a row another capture relied on, even when the disk is unchanged', async () => {
    const h = makeHarness({ initialFiles: { '/proj/a.txt': 'A' } })
    expect(await h.recorder.probeBeforeMutation('/proj/a.txt', T1)).toBe(true)
    await h.recorder.trackBeforeMutation('/proj/a.txt', T1)
    expect(await h.recorder.discardUnchangedProbe('/proj/a.txt', 1)).toBe(false)
    expect(h.fake.turnFiles.size).toBe(1)
  })

  it('a discarded probe in a later turn leaves the session original and the shared blob in place', async () => {
    const h = makeHarness({ initialFiles: { '/proj/a.txt': 'A' } })
    await h.recorder.trackBeforeMutation('/proj/a.txt', T1)
    h.disk.write('/proj/a.txt', 'B')
    await h.recorder.finalizeOpenTurns()
    const blobsAfterTurn1 = h.fake.snapshots.size
    expect(await h.recorder.probeBeforeMutation('/proj/a.txt', T2)).toBe(true)
    // Turn 2's before reused turn 1's after blob — no new blob.
    expect(h.fake.snapshots.size).toBe(blobsAfterTurn1)
    expect(await h.recorder.discardUnchangedProbe('/proj/a.txt', 2)).toBe(true)
    expect(h.fake.turnFiles.size).toBe(1)
    expect(h.fake.sessionFiles.size).toBe(1)
    expect(h.fake.snapshots.size).toBe(blobsAfterTurn1)
  })

  it('an absent path: still absent → discarded; created → kept as a new file', async () => {
    const h = makeHarness()
    await h.recorder.probeBeforeMutation('/proj/new.txt', T1)
    await h.recorder.probeBeforeMutation('/proj/made.txt', T1)
    h.disk.write('/proj/made.txt', 'hello')
    expect(await h.recorder.discardUnchangedProbe('/proj/new.txt', 1)).toBe(true)
    expect(await h.recorder.discardUnchangedProbe('/proj/made.txt', 1)).toBe(false)
    await h.recorder.finalizeOpenTurns()
    const turns = await h.recorder.getTurnDiffs()
    expect(turns[0]?.files.map(f => [f.displayPath, f.fileWasCreated])).toEqual([['/proj/made.txt', true]])
  })

  it('never discards after finalize or when the before-state was skipped', async () => {
    const h = makeHarness({ initialFiles: { '/proj/a.txt': 'A', '/proj/big.txt': 'x'.repeat(40) }, maxSnapshotBytes: 10 })
    await h.recorder.probeBeforeMutation('/proj/a.txt', T1)
    await h.recorder.probeBeforeMutation('/proj/big.txt', T1)
    expect(await h.recorder.discardUnchangedProbe('/proj/big.txt', 1)).toBe(false)
    await h.recorder.finalizeOpenTurns()
    expect(await h.recorder.discardUnchangedProbe('/proj/a.txt', 1)).toBe(false)
  })
})

describe('beginShellMutationProbe — a shell command end to end', () => {
  const big = 'x'.repeat(3 * 1024 * 1024)

  it('captures the named write targets, then keeps only what the command changed', async () => {
    const h = makeHarness({
      initialFiles: { '/proj/a.txt': 'A\n', '/proj/in.txt': 'in', '/proj/large.log': big },
    })
    const probe = await beginShellMutationProbe({
      recorder: h.recorder,
      fs: h.disk.fs,
      turn: T1,
      shell: 'bash',
      cwd: '/proj',
      command: "sed -i 's/A/B/' a.txt && cat in.txt > out.txt && mytool large.log && touch same.txt",
    })
    // a.txt (writer), out.txt (redirect, absent), same.txt (writer, absent);
    // in.txt is read; large.log is a weak operand over the size cap.
    expect([...probe.tracked].sort()).toEqual(['/proj/a.txt', '/proj/out.txt', '/proj/same.txt'])
    expect(h.fake.turnFiles.size).toBe(3)

    h.disk.write('/proj/a.txt', 'B\n')
    h.disk.write('/proj/out.txt', 'in')
    await probe.settle()
    await probe.settle()
    expect([...h.fake.turnFiles.keys()].sort()).toEqual(['1|/proj/a.txt', '1|/proj/out.txt'])
    await h.recorder.finalizeOpenTurns()
    const turns = await h.recorder.getTurnDiffs()
    expect(turns[0]?.files.map(f => [f.displayPath, f.fileWasCreated]).sort()).toEqual([
      ['/proj/a.txt', false],
      ['/proj/out.txt', true],
    ])
  })

  it('a weak operand under the cap is captured, and let go when the tool only read it', async () => {
    const h = makeHarness({ initialFiles: { '/proj/src/x.ts': 'const a = 1\n' } })
    const probe = await beginShellMutationProbe({
      recorder: h.recorder, fs: h.disk.fs, turn: T1, shell: 'bash', cwd: '/proj',
      command: 'npx prettier --check src/x.ts',
    })
    expect(probe.tracked).toEqual(['/proj/src/x.ts'])
    await probe.settle()
    expect(h.fake.turnFiles.size).toBe(0)
    expect(h.fake.snapshots.size).toBe(0)
  })

  it('a recursive removal captures the tree through the directory walk', async () => {
    const h = makeHarness({ initialFiles: { '/proj/build/a.js': '1', '/proj/build/sub/b.js': '2' } })
    const probe = await beginShellMutationProbe({
      recorder: h.recorder, fs: h.disk.fs, turn: T1, shell: 'bash', cwd: '/proj', command: 'rm -rf build',
    })
    expect(probe.tracked).toEqual([])
    expect([...h.fake.turnFiles.keys()].sort()).toEqual(['1|/proj/build/a.js', '1|/proj/build/sub/b.js'])
    await h.disk.fs.rm('/proj/build')
    await probe.settle()
    await h.recorder.finalizeOpenTurns()
    const turns = await h.recorder.getTurnDiffs()
    expect(turns[0]?.files.map(f => f.isDeleted)).toEqual([true, true])
  })

  it('a capture failure skips that path and the command still gets its probe', async () => {
    const h = makeHarness({ initialFiles: { '/proj/a.txt': 'A' } })
    const stat = h.disk.fs.stat.bind(h.disk.fs)
    ;(h.disk.fs as { stat: unknown }).stat = async (p: string) => {
      if (p.endsWith('bad.txt')) throw new Error('EACCES: denied')
      return stat(p)
    }
    const probe = await beginShellMutationProbe({
      recorder: h.recorder, fs: h.disk.fs, turn: T1, shell: 'bash', cwd: '/proj', command: 'touch bad.txt a.txt',
    })
    expect(probe.tracked).toEqual(['/proj/a.txt'])
  })

  it('held probes settle by task id, once', async () => {
    resetHeldShellMutationProbes()
    const h = makeHarness({ initialFiles: { '/proj/a.txt': 'A' } })
    const probe = await beginShellMutationProbe({
      recorder: h.recorder, fs: h.disk.fs, turn: T1, shell: 'bash', cwd: '/proj', command: 'touch a.txt',
    })
    holdShellMutationProbe('b1', probe)
    expect(h.fake.turnFiles.size).toBe(1)
    await settleHeldShellMutationProbe('b1')
    expect(h.fake.turnFiles.size).toBe(0)
    await settleHeldShellMutationProbe('b1')
    await settleHeldShellMutationProbe('never-held')
  })
})

describe('snapshotDiff', () => {
  const enc = (s: string) => new TextEncoder().encode(s)

  it('decodeSnapshotBytes: text, binary (NUL sniff), absent', () => {
    expect(decodeSnapshotBytes(enc('hello'))).toEqual({ kind: 'text', text: 'hello' })
    expect(decodeSnapshotBytes(new Uint8Array([104, 0, 105]))).toEqual({
      kind: 'binary',
    })
    expect(decodeSnapshotBytes(null)).toEqual({ kind: 'absent' })
  })

  it('computeSnapshotFileDiff covers edit / create / delete / unchanged / binary / notCaptured', () => {
    const edit = computeSnapshotFileDiff({
      displayPath: 'a.txt',
      before: { kind: 'text', text: 'one\ntwo\n' },
      after: { kind: 'text', text: 'one\nTWO\n' },
    })
    expect(edit.kind).toBe('text')
    expect(edit.plusLines).toBe(1)
    expect(edit.minusLines).toBe(1)

    const created = computeSnapshotFileDiff({
      displayPath: 'b.txt',
      before: { kind: 'absent' },
      after: { kind: 'text', text: 'fresh\n' },
    })
    expect(created.kind).toBe('text')
    expect(created.fileWasCreated).toBe(true)
    expect(created.hunks[0]!.lines[0]).toBe('+fresh')

    const deleted = computeSnapshotFileDiff({
      displayPath: 'c.txt',
      before: { kind: 'text', text: 'gone\n' },
      after: { kind: 'absent' },
    })
    expect(deleted.kind).toBe('text')
    expect(deleted.isDeleted).toBe(true)
    expect(deleted.minusLines).toBeGreaterThan(0)

    expect(
      computeSnapshotFileDiff({
        displayPath: 'd.txt',
        before: { kind: 'text', text: 'same' },
        after: { kind: 'text', text: 'same' },
      }).kind,
    ).toBe('unchanged')

    expect(
      computeSnapshotFileDiff({
        displayPath: 'e.bin',
        before: { kind: 'binary' },
        after: { kind: 'text', text: 'now text' },
      }).kind,
    ).toBe('binary')

    expect(
      computeSnapshotFileDiff({
        displayPath: 'f.big',
        before: { kind: 'notCaptured' },
        after: { kind: 'text', text: 'x' },
      }).kind,
    ).toBe('notCaptured')
  })

  it('formatUnifiedDiffText renders git-style headers, /dev/null sides, and marker lines', () => {
    const text = formatUnifiedDiffText([
      computeSnapshotFileDiff({
        displayPath: 'D:\\ws\\a.txt',
        before: { kind: 'absent' },
        after: { kind: 'text', text: 'new\n' },
      }),
      computeSnapshotFileDiff({
        displayPath: 'b.bin',
        before: { kind: 'binary' },
        after: { kind: 'binary' },
      }),
      computeSnapshotFileDiff({
        displayPath: 'c.big',
        before: { kind: 'notCaptured' },
        after: { kind: 'text', text: 'x' },
      }),
    ])
    expect(text).toContain('diff --git a/D:/ws/a.txt b/D:/ws/a.txt')
    expect(text).toContain('--- /dev/null')
    expect(text).toContain('+new')
    expect(text).toContain('Binary file b.bin changed')
    expect(text).toContain('c.big: changes not captured')
  })
})

describe('deriveSnapshotTurnInfo', () => {
  const user = (text: string, uuid: string, extra?: Record<string, unknown>) =>
    ({
      type: 'user',
      uuid,
      message: { content: text },
      ...extra,
    }) as unknown as Message
  const assistant = () =>
    ({ type: 'assistant', message: { content: [] } }) as unknown as Message

  it('counts real user-prompt boundaries and reports the LAST one (agrees with isTurnBoundary)', () => {
    const messages = [
      user('first', 'u1'),
      assistant(),
      user('second', 'u2'),
      assistant(),
    ]
    expect(deriveSnapshotTurnInfo(messages)).toEqual({
      seq: 2,
      uuid: 'u2',
      preview: 'second',
    })
    expect(messages.filter(isTurnBoundary)).toHaveLength(2)
  })

  it('a meta message opens no new turn — mutations attribute to the last real boundary', () => {
    const messages = [
      user('real', 'u1'),
      assistant(),
      user('resume', 'u-meta', { isMeta: true }),
    ]
    expect(deriveSnapshotTurnInfo(messages).seq).toBe(1)
    expect(deriveSnapshotTurnInfo(messages).uuid).toBe('u1')
  })

  it('degrades to seq 1 on an empty / boundary-less transcript instead of failing the capture', () => {
    expect(deriveSnapshotTurnInfo([])).toEqual({ seq: 1, preview: '' })
  })
})
