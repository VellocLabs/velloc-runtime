import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { HOUR_MS } from '../models/usage/requestLogSchema'
import { FILE_ROWS_MAX, PROJECT_ROWS_MAX, PURPOSE_ROWS_MAX } from '../models/usage/requestLogInsights'
import { RequestLogQueryError, RequestLogStore, type FileOpRow, type RequestLogRow } from '../models/usage/requestLogStore'
import { readUsageQuery, refuseUsageCall, serveUsageCall, usageGrantOf, USAGE_ALL_BY } from '../mods/app/appUsageCalls'

type SqlValue = null | number | string

const T0 = Date.UTC(2026, 10, 23, 9)

/** The `sqlite` routes over one in-memory database; every query's SQL and params are kept. */
function makeStore() {
  const db = new DatabaseSync(':memory:')
  const queries: Array<{ sql: string; params: SqlValue[] }> = []
  const ok = (result: unknown) => ({ ok: true as const, result })
  const transport = {
    request: vi.fn(async (request: { route: { capability: string; action: string }; payload: Record<string, unknown> }) => {
      const { capability, action } = request.route
      const payload = request.payload
      if (capability === 'fs') return ok({ ok: true })
      try {
        if (action === 'query') {
          const params = (payload.params ?? []) as SqlValue[]
          queries.push({ sql: String(payload.sql), params })
          const statement = db.prepare(String(payload.sql))
          statement.setReturnArrays(true)
          const rows = statement.all(...params) as unknown as SqlValue[][]
          return ok({ rows, rowCount: rows.length, truncated: false })
        }
        const statements = payload.statements as Array<{ sql: string; params?: SqlValue[] }>
        db.exec('BEGIN')
        for (const s of statements) db.prepare(s.sql).run(...(s.params ?? []))
        db.exec('COMMIT')
        return ok({ results: [] })
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK')
        return { ok: false as const, error: { code: 'SQLITE_ERROR', message: error instanceof Error ? error.message : String(error) } }
      }
    }),
  }
  const store = new RequestLogStore({ transport: () => transport as unknown as BrowserBridgeTransport, dbPath: '/x/usage.sqlite' })
  return { db, store, queries }
}

const send = (at: number, extra: Partial<RequestLogRow> = {}): RequestLogRow => ({
  startedMs: at,
  durationMs: 100,
  sessionId: 's1',
  provider: 'p',
  model: 'm',
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 0 },
  outcome: 'ok',
  project: 'D:/ws',
  purpose: 'turn',
  source: 'sdk',
  ...extra,
})

const op = (at: number, extra: Partial<FileOpRow> = {}): FileOpRow => ({
  atMs: at,
  sessionId: 's1',
  project: 'D:/ws',
  repo: 'D:/ws',
  path: 'src/a.ts',
  tool: 'Read',
  op: 'read',
  bytes: 1000,
  lines: 40,
  outcome: 'ok',
  ...extra,
})

const range = { from: T0, to: T0 + 24 * HOUR_MS }

async function seeded() {
  const world = makeStore()
  const { store } = world
  await store.record(send(T0))
  await store.record(send(T0 + 5 * 60_000, { outcome: 'failed', failureKind: 'rate_limit', usage: {} }))
  await store.record(send(T0 + HOUR_MS, { project: 'D:/ws/app', purpose: 'turn', source: 'agent_tool', agentId: 'a-1' }))
  await store.record(send(T0 + 2 * HOUR_MS, { project: undefined, purpose: 'title', source: 'rename_generate_name' }))
  await store.recordFileOps([
    op(T0),
    op(T0 + 60_000),
    op(T0 + 2 * 60_000, { partial: true, bytes: 200, lines: 10 }),
    op(T0 + 3 * 60_000, { path: 'src/b.ts', bytes: 5000, lines: 200 }),
    op(T0 + 4 * 60_000, { tool: 'Edit', op: 'edit', bytes: undefined, lines: undefined, added: 5, removed: 2 }),
    op(T0 + 5 * 60_000, { tool: 'Edit', op: 'edit', bytes: undefined, lines: undefined, outcome: 'failed', failureKind: 'no_match', added: 9, removed: 9 }),
    op(T0 + HOUR_MS, { sessionId: 's2', project: 'D:/ws/app', repo: 'D:/ws/app', path: 'lib/c.ts', tool: 'Write', op: 'write', bytes: undefined, lines: undefined, added: 30, removed: 0, created: true }),
    op(T0 + HOUR_MS + 60_000, { project: 'D:/ws/app', repo: undefined, path: 'C:/Users/me/.config/x.json', bytes: 50, lines: 3 }),
  ])
  return world
}

