/**
 * Contract: the request log's file (F-27), one row per model request sent
 * and an hourly rollup beside the rows. `record` writes the row and its rollup in one transaction, or
 * neither. `query` reads; a span over `QUERY_SPAN_MAX_MS` or a malformed
 * range throws `RequestLogQueryError` before anything is read. Every method
 * rejects on a failed bridge request; nothing here retries beyond a short
 * wait on a locked file. Callers serialize writes (requestLogWriter.ts).
 *
 * Security: a provider id is an opaque instance id; it is stored and
 * compared whole, never parsed. Nothing but the fields of `RequestLogRow`
 * reaches the file.
 */
import type {
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
} from '../../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../../browser/bridge/browserBridgeProtocol'
import type { SqlValue } from '../../browser/bridge/protocol/sqlite'
import { isContendedSqliteError } from '../../browser/storage/SqliteSessionMetaStore'
import { dirnameRuntimePath } from '../../utils/runtimePaths'
import {
  ADD_HOURLY_SQL,
  CREATE_META_SQL,
  CREATE_STATEMENTS,
  DAY_MS,
  HOUR_MS,
  INSERT_SEND_SQL,
  INTERN_NAME_SQL,
  NAME_ID,
  OUTCOME_ABORTED,
  OUTCOME_FAILED,
  OUTCOME_OK,
  READ_VERSION_SQL,
  REBUILD_HOURLY_STATEMENTS,
  REQUEST_LOG_SCHEMA_VERSION,
  SCHEMA_STEPS,
  SEED_HOURLY_SQL,
  WRITE_VERSION_SQL,
} from './requestLogSchema'

export type RequestLogUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** One send of a model request. */
export type RequestLogRow = {
  startedMs: number
  durationMs: number
  /** The top-level session; absent for a request of no session. */
  sessionId?: string
  /** Shared by the sends of one call; absent: the send is a call of its own. */
  callId?: number
  /** 1 for a call's first send; absent: 1. */
  hop?: number
  /** The provider instance that served the send, and its model. */
  provider: string
  model: string
  /** The router provider the call was made to and its row; absent: not routed. */
  router?: { provider: string; row: string }
  /** The target the call left for this one, and the verdict kind that moved it. */
  switchedFrom?: { provider: string; model: string; kind: string }
  usage?: RequestLogUsage
  outcome: 'ok' | 'failed' | 'aborted'
  /** On `failed`: the verdict kind, or a transport word when none was found. */
  failureKind?: string
  httpStatus?: number
}

export type RequestLogQuery = {
  /** Epoch ms, inclusive. `hour` and `day` widen it to whole hours. */
  from: number
  /** Epoch ms, exclusive. */
  to: number
  by: 'hour' | 'day' | 'switch'
  /** Only requests that went through this router provider. */
  router?: string
  /** `day` only: minutes east of UTC of the days to sum into. An hour belongs
   *  to the day its first minute falls in. */
  tzOffsetMinutes?: number
}

export type RequestLogBucket = {
  /** Epoch ms of the bucket's first instant. */
  start: number
  provider: string
  model: string
  router?: string
  routerRow?: string
  requests: number
  failures: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  switches: number
}

export type RequestLogSwitch = {
  startedMs: number
  callId: number
  hop: number
  provider: string
  model: string
  router?: string
  routerRow?: string
  from: { provider: string; model: string }
  kind?: string
}

export type RequestLogQueryResult =
  | { by: 'hour' | 'day'; buckets: RequestLogBucket[]; truncated: boolean }
  | { by: 'switch'; switches: RequestLogSwitch[] }

export const QUERY_SPAN_MAX_MS = 90 * DAY_MS
export const SWITCH_ROWS_MAX = 100
const BUCKET_ROWS_MAX = 100_000

export class RequestLogQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestLogQueryError'
  }
}

type Statement = { sql: string; params?: SqlValue[] }

type BridgeResponse<C extends BrowserBridgeCapability, A extends BrowserBridgeAction<C>> =
  | { ok: true; result: BrowserBridgeResult<C, A> }
  | { ok: false; error: { code: string; message: string } }

