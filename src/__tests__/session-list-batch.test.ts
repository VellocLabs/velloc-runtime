import { describe, expect, it, vi } from 'vitest'
import { GroupedConversationStorage } from '../browser/storage/GroupedConversationStorage'
import type { SqliteSessionMetaStore } from '../browser/storage/SqliteSessionMetaStore'
import {
  parseSessionTree,
  scanSessionTreeComplete,
} from '../browser/storage/sessionTreeScan'
import { sliceReadBatch } from '../browser/bridge/protocol/fs'
import type { BridgeFsTreeEntry } from '../browser/bridge/protocol/fs'
import type { SessionMetaFile } from '../sessions/sessionStore'

/**
 * The session index scan (`parseSessionTree`) and the batched read
 * (`sliceReadBatch`) are still the primitives — the one-time `meta.json` →
 * sqlite migration reuses them to seed the store from the legacy files. After
 * that seed, the sidebar reads the single DB in one query and never scans
 * again. The tests below pin the pure scan/slice units, then the migration's
 * source selection (which file it reads per session) and its run-once guard.
 */

const PROJECTS = '/home/.velloc/projects'

function dirRow(path: string): BridgeFsTreeEntry {
  return { path, isDirectory: true, size: 0 }
}
function fileRow(path: string, size: number): BridgeFsTreeEntry {
  return { path, isDirectory: false, size, mtimeMs: 1 }
}

describe('parseSessionTree', () => {
  it('indexes sessions from a depth-3 scan and ignores tool-details', () => {
    const rows = parseSessionTree([
      dirRow('ProjA'),
      dirRow('ProjA/s1'),
      fileRow('ProjA/s1/transcript.jsonl', 4096),
      fileRow('ProjA/s1/meta.json', 512),
      // The depth cap lists tool-details as a dir; if a future change ever
      // descends, these rows must still not become sessions.
      dirRow('ProjA/s1/tool-details'),
      fileRow('ProjA/s1/tool-details/a.json', 10),
      dirRow('ProjB'),
      dirRow('ProjB/s2'),
      fileRow('ProjB/s2/transcript.jsonl', 128),
      // Pre-migration: no meta.json yet, but the retired sidecar is there.
      fileRow('ProjB/s2/meta.jsonl', 300),
      // A meta.json-only session — an empty New Thread that survived a restart.
      dirRow('ProjB/s3'),
      fileRow('ProjB/s3/meta.json', 200),
    ])

    expect(rows).toEqual([
      {
        projectDirName: 'ProjA',
        sessionId: 's1',
        transcriptSize: 4096,
        metaSize: 512,
        legacyMetaSize: null,
      },
      {
        projectDirName: 'ProjB',
        sessionId: 's2',
        transcriptSize: 128,
        metaSize: null,
        legacyMetaSize: 300,
      },
      {
        projectDirName: 'ProjB',
        sessionId: 's3',
        transcriptSize: null,
        metaSize: 200,
        legacyMetaSize: null,
      },
    ])
  })

  it('drops a session dir with neither meta.json nor a transcript', () => {
    // A stray directory — or a retired `meta.jsonl` on its own, which was
    // always derived from the transcript — is not a session.
    const rows = parseSessionTree([
      dirRow('ProjA/orphan'),
      fileRow('ProjA/orphan/meta.jsonl', 40),
      dirRow('ProjA/empty'),
      fileRow('ProjA/empty/meta.json', 0),
      fileRow('ProjA/empty/transcript.jsonl', 0),
    ])
    expect(rows).toEqual([])
  })

  it('keeps a session id appearing under two project dirs as two rows', () => {
    // Resolving that duplicate needs both copies.
    const rows = parseSessionTree([
      fileRow('ProjA/dup/transcript.jsonl', 10),
      fileRow('ProjB/dup/transcript.jsonl', 20),
    ])
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.projectDirName).sort()).toEqual(['ProjA', 'ProjB'])
  })
})

// ---------------------------------------------------------------------------

/**
 * A host `fs.readdirTree` over an in-memory tree, with the host's semantics:
 * breadth-first, root-relative '/' paths, directories at `maxDepth` listed but
 * not descended, and the scan cut (`truncated`) once it has `cap` rows.
 * `tree` holds every path under PROJECTS; a trailing '/' marks a directory.
 */
