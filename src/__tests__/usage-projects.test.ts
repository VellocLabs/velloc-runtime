import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { normalizeProjectPath } from '../utils/workspaceState'
import { getSessionMetaDbPath, projectsHome } from '../utils/conversationStoragePaths'
import { RequestLogStore, requestLogCallerOf, type RequestLogRow } from '../models/usage/requestLogStore'
import { attachRequestLogBridge, recordRequest, requestLogIdle, requestLogPath, resetRequestLog } from '../models/usage/requestLogWriter'
import { projectKeyOf, registerSessionProject, sessionProjectOf } from '../models/usage/sessionProjects'

type SqlValue = null | number | string

const HOME = '/home/tester'
const LOG = requestLogPath(HOME)
const META = getSessionMetaDbPath(projectsHome(HOME))

/** The `sqlite` routes over one in-memory database per path; a path never written answers CANTOPEN. */
function makeBridge() {
  const dbs = new Map<string, DatabaseSync>()
  const dbOf = (path: string, create: boolean) => {
    let db = dbs.get(path)
    if (!db && create) dbs.set(path, (db = new DatabaseSync(':memory:')))
    return db
  }
  const ok = (result: unknown) => ({ ok: true as const, result })
  const err = (code: string, message = code) => ({ ok: false as const, error: { code, message } })
  const transport = {
    request: vi.fn(async (request: { route: { capability: string; action: string }; payload: Record<string, unknown> }) => {
      const { capability, action } = request.route
      const payload = request.payload
      if (capability === 'fs' && action === 'userHome') return ok(HOME)
      if (capability === 'fs' && action === 'exists') return ok(false)
      if (capability === 'fs') return ok({ ok: true })
      const db = dbOf(String(payload.path), payload.mode === 'rwc')
      if (!db) return err('SQLITE_CANTOPEN')
      try {
        if (action === 'query') {
          const statement = db.prepare(String(payload.sql))
          statement.setReturnArrays(true)
          const rows = statement.all(...((payload.params ?? []) as SqlValue[])) as unknown as SqlValue[][]
          return ok({ rows, rowCount: rows.length, truncated: false })
        }
        db.exec('BEGIN')
        for (const s of payload.statements as Array<{ sql: string; params?: SqlValue[] }>) db.prepare(s.sql).run(...(s.params ?? []))
        db.exec('COMMIT')
        return ok({ results: [] })
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK')
        return err('SQLITE_ERROR', error instanceof Error ? error.message : String(error))
      }
    }),
  }
  const meta = (rows: Array<[string, string | null]>) => {
    const db = dbOf(META, true)!
    db.exec('CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, project_root TEXT)')
    for (const row of rows) db.prepare('INSERT INTO session_meta VALUES (?, ?)').run(...row)
  }
  const projects = () =>
    dbOf(LOG, false)!
      .prepare('SELECT n.text AS session, p.text AS project FROM sends s JOIN names n ON n.id = s.session LEFT JOIN names p ON p.id = s.project ORDER BY s.id')
      .all()
      .map(row => Object.values(row as Record<string, SqlValue>))
  return { transport: transport as unknown as BrowserBridgeTransport & typeof transport, meta, projects, dbOf }
}

const send = (sessionId: string | undefined, extra: Partial<RequestLogRow> = {}): RequestLogRow => ({
  startedMs: Date.UTC(2026, 10, 23),
  durationMs: 10,
  ...(sessionId ? { sessionId } : {}),
  provider: 'p',
  model: 'm',
  outcome: 'ok',
  ...extra,
})

afterEach(() => {
  resetRequestLog()
})

