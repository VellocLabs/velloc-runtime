import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { recordEntryResolution, resetEntryResolutions } from '../config/nexusModelConfig/modelEntryResolution'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  HOURLY_COLUMNS,
  HOUR_MS,
  REQUEST_LOG_SCHEMA_VERSION,
  SEND_COLUMNS,
} from '../models/usage/requestLogSchema'
import {
  RequestLogQueryError,
  RequestLogStore,
  type RequestLogRow,
} from '../models/usage/requestLogStore'
import { withRequestLog } from '../models/usage/requestLogTransport'
import {
  attachRequestLogBridge,
  openRequestLog,
  recordRequest,
  REQUEST_LOG_QUEUE_MAX,
  requestLogIdle,
  requestLogPath,
  requestLogQueueLength,
  resetRequestLog,
} from '../models/usage/requestLogWriter'

type SqlValue = null | number | string

/**
 * The `sqlite` and `fs` routes of the bridge over one in-memory database, so
 * the store's own SQL runs. A statement the host's engine does not have (an
 * upsert) is refused as the host refuses it.
 */
function makeBridge(options: { failBatches?: () => boolean; gate?: Promise<void> } = {}) {
  const db = new DatabaseSync(':memory:')
  const requests: Array<{ capability: string; action: string; payload: Record<string, unknown> }> = []
  const ok = (result: unknown) => ({ ok: true as const, result })
  const err = (code: string, message = code) => ({ ok: false as const, error: { code, message } })
  const run = (sql: string, params: SqlValue[] = []) => {
    if (/ON CONFLICT|DO UPDATE/i.test(sql)) throw new Error('unsupported')
    return db.prepare(sql).run(...params)
  }
  const transport = {
    request: vi.fn(async (request: { route: { capability: string; action: string }; payload: Record<string, unknown> }) => {
      const { capability, action } = request.route
      const payload = request.payload
      requests.push({ capability, action, payload })
      if (options.gate) await options.gate
      if (capability === 'fs' && action === 'userHome') return ok('/home/tester')
      if (capability === 'fs') return ok({ ok: true })
      if (capability !== 'sqlite') return err('UNKNOWN_CAPABILITY')
      try {
        if (action === 'query') {
          const statement = db.prepare(String(payload.sql))
          statement.setReturnArrays(true)
          const rows = statement.all(...((payload.params ?? []) as SqlValue[])) as unknown as SqlValue[][]
          return ok({ rows, rowCount: rows.length, truncated: false })
        }
        if (action === 'batch') {
          if (options.failBatches?.()) return err('SQLITE_ERROR', 'disk I/O error')
          const statements = payload.statements as Array<{ sql: string; params?: SqlValue[] }>
          db.exec('BEGIN')
          try {
            const results = statements.map(s => ({ rowsAffected: Number(run(s.sql, s.params).changes) }))
            db.exec('COMMIT')
            return ok({ results })
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
        }
      } catch (error) {
        return err('SQLITE_ERROR', error instanceof Error ? error.message : String(error))
      }
      return err('UNKNOWN_ACTION')
    }),
  }
  const all = (sql: string) => {
    const statement = db.prepare(sql)
    statement.setReturnArrays(true)
    return statement.all() as unknown as SqlValue[][]
  }
  return { db, all, requests, transport: transport as unknown as BrowserBridgeTransport }
}

function makeStore(bridge = makeBridge()) {
  const store = new RequestLogStore({ transport: () => bridge.transport, dbPath: '/home/tester/.velloc/usage/requests.sqlite' })
  return { ...bridge, store }
}

const T0 = Date.UTC(2031, 2, 10, 0, 0, 0)

function row(over: Partial<RequestLogRow> = {}): RequestLogRow {
  return {
    startedMs: T0 + 5 * 60_000,
    durationMs: 1200,
    sessionId: 'session-a',
    provider: 'acme',
    model: 'acme-large',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3 },
    outcome: 'ok',
    ...over,
  }
}

const viaRouter = {
  router: { provider: 'mod.pool.main', row: 'fast' },
} satisfies Partial<RequestLogRow>

