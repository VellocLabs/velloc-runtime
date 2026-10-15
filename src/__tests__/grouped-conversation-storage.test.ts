import { describe, expect, it, vi } from 'vitest'
import { GroupedConversationStorage } from '../browser/storage/GroupedConversationStorage'
import type { SqliteSessionMetaStore } from '../browser/storage/SqliteSessionMetaStore'
import { MIGRATION_READ_FAILURE_LIMIT } from '../browser/storage/SqliteSessionMetaStore'
import type { SessionMetaFile } from '../sessions/sessionStore'

const PROJECTS = '/home/.velloc/projects'

/** A SessionMetaFile whose `metadata.projectRoot` IS the routing dir (the fake
 *  `resolveProjectDirForMeta` returns it verbatim), so a seeded/read row routes
 *  to that dir. `messageCount`/`updatedAt` drive the migration's duplicate
 *  tiebreak (`rankCopies`). */
function makeMeta(
  sessionId: string,
  projectDir: string,
  updatedAt = 0,
  messageCount = 0,
): SessionMetaFile {
  return {
    schemaVersion: 1,
    sessionId,
    updatedAt,
    metadata: { projectRoot: projectDir, messageCount },
  }
}

/** In-memory stand-in for `SqliteSessionMetaStore` — one row per sessionId,
 *  sub-agent ids filtered from `listAll` exactly like the real store. */
function makeFakeMetaStore(
  preseed: Array<{ sessionId: string; meta: SessionMetaFile }> = [],
  migrated = false,
) {
  const rows = new Map<string, SessionMetaFile>()
  // Parallel `sessionId → project_dir` map, mirroring the real column. `upsert`
  // only overwrites it when a dir is supplied (the store's COALESCE preserve).
  const dirs = new Map<string, string>()
  for (const { sessionId, meta } of preseed) rows.set(sessionId, meta)
  let migratedFlag = migrated
  const readFailures = new Map<string, number>()
  const store = {
    readMeta: vi.fn(async (id: string) => rows.get(id) ?? null),
    readStoredMeta: vi.fn(async (id: string) =>
      rows.has(id)
        ? { meta: rows.get(id)!, projectDir: dirs.get(id) }
        : null,
    ),
    upsertMeta: vi.fn(
      async (id: string, meta: SessionMetaFile, projectDir?: string) => {
        rows.set(id, meta)
        if (projectDir !== undefined) dirs.set(id, projectDir)
      },
    ),
    deleteMeta: vi.fn(async (id: string) => {
      rows.delete(id)
      dirs.delete(id)
    }),
    seedMeta: vi.fn(
      async (id: string, meta: SessionMetaFile, projectDir?: string) => {
        if (!rows.has(id)) {
          rows.set(id, meta)
          if (projectDir !== undefined) dirs.set(id, projectDir)
        }
      },
    ),
    listAll: vi.fn(async () =>
      [...rows.entries()]
        .filter(([id]) => !id.startsWith('subagent-'))
        .map(([sessionId, meta]) => ({
          sessionId,
          meta,
          projectDir: dirs.get(sessionId),
        })),
    ),
    hasMigration: vi.fn(async () => migratedFlag),
    markMigration: vi.fn(async () => {
      migratedFlag = true
    }),
    // Mirrors the real store's per-path failed-boot counter (persisted in
    // `meta_migration_failures`), so a test can boot the router repeatedly.
    noteMigrationReadFailures: vi.fn(
      async (_name: string, paths: Iterable<string>) => {
        const pending: string[] = []
        const skipped: string[] = []
        for (const path of new Set(paths)) {
          const n = (readFailures.get(path) ?? 0) + 1
          readFailures.set(path, n)
          ;(n >= MIGRATION_READ_FAILURE_LIMIT ? skipped : pending).push(path)
        }
        return { pending, skipped }
      },
    ),
  }
  return { store, rows, dirs, readFailures }
}