const LOCK_RETRIES = 4
const LOCK_BACKOFF_MS = 25

/** Another writer holds the file, or its open was contended. */
function isContended(error: { code: string; message: string }): boolean {
  return isContendedSqliteError(new Error(`${error.code}: ${error.message}`))
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function readNumber(value: SqlValue | undefined): number {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object' && '$int' in value) return Number(value.$int)
  return 0
}

function readText(value: SqlValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

let nextRequest = 0
const requestPrefix = `reqlog-${Math.random().toString(36).slice(2, 8)}`

/** A call id no other call of this or another runtime is likely to share. */
let callCounter = Math.floor(Math.random() * 4096)
export function newRequestLogCallId(nowMs: number = Date.now()): number {
  callCounter = (callCounter + 1) % 4096
  return nowMs * 4096 + callCounter
}

/** The statements that write one row and its rollup. */
export function recordStatements(row: RequestLogRow): Statement[] {
  const names = new Set<string>([row.provider, row.model])
  for (const name of [
    row.sessionId,
    row.router?.provider,
    row.router?.row,
    row.switchedFrom?.provider,
    row.switchedFrom?.model,
    row.switchedFrom?.kind,
    row.outcome === 'failed' ? row.failureKind : undefined,
  ]) {
    if (name !== undefined) names.add(name)
  }
  const usage = row.usage ?? {}
  const tokens = [
    count(usage.inputTokens),
    count(usage.outputTokens),
    count(usage.cacheReadTokens),
    count(usage.cacheWriteTokens),
  ]
  const startedMs = Math.floor(row.startedMs)
  const failed = row.outcome === 'failed'
  const key: SqlValue[] = [
    Math.floor(startedMs / HOUR_MS),
    row.provider,
    row.model,
    row.router?.provider ?? null,
    row.router?.row ?? null,
  ]
  return [
    ...[...names].map(name => ({ sql: INTERN_NAME_SQL, params: [name] })),
    {
      sql: INSERT_SEND_SQL,
      params: [
        startedMs,
        count(row.durationMs),
        row.sessionId ?? null,
        row.callId ?? newRequestLogCallId(startedMs),
        row.hop ?? 1,
        row.provider,
        row.model,
        row.router?.provider ?? null,
        row.router?.row ?? null,
        row.switchedFrom?.provider ?? null,
        row.switchedFrom?.model ?? null,
        row.switchedFrom?.kind ?? null,
        ...tokens,
        failed ? OUTCOME_FAILED : row.outcome === 'aborted' ? OUTCOME_ABORTED : OUTCOME_OK,
        failed ? (row.failureKind ?? null) : null,
        failed ? (row.httpStatus ?? null) : null,
      ],
    },
    { sql: SEED_HOURLY_SQL, params: key },
    { sql: ADD_HOURLY_SQL, params: [failed ? 1 : 0, ...tokens, row.switchedFrom ? 1 : 0, ...key] },
  ]
}

function checkedRange(query: RequestLogQuery): void {
  if (!Number.isFinite(query.from) || !Number.isFinite(query.to) || query.from < 0 || query.to <= query.from) {
    throw new RequestLogQueryError('the range needs a start before its end')
  }
  if (query.to - query.from > QUERY_SPAN_MAX_MS) {
    throw new RequestLogQueryError('the range is longer than 90 days')
  }
  const offset = query.tzOffsetMinutes ?? 0
  if (!Number.isInteger(offset) || Math.abs(offset) > 24 * 60) {
    throw new RequestLogQueryError('the time-zone offset is not a whole number of minutes within a day')
  }
}

export class RequestLogStore {
  private readonly transport: () => BrowserBridgeTransport
  readonly dbPath: string
  private schemaReady: Promise<void> | undefined

  constructor(options: { transport: () => BrowserBridgeTransport; dbPath: string }) {
    this.transport = options.transport
    this.dbPath = options.dbPath
  }

  /** Creates the file and its tables when absent and brings an older file up
   *  to this build's version. Rejects, and writes nothing, for a file a newer
   *  build wrote. A failed bring-up is tried again by the next call. */
  ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.bringUp().catch(error => {
        this.schemaReady = undefined
        throw error
      })
    }
    return this.schemaReady
  }

  private async bringUp(): Promise<void> {
    // `rwc` creates the file, not its directory.
    await this.request(createBridgeRoute('fs', 'mkdir'), { path: dirnameRuntimePath(this.dbPath) })
    await this.write([{ sql: CREATE_META_SQL }], 'rwc')
    const found = readNumber((await this.read(READ_VERSION_SQL)).rows[0]?.[0])
    if (found > REQUEST_LOG_SCHEMA_VERSION) {
      throw new Error(`the request log was written by a newer build (version ${found})`)
    }
    await this.write(CREATE_STATEMENTS.map(sql => ({ sql })))
    const stored = readNumber((await this.read(READ_VERSION_SQL)).rows[0]?.[0])
    for (let version = stored; version < REQUEST_LOG_SCHEMA_VERSION; version += 1) {
      await this.write([
        ...(SCHEMA_STEPS[version] ?? []).map(sql => ({ sql })),
        { sql: WRITE_VERSION_SQL, params: [version + 1] },
      ])
    }
  }

  async schemaVersion(): Promise<number> {
    await this.ensureSchema()
    return readNumber((await this.read(READ_VERSION_SQL)).rows[0]?.[0])
  }

  async record(row: RequestLogRow): Promise<void> {
    await this.ensureSchema()
    await this.write(recordStatements(row))
  }

  /** Replaces the rollup with one computed from the detail rows. */
  async rebuildRollup(): Promise<void> {
    await this.ensureSchema()
    await this.write(REBUILD_HOURLY_STATEMENTS.map(sql => ({ sql })))
  }

  async query(query: RequestLogQuery): Promise<RequestLogQueryResult> {
    checkedRange(query)
    await this.ensureSchema()
    return query.by === 'switch' ? this.switches(query) : this.buckets(query)
  }

  private async buckets(query: RequestLogQuery): Promise<RequestLogQueryResult> {
    const unit = query.by === 'day' ? DAY_MS : HOUR_MS
    const offsetMs = query.by === 'day' ? (query.tzOffsetMinutes ?? 0) * 60_000 : 0
    const params: SqlValue[] = [offsetMs, Math.floor(query.from / HOUR_MS), Math.ceil(query.to / HOUR_MS)]
    if (query.router !== undefined) params.push(query.router)
    const result = await this.read(
      `SELECT (h.hour * ${HOUR_MS} + CAST(? AS INTEGER)) / ${unit} AS bucket, p.text, m.text, r.text, w.text,
        SUM(h.requests), SUM(h.failures), SUM(h.input_tokens), SUM(h.output_tokens),
        SUM(h.cache_read_tokens), SUM(h.cache_write_tokens), SUM(h.switches)
      FROM hourly h
        JOIN names p ON p.id = h.provider
        JOIN names m ON m.id = h.model
        LEFT JOIN names r ON r.id = h.router
        LEFT JOIN names w ON w.id = h.router_row
      WHERE h.hour >= ? AND h.hour < ?
        ${query.router !== undefined ? `AND h.router = COALESCE(${NAME_ID}, -1)` : ''}
      GROUP BY bucket, h.provider, h.model, h.router, h.router_row
      ORDER BY bucket, p.text, m.text, r.text, w.text`,
      params,
      BUCKET_ROWS_MAX,
    )
    const buckets = result.rows.map((row): RequestLogBucket => {
      const router = readText(row[3])
      const routerRow = readText(row[4])
      return {
        start: readNumber(row[0]) * unit - offsetMs,
        provider: readText(row[1]) ?? '',
        model: readText(row[2]) ?? '',
        ...(router !== undefined ? { router } : {}),
        ...(routerRow !== undefined ? { routerRow } : {}),
        requests: readNumber(row[5]),
        failures: readNumber(row[6]),
        inputTokens: readNumber(row[7]),
        outputTokens: readNumber(row[8]),
        cacheReadTokens: readNumber(row[9]),
        cacheWriteTokens: readNumber(row[10]),
        switches: readNumber(row[11]),
      }
    })
    return { by: query.by as 'hour' | 'day', buckets, truncated: result.truncated }
  }

  private async switches(query: RequestLogQuery): Promise<RequestLogQueryResult> {
    const params: SqlValue[] = [Math.floor(query.from), Math.floor(query.to)]
    if (query.router !== undefined) params.push(query.router)
    const result = await this.read(
      `SELECT s.started_ms, s.call_id, s.hop, p.text, m.text, r.text, w.text, fp.text, fm.text, k.text
      FROM sends s
        JOIN names p ON p.id = s.provider
        JOIN names m ON m.id = s.model
        JOIN names fp ON fp.id = s.from_provider
        LEFT JOIN names fm ON fm.id = s.from_model
        LEFT JOIN names r ON r.id = s.router
        LEFT JOIN names w ON w.id = s.router_row
        LEFT JOIN names k ON k.id = s.switch_kind
      WHERE s.started_ms >= ? AND s.started_ms < ?
        ${query.router !== undefined ? `AND s.router = COALESCE(${NAME_ID}, -1)` : ''}
      ORDER BY s.started_ms DESC, s.id DESC
      LIMIT ${SWITCH_ROWS_MAX}`,
      params,
      SWITCH_ROWS_MAX,
    )
    const switches = result.rows.map((row): RequestLogSwitch => {
      const router = readText(row[5])
      const routerRow = readText(row[6])
      const kind = readText(row[9])
      return {
        startedMs: readNumber(row[0]),
        callId: readNumber(row[1]),
        hop: readNumber(row[2]),
        provider: readText(row[3]) ?? '',
        model: readText(row[4]) ?? '',
        ...(router !== undefined ? { router } : {}),
        ...(routerRow !== undefined ? { routerRow } : {}),
        from: { provider: readText(row[7]) ?? '', model: readText(row[8]) ?? '' },
        ...(kind !== undefined ? { kind } : {}),
      }
    })
    return { by: 'switch', switches }
  }

  private async read(sql: string, params: SqlValue[] = [], maxRows?: number) {
    const response = await this.sqlite(createBridgeRoute('sqlite', 'query'), {
      path: this.dbPath,
      mode: 'ro',
      sql,
      params,
      bigIntMode: 'number',
      ...(maxRows !== undefined ? { maxRows } : {}),
    })
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result
  }

  /** One transaction: every statement, or none. */
  private async write(statements: Statement[], mode: 'rw' | 'rwc' = 'rw'): Promise<void> {
    const response = await this.sqlite(createBridgeRoute('sqlite', 'batch'), {
      path: this.dbPath,
      mode,
      atomic: true,
      statements,
    })
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
  }

  private async sqlite<A extends BrowserBridgeAction<'sqlite'>>(
    route: BrowserBridgeRoute<'sqlite', A>,
    payload: BrowserBridgeRequestPayload<'sqlite', A>,
  ): Promise<BridgeResponse<'sqlite', A>> {
    let response = await this.request(route, payload)
    for (let attempt = 1; attempt <= LOCK_RETRIES && !response.ok && isContended(response.error); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, LOCK_BACKOFF_MS * attempt))
      response = await this.request(route, payload)
    }
    return response
  }

  private async request<C extends BrowserBridgeCapability, A extends BrowserBridgeAction<C>>(
    route: BrowserBridgeRoute<C, A>,
    payload: BrowserBridgeRequestPayload<C, A>,
  ): Promise<BridgeResponse<C, A>> {
    nextRequest += 1
    return (await this.transport().request({
      id: `${requestPrefix}-${nextRequest}`,
      route,
      payload,
    })) as BridgeResponse<C, A>
  }
}