afterEach(async () => {
  await requestLogIdle()
  resetRequestLog()
  resetEntryResolutions()
})

describe('request log schema', () => {
  it('creates the tables and stamps the version', async () => {
    const { store, all, requests } = makeStore()
    expect(await store.schemaVersion()).toBe(REQUEST_LOG_SCHEMA_VERSION)
    const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(r => r[0])
    expect(tables).toEqual(['hourly', 'log_meta', 'names', 'sends'])
    expect(requests[0]).toMatchObject({ capability: 'fs', action: 'mkdir', payload: { path: '/home/tester/.velloc/usage' } })
    expect(requests[1]).toMatchObject({ action: 'batch', payload: { mode: 'rwc', atomic: true } })
  })

  it('raises an older file to this version and refuses a newer one', async () => {
    const older = makeStore()
    await older.store.ensureSchema()
    older.db.exec("UPDATE log_meta SET value = 0 WHERE key = 'schema_version'")
    const reopened = new RequestLogStore({ transport: () => older.transport, dbPath: older.store.dbPath })
    expect(await reopened.schemaVersion()).toBe(REQUEST_LOG_SCHEMA_VERSION)

    older.db.exec(`UPDATE log_meta SET value = ${REQUEST_LOG_SCHEMA_VERSION + 1} WHERE key = 'schema_version'`)
    older.db.exec('DROP TABLE hourly')
    const newer = new RequestLogStore({ transport: () => older.transport, dbPath: older.store.dbPath })
    await expect(newer.record(row())).rejects.toThrow(/newer build/)
    expect(older.all('SELECT COUNT(*) FROM sends')[0]![0]).toBe(0)
    // Nothing of this version's is written into a newer file.
    expect(older.all("SELECT COUNT(*) FROM sqlite_master WHERE name = 'hourly'")[0]![0]).toBe(0)
  })

  it('holds exactly these columns', async () => {
    const { store, all } = makeStore()
    await store.ensureSchema()
    const columns = (table: string) => all(`PRAGMA table_info(${table})`).map(r => r[1])
    expect(columns('sends')).toEqual([...SEND_COLUMNS])
    expect([...SEND_COLUMNS]).toEqual([
      'id', 'started_ms', 'duration_ms', 'session', 'call_id', 'hop', 'provider', 'model',
      'router', 'router_row', 'from_provider', 'from_model', 'switch_kind',
      'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
      'outcome', 'failure', 'http_status',
    ])
    expect(columns('hourly')).toEqual([...HOURLY_COLUMNS])
    expect(columns('names')).toEqual(['id', 'text'])
    // Every text column of the file is a lookup string or the version key.
    const textColumns = ['sends', 'hourly', 'names', 'log_meta'].flatMap(table =>
      all(`PRAGMA table_info(${table})`).filter(r => r[2] === 'TEXT').map(r => `${table}.${r[1]}`))
    expect(textColumns).toEqual(['names.text', 'log_meta.key'])
  })
})

