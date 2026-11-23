/**
 * Contract: the usage log's file (F-27), one row per model request sent and
 * one per file a file tool read or changed. `record` writes one request;
 * `recordFileOps` writes its rows in one transaction, all or none. `query`
 * reads both tables, summed when asked; a span over `QUERY_SPAN_MAX_MS` or a malformed
 * range throws `RequestLogQueryError` before anything is read. Every method
 * rejects on a failed bridge request; nothing here retries beyond a short
 * wait on a locked file. Callers serialize writes (requestLogWriter.ts).
 *
 * Security: a provider id is an opaque instance id; it is stored and
 * compared whole, never parsed. Nothing but the fields of `RequestLogRow`
 * and `FileOpRow` reaches the file. The `hour`, `day`, `switch` and `request`
 * answers read `sends` alone and carry no file path, project root or agent id;
 * the `INSIGHT_BY` answers carry paths and project roots.
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
import { insightQuery, SEND_BY, type InsightBy, type InsightResult } from './requestLogInsights'
import {
  COUNT_ROWS_SQL,
  CREATE_META_SQL,
  CREATE_STATEMENTS,
  DAY_MS,
  FILE_OP_CODES,
  HOUR_MS,
  INSERT_FILE_OP_SQL,
  INSERT_SEND_SQL,
  INTERN_NAME_SQL,
  NAME_ID,
  OLDEST_ROW_SQL,
  OUTCOME_ABORTED,
  OUTCOME_FAILED,
  OUTCOME_OK,
  READ_VERSION_SQL,
  REQUEST_LOG_SCHEMA_VERSION,
  SCHEMA_STEPS,
  TRIM_STATEMENTS,
  WRITE_VERSION_SQL,
} from './requestLogSchema'
import { sessionProjectOf } from './sessionProjects'

export type RequestLogUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

const USAGE_FIELDS: ReadonlyArray<[keyof RequestLogUsage, string]> = [
  ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cache_read_input_tokens'],
  ['cacheWriteTokens', 'cache_creation_input_tokens'],
]

/** Folds a reported wire `usage` into `into`. A later report replaces a
 *  figure only when it carries one. */
export function foldUsage(into: RequestLogUsage, reported: unknown): void {
  if (!reported || typeof reported !== 'object') return
  const usage = reported as Record<string, unknown>
  for (const [key, wire] of USAGE_FIELDS) {
    const value = usage[wire]
    if (typeof value === 'number' && value > 0) into[key] = value
  }
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
  /** The session's project root. */
  project?: string
  /** What the request was for, and the caller tag behind that. */
  purpose?: string
  source?: string
  /** The loop under the session that asked: a sub-agent or a side run. */
  agentId?: string
}

/** Who asked, as a request's context names it. */
export type RequestLogCaller = Pick<RequestLogRow, 'sessionId' | 'purpose' | 'source' | 'agentId' | 'project'>

/** The caller fields of a request context, with the project its session registered; a field it does not name as text is left out. */
export function requestLogCallerOf(context: unknown): RequestLogCaller {
  const named = context && typeof context === 'object' ? (context as Record<string, unknown>) : {}
  const caller: RequestLogCaller = {}
  if (typeof named.sessionId === 'string' && named.sessionId) caller.sessionId = named.sessionId
  if (typeof named.purpose === 'string' && named.purpose) caller.purpose = named.purpose
  if (typeof named.querySource === 'string' && named.querySource) caller.source = named.querySource
  if (typeof named.agentId === 'string' && named.agentId) caller.agentId = named.agentId
  const project = sessionProjectOf(caller.sessionId)
  if (project) caller.project = project
  return caller
}