function makeReaddirTree(tree: readonly string[], cap: number) {
  const calls: Array<{ path: string; maxDepth: number }> = []
  const readdirTree = async (path: string, maxDepth: number) => {
    calls.push({ path, maxDepth })
    const base = path === PROJECTS ? '' : path.slice(PROJECTS.length + 1) + '/'
    const rows = tree
      .filter(p => p.startsWith(base) && p !== base)
      .map(p => {
        const isDirectory = p.endsWith('/')
        const rel = (isDirectory ? p.slice(0, -1) : p).slice(base.length)
        return { rel, isDirectory, depth: rel.split('/').length }
      })
      .filter(row => row.depth <= maxDepth)
      .sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel))
    const entries = rows
      .slice(0, cap)
      .map(row =>
        row.isDirectory ? dirRow(row.rel) : fileRow(row.rel, 10),
      )
    return { entries, truncated: rows.length > cap }
  }
  return { readdirTree, calls }
}

describe('scanSessionTreeComplete', () => {
  const join = (base: string, child: string) => `${base}/${child}`
  const TREE = [
    'ProjA/',
    'ProjA/s1/',
    'ProjA/s1/meta.json',
    'ProjA/s1/transcript.jsonl',
    'ProjA/s1/tool-details/',
    'ProjA/s1/tool-details/t1.json',
    'ProjA/s2/',
    'ProjA/s2/meta.json',
    'ProjB/',
    'ProjB/s3/',
    'ProjB/s3/meta.json',
  ]

  it('is ONE depth-3 call when the host does not cut it', async () => {
    const { readdirTree, calls } = makeReaddirTree(TREE, 1000)
    const scan = await scanSessionTreeComplete(PROJECTS, readdirTree, join)
    expect(calls).toEqual([{ path: PROJECTS, maxDepth: 3 }])
    expect(scan.truncated).toBe(false)
    expect(scan.rows.map(r => r.sessionId).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('a profile past the entry cap is scanned a level at a time — COMPLETE, not truncated', async () => {
    // Cap 5: the depth-3 scan and ProjA's depth-2 scan are both cut; ProjA is
    // then listed (depth 1) and each session dir scanned on its own.
    const { readdirTree } = makeReaddirTree(TREE, 5)
    expect((await readdirTree(PROJECTS, 3)).truncated).toBe(true)
    const scan = await scanSessionTreeComplete(PROJECTS, readdirTree, join)
    expect(scan.truncated).toBe(false)
    expect(
      scan.rows
        .map(r => `${r.projectDirName}/${r.sessionId}:${r.transcriptSize ?? '-'}`)
        .sort(),
    ).toEqual(['ProjA/s1:10', 'ProjA/s2:-', 'ProjB/s3:-'])
  })

  it('reports truncated only when a single dir has more children than the cap', async () => {
    const wide = ['ProjA/', ...[1, 2, 3, 4].flatMap(n => [`ProjA/s${n}/`, `ProjA/s${n}/meta.json`])]
    const { readdirTree } = makeReaddirTree(wide, 3)
    const scan = await scanSessionTreeComplete(PROJECTS, readdirTree, join)
    expect(scan.truncated).toBe(true)
  })
})

describe('sliceReadBatch', () => {
  const blob = new TextEncoder().encode('aaabb')

  it('slices each item out of the single concatenated blob', () => {
    const sliced = sliceReadBatch(
      [{ path: 'a' }, { path: 'b' }],
      {
        entries: [
          { path: 'a', ok: true, byteOffset: 0, byteLength: 3 },
          { path: 'b', ok: true, byteOffset: 3, byteLength: 2 },
        ],
        blob,
      },
    )
    expect(new TextDecoder().decode(sliced[0]!.bytes!)).toBe('aaa')
    expect(new TextDecoder().decode(sliced[1]!.bytes!)).toBe('bb')
  })

  // The guard that matters. The C++ codegen's array<object> extractor DROPS a
  // malformed item, and a short index would shift every later entry —
  // handing one session's bytes to another. Losing the batch is recoverable;
  // silently mixing up summaries is not.
  it('rejects the whole batch when the index is shorter than the request', () => {
    expect(() =>
      sliceReadBatch([{ path: 'a' }, { path: 'b' }], {
        entries: [{ path: 'a', ok: true, byteOffset: 0, byteLength: 3 }],
        blob,
      }),
    ).toThrow(/1 entries for 2 items/)
  })

  it('rejects a batch whose entries came back out of order', () => {
    expect(() =>
      sliceReadBatch([{ path: 'a' }, { path: 'b' }], {
        entries: [
          { path: 'b', ok: true, byteOffset: 0, byteLength: 2 },
          { path: 'a', ok: true, byteOffset: 2, byteLength: 3 },
        ],
        blob,
      }),
    ).toThrow(/expected "a"/)
  })

  it('passes per-item failure through without throwing', () => {
    const sliced = sliceReadBatch([{ path: 'a' }, { path: 'gone' }], {
      entries: [
        { path: 'a', ok: true, byteOffset: 0, byteLength: 3 },
        { path: 'gone', ok: false, byteOffset: 0, byteLength: 0, error: 'ENOENT' },
      ],
      blob,
    })
    expect(sliced[1]!.ok).toBe(false)
    expect(sliced[1]!.bytes).toBeNull()
    expect(sliced[1]!.error).toBe('ENOENT')
  })

  it('treats an index that runs past the blob as an unreadable item', () => {
    const sliced = sliceReadBatch([{ path: 'a' }], {
      entries: [{ path: 'a', ok: true, byteOffset: 0, byteLength: 999 }],
      blob,
    })
    expect(sliced[0]!.ok).toBe(false)
    expect(sliced[0]!.bytes).toBeNull()
  })
})

// ---------------------------------------------------------------------------

type Seed = {
  /** projectDirName → sessionId → { transcriptSize, metaSize, legacyMetaSize? } */
  [projectDirName: string]: Record<
    string,
    {
      transcriptSize: number | null
      metaSize: number | null
      legacyMetaSize?: number | null
    }
  >
}

/** In-memory `SqliteSessionMetaStore` stand-in that records seeds and the
 *  migration marker. */
function makeFakeMetaStore() {
  const rows = new Map<string, SessionMetaFile>()
  let migrated = false
  const store = {
    readMeta: vi.fn(async (id: string) => rows.get(id) ?? null),
    upsertMeta: vi.fn(async (id: string, meta: SessionMetaFile) => {
      rows.set(id, meta)
    }),
    deleteMeta: vi.fn(async (id: string) => {
      rows.delete(id)
    }),
    seedMeta: vi.fn(async (id: string, meta: SessionMetaFile) => {
      if (!rows.has(id)) rows.set(id, meta)
    }),
    listAll: vi.fn(async () =>
      [...rows.entries()].map(([sessionId, meta]) => ({ sessionId, meta })),
    ),
    hasMigration: vi.fn(async () => migrated),
    markMigration: vi.fn(async () => {
      migrated = true
    }),
  }
  return { store, rows }
}

function makeStorage(seed: Seed) {
  const { store, rows } = makeFakeMetaStore()

  const createBackend = vi.fn((basePath: string) => {
    const backend = {
      basePath,
      append: vi.fn(async () => {}),
      // The full-transcript fallback used when a source yields no meta.
      load: vi.fn(async () => null),
      flush: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => {}),
    }
    return backend as never
  })

  const scanSessionTree = vi.fn(async () =>
    Object.entries(seed).flatMap(([projectDirName, sessions]) =>
      Object.entries(sessions).map(([sessionId, sizes]) => ({
        projectDirName,
        sessionId,
        transcriptSize: sizes.transcriptSize,
        metaSize: sizes.metaSize,
        legacyMetaSize: sizes.legacyMetaSize ?? null,
      })),
    ),
  )

  const requested: Array<
    Array<{ path: string; offset?: number; length?: number }>
  > = []
  const readSummarySources = vi.fn(
    async (
      items: ReadonlyArray<{ path: string; offset?: number; length?: number }>,
    ): Promise<
      Array<{ path: string; ok: boolean; bytes: Uint8Array | null }>
    > => {
      requested.push(items.map(item => ({ ...item })))
      // Return a valid meta.json for `meta.json` paths (so the migration seeds
      // real rows); other sources ('x') don't parse and simply don't seed —
      // enough to assert which SOURCE was chosen per session.
      return items.map(item => {
        const segments = item.path.split('/')
        const sessionId = segments[segments.length - 2] ?? ''
        const dir = segments.slice(0, -2).join('/')
        const bytes = item.path.endsWith('meta.json')
          ? new TextEncoder().encode(
              JSON.stringify({
                schemaVersion: 1,
                sessionId,
                updatedAt: 1,
                metadata: { projectRoot: dir, messageCount: 1 },
              } satisfies SessionMetaFile),
            )
          : new TextEncoder().encode('x')
        return { path: item.path, ok: true, bytes: bytes as Uint8Array | null }
      })
    },
  )

  const storage = new GroupedConversationStorage({
    projectsRoot: PROJECTS,
    defaultProjectDir: `${PROJECTS}/workspace`,
    createBackend,
    scanSessionTree,
    readSummarySources,
    joinPath: (base, child) => `${base}/${child}`,
    metaStore: store as unknown as SqliteSessionMetaStore,
    resolveProjectDirForMeta: meta =>
      (meta.metadata.projectRoot as string | undefined) ??
      `${PROJECTS}/workspace`,
  })

  return { storage, scanSessionTree, readSummarySources, requested, store, rows }
}

describe('meta.json → sqlite migration (runs inside first listSessions)', () => {
  it('seeds every session, then never scans again', async () => {
    const { storage, scanSessionTree, store } = makeStorage({
      ProjA: {
        s1: { transcriptSize: 100, metaSize: 40 },
        s2: { transcriptSize: 200, metaSize: 40 },
      },
      ProjB: { s3: { transcriptSize: 300, metaSize: 40 } },
    })

    expect((await storage.listSessions()).sort()).toEqual(['s1', 's2', 's3'])
    expect(scanSessionTree).toHaveBeenCalledTimes(1)
    expect(store.markMigration).toHaveBeenCalledTimes(1)

    // The store is authoritative now — a second list reads it, no re-scan.
    await storage.listSessions()
    expect(scanSessionTree).toHaveBeenCalledTimes(1)
  })

  it('picks the migration source per session from the scan (meta.json / sidecar / tail)', async () => {
    const { storage, requested } = makeStorage({
      ProjA: {
        migrated: { transcriptSize: 900_000, metaSize: 40 },
        withSidecar: {
          transcriptSize: 900_000,
          metaSize: null,
          legacyMetaSize: 120,
        },
        legacy: { transcriptSize: 900_000, metaSize: null },
        emptyThread: { transcriptSize: null, metaSize: 40 },
      },
    })
    await storage.listSessions()

    // All source reads ride ONE batch (no per-session round-trips).
    expect(requested).toHaveLength(1)
    const items = requested[0]!
    // A session with a meta.json reads it whole; its transcript is never opened.
    const migrated = items.find(i => i.path.includes('/migrated/'))!
    expect(migrated.path).toMatch(/meta\.json$/)
    expect(migrated.length).toBeUndefined()
    // An empty New Thread (meta.json only) reads its meta.json.
    expect(items.find(i => i.path.includes('/emptyThread/'))!.path).toMatch(
      /meta\.json$/,
    )
    // A not-yet-migrated session with the retired sidecar reads that whole.
    const withSidecar = items.find(i => i.path.includes('/withSidecar/'))!
    expect(withSidecar.path).toMatch(/meta\.jsonl$/)
    expect(withSidecar.length).toBeUndefined()
    // One with neither reads a bounded transcript tail at the scan's offset.
    const legacy = items.find(i => i.path.includes('/legacy/'))!
    expect(legacy.path).toMatch(/transcript\.jsonl$/)
    expect(legacy.length).toBe(64 * 1024)
    expect(legacy.offset).toBe(900_000 - 64 * 1024)
  })

  it('resolves a duplicate session id to the copy WITH messages, listed once', async () => {
    // ProjB holds the real conversation; ProjA is a newer bind-time stub.
    // "has messages" must beat "newer", or the session opens blank. Both have
    // a meta.json, so the migration derives real metas and ranks them.
    const { storage, readSummarySources } = makeStorage({
      ProjA: { dup: { transcriptSize: 100, metaSize: 40 } },
      ProjB: { dup: { transcriptSize: 100, metaSize: 40 } },
    })
    // Override the source read so ProjB's copy has messages (newer ProjA is 0).
    readSummarySources.mockImplementation(async items =>
      items.map(item => {
        const segments = item.path.split('/')
        const sessionId = segments[segments.length - 2] ?? ''
        const dir = segments.slice(0, -2).join('/')
        const messageCount = dir.endsWith('ProjB') ? 5 : 0
        const updatedAt = dir.endsWith('ProjB') ? 1 : 999
        return {
          path: item.path,
          ok: true,
          bytes: new TextEncoder().encode(
            JSON.stringify({
              schemaVersion: 1,
              sessionId,
              updatedAt,
              metadata: { projectRoot: dir, messageCount },
            } satisfies SessionMetaFile),
          ) as Uint8Array | null,
        }
      }),
    )

    expect(await storage.listSessions()).toEqual(['dup'])
    expect(storage.projectRouteOf('dup')).toBe(`${PROJECTS}/ProjB`)
  })
})