describe("a session's project in the usage log", () => {
  it('keys a project as the sidebar does', () => {
    for (const root of ['D:\\ws\\app\\', 'd:/ws/app', '/home/me/proj/', '\\\\server\\share\\x']) {
      expect(projectKeyOf(root)).toBe(normalizeProjectPath(root))
    }
    expect(projectKeyOf('d:\\ws\\app')).toBe(projectKeyOf('D:/ws/app/'))
  })

  it('looks a project up by its top-level session, and drops only its own entry', () => {
    const drop = registerSessionProject('s1', 'D:\\ws\\app')
    expect(sessionProjectOf('s1')).toBe(projectKeyOf('D:\\ws\\app'))
    const newer = registerSessionProject('s1', 'D:\\ws')
    drop()
    expect(sessionProjectOf('s1')).toBe(projectKeyOf('D:\\ws'))
    newer()
    expect(sessionProjectOf('s1')).toBeUndefined()
    expect(sessionProjectOf(undefined)).toBeUndefined()
  })

  it("fills a request's project from its session, never from the request context", () => {
    const drop = registerSessionProject('s1', 'D:\\ws\\app')
    try {
      expect(requestLogCallerOf({ sessionId: 's1', purpose: 'turn', querySource: 'sdk', projectRoot: 'D:/other' })).toEqual({
        sessionId: 's1',
        purpose: 'turn',
        source: 'sdk',
        project: projectKeyOf('D:\\ws\\app'),
      })
      expect(requestLogCallerOf({ sessionId: 's2', purpose: 'turn', querySource: 'sdk' })).not.toHaveProperty('project')
    } finally {
      drop()
    }
  })

  it('backfills earlier rows once from the session metadata, leaving unknown sessions and filled rows alone', async () => {
    const bridge = makeBridge()
    const store = new RequestLogStore({ transport: () => bridge.transport, dbPath: LOG })
    await store.record(send('s1'))
    await store.record(send('s2'))
    await store.record(send('s3', { project: 'D:/kept' }))
    await store.record(send(undefined))
    const readRoots = vi.fn(async () => new Map([['s1', 'D:/ws'], ['s3', 'D:/elsewhere']]))
    expect(await store.backfillProjects(readRoots)).toBe(1)
    expect(bridge.projects()).toEqual([['s1', 'D:/ws'], ['s2', null], ['s3', 'D:/kept']])
    expect(await store.backfillProjects(readRoots)).toBeNull()
    expect(readRoots).toHaveBeenCalledTimes(1)
  })

  it('does not mark the backfill done when the metadata names none of the sessions it needs', async () => {
    const bridge = makeBridge()
    const store = new RequestLogStore({ transport: () => bridge.transport, dbPath: LOG })
    await store.record(send('s1'))
    expect(await store.backfillProjects(async () => new Map())).toBe(0)
    expect(await store.backfillProjects(async () => new Map([['s1', 'D:/ws']]))).toBe(1)
    expect(bridge.projects()).toEqual([['s1', 'D:/ws']])
  })

  it('backfills on the first open through the writer, in the sidebar form, before the new row', async () => {
    const bridge = makeBridge()
    await new RequestLogStore({ transport: () => bridge.transport, dbPath: LOG }).record(send('old'))
    bridge.meta([['old', 'D:\\ws\\app\\'], ['gone', null]])
    const drop = registerSessionProject('new', 'D:\\ws')
    try {
      attachRequestLogBridge(bridge.transport)
      recordRequest({ ...send('new'), ...requestLogCallerOf({ sessionId: 'new', purpose: 'turn', querySource: 'sdk' }) })
      await requestLogIdle()
    } finally {
      drop()
    }
    expect(bridge.projects()).toEqual([
      ['old', projectKeyOf('D:\\ws\\app\\')],
      ['new', projectKeyOf('D:\\ws')],
    ])
    const marked = bridge.dbOf(LOG, false)!.prepare("SELECT value FROM log_meta WHERE key = 'project_backfill'").all()
    expect(marked).toHaveLength(1)
  })

  it('leaves earlier rows unfilled, and writes new ones, when there is no session metadata file', async () => {
    const bridge = makeBridge()
    await new RequestLogStore({ transport: () => bridge.transport, dbPath: LOG }).record(send('old'))
    attachRequestLogBridge(bridge.transport)
    recordRequest(send('new'))
    await requestLogIdle()
    expect(bridge.projects()).toEqual([['old', null], ['new', null]])
    expect(bridge.dbOf(LOG, false)!.prepare("SELECT value FROM log_meta WHERE key = 'project_backfill'").all()).toHaveLength(0)
  })
})