describe('request log rows', () => {
  it('writes a row and its rollup in one transaction', async () => {
    const { store, all, requests } = makeStore()
    await store.ensureSchema()
    const before = requests.length
    await store.record(row({ outcome: 'failed', failureKind: 'rate_limit', httpStatus: 429 }))
    const writes = requests.slice(before)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ action: 'batch', payload: { atomic: true } })

    const name = (text: string) => all(`SELECT id FROM names WHERE text = '${text}'`)[0]![0]
    const sends = all(`SELECT ${SEND_COLUMNS.slice(1).join(', ')} FROM sends`)
    expect(sends).toHaveLength(1)
    const [started, duration, session, callId, hop, provider, model, router, routerRow, fromProvider, fromModel,
      switchKind, input, output, cacheRead, cacheWrite, outcome, failure, status] = sends[0]!
    expect([started, duration, hop]).toEqual([T0 + 5 * 60_000, 1200, 1])
    expect(typeof callId).toBe('number')
    expect([session, provider, model]).toEqual([name('session-a'), name('acme'), name('acme-large')])
    expect([router, routerRow, fromProvider, fromModel, switchKind]).toEqual([null, null, null, null, null])
    expect([input, output, cacheRead, cacheWrite]).toEqual([100, 20, 7, 3])
    expect([outcome, failure, status]).toEqual([1, name('rate_limit'), 429])
    expect(all('SELECT * FROM hourly')).toEqual([
      [T0 / HOUR_MS, name('acme'), name('acme-large'), 0, 0, 1, 1, 100, 20, 7, 3, 0],
    ])
  })

  it('leaves neither the row nor the rollup when a statement fails', async () => {
    const { store, db, all } = makeStore()
    await store.ensureSchema()
    db.exec('DROP TABLE hourly')
    await expect(store.record(row())).rejects.toThrow(/SQLITE_ERROR/)
    expect(all('SELECT COUNT(*) FROM sends')[0]![0]).toBe(0)
    expect(all('SELECT COUNT(*) FROM names')[0]![0]).toBe(0)
  })

  it('stores each string once', async () => {
    const { store, all } = makeStore()
    await store.record(row())
    await store.record(row({ startedMs: T0 + 2 * HOUR_MS }))
    await store.record(row({ model: 'acme-small' }))
    expect(all('SELECT text FROM names ORDER BY id').map(r => r[0])).toEqual([
      'acme', 'acme-large', 'session-a', 'acme-small',
    ])
    expect(all('SELECT COUNT(DISTINCT provider), COUNT(DISTINCT session) FROM sends')[0]).toEqual([1, 1])
  })

  it('keeps a request of no session and an aborted one out of the failures', async () => {
    const { store, all } = makeStore()
    const { sessionId: _none, ...sessionless } = row({ outcome: 'aborted', failureKind: 'ignored', httpStatus: 500 })
    await store.record(sessionless)
    expect(all('SELECT session, outcome, failure, http_status FROM sends')).toEqual([[null, 2, null, null]])
    expect(all('SELECT requests, failures FROM hourly')).toEqual([[1, 0]])
  })

  it('writes two sends of one call as two rows', async () => {
    const { store, all } = makeStore()
    const first = row({ ...viaRouter, callId: 4242, hop: 1, outcome: 'failed', failureKind: 'quota', httpStatus: 402 })
    const second = row({
      ...viaRouter,
      callId: 4242,
      hop: 2,
      provider: 'zeta',
      model: 'zeta-pro',
      startedMs: first.startedMs + 900,
      switchedFrom: { provider: 'acme', model: 'acme-large', kind: 'quota' },
    })
    await store.record(first)
    await store.record(second)
    expect(all('SELECT call_id, hop FROM sends ORDER BY id')).toEqual([[4242, 1], [4242, 2]])
    expect(all('SELECT requests, failures, switches FROM hourly ORDER BY provider')).toEqual([[1, 1, 0], [1, 0, 1]])
    const text = (id: SqlValue) => all(`SELECT text FROM names WHERE id = ${id}`)[0]![0]
    const [fromProvider, fromModel, kind, router, routerRow] =
      all('SELECT from_provider, from_model, switch_kind, router, router_row FROM sends WHERE hop = 2')[0]!
    expect([fromProvider, fromModel, kind, router, routerRow].map(text)).toEqual([
      'acme', 'acme-large', 'quota', 'mod.pool.main', 'fast',
    ])
  })

  it('gives a send without a call id one of its own', async () => {
    const { store, all } = makeStore()
    await store.record(row())
    await store.record(row())
    const ids = all('SELECT call_id FROM sends').map(r => r[0])
    expect(new Set(ids).size).toBe(2)
  })
})

async function seeded() {
  const made = makeStore()
  const { store } = made
  // Hour 0: two direct sends, one failed. Hour 1: one routed. Hour 30 (the
  // next UTC day): one routed switch and one direct send of another model.
  await store.record(row())
  await store.record(row({ outcome: 'failed', failureKind: 'service', httpStatus: 503, usage: { inputTokens: 10 } }))
  await store.record(row({ ...viaRouter, startedMs: T0 + HOUR_MS + 1 }))
  await store.record(row({
    ...viaRouter,
    startedMs: T0 + 30 * HOUR_MS,
    provider: 'zeta',
    model: 'zeta-pro',
    callId: 7,
    hop: 2,
    switchedFrom: { provider: 'acme', model: 'acme-large', kind: 'rate_limit' },
  }))
  await store.record(row({ startedMs: T0 + 30 * HOUR_MS + 5, model: 'acme-small', outcome: 'aborted' }))
  return made
}