function makeFakeBackend(basePath: string) {
  return {
    basePath,
    append: vi.fn(async () => {}),
    load: vi.fn(async () => null),
    flush: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    saveToolCallDetail: vi.fn(async () => {}),
    loadToolCallDetail: vi.fn(async () => null),
  }
}

type Options = {
  /** Rows already in the store (steady-state tests). */
  preseed?: Array<{ sessionId: string; meta: SessionMetaFile }>
  /** Whether the one-time migration has already run. */
  migrated?: boolean
  /**
   * Migration inputs: sessions on disk, keyed by project dir, plus their
   * per-copy `updatedAt`/`messageCount` for the tiebreak. Drives the fake
   * `scanSessionTree` + `readSummarySources` so the migration seeds real metas.
   */
  onDisk?: Record<string, string[]>
  updatedAt?: Record<string, Record<string, number>>
  messageCount?: Record<string, Record<string, number>>
  /**
   * When set, the on-disk `meta.json` files carry NO `projectRoot` (the real
   * legacy shape — it persisted neither `projectRoot` nor `templateType`), so
   * the session's ONLY routing key is the folder the scan found it in. Exercises
   * the `project_dir` recovery path.
   */
  rootless?: boolean
}

function makeStorage(opts: Options = {}) {
  const { store, rows, readFailures } = makeFakeMetaStore(
    opts.preseed,
    opts.migrated ?? false,
  )
  const created = new Map<string, ReturnType<typeof makeFakeBackend>>()
  const createBackend = vi.fn((basePath: string) => {
    const b = makeFakeBackend(basePath)
    created.set(basePath, b)
    return b as never
  })

  const onDisk = opts.onDisk ?? {}
  // One tree row per (dir, sessionId), all with a `meta.json` (metaSize > 0).
  const scanSessionTree = vi.fn(async () =>
    Object.entries(onDisk).flatMap(([basePath, ids]) =>
      ids.map(sessionId => ({
        projectDirName: basePath.slice(PROJECTS.length + 1),
        sessionId,
        transcriptSize: 100,
        metaSize: 50,
        legacyMetaSize: null,
      })),
    ),
  )
  // The batched read returns REAL meta.json bytes for each `<dir>/<id>/meta.json`
  // path (the migration parses them into full SessionMetaFiles).
  const readSummarySources = vi.fn(
    async (items: ReadonlyArray<{ path: string }>) =>
      items.map(item => {
        const segments = item.path.split('/')
        const sessionId = segments[segments.length - 2] ?? ''
        const basePath = segments.slice(0, -2).join('/')
        const known = (onDisk[basePath] ?? []).includes(sessionId)
        if (!known) return { path: item.path, ok: false, bytes: null }
        const full = makeMeta(
          sessionId,
          basePath,
          opts.updatedAt?.[basePath]?.[sessionId] ?? 0,
          opts.messageCount?.[basePath]?.[sessionId] ?? 0,
        )
        // The legacy `meta.json` stored NEITHER projectRoot nor templateType —
        // strip them so routing must come from the scanned folder (project_dir).
        const meta = opts.rootless
          ? { ...full, metadata: { messageCount: full.metadata.messageCount } }
          : full
        return {
          path: item.path,
          ok: true,
          bytes: new TextEncoder().encode(JSON.stringify(meta)),
        }
      }),
  )

  // A fresh router over the SAME store and fs — what the next worker boot
  // builds. The store (marker, rows, failure counts) is what persists.
  const boot = () =>
    new GroupedConversationStorage({
      projectsRoot: PROJECTS,
      defaultProjectDir: `${PROJECTS}/workspace`,
      createBackend,
      scanSessionTree,
      readSummarySources,
      joinPath: (base, child) => `${base}/${child}`,
      metaStore: store as unknown as SqliteSessionMetaStore,
      // The test's `projectRoot` IS the routing dir.
      resolveProjectDirForMeta: meta =>
        (meta.metadata.projectRoot as string | undefined) ??
        `${PROJECTS}/workspace`,
    })
  const storage = boot()
  return {
    boot,
    readFailures,
    storage,
    created,
    createBackend,
    store,
    rows,
    scanSessionTree,
    readSummarySources,
  }
}