describe('usage log insights', () => {
  it('sums tokens and file work over the range, a failed edit adding no lines', async () => {
    const { store } = await seeded()
    expect(await store.query({ ...range, by: 'total' })).toEqual({
      by: 'total',
      total: {
        requests: 4,
        failures: 1,
        inputTokens: 300,
        outputTokens: 30,
        cacheReadTokens: 3000,
        cacheWriteTokens: 0,
        reads: 5,
        readBytes: 7250,
        readLines: 293,
        edits: 3,
        failedEdits: 1,
        added: 35,
        removed: 2,
        filesRead: 3,
        filesChanged: 2,
      },
    })
  })

  it('narrows every grouping to one project as stored, a subdirectory being a project of its own', async () => {
    const { store } = await seeded()
    const total = await store.query({ ...range, by: 'total', project: 'D:/ws/app' })
    expect(total).toMatchObject({ total: { requests: 1, reads: 1, edits: 1, added: 30 } })
    const hours = await store.query({ ...range, by: 'hour', project: 'D:/ws' })
    expect(hours.by === 'hour' && hours.buckets.map(b => [b.start, b.requests])).toEqual([[T0, 2]])
    const none = await store.query({ ...range, by: 'total', project: 'D:/nowhere' })
    expect(none).toMatchObject({ total: { requests: 0, reads: 0 } })
  })

  it('lists projects with tokens and file work side by side, most tokens first, then most lines added', async () => {
    const { store } = await seeded()
    const answer = await store.query({ ...range, by: 'project' })
    expect(answer.by === 'project' && answer.projects.map(p => [p.project, p.requests, p.inputTokens, p.reads, p.edits, p.added])).toEqual([
      ['D:/ws/app', 1, 100, 1, 1, 30],
      ['D:/ws', 2, 100, 4, 2, 5],
      [undefined, 1, 100, 0, 0, 0],
    ])
  })

  it('groups requests by purpose and caller tag, sub-agents apart', async () => {
    const { store } = await seeded()
    const answer = await store.query({ ...range, by: 'purpose' })
    expect(answer.by === 'purpose' && answer.purposes.map(p => [p.purpose, p.source, p.subAgent, p.requests])).toEqual([
      ['title', 'rename_generate_name', false, 1],
      ['turn', 'agent_tool', true, 1],
      ['turn', 'sdk', false, 2],
    ])
  })

  it('buckets file work by hour, and by day in the asked time zone', async () => {
    const { store } = await seeded()
    const hours = await store.query({ ...range, by: 'file_hour' })
    expect(hours.by === 'file_hour' && hours.buckets.map(b => [b.start, b.reads, b.added])).toEqual([
      [T0, 4, 5],
      [T0 + HOUR_MS, 1, 30],
    ])
    const days = await store.query({ ...range, by: 'file_day', tzOffsetMinutes: -10 * 60 })
    // 09:00 UTC is 23:00 the day before at UTC-10; 10:00 UTC is the next day there.
    expect(days.by === 'file_day' && days.buckets.map(b => [b.start, b.reads])).toEqual([
      [Date.UTC(2026, 10, 22) + 10 * HOUR_MS, 4],
      [Date.UTC(2026, 10, 23) + 10 * HOUR_MS, 1],
    ])
  })

  it('ranks files by reads and by lines changed, one row per repository and path', async () => {
    const { store } = await seeded()
    const read = await store.query({ ...range, by: 'file_read' })
    expect(read.by === 'file_read' && read.files.map(f => [f.repo, f.path, f.reads, f.edits])).toEqual([
      ['D:/ws', 'src/a.ts', 3, 2],
      ['D:/ws', 'src/b.ts', 1, 0],
      [undefined, 'C:/Users/me/.config/x.json', 1, 0],
    ])
    const edit = await store.query({ ...range, by: 'file_edit' })
    expect(edit.by === 'file_edit' && edit.files.map(f => [f.path, f.edits, f.failedEdits, f.added, f.removed])).toEqual([
      ['lib/c.ts', 1, 0, 30, 0],
      ['src/a.ts', 2, 1, 5, 2],
    ])
  })

  it('lists whole-file reads repeated in one session with the bytes read again', async () => {
    const { store } = await seeded()
    const answer = await store.query({ ...range, by: 'reread' })
    expect(answer).toEqual({
      by: 'reread',
      rereads: [{ sessionId: 's1', repo: 'D:/ws', path: 'src/a.ts', reads: 2, readBytes: 2000, extraBytes: 1000 }],
    })
  })

  it('caps a ranking at its row limit', async () => {
    const { store } = makeStore()
    await store.recordFileOps(Array.from({ length: FILE_ROWS_MAX + 5 }, (_, i) => op(T0 + i, { path: `f${i}.ts` })))
    const answer = await store.query({ ...range, by: 'file_read' })
    expect(answer.by === 'file_read' && answer.files).toHaveLength(FILE_ROWS_MAX)
  })

  it('says when a project or purpose list was cut at its cap, and not when it fits', async () => {
    const { store } = makeStore()
    for (let i = 0; i <= Math.max(PROJECT_ROWS_MAX, PURPOSE_ROWS_MAX); i++) {
      await store.record(send(T0 + i, { project: `D:/p${i}`, purpose: `p${i}` }))
    }
    const projects = await store.query({ ...range, by: 'project' })
    expect(projects.by === 'project' && [projects.projects.length, projects.truncated]).toEqual([PROJECT_ROWS_MAX, true])
    const purposes = await store.query({ ...range, by: 'purpose' })
    expect(purposes.by === 'purpose' && [purposes.purposes.length, purposes.truncated]).toEqual([PURPOSE_ROWS_MAX, true])
    const narrow = await store.query({ ...range, by: 'project', project: 'D:/p0' })
    expect(narrow.by === 'project' && [narrow.projects.length, narrow.truncated]).toEqual([1, false])
  })

  it('walks file rows by time, or by project when narrowed, never by the file index', async () => {
    const { db, store, queries } = await seeded()
    for (const project of [undefined, 'D:/ws']) {
      for (const by of ['total', 'project', 'file_hour', 'file_read', 'file_edit', 'reread'] as const) {
        queries.length = 0
        await store.query({ ...range, by, ...(project ? { project } : {}) })
        const fileReads = queries.filter(q => q.sql.includes('FROM file_ops'))
        expect(fileReads.length).toBeGreaterThan(0)
        for (const q of fileReads) {
          const plan = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as Array<{ detail: string }>
          const details = plan.map(row => row.detail).filter(detail => /file_ops/.test(detail))
          expect(details.join('\n')).toContain(project ? 'file_ops_project' : 'file_ops_at')
          expect(details.join('\n')).not.toContain('file_ops_file')
        }
      }
    }
  })

  it('refuses a router narrowing on a grouping that reads file rows', async () => {
    const { store } = makeStore()
    await expect(store.query({ ...range, by: 'file_read', router: 'r' })).rejects.toBeInstanceOf(RequestLogQueryError)
  })
})