/** One file a file tool read or changed, or tried to. */
export type FileOpRow = {
  atMs: number
  sessionId?: string
  agentId?: string
  /** The model call that asked for it. */
  callId?: number
  /** The session's project root. */
  project?: string
  /** The file's own main repository root; absent outside a repository. */
  repo?: string
  /** The linked worktree the file is in; absent in the main checkout. */
  worktree?: string
  /** Relative to the file's working tree root; absolute without `repo`. */
  path: string
  /** A move's source, in the form of `path`. */
  fromPath?: string
  tool: string
  op: keyof typeof FILE_OP_CODES
  /** A read: what it returned. A change: the file's size afterwards. */
  bytes?: number
  /** A read: the lines it returned. */
  lines?: number
  added?: number
  removed?: number
  /** A read of part of the file. */
  partial?: boolean
  /** The file did not exist before. */
  created?: boolean
  outcome: 'ok' | 'failed'
  failureKind?: string
}

export type RequestLogQuery = {
  /** Epoch ms, inclusive. `hour` and `day` widen it to whole hours. */
  from: number
  /** Epoch ms, exclusive. */
  to: number
  by: 'hour' | 'day' | 'switch' | 'request' | InsightBy
  /** Only requests that went through this router provider; not with an `INSIGHT_BY` grouping. */
  router?: string
  /** Only rows of sessions whose project root is this string, as stored. */
  project?: string
  /** `day` and `file_day` only: minutes east of UTC of the days to sum into. An hour belongs
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

/** One send that succeeded, with what it used. */
export type RequestLogRequest = {
  startedMs: number
  durationMs: number
  callId: number
  hop: number
  provider: string
  model: string
  router?: string
  routerRow?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type RequestLogQueryResult =
  | { by: 'hour' | 'day'; buckets: RequestLogBucket[]; truncated: boolean }
  | { by: 'switch'; switches: RequestLogSwitch[] }
  | { by: 'request'; requests: RequestLogRequest[] }
  | InsightResult

export const QUERY_SPAN_MAX_MS = 90 * DAY_MS
export const SWITCH_ROWS_MAX = 100
/** Successful sends one `request` read lists at most, newest first. */
export const REQUEST_ROWS_MAX = 100
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

const READ_BACKFILL_SQL = "SELECT value FROM log_meta WHERE key = 'project_backfill'"
const MARK_BACKFILL_SQL = "INSERT OR REPLACE INTO log_meta (key, value) VALUES ('project_backfill', 1)"
const UNFILLED_SESSIONS_SQL =
  'SELECT DISTINCT n.text FROM sends s JOIN names n ON n.id = s.session WHERE s.project IS NULL ORDER BY n.text'
const FILL_PROJECT_SQL = `UPDATE sends SET project = ${NAME_ID} WHERE project IS NULL AND session = ${NAME_ID}`

/** A call id no other call of this or another runtime is likely to share. */
let callCounter = Math.floor(Math.random() * 4096)
export function newRequestLogCallId(nowMs: number = Date.now()): number {
  callCounter = (callCounter + 1) % 4096
  return nowMs * 4096 + callCounter
}

/** The statements that write one request. */
export function recordStatements(row: RequestLogRow): Statement[] {
  const names = new Set<string>([row.provider, row.model])
  for (const name of [
    row.sessionId,
    row.project,
    row.purpose,
    row.source,
    row.agentId,
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
        row.project ?? null,
        row.purpose ?? null,
        row.source ?? null,
        row.agentId ?? null,
      ],
    },
  ]
}

/** The statements that write a batch of file rows: each string once, then the rows in order. */
export function fileOpStatements(rows: readonly FileOpRow[]): Statement[] {
  const names = new Set<string>()
  for (const row of rows) {
    names.add(row.path)
    names.add(row.tool)
    for (const name of [
      row.sessionId,
      row.agentId,
      row.project,
      row.repo,
      row.worktree,
      row.fromPath,
      row.outcome === 'failed' ? row.failureKind : undefined,
    ]) {
      if (name !== undefined) names.add(name)
    }
  }
  return [
    ...[...names].map(name => ({ sql: INTERN_NAME_SQL, params: [name] })),
    ...rows.map(row => {
      const failed = row.outcome === 'failed'
      const params: SqlValue[] = [
        Math.floor(row.atMs),
        row.sessionId ?? null,
        row.agentId ?? null,
        row.callId ?? null,
        row.project ?? null,
        row.repo ?? null,
        row.worktree ?? null,
        row.path,
        row.fromPath ?? null,
        row.tool,
        FILE_OP_CODES[row.op],
        count(row.bytes),
        count(row.lines),
        count(row.added),
        count(row.removed),
        row.partial ? 1 : 0,
        row.created ? 1 : 0,
        failed ? OUTCOME_FAILED : OUTCOME_OK,
        failed ? (row.failureKind ?? null) : null,
      ]
      return { sql: INSERT_FILE_OP_SQL, params }
    }),
  ]
}

/** The router and project clauses of a `sends` read, with their params appended. */
function sendFilters(query: RequestLogQuery, params: SqlValue[]): string {
  let clause = ''
  if (query.router !== undefined) {
    params.push(query.router)
    clause += ` AND s.router = COALESCE(${NAME_ID}, -1)`
  }
  if (query.project !== undefined) {
    params.push(query.project)
    clause += ` AND s.project = COALESCE(${NAME_ID}, -1)`
  }
  return clause
}

function checkedRange(query: RequestLogQuery): void {
  if (!Number.isFinite(query.from) || !Number.isFinite(query.to) || query.from < 0 || query.to <= query.from) {
    throw new RequestLogQueryError('the range needs a start before its end')
  }
  if (query.to - query.from > QUERY_SPAN_MAX_MS) {
    throw new RequestLogQueryError('the range is longer than 90 days')
  }
  if (query.router !== undefined && !(SEND_BY as readonly string[]).includes(query.by)) {
    throw new RequestLogQueryError(`a ${query.by} answer is not narrowed by router`)
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

  async recordFileOps(rows: readonly FileOpRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.ensureSchema()
    await this.write(fileOpStatements(rows))
  }

  /** Fills `sends.project` once for rows written before it was recorded:
   *  each session's project from `readRoots` (session id to project, in the
   *  form `projectKeyOf` gives), in one transaction with the mark that it ran.
   *  A session `readRoots` does not name stays without; when it names none,
   *  nothing is marked. Answers the sessions filled, or null when it had
   *  already run. */
  async backfillProjects(readRoots: () => Promise<ReadonlyMap<string, string>>): Promise<number | null> {
    await this.ensureSchema()
    if ((await this.read(READ_BACKFILL_SQL)).rows.length > 0) return null
    const sessions = (await this.read(UNFILLED_SESSIONS_SQL)).rows.map(row => readText(row[0])).filter((id): id is string => id !== undefined)
    const roots = sessions.length > 0 ? await readRoots() : new Map<string, string>()
    // No metadata at all for rows that need it: likely an unreadable file, so the next open tries again.
    if (sessions.length > 0 && roots.size === 0) return 0
    const statements: Statement[] = []
    let filled = 0
    for (const session of sessions) {
      const project = roots.get(session)
      if (!project) continue
      filled += 1
      statements.push({ sql: INTERN_NAME_SQL, params: [project] }, { sql: FILL_PROJECT_SQL, params: [project, session] })
    }
    await this.write([...statements, { sql: MARK_BACKFILL_SQL }])
    return filled
  }

  /** Rows of both tables together. */
  async rowCount(): Promise<number> {
    await this.ensureSchema()
    return readNumber((await this.read(COUNT_ROWS_SQL)).rows[0]?.[0])
  }

  /** Deletes the rows of both tables older than the oldest row's time plus
   *  `spanMs`, in one transaction. False when there was no row to delete. */
  async trimOldest(spanMs: number): Promise<boolean> {
    await this.ensureSchema()
    const oldest = (await this.read(OLDEST_ROW_SQL)).rows[0]?.[0]
    if (oldest === null || oldest === undefined) return false
    const cutoff = readNumber(oldest) + spanMs
    await this.write(TRIM_STATEMENTS.map(sql => ({ sql, params: [cutoff] })))
    return true
  }

  async query(query: RequestLogQuery): Promise<RequestLogQueryResult> {
    checkedRange(query)
    await this.ensureSchema()
    if (query.by === 'switch') return this.switches(query)
    if (query.by === 'request') return this.requests(query)
    if (query.by === 'hour' || query.by === 'day') return this.buckets(query)
    return insightQuery((sql, params, maxRows) => this.read(sql, params, maxRows), { ...query, by: query.by })
  }

  private async buckets(query: RequestLogQuery): Promise<RequestLogQueryResult> {
    const unit = query.by === 'day' ? DAY_MS : HOUR_MS
    const offsetMs = query.by === 'day' ? (query.tzOffsetMinutes ?? 0) * 60_000 : 0
    const params: SqlValue[] = [
      offsetMs,
      Math.floor(query.from / HOUR_MS) * HOUR_MS,
      Math.ceil(query.to / HOUR_MS) * HOUR_MS,
    ]
    const filters = sendFilters(query, params)
    const result = await this.read(
      `SELECT ((s.started_ms / ${HOUR_MS}) * ${HOUR_MS} + CAST(? AS INTEGER)) / ${unit} AS bucket,
        p.text, m.text, r.text, w.text,
        COUNT(*), SUM(CASE WHEN s.outcome = ${OUTCOME_FAILED} THEN 1 ELSE 0 END),
        SUM(s.input_tokens), SUM(s.output_tokens), SUM(s.cache_read_tokens), SUM(s.cache_write_tokens),
        SUM(CASE WHEN s.from_provider IS NOT NULL THEN 1 ELSE 0 END)
      FROM sends s
        JOIN names p ON p.id = s.provider
        JOIN names m ON m.id = s.model
        LEFT JOIN names r ON r.id = s.router
        LEFT JOIN names w ON w.id = s.router_row
      WHERE s.started_ms >= ? AND s.started_ms < ?
        ${filters}
      GROUP BY bucket, s.provider, s.model, s.router, s.router_row
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
    const filters = sendFilters(query, params)
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
        ${filters}
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

  private async requests(query: RequestLogQuery): Promise<RequestLogQueryResult> {
    const params: SqlValue[] = [Math.floor(query.from), Math.floor(query.to)]
    const filters = sendFilters(query, params)
    const result = await this.read(
      `SELECT s.started_ms, s.duration_ms, s.call_id, s.hop, p.text, m.text, r.text, w.text,
        s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_write_tokens
      FROM sends s
        JOIN names p ON p.id = s.provider
        JOIN names m ON m.id = s.model
        LEFT JOIN names r ON r.id = s.router
        LEFT JOIN names w ON w.id = s.router_row
      WHERE s.started_ms >= ? AND s.started_ms < ? AND s.outcome = ${OUTCOME_OK}
        ${filters}
      ORDER BY s.started_ms DESC, s.id DESC
      LIMIT ${REQUEST_ROWS_MAX}`,
      params,
      REQUEST_ROWS_MAX,
    )
    const requests = result.rows.map((row): RequestLogRequest => {
      const router = readText(row[6])
      const routerRow = readText(row[7])
      return {
        startedMs: readNumber(row[0]),
        durationMs: readNumber(row[1]),
        callId: readNumber(row[2]),
        hop: readNumber(row[3]),
        provider: readText(row[4]) ?? '',
        model: readText(row[5]) ?? '',
        ...(router !== undefined ? { router } : {}),
        ...(routerRow !== undefined ? { routerRow } : {}),
        inputTokens: readNumber(row[8]),
        outputTokens: readNumber(row[9]),
        cacheReadTokens: readNumber(row[10]),
        cacheWriteTokens: readNumber(row[11]),
      }
    })
    return { by: 'request', requests }
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