describe('GroupedConversationStorage (sqlite meta store)', () => {
  it('listSessions returns every session from the store, across projects', async () => {
    const { storage } = makeStorage({
      migrated: true,
      preseed: [
        { sessionId: 's1', meta: makeMeta('s1', `${PROJECTS}/ProjA`) },
        { sessionId: 's2', meta: makeMeta('s2', `${PROJECTS}/ProjA`) },
        { sessionId: 's3', meta: makeMeta('s3', `${PROJECTS}/ProjB`) },
      ],
    })
    expect((await storage.listSessions()).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('sub-agent rows never surface in listSessions', async () => {
    const { storage } = makeStorage({
      migrated: true,
      preseed: [
        { sessionId: 's1', meta: makeMeta('s1', `${PROJECTS}/ProjA`) },
        {
          sessionId: 'subagent-x',
          meta: makeMeta('subagent-x', `${PROJECTS}/ProjA`),
        },
      ],
    })
    expect(await storage.listSessions()).toEqual(['s1'])
  })

  it('listSessions restores routing so transcript ops hit the right dir', async () => {
    const { storage, created } = makeStorage({
      migrated: true,
      preseed: [{ sessionId: 's3', meta: makeMeta('s3', `${PROJECTS}/ProjB`) }],
    })
    await storage.listSessions()
    await storage.append('s3', { type: 'x' } as never)
    expect(created.get(`${PROJECTS}/ProjB`)?.append).toHaveBeenCalledWith(
      's3',
      { type: 'x' },
    )
    expect(created.get(`${PROJECTS}/workspace`)).toBeUndefined()
  })

  it('readSessionMeta / loadSessionSummary come from the store, not a backend', async () => {
    const { storage, store, created } = makeStorage({
      migrated: true,
      preseed: [{ sessionId: 's1', meta: makeMeta('s1', `${PROJECTS}/ProjA`, 7) }],
    })
    expect((await storage.readSessionMeta('s1'))?.updatedAt).toBe(7)
    expect((await storage.loadSessionSummary('s1'))?.sessionId).toBe('s1')
    expect(store.readMeta).toHaveBeenCalledWith('s1')
    // No child backend was created just to read meta.
    expect(created.size).toBe(0)
  })

  it('writeSessionMeta upserts into the store', async () => {
    const { storage, rows } = makeStorage({ migrated: true })
    await storage.writeSessionMeta('n1', makeMeta('n1', `${PROJECTS}/ProjA`, 3))
    expect(rows.get('n1')?.updatedAt).toBe(3)
  })

  it('setSessionProjectDir routes a new session before any list', async () => {
    const { storage, created } = makeStorage({ migrated: true })
    storage.setSessionProjectDir('new1', `${PROJECTS}/D--project-Maxh`)
    await storage.append('new1', { type: 'x' } as never)
    expect(
      created.get(`${PROJECTS}/D--project-Maxh`)?.append,
    ).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default (workspace) dir for an unmapped session', async () => {
    const { storage, created } = makeStorage({ migrated: true })
    await storage.append('orphan', { type: 'x' } as never)
    expect(created.get(`${PROJECTS}/workspace`)?.append).toHaveBeenCalledTimes(1)
  })

  it('deleteSession removes the dir AND the store row, then unmaps', async () => {
    const { storage, created, store, rows } = makeStorage({
      migrated: true,
      preseed: [{ sessionId: 's1', meta: makeMeta('s1', `${PROJECTS}/ProjA`) }],
    })
    await storage.listSessions()
    await storage.deleteSession('s1')
    expect(created.get(`${PROJECTS}/ProjA`)?.deleteSession).toHaveBeenCalledWith(
      's1',
    )
    expect(store.deleteMeta).toHaveBeenCalledWith('s1')
    expect(rows.has('s1')).toBe(false)
    // After delete it's unmapped → a later op falls back to the default dir.
    await storage.append('s1', { type: 'x' } as never)
    expect(created.get(`${PROJECTS}/workspace`)?.append).toHaveBeenCalledTimes(1)
  })

  // --- Teammate nesting ------------------------------------------------------
  // A teammate's transcript lives under its lead at `<leadDir>/<headSessionId>/teammates/`; the scan routes
  // reads there, not to the teammate's own projectRoot (which reads back empty).

  it('lists a lead\u2019s TEAMMATE children with their name and shutdown state', async () => {
    // What a lead's bind reconciles against after a restart
    // (TeamCoordinator.reconcileLost): every child on record, marked or not —
    // and, for a marked one, whether the marker says it was LOST to a restart
    // or shut down on purpose. Without `lostAt` the reconcile cannot tell the
    // two apart, and can explain a loss exactly once.
    const child = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({
      sessionId: id,
      meta: {
        ...makeMeta(id, `${PROJECTS}/ProjA`),
        metadata: { projectRoot: `${PROJECTS}/ProjA`, spawnerSessionId: parent, ...extra },
      },
    })
    const { storage } = makeStorage({
      migrated: true,
      preseed: [
        { sessionId: 'lead-1', meta: makeMeta('lead-1', `${PROJECTS}/ProjA`) },
        child('teammate-lead-1-a-1', 'lead-1', { teammateName: 'A' }),
        child('teammate-lead-1-b-2', 'lead-1', { teammateName: 'B', shutdown: true }),
        child('teammate-lead-1-d-4', 'lead-1', {
          teammateName: 'D',
          shutdown: true,
          lostAt: 1_700_000_000_000,
        }),
        child('teammate-lead-2-c-3', 'lead-2', { teammateName: 'C' }),
        // A non-teammate child (a fork) is not a teammate.
        child('fork-of-lead-1', 'lead-1'),
      ],
    })
    expect(await storage.listTeammateChildren('lead-1')).toEqual([
      { sessionId: 'teammate-lead-1-a-1', teammateName: 'A', shutdown: false },
      { sessionId: 'teammate-lead-1-b-2', teammateName: 'B', shutdown: true },
      {
        sessionId: 'teammate-lead-1-d-4',
        teammateName: 'D',
        shutdown: true,
        lostAt: 1_700_000_000_000,
      },
    ])
  })

  it('routes a teammate under its lead, not under its own projectRoot', async () => {
    const { storage, created } = makeStorage({
      migrated: true,
      preseed: [
        { sessionId: 'lead-1', meta: makeMeta('lead-1', `${PROJECTS}/ProjA`) },
        {
          sessionId: 'teammate-lead-1-worker-a-9',
          meta: {
            ...makeMeta('teammate-lead-1-worker-a-9', `${PROJECTS}/Worktree`),
            metadata: {
              projectRoot: `${PROJECTS}/Worktree`,
              spawnerSessionId: 'lead-1',
            },
          },
        },
      ],
    })
    await storage.listSessions()
    expect(storage.projectRouteOf('teammate-lead-1-worker-a-9')).toBe(
      `${PROJECTS}/ProjA/lead-1/teammates`,
    )
    await storage.load('teammate-lead-1-worker-a-9')
    expect(
      created.get(`${PROJECTS}/ProjA/lead-1/teammates`)?.load,
    ).toHaveBeenCalledWith('teammate-lead-1-worker-a-9')
    // The dir the child's own projectRoot resolves to is never touched.
    expect(created.get(`${PROJECTS}/Worktree`)).toBeUndefined()
  })

  it('nests a teammate whose lead is listed AFTER it', async () => {
    // `listAll` gives no parent-before-child ordering, so the resolution has to
    // be two-pass. Preseed insertion order puts the child first.
    const { storage } = makeStorage({
      migrated: true,
      preseed: [
        {
          sessionId: 'teammate-lead-2-x-1',
          meta: {
            ...makeMeta('teammate-lead-2-x-1', `${PROJECTS}/ProjB`),
            metadata: {
              projectRoot: `${PROJECTS}/ProjB`,
              spawnerSessionId: 'lead-2',
            },
          },
        },
        { sessionId: 'lead-2', meta: makeMeta('lead-2', `${PROJECTS}/ProjB`) },
      ],
    })
    await storage.listSessions()
    expect(storage.projectRouteOf('teammate-lead-2-x-1')).toBe(
      `${PROJECTS}/ProjB/lead-2/teammates`,
    )
  })

  it('leaves a teammate whose lead is gone on its own dir', async () => {
    const { storage } = makeStorage({
      migrated: true,
      preseed: [
        {
          sessionId: 'teammate-orphan-x-1',
          meta: {
            ...makeMeta('teammate-orphan-x-1', `${PROJECTS}/ProjC`),
            metadata: {
              projectRoot: `${PROJECTS}/ProjC`,
              spawnerSessionId: 'lead-gone',
            },
          },
        },
      ],
    })
    await storage.listSessions()
    expect(storage.projectRouteOf('teammate-orphan-x-1')).toBe(
      `${PROJECTS}/ProjC`,
    )
  })

  it('does not nest an ordinary session that merely carries a parent', async () => {
    // The nesting is keyed on the `teammate-` mint prefix, which is what routes
    // storage — a forked/imported session can carry a parent without living
    // under it.
    const { storage } = makeStorage({
      migrated: true,
      preseed: [
        { sessionId: 'lead-3', meta: makeMeta('lead-3', `${PROJECTS}/ProjD`) },
        {
          sessionId: 'plain-child',
          meta: {
            ...makeMeta('plain-child', `${PROJECTS}/ProjD`),
            metadata: {
              projectRoot: `${PROJECTS}/ProjD`,
              spawnerSessionId: 'lead-3',
            },
          },
        },
      ],
    })
    await storage.listSessions()
    expect(storage.projectRouteOf('plain-child')).toBe(
      `${PROJECTS}/ProjD`,
    )
  })

  it('deleteSessionInDir deletes from the GIVEN dir without dropping the row', async () => {
    const bound = `${PROJECTS}/E--temp-bound-folder`
    const { storage, created, store } = makeStorage({
      migrated: true,
      preseed: [{ sessionId: 'dup', meta: makeMeta('dup', bound) }],
    })
    await storage.listSessions()
    await storage.deleteSessionInDir(`${PROJECTS}/workspace-group`, 'dup')
    expect(
      created.get(`${PROJECTS}/workspace-group`)?.deleteSession,
    ).toHaveBeenCalledWith('dup')
    // A relocation must NOT drop the meta row nor re-route.
    expect(store.deleteMeta).not.toHaveBeenCalled()
    expect(storage.projectRouteOf('dup')).toBe(bound)
  })

  // --- The one-time migration now owns duplicate resolution -----------------

  it('migration seeds the store from on-disk meta.json, once', async () => {
    const { storage, store, rows } = makeStorage({
      onDisk: {
        [`${PROJECTS}/ProjA`]: ['s1', 's2'],
        [`${PROJECTS}/ProjB`]: ['s3'],
      },
    })
    expect((await storage.listSessions()).sort()).toEqual(['s1', 's2', 's3'])
    expect(rows.size).toBe(3)
    expect(store.markMigration).toHaveBeenCalledTimes(1)
    // A second list skips the scan/seed and just reads the store.
    store.seedMeta.mockClear()
    await storage.listSessions()
    expect(store.seedMeta).not.toHaveBeenCalled()
  })

  // --- The done-marker is written ONLY for a complete run -------------------
  //
  // Once `meta_migrations` carries the marker the scan never runs again, so a
  // session the run did not seed is gone for good. A partial run must seed
  // what it saw and leave the marker unset so the next boot retries (seeding
  // is INSERT OR IGNORE, so the rerun is idempotent).

  it('a failed read chunk seeds the rest but does NOT write the done-marker', async () => {
    const { storage, store, rows, readSummarySources } = makeStorage({
      onDisk: {
        [`${PROJECTS}/ProjA`]: ['s1', 's2'],
        [`${PROJECTS}/ProjB`]: ['s3'],
      },
    })
    // Every request fits one chunk here, so fail that ONE chunk: nothing seeds
    // this run — the point is the marker, not what got through.
    readSummarySources.mockRejectedValueOnce(new Error('EIO: bridge hiccup'))
    await storage.listSessions()
    expect(store.markMigration).not.toHaveBeenCalled()
    expect(rows.size).toBe(0)
    // Nothing else broke: the list itself still resolved (from the store).
    expect(store.listAll).toHaveBeenCalled()
  })

  it('a TRUNCATED scan seeds what it saw but does NOT write the done-marker', async () => {
    const { storage, store, rows, scanSessionTree } = makeStorage({
      onDisk: { [`${PROJECTS}/ProjA`]: ['s1', 's2'] },
    })
    const full = await scanSessionTree()
    scanSessionTree.mockResolvedValueOnce({
      rows: full,
      truncated: true,
    } as never)
    expect((await storage.listSessions()).sort()).toEqual(['s1', 's2'])
    expect(rows.size).toBe(2)
    expect(store.markMigration).not.toHaveBeenCalled()
  })

  it('a complete `{ rows, truncated: false }` scan writes the done-marker', async () => {
    const { storage, store, scanSessionTree } = makeStorage({
      onDisk: { [`${PROJECTS}/ProjA`]: ['s1'] },
    })
    const full = await scanSessionTree()
    scanSessionTree.mockResolvedValueOnce({ rows: full, truncated: false } as never)
    expect(await storage.listSessions()).toEqual(['s1'])
    expect(store.markMigration).toHaveBeenCalledTimes(1)
  })

  it('a failed full-transcript fallback load does NOT write the done-marker', async () => {
    // A session with a transcript but no meta.json and no legacy sidecar
    // reaches the serial full-load fallback; make that backend load throw.
    const { storage, store, scanSessionTree, readSummarySources, createBackend } =
      makeStorage({ onDisk: { [`${PROJECTS}/ProjA`]: ['t1'] } })
    scanSessionTree.mockResolvedValueOnce([
      {
        projectDirName: 'ProjA',
        sessionId: 't1',
        transcriptSize: 100,
        metaSize: null,
        legacyMetaSize: null,
      },
    ] as never)
    // The tail read yields nothing derivable → falls through to load().
    readSummarySources.mockImplementationOnce(async items =>
      items.map(item => ({ path: item.path, ok: true, bytes: new Uint8Array(0) })),
    )
    createBackend.mockImplementationOnce((basePath: string) => {
      const b = makeFakeBackend(basePath)
      b.load.mockRejectedValue(new Error('readFile exploded'))
      return b as never
    })
    await storage.listSessions()
    expect(store.markMigration).not.toHaveBeenCalled()
  })

  // --- ...but a read that keeps failing cannot hold it forever ---------------
  //
  // Each boot a read FAILS on counts against its path in the store; on the
  // MIGRATION_READ_FAILURE_LIMIT-th failing boot the path is skipped (recorded,
  // warned) and the marker is written — otherwise one permanently unreadable
  // file re-ran the scan + batched read on every boot, forever.

  it('a read that fails on every boot is skipped (recorded + warned) on the 3rd, and the marker is written', async () => {
    const { boot, store, readFailures, readSummarySources } = makeStorage({
      onDisk: { [`${PROJECTS}/ProjA`]: ['s1'] },
    })
    readSummarySources.mockRejectedValue(new Error('EIO: bridge hiccup'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const path = `${PROJECTS}/ProjA/s1/meta.json`
      for (let n = 1; n < MIGRATION_READ_FAILURE_LIMIT; n += 1) {
        await boot().listSessions()
        expect(store.markMigration).not.toHaveBeenCalled()
        expect(readFailures.get(path)).toBe(n)
      }
      await boot().listSessions()
      expect(store.markMigration).toHaveBeenCalledTimes(1)
      // Not silently lost: the row stays, and the warning names the file.
      expect(readFailures.get(path)).toBe(MIGRATION_READ_FAILURE_LIMIT)
      expect(
        warn.mock.calls.some(
          call => String(call[0]).includes('SKIPPED') && String(call[0]).includes(path),
        ),
      ).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('an item that comes back FAILED (not missing) holds the marker; a MISSING one does not', async () => {
    const failing = makeStorage({ onDisk: { [`${PROJECTS}/ProjA`]: ['s1'] } })
    failing.readSummarySources.mockImplementation(async items =>
      items.map(item => ({
        path: item.path,
        ok: false,
        bytes: null,
        error: 'Item exceeds the per-item byte limit',
      })),
    )
    await failing.storage.listSessions()
    expect(failing.store.markMigration).not.toHaveBeenCalled()
    expect(failing.readFailures.get(`${PROJECTS}/ProjA/s1/meta.json`)).toBe(1)

    const missing = makeStorage({ onDisk: { [`${PROJECTS}/ProjA`]: ['s1'] } })
    missing.readSummarySources.mockImplementation(async items =>
      items.map(item => ({
        path: item.path,
        ok: false,
        bytes: null,
        error: 'ENOENT: no such file or directory',
      })),
    )
    await missing.storage.listSessions()
    expect(missing.store.markMigration).toHaveBeenCalledTimes(1)
    expect(missing.readFailures.size).toBe(0)
  })

  it('deleteSession drops the row FIRST and clears caches even if it throws', async () => {
    const { storage, created, store } = makeStorage({
      migrated: true,
      preseed: [{ sessionId: 's1', meta: makeMeta('s1', `${PROJECTS}/ProjA`) }],
    })
    await storage.listSessions()
    expect(storage.projectRouteOf('s1')).toBe(`${PROJECTS}/ProjA`)
    store.deleteMeta.mockRejectedValueOnce(new Error('SQLITE_BUSY'))
    await expect(storage.deleteSession('s1')).rejects.toThrow(/SQLITE_BUSY/)
    // The row survived, so the files must too — no listed row pointing at a
    // deleted directory.
    expect(created.get(`${PROJECTS}/ProjA`)?.deleteSession).not.toHaveBeenCalled()
    // But memory no longer serves the failed session's stale state.
    expect(storage.projectRouteOf('s1')).toBeUndefined()
    expect((await storage.loadSessionSummariesBatch(['s1'])).get('s1')?.projectDir).toBe(
      `${PROJECTS}/ProjA`,
    )
  })

  // Regression: a re-bind used to leave the pre-bind meta stub under the
  // workspace dir while the live transcript moved to the bound folder's dir.
  // The duplicate now resolves — during migration — to the copy with the newer
  // summary, listed once and routed to the winner.
  it('a session duplicated across dirs migrates to the NEWEST copy, listed once', async () => {
    const ws = `${PROJECTS}/workspace-group`
    const bound = `${PROJECTS}/E--temp-bound-folder`
    const { storage } = makeStorage({
      onDisk: { [ws]: ['dup'], [bound]: ['dup'] },
      updatedAt: { [ws]: { dup: 1_000 }, [bound]: { dup: 2_000 } },
    })
    expect(await storage.listSessions()).toEqual(['dup'])
    expect(storage.projectRouteOf('dup')).toBe(bound)
  })

  // Regression (the "session opened blank" report): a copy WITH messages must
  // beat a NEWER empty stub, regardless of enumeration order.
  it('a copy WITH messages beats a NEWER empty stub', async () => {
    const real = `${PROJECTS}/C--Users--velloc-shared-workspace-agent`
    const stub = `${PROJECTS}/C--Users-Videos-Screen-Recordings`
    const { storage } = makeStorage({
      onDisk: { [real]: ['dup'], [stub]: ['dup'] },
      updatedAt: {
        [real]: { dup: 1_784_129_575_650 },
        [stub]: { dup: 1_784_156_593_638 },
      },
      messageCount: { [real]: { dup: 36 }, [stub]: { dup: 0 } },
    })
    expect(await storage.listSessions()).toEqual(['dup'])
    expect(storage.projectRouteOf('dup')).toBe(real)
  })

  it('has-messages wins regardless of enumeration order (stub enumerates last)', async () => {
    const stubFirst = `${PROJECTS}/a-stub-first`
    const realLast = `${PROJECTS}/z-real-last`
    const { storage } = makeStorage({
      onDisk: { [stubFirst]: ['dup'], [realLast]: ['dup'] },
      updatedAt: { [stubFirst]: { dup: 2_000 }, [realLast]: { dup: 1_000 } },
      messageCount: { [stubFirst]: { dup: 0 }, [realLast]: { dup: 5 } },
    })
    expect(await storage.listSessions()).toEqual(['dup'])
    expect(storage.projectRouteOf('dup')).toBe(realLast)
  })

  it('the duplicate tiebreak does not depend on enumeration order', async () => {
    const first = `${PROJECTS}/a-enumerates-first`
    const last = `${PROJECTS}/z-enumerates-last`
    const { storage } = makeStorage({
      onDisk: { [first]: ['dup'], [last]: ['dup'] },
      updatedAt: { [first]: { dup: 2_000 }, [last]: { dup: 1_000 } },
    })
    expect(await storage.listSessions()).toEqual(['dup'])
    expect(storage.projectRouteOf('dup')).toBe(first)
  })

  // --- project_dir routing recovery (the "every session opens empty" bug) ----

  // A session whose legacy `meta.json` never stored `projectRoot` (the real
  // on-disk shape) must still route to the folder it lives in. The migration
  // records the SCANNED folder as `project_dir`; listSessions routes there.
  // WITHOUT the fix, a rootless meta resolves to the workspace sandbox and the
  // session opens empty.
  it('migrates a projectRoot-less session and routes it to the SCANNED folder, not the sandbox', async () => {
    const bound = `${PROJECTS}/D--project-velloc`
    const { storage, store } = makeStorage({
      rootless: true,
      onDisk: { [bound]: ['r1'] },
      messageCount: { [bound]: { r1: 4 } },
    })
    expect(await storage.listSessions()).toEqual(['r1'])
    expect(storage.projectRouteOf('r1')).toBe(bound)
    // The seed recorded the folder as project_dir (3rd arg).
    expect(store.seedMeta).toHaveBeenCalledWith('r1', expect.anything(), bound)
  })

  it('a projectRoot-less session with a recorded project_dir routes transcript ops to that dir', async () => {
    const bound = `${PROJECTS}/D--project-velloc`
    const { storage, store, created } = makeStorage({ migrated: true })
    // Simulate the migration having recorded the folder for a rootless session.
    await store.seedMeta(
      'r1',
      {
        schemaVersion: 1,
        sessionId: 'r1',
        updatedAt: 5,
        metadata: { firstPrompt: 'x', previewText: 'x', messageCount: 4 },
      },
      bound,
    )
    await storage.listSessions()
    await storage.append('r1', { type: 'x' } as never)
    expect(created.get(bound)?.append).toHaveBeenCalledWith('r1', { type: 'x' })
    // It must NOT fall to the sandbox default (the empty-session symptom).
    expect(created.get(`${PROJECTS}/workspace`)).toBeUndefined()
    // The summary surfaces the folder so the reconcile can restore routing.
    expect((await storage.loadSessionSummary('r1'))?.projectDir).toBe(bound)
  })

  it('projectRoot still wins over a recorded project_dir (re-bound session)', async () => {
    const oldDir = `${PROJECTS}/old-sandbox`
    const boundRoot = 'D:/project/velloc'
    const { storage, store, created } = makeStorage({ migrated: true })
    // A stale project_dir from before the re-bind, but projectRoot now set.
    await store.seedMeta(
      's1',
      makeMeta('s1', boundRoot, 9, 3), // metadata.projectRoot = boundRoot
      oldDir,
    )
    await storage.listSessions()
    await storage.append('s1', { type: 'x' } as never)
    // resolveProjectDirForMeta(projectRoot) wins — routes to the bound root.
    expect(created.get(boundRoot)?.append).toHaveBeenCalledWith('s1', {
      type: 'x',
    })
    expect(created.get(oldDir)).toBeUndefined()
  })
})