describe('$.usage grants', () => {
  const router = { providerId: 'mod.sr.route', router: true }

  it('grants a router its own requests, an app Velloc ships everything, and nothing to others', () => {
    expect(usageGrantOf(router, false)).toEqual({ router: 'mod.sr.route' })
    expect(usageGrantOf(undefined, true)).toEqual({ all: true })
    expect(usageGrantOf(router, true)).toEqual({ all: true })
    expect(usageGrantOf({ providerId: 'mod.x.direct', router: false }, false)).toBeNull()
    expect(usageGrantOf(undefined, false)).toBeNull()
    expect(refuseUsageCall('query', null)).toMatch(/open to a router's settings app/)
    expect(refuseUsageCall('drop', { all: true })).toMatch(/offers query/)
    expect(refuseUsageCall('query', { router: 'r' })).toBeNull()
  })

  it('reads every grouping without a path for a router, its own router forced, and no project', () => {
    const grant = { router: 'mod.sr.route' }
    expect(readUsageQuery({ from: 0, to: 1, by: 'switch', router: 'someone-else' }, grant)).toEqual({ from: 0, to: 1, by: 'switch', router: 'mod.sr.route' })
    for (const by of ['total', 'project', 'purpose', 'file_hour', 'file_day', 'file_read', 'file_edit', 'reread']) {
      expect(() => readUsageQuery({ from: 0, to: 1, by }, grant)).toThrow(expect.objectContaining({ name: 'NotAllowedError' }))
    }
    expect(() => readUsageQuery({ from: 0, to: 1, by: 'hour', project: 'D:/ws' }, grant)).toThrow(expect.objectContaining({ name: 'NotAllowedError' }))
  })

  it('reads every grouping, with a project, for an app Velloc ships, across all routers', () => {
    for (const by of USAGE_ALL_BY) {
      expect(readUsageQuery({ from: 0, to: 1, by, project: 'D:/ws', router: 'r' }, { all: true })).toEqual({ from: 0, to: 1, by, project: 'D:/ws' })
    }
    expect(() => readUsageQuery({ from: 0, to: 1, by: 'everything' }, { all: true })).toThrow(TypeError)
    expect(() => readUsageQuery({ from: 0, to: 1, by: 'hour', project: '' }, { all: true })).toThrow(TypeError)
  })

  it('fails as unavailable when the log answers nothing', async () => {
    await expect(serveUsageCall({ all: true }, 'query', [{ from: 0, to: 1, by: 'total' }], async () => undefined)).rejects.toMatchObject({ name: 'NotSupportedError' })
    await expect(serveUsageCall(null, 'query', [{ from: 0, to: 1, by: 'total' }], async () => undefined)).rejects.toMatchObject({ name: 'NotAllowedError' })
  })
})