describe('request log queries', () => {
  it('sums by hour', async () => {
    const { store } = await seeded()
    const result = await store.query({ from: T0, to: T0 + 2 * HOUR_MS, by: 'hour' })
    expect(result).toEqual({
      by: 'hour',
      truncated: false,
      buckets: [
        {
          start: T0, provider: 'acme', model: 'acme-large', requests: 2, failures: 1,
          inputTokens: 110, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3, switches: 0,
        },
        {
          start: T0 + HOUR_MS, provider: 'acme', model: 'acme-large', router: 'mod.pool.main', routerRow: 'fast',
          requests: 1, failures: 0, inputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3, switches: 0,
        },
      ],
    })
  })

  it('sums hours into days of the given offset', async () => {
    const { store } = await seeded()
    const utc = await store.query({ from: T0, to: T0 + 48 * HOUR_MS, by: 'day' })
    if (utc.by !== 'day') throw new Error('unexpected')
    expect(utc.buckets.map(b => [b.start, b.model, b.router ?? null, b.requests])).toEqual([
      [T0, 'acme-large', null, 2],
      [T0, 'acme-large', 'mod.pool.main', 1],
      [T0 + 24 * HOUR_MS, 'acme-small', null, 1],
      [T0 + 24 * HOUR_MS, 'zeta-pro', 'mod.pool.main', 1],
    ])
    // Seven hours west, hours 0 and 1 belong to the day before, which starts at 07:00 UTC.
    const west = await store.query({ from: T0, to: T0 + 48 * HOUR_MS, by: 'day', tzOffsetMinutes: -7 * 60 })
    if (west.by !== 'day') throw new Error('unexpected')
    expect(west.buckets.map(b => [b.start, b.requests])).toEqual([
      [T0 - 17 * HOUR_MS, 2],
      [T0 - 17 * HOUR_MS, 1],
      [T0 + 7 * HOUR_MS, 1],
      [T0 + 7 * HOUR_MS, 1],
    ])
  })

  it('lists the most recent switches, at most a hundred', async () => {
    const { store } = await seeded()
    const result = await store.query({ from: T0, to: T0 + 48 * HOUR_MS, by: 'switch' })
    expect(result).toEqual({
      by: 'switch',
      switches: [{
        startedMs: T0 + 30 * HOUR_MS, callId: 7, hop: 2, provider: 'zeta', model: 'zeta-pro',
        router: 'mod.pool.main', routerRow: 'fast', from: { provider: 'acme', model: 'acme-large' }, kind: 'rate_limit',
      }],
    })
    for (let i = 0; i < 120; i += 1) {
      await store.record(row({
        startedMs: T0 + 40 * HOUR_MS + i,
        switchedFrom: { provider: 'zeta', model: 'zeta-pro', kind: 'service' },
      }))
    }
    const many = await store.query({ from: T0, to: T0 + 48 * HOUR_MS, by: 'switch' })
    if (many.by !== 'switch') throw new Error('unexpected')
    expect(many.switches).toHaveLength(100)
    expect(many.switches[0]!.startedMs).toBe(T0 + 40 * HOUR_MS + 119)
    expect(many.switches[99]!.startedMs).toBe(T0 + 40 * HOUR_MS + 20)
  })

  it('lists the most recent successful sends with their tokens, at most a hundred', async () => {
    const { store } = await seeded()
    const result = await store.query({ from: T0, to: T0 + 48 * HOUR_MS, by: 'request' })
    // The failed and the aborted send are left out.
    expect(result).toEqual({
      by: 'request',
      requests: [
        {
          startedMs: T0 + 30 * HOUR_MS, durationMs: 1200, callId: 7, hop: 2, provider: 'zeta', model: 'zeta-pro',
          router: 'mod.pool.main', routerRow: 'fast', inputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3,
        },
        expect.objectContaining({ startedMs: T0 + HOUR_MS + 1, provider: 'acme', router: 'mod.pool.main', hop: 1 }),
        expect.objectContaining({ startedMs: T0 + 5 * 60_000, provider: 'acme', inputTokens: 100 }),
      ],
    })
    const routed = await store.query({ from: T0, to: T0 + 48 * HOUR_MS, by: 'request', router: 'mod.pool.main' })
    if (routed.by !== 'request') throw new Error('unexpected')
    expect(routed.requests.map(r => r.startedMs)).toEqual([T0 + 30 * HOUR_MS, T0 + HOUR_MS + 1])
    for (let i = 0; i < 120; i += 1) await store.record(row({ startedMs: T0 + 40 * HOUR_MS + i }))
    const many = await store.query({ from: T0, to: T0 + 48 * HOUR_MS, by: 'request' })
    if (many.by !== 'request') throw new Error('unexpected')
    expect(many.requests).toHaveLength(100)
    expect(many.requests[0]!.startedMs).toBe(T0 + 40 * HOUR_MS + 119)
  })

  it('restricts to one router', async () => {
    const { store } = await seeded()
    const span = { from: T0, to: T0 + 48 * HOUR_MS }
    const hours = await store.query({ ...span, by: 'hour', router: 'mod.pool.main' })
    if (hours.by !== 'hour') throw new Error('unexpected')
    expect(hours.buckets.map(b => [b.provider, b.router, b.requests])).toEqual([
      ['acme', 'mod.pool.main', 1],
      ['zeta', 'mod.pool.main', 1],
    ])
    const other = await store.query({ ...span, by: 'day', router: 'mod.other.router' })
    expect(other).toEqual({ by: 'day', buckets: [], truncated: false })
    // A direct provider's id is not a router's: it selects nothing.
    expect(await store.query({ ...span, by: 'hour', router: 'acme' })).toEqual({ by: 'hour', buckets: [], truncated: false })
    expect(await store.query({ ...span, by: 'switch', router: 'mod.other.router' })).toEqual({ by: 'switch', switches: [] })
  })

  it('refuses a span over ninety days and a malformed range before reading', async () => {
    const { store, requests } = makeStore()
    const day = 24 * HOUR_MS
    await expect(store.query({ from: T0, to: T0 + 90 * day + 1, by: 'hour' })).rejects.toBeInstanceOf(RequestLogQueryError)
    await expect(store.query({ from: T0, to: T0, by: 'day' })).rejects.toBeInstanceOf(RequestLogQueryError)
    await expect(store.query({ from: T0, to: T0 + day, by: 'day', tzOffsetMinutes: 0.5 })).rejects.toBeInstanceOf(RequestLogQueryError)
    expect(requests).toHaveLength(0)
    await expect(store.query({ from: T0, to: T0 + 90 * day, by: 'switch' })).resolves.toEqual({ by: 'switch', switches: [] })
  })

  it('rebuilds the rollup from the rows to the same table', async () => {
    const { store, db, all } = await seeded()
    const incremental = all('SELECT * FROM hourly ORDER BY hour, provider, model, router, router_row')
    expect(incremental.length).toBeGreaterThan(3)
    db.exec('UPDATE hourly SET requests = 99, switches = 5')
    db.exec('DELETE FROM hourly WHERE router = 0')
    await store.rebuildRollup()
    expect(all('SELECT * FROM hourly ORDER BY hour, provider, model, router, router_row')).toEqual(incremental)
  })
})

describe('request log writer', () => {
  it('names the file under the usage directory of the user data', () => {
    expect(requestLogPath('/home/tester')).toBe('/home/tester/.velloc/usage/requests.sqlite')
  })

  it('writes rows in the order recorded, one at a time', async () => {
    const bridge = makeBridge()
    attachRequestLogBridge(bridge.transport)
    for (let i = 0; i < 5; i += 1) recordRequest(row({ durationMs: i + 1 }))
    await requestLogIdle()
    expect(bridge.all('SELECT duration_ms FROM sends ORDER BY id').map(r => r[0])).toEqual([1, 2, 3, 4, 5])
    expect(bridge.requests.find(r => r.action === 'mkdir')?.payload.path).toBe('/home/tester/.velloc/usage')
  })

  it('keeps a failed write from its caller and writes the rows after it', async () => {
    let failing = false
    const bridge = makeBridge({ failBatches: () => failing })
    attachRequestLogBridge(bridge.transport)
    recordRequest(row())
    await requestLogIdle()
    failing = true
    expect(() => recordRequest(row({ durationMs: 2 }))).not.toThrow()
    await requestLogIdle()
    failing = false
    recordRequest(row({ durationMs: 3 }))
    await requestLogIdle()
    expect(bridge.all('SELECT duration_ms FROM sends ORDER BY id').map(r => r[0])).toEqual([1200, 3])
  })

  it('returns before the row is written', async () => {
    let open!: () => void
    const bridge = makeBridge({ gate: new Promise<void>(resolve => { open = resolve }) })
    attachRequestLogBridge(bridge.transport)
    recordRequest(row())
    expect(requestLogQueueLength()).toBe(1)
    open()
    await requestLogIdle()
    expect(bridge.all('SELECT COUNT(*) FROM sends')[0]![0]).toBe(1)
  })

  it('queues a bounded number of rows until a bridge is attached, then drops', async () => {
    for (let i = 0; i < REQUEST_LOG_QUEUE_MAX + 40; i += 1) recordRequest(row({ durationMs: i + 1 }))
    expect(requestLogQueueLength()).toBe(REQUEST_LOG_QUEUE_MAX)
    const bridge = makeBridge()
    attachRequestLogBridge(bridge.transport)
    await requestLogIdle()
    const written = bridge.all('SELECT duration_ms FROM sends ORDER BY id').map(r => r[0])
    expect(written).toHaveLength(REQUEST_LOG_QUEUE_MAX)
    expect(written[0]).toBe(1)
    expect(written.at(-1)).toBe(REQUEST_LOG_QUEUE_MAX)
  })

  it('drops the waiting rows when the file cannot be opened and stays quiet for a while', async () => {
    const transport = {
      request: vi.fn(async () => ({ ok: false, error: { code: 'UNKNOWN_CAPABILITY', message: 'no such capability' } })),
    } as unknown as BrowserBridgeTransport
    attachRequestLogBridge(transport)
    recordRequest(row())
    recordRequest(row())
    await requestLogIdle()
    expect(requestLogQueueLength()).toBe(0)
    const asked = (transport.request as ReturnType<typeof vi.fn>).mock.calls.length
    recordRequest(row())
    await requestLogIdle()
    expect((transport.request as ReturnType<typeof vi.fn>).mock.calls.length).toBe(asked)
  })
})

describe('request log reader', () => {
  it('reads through the reader\'s own bridge, whatever bridge the writer last used', async () => {
    const writer = makeBridge()
    attachRequestLogBridge(writer.transport)
    recordRequest(row({ ...viaRouter }))
    await requestLogIdle()
    const closed = {
      request: vi.fn(async () => { throw new DOMException('Runtime scope was disposed.', 'AbortError') }),
    } as unknown as BrowserBridgeTransport
    attachRequestLogBridge(closed)
    const reader = makeBridge()
    const log = await openRequestLog(reader.transport)
    expect(log).toBeDefined()
    await log!.query({ from: T0, to: T0 + HOUR_MS, by: 'hour', router: 'mod.pool.main' })
    expect(reader.requests.some(r => r.action === 'query')).toBe(true)
    expect(closed.request).not.toHaveBeenCalled()
    expect(await openRequestLog(reader.transport)).toBe(log)
  })
})

describe('request log writer and a closed bridge', () => {
  it('drops a row whose bridge was closed and keeps writing through the next one', async () => {
    const closed = {
      request: vi.fn(async () => { throw new DOMException('Runtime scope was disposed.', 'AbortError') }),
    } as unknown as BrowserBridgeTransport
    const config = { getEnv: (name: string) => (name === 'HOME' ? '/home/tester' : undefined) } as unknown as RuntimeConfig
    attachRequestLogBridge(closed, config)
    recordRequest(row({ durationMs: 1 }))
    await requestLogIdle()
    expect(requestLogQueueLength()).toBe(0)
    const bridge = makeBridge()
    attachRequestLogBridge(bridge.transport)
    recordRequest(row({ durationMs: 2 }))
    await requestLogIdle()
    expect(bridge.all('SELECT duration_ms FROM sends').map(r => r[0])).toEqual([2])
  })
})

describe('request log transport', () => {
  type ModelRequest = { id: string; route: { capability: string; action: string }; payload: Record<string, unknown> }

  function serving(script: (request: ModelRequest) => unknown) {
    const bridge = makeBridge()
    const served = { request: vi.fn(async (request: ModelRequest) => script(request)) }
    const logged = withRequestLog(served as unknown as BrowserBridgeTransport, bridge.transport)
    const send = (action: string, payload: Record<string, unknown>) =>
      logged.request({ id: 'r', route: { capability: 'model', action }, payload } as never) as Promise<unknown>
    const sends = async () => {
      await requestLogIdle()
      // Nothing recorded yet: the file was never opened.
      if (!bridge.requests.some(r => r.capability === 'sqlite')) return []
      return bridge.all(`SELECT p.text, m.text, s.text, hop, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, outcome, f.text, http_status
        FROM sends LEFT JOIN names p ON p.id = provider LEFT JOIN names m ON m.id = model
        LEFT JOIN names s ON s.id = session LEFT JOIN names f ON f.id = failure ORDER BY sends.id`)
    }
    return { bridge, served, send, sends }
  }

  const start = { providerId: 'acme', model: 'acme@latest', requestContext: { sessionId: 'session-a', purpose: 'main', querySource: 'sdk' } }

  it('records a stream when it ends, with the model that answered and its usage', async () => {
    const replies: unknown[] = [
      { ok: true, result: { streamId: 's1' } },
      { ok: true, result: { done: false, status: 'ok', chunks: [
        { type: 'message_start', message: { model: 'acme-large' } },
        { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 9, cache_creation_input_tokens: 0 } } },
      ] } },
      { ok: true, result: { done: true, status: 'done', chunks: [
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 0, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 4 } },
        { type: 'message_stop' },
      ] } },
    ]
    const { send, sends } = serving(() => replies.shift())
    const opened = await send('streamStart', start)
    expect(opened).toEqual({ ok: true, result: { streamId: 's1' } })
    await send('streamRead', { streamId: 's1' })
    expect(await sends()).toEqual([])
    await send('streamRead', { streamId: 's1' })
    expect(await sends()).toEqual([['acme', 'acme-large', 'session-a', 1, 50, 12, 9, 4, 0, null, null]])
  })

  it('records a provider that hooks nothing, a failed stream and a cancelled one', async () => {
    let next = 0
    const { send, sends } = serving(request => {
      if (request.route.action === 'streamStart') return { ok: true, result: { streamId: `s${next += 1}` } }
      if (request.route.action === 'streamCancel') return { ok: true, result: { ok: true } }
      return { ok: true, result: { done: true, status: 'done', chunks: [
        { type: 'error', error: { type: 'rate_limit_error', message: 'HTTP 429 slow down', httpStatus: 429 } },
      ] } }
    })
    await send('streamStart', { providerId: 'plain', model: 'plain-1' })
    await send('streamRead', { streamId: 's1' })
    await send('streamStart', { providerId: 'plain', model: 'plain-1' })
    await send('streamCancel', { streamId: 's2' })
    await send('streamCancel', { streamId: 's2' })
    expect(await sends()).toEqual([
      ['plain', 'plain-1', null, 1, 0, 0, 0, 0, 1, 'rate_limit', 429],
      ['plain', 'plain-1', null, 1, 0, 0, 0, 0, 2, null, null],
    ])
  })

  it('records a blocking call, and nothing for a request that was refused before it left', async () => {
    const replies: unknown[] = [
      { ok: true, result: { message: { role: 'assistant', content: [], model: 'acme-large', usage: { input_tokens: 5, output_tokens: 6 } } } },
      { ok: false, error: { code: 'provider_error', message: 'no runtime driver serves the provider acme' } },
      { ok: false, error: { code: 'provider_error', message: 'no runtime driver serves the provider acme' } },
      { ok: true, result: { status: 'timeout', message: { role: 'assistant', content: [] } } },
    ]
    const { send, sends } = serving(() => replies.shift())
    await send('call', start)
    await send('call', start)
    await send('streamStart', start)
    await send('call', start)
    expect(await sends()).toEqual([
      ['acme', 'acme-large', 'session-a', 1, 5, 6, 0, 0, 0, null, null],
      ['acme', 'acme@latest', 'session-a', 1, 0, 0, 0, 0, 1, 'timeout', null],
    ])
  })

  it('passes every response through unchanged, and a rejection too', async () => {
    const reply = { ok: true, result: { chunks: 'not a list', done: true, extra: 1 } }
    const { send, served } = serving(request => {
      if (request.route.capability !== 'model') throw new Error('offline')
      return request.route.action === 'streamStart' ? { ok: true, result: { streamId: 's1' } } : reply
    })
    await send('streamStart', start)
    expect(await send('streamRead', { streamId: 's1' })).toBe(reply)
    expect(await send('catalog', {})).toBe(reply)
    expect(served.request).toHaveBeenCalledTimes(3)
  })

  it('counts a send under the concrete model its entry resolved to, whether or not the model was reported', async () => {
    recordEntryResolution('acme', 'acme@latest', { id: 'acme-large', versionLabel: '2', preview: false })
    const replies: unknown[] = [
      { ok: true, result: { message: { role: 'assistant', content: [], model: 'acme-large' } } },
      { ok: true, result: { status: 'timeout', message: { role: 'assistant', content: [] } } },
    ]
    const { send, sends } = serving(() => replies.shift())
    await send('call', start)
    await send('call', start)
    expect((await sends()).map(r => [r[1], r[8]])).toEqual([['acme-large', 0], ['acme-large', 1]])
  })

  it('stores the failure kind the provider declared, as the turn reads it', async () => {
    const { send, sends } = serving(request => request.route.action === 'streamStart'
      ? { ok: true, result: { streamId: 's1' } }
      : { ok: true, result: { done: true, status: 'done', chunks: [
          { type: 'error', error: { message: 'HTTP 403 forbidden', httpStatus: 403, verdict: { kind: 'quota' } } },
        ] } })
    await send('streamStart', { providerId: 'plain', model: 'plain-1' })
    await send('streamRead', { streamId: 's1' })
    expect((await sends()).map(r => [r[9], r[10]])).toEqual([['quota', 403]])
  })

  it('ends a stream whose read was refused or rejected', async () => {
    let next = 0
    const { send, sends } = serving(request => {
      if (request.route.action === 'streamStart') return { ok: true, result: { streamId: `s${next += 1}` } }
      if ((request.payload as { streamId?: string }).streamId === 's1') {
        return { ok: false, error: { code: 'STREAM_NOT_FOUND', message: 'no such stream' } }
      }
      throw new DOMException('Runtime scope was disposed.', 'AbortError')
    })
    await send('streamStart', { providerId: 'plain', model: 'plain-1' })
    await send('streamRead', { streamId: 's1' })
    await send('streamStart', { providerId: 'plain', model: 'plain-1' })
    await expect(send('streamRead', { streamId: 's2' })).rejects.toThrow(/disposed/)
    expect((await sends()).map(r => r[8])).toEqual([1, 2])
  })

  it('leaves a transport that scripts the model routes as it is', () => {
    const scripted = { request: vi.fn(), servesModelRoutes: true } as unknown as BrowserBridgeTransport
    expect(withRequestLog(scripted, scripted)).toBe(scripted)
    expect(requestLogQueueLength()).toBe(0)
  })
})
