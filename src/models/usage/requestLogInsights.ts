/**
 * Contract: the summed reads of the usage log beyond the per-request ones
 * (F-27): totals, per project, per purpose, file work per hour or day, and
 * file rankings. Each runs over a range the store has already checked and
 * returns groups only, never a row of either table.
 *
 * Security: these answers carry project roots and file paths. Only a caller
 * granted every grouping may ask for them (`usageGrantOf`).
 */
import type { SqlValue } from '../../browser/bridge/protocol/sqlite'
import { FILE_OP_CODES, HOUR_MS, DAY_MS, NAME_ID, OUTCOME_FAILED, OUTCOME_OK } from './requestLogSchema'

/** The groupings that read `sends` alone and carry no path, project root or agent id. */
export const SEND_BY = ['hour', 'day', 'switch', 'request'] as const

/** The groupings that read file rows or project roots. */
export const INSIGHT_BY = ['total', 'project', 'purpose', 'file_hour', 'file_day', 'file_read', 'file_edit', 'reread'] as const
export type InsightBy = (typeof INSIGHT_BY)[number]

/** Rows a ranking (`file_read`, `file_edit`, `reread`) lists at most. */
export const FILE_ROWS_MAX = 50
/** Projects a `project` answer lists at most, most tokens first. */
export const PROJECT_ROWS_MAX = 500
/** Purpose rows a `purpose` answer lists at most. */
export const PURPOSE_ROWS_MAX = 500
const FILE_BUCKET_ROWS_MAX = 5_000

export type InsightQuery = {
  from: number
  to: number
  by: InsightBy
  /** Only rows of sessions whose project root is this string, as stored. */
  project?: string
  /** `file_day` only: minutes east of UTC of the days to sum into. */
  tzOffsetMinutes?: number
}

export type TokenSums = {
  requests: number
  failures: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type FileSums = {
  /** Read calls, the bytes and lines they returned. */
  reads: number
  readBytes: number
  readLines: number
  /** Edit, write, remove and move calls; `failedEdits` of them did not apply. */
  edits: number
  failedEdits: number
  /** Lines of the changes that applied. */
  added: number
  removed: number
}

/** `filesCreated`: files an applied change created. `filesReadBeforeChange`: files changed in the range that an applied read
 *  in the range reached before their first applied change. */
export type InsightTotal = TokenSums &
  FileSums & { filesRead: number; filesChanged: number; filesCreated: number; filesReadBeforeChange: number }
/** `project` absent: requests or files of no known project. */
export type InsightProject = TokenSums & FileSums & { project?: string }
export type InsightPurpose = TokenSums & { purpose?: string; source?: string; subAgent: boolean }
export type InsightFileBucket = FileSums & { start: number }
/** `repo` absent: `path` is absolute, outside any repository. `partialReads`: reads given an offset or a limit.
 *  `maxReadBytes`: the largest applied whole-file read, 0 when none. */
export type InsightFile = FileSums & { repo?: string; path: string; partialReads: number; maxReadBytes: number }
export type InsightReread = { sessionId: string; repo?: string; path: string; reads: number; readBytes: number; extraBytes: number }

export type InsightResult =
  | { by: 'total'; total: InsightTotal }
  | { by: 'project'; projects: InsightProject[]; truncated: boolean }
  | { by: 'purpose'; purposes: InsightPurpose[]; truncated: boolean }
  | { by: 'file_hour' | 'file_day'; buckets: InsightFileBucket[]; truncated: boolean }
  | { by: 'file_read' | 'file_edit'; files: InsightFile[] }
  | { by: 'reread'; rereads: InsightReread[] }

export type InsightRead = (sql: string, params: SqlValue[], maxRows?: number) => Promise<{ rows: SqlValue[][]; truncated: boolean }>

const READ = FILE_OP_CODES.read

const num = (value: SqlValue | undefined): number => (typeof value === 'number' ? value : Number(value ?? 0) || 0)
const text = (value: SqlValue | undefined): string | undefined => (typeof value === 'string' ? value : undefined)

const TOKEN_COLUMNS = `COUNT(*), SUM(CASE WHEN s.outcome = ${OUTCOME_FAILED} THEN 1 ELSE 0 END),
  TOTAL(s.input_tokens), TOTAL(s.output_tokens), TOTAL(s.cache_read_tokens), TOTAL(s.cache_write_tokens)`

const FILE_SUMS = [
  `SUM(f.op = ${READ})`,
  `TOTAL(CASE WHEN f.op = ${READ} THEN f.bytes END)`,
  `TOTAL(CASE WHEN f.op = ${READ} THEN f.lines END)`,
  `SUM(f.op <> ${READ})`,
  `SUM(f.op <> ${READ} AND f.outcome = ${OUTCOME_FAILED})`,
  `TOTAL(CASE WHEN f.op <> ${READ} AND f.outcome = ${OUTCOME_OK} THEN f.added END)`,
  `TOTAL(CASE WHEN f.op <> ${READ} AND f.outcome = ${OUTCOME_OK} THEN f.removed END)`,
]
const FILE_COLUMNS = FILE_SUMS.join(', ')
const WHOLE_READ = `f.op = ${READ} AND f.outcome = ${OUTCOME_OK} AND f.partial = 0`

const tokensAt = (row: SqlValue[], at: number): TokenSums => ({
  requests: num(row[at]),
  failures: num(row[at + 1]),
  inputTokens: num(row[at + 2]),
  outputTokens: num(row[at + 3]),
  cacheReadTokens: num(row[at + 4]),
  cacheWriteTokens: num(row[at + 5]),
})

const filesAt = (row: SqlValue[], at: number): FileSums => ({
  reads: num(row[at]),
  readBytes: num(row[at + 1]),
  readLines: num(row[at + 2]),
  edits: num(row[at + 3]),
  failedEdits: num(row[at + 4]),
  added: num(row[at + 5]),
  removed: num(row[at + 6]),
})

/** Scan by time; a project narrows through its own index. Named so a grouping by file never walks the file index instead. */
const fileIndex = (query: InsightQuery): string => (query.project !== undefined ? 'file_ops_project' : 'file_ops_at')

/** The range and project clause of `alias`, with its params appended. */
function where(alias: 's' | 'f', query: InsightQuery, params: SqlValue[]): string {
  const at = alias === 's' ? 's.started_ms' : 'f.at_ms'
  params.push(Math.floor(query.from), Math.floor(query.to))
  if (query.project === undefined) return `${at} >= ? AND ${at} < ?`
  params.push(query.project)
  return `${at} >= ? AND ${at} < ? AND ${alias}.project = COALESCE(${NAME_ID}, -1)`
}

export async function insightQuery(read: InsightRead, query: InsightQuery): Promise<InsightResult> {
  switch (query.by) {
    case 'total':
      return total(read, query)
    case 'project':
      return projects(read, query)
    case 'purpose':
      return purposes(read, query)
    case 'file_hour':
    case 'file_day':
      return fileBuckets(read, query)
    case 'file_read':
    case 'file_edit':
      return files(read, query)
    case 'reread':
      return rereads(read, query)
  }
}

async function total(read: InsightRead, query: InsightQuery): Promise<InsightResult> {
  const sendParams: SqlValue[] = []
  const fileParams: SqlValue[] = []
  const [sends, fileRows] = await Promise.all([
    read(`SELECT ${TOKEN_COLUMNS} FROM sends s WHERE ${where('s', query, sendParams)}`, sendParams),
    // One row per file in the range, then summed: a file's first applied read and change are compared within its own row.
    read(
      `SELECT ${FILE_SUMS.map((_, i) => `TOTAL(g.s${i})`).join(', ')},
        TOTAL(g.s0 > 0), TOTAL(g.s3 > 0), TOTAL(g.created), TOTAL(g.first_read < g.first_change)
      FROM (
        SELECT ${FILE_SUMS.map((sum, i) => `${sum} AS s${i}`).join(', ')},
          MAX(f.op <> ${READ} AND f.outcome = ${OUTCOME_OK} AND f.created = 1) AS created,
          MIN(CASE WHEN f.op = ${READ} AND f.outcome = ${OUTCOME_OK} THEN f.at_ms END) AS first_read,
          MIN(CASE WHEN f.op <> ${READ} AND f.outcome = ${OUTCOME_OK} THEN f.at_ms END) AS first_change
        FROM file_ops f INDEXED BY ${fileIndex(query)}
        WHERE ${where('f', query, fileParams)}
        GROUP BY f.repo, f.path
      ) g`,
      fileParams,
    ),
  ])
  const s = sends.rows[0] ?? []
  const f = fileRows.rows[0] ?? []
  return {
    by: 'total',
    total: {
      ...tokensAt(s, 0),
      ...filesAt(f, 0),
      filesRead: num(f[FILE_SUMS.length]),
      filesChanged: num(f[FILE_SUMS.length + 1]),
      filesCreated: num(f[FILE_SUMS.length + 2]),
      filesReadBeforeChange: num(f[FILE_SUMS.length + 3]),
    },
  }
}

async function projects(read: InsightRead, query: InsightQuery): Promise<InsightResult> {
  const params: SqlValue[] = []
  const sendRange = where('s', query, params)
  const fileRange = where('f', query, params)
  const result = await read(
    `SELECT n.text, SUM(t.c0), SUM(t.c1), SUM(t.c2), SUM(t.c3), SUM(t.c4), SUM(t.c5),
      SUM(t.d0), SUM(t.d1), SUM(t.d2), SUM(t.d3), SUM(t.d4), SUM(t.d5), SUM(t.d6)
    FROM (
      SELECT s.project AS project, COUNT(*) AS c0, SUM(CASE WHEN s.outcome = ${OUTCOME_FAILED} THEN 1 ELSE 0 END) AS c1,
        TOTAL(s.input_tokens) AS c2, TOTAL(s.output_tokens) AS c3, TOTAL(s.cache_read_tokens) AS c4, TOTAL(s.cache_write_tokens) AS c5,
        0 AS d0, 0 AS d1, 0 AS d2, 0 AS d3, 0 AS d4, 0 AS d5, 0 AS d6
      FROM sends s WHERE ${sendRange} GROUP BY s.project
      UNION ALL
      SELECT f.project, 0, 0, 0, 0, 0, 0, ${FILE_COLUMNS}
      FROM file_ops f INDEXED BY ${fileIndex(query)} WHERE ${fileRange} GROUP BY f.project
    ) t LEFT JOIN names n ON n.id = t.project
    GROUP BY t.project
    ORDER BY SUM(t.c2) + SUM(t.c3) + SUM(t.c4) + SUM(t.c5) DESC, SUM(t.d5) DESC, n.text
    LIMIT ${PROJECT_ROWS_MAX + 1}`,
    params,
  )
  const list = result.rows.slice(0, PROJECT_ROWS_MAX).map((row): InsightProject => {
    const project = text(row[0])
    return { ...(project !== undefined ? { project } : {}), ...tokensAt(row, 1), ...filesAt(row, 7) }
  })
  return { by: 'project', projects: list, truncated: result.rows.length > PROJECT_ROWS_MAX }
}

async function purposes(read: InsightRead, query: InsightQuery): Promise<InsightResult> {
  const params: SqlValue[] = []
  const result = await read(
    `SELECT pu.text, so.text, s.agent IS NOT NULL AS sub, ${TOKEN_COLUMNS}
    FROM sends s
      LEFT JOIN names pu ON pu.id = s.purpose
      LEFT JOIN names so ON so.id = s.source
    WHERE ${where('s', query, params)}
    GROUP BY s.purpose, s.source, sub
    ORDER BY pu.text, so.text, sub
    LIMIT ${PURPOSE_ROWS_MAX + 1}`,
    params,
  )
  const list = result.rows.slice(0, PURPOSE_ROWS_MAX).map((row): InsightPurpose => {
    const purpose = text(row[0])
    const source = text(row[1])
    return {
      ...(purpose !== undefined ? { purpose } : {}),
      ...(source !== undefined ? { source } : {}),
      subAgent: num(row[2]) === 1,
      ...tokensAt(row, 3),
    }
  })
  return { by: 'purpose', purposes: list, truncated: result.rows.length > PURPOSE_ROWS_MAX }
}

async function fileBuckets(read: InsightRead, query: InsightQuery): Promise<InsightResult> {
  const unit = query.by === 'file_day' ? DAY_MS : HOUR_MS
  const offsetMs = query.by === 'file_day' ? (query.tzOffsetMinutes ?? 0) * 60_000 : 0
  const params: SqlValue[] = [offsetMs]
  const range = where('f', { ...query, from: Math.floor(query.from / HOUR_MS) * HOUR_MS, to: Math.ceil(query.to / HOUR_MS) * HOUR_MS }, params)
  const result = await read(
    `SELECT ((f.at_ms / ${HOUR_MS}) * ${HOUR_MS} + CAST(? AS INTEGER)) / ${unit} AS bucket, ${FILE_COLUMNS}
    FROM file_ops f INDEXED BY ${fileIndex(query)}
    WHERE ${range}
    GROUP BY bucket ORDER BY bucket`,
    params,
    FILE_BUCKET_ROWS_MAX,
  )
  const buckets = result.rows.map((row): InsightFileBucket => ({ start: num(row[0]) * unit - offsetMs, ...filesAt(row, 1) }))
  return { by: query.by as 'file_hour' | 'file_day', buckets, truncated: result.truncated }
}

async function files(read: InsightRead, query: InsightQuery): Promise<InsightResult> {
  const params: SqlValue[] = []
  const reading = query.by === 'file_read'
  const result = await read(
    `SELECT r.text, p.text, ${FILE_COLUMNS},
      SUM(f.op = ${READ} AND f.partial = 1),
      MAX(CASE WHEN ${WHOLE_READ} THEN f.bytes END)
    FROM file_ops f INDEXED BY ${fileIndex(query)}
      LEFT JOIN names r ON r.id = f.repo
      JOIN names p ON p.id = f.path
    WHERE ${where('f', query, params)}
    GROUP BY f.repo, f.path
    HAVING ${reading ? `SUM(f.op = ${READ}) > 0` : `SUM(f.op <> ${READ}) > 0`}
    ORDER BY ${
      reading
        ? `SUM(f.op = ${READ}) DESC, TOTAL(CASE WHEN f.op = ${READ} THEN f.bytes END) DESC`
        : `TOTAL(CASE WHEN f.op <> ${READ} AND f.outcome = ${OUTCOME_OK} THEN f.added + f.removed END) DESC, SUM(f.op <> ${READ}) DESC`
    }, r.text, p.text
    LIMIT ${FILE_ROWS_MAX}`,
    params,
    FILE_ROWS_MAX,
  )
  const list = result.rows.map((row): InsightFile => {
    const repo = text(row[0])
    return {
      ...(repo !== undefined ? { repo } : {}),
      path: text(row[1]) ?? '',
      ...filesAt(row, 2),
      partialReads: num(row[2 + FILE_SUMS.length]),
      maxReadBytes: num(row[3 + FILE_SUMS.length]),
    }
  })
  return { by: query.by as 'file_read' | 'file_edit', files: list }
}

async function rereads(read: InsightRead, query: InsightQuery): Promise<InsightResult> {
  const params: SqlValue[] = []
  const result = await read(
    `SELECT se.text, r.text, p.text, COUNT(*), TOTAL(f.bytes), TOTAL(f.bytes) - MAX(f.bytes)
    FROM file_ops f INDEXED BY ${fileIndex(query)}
      JOIN names se ON se.id = f.session
      LEFT JOIN names r ON r.id = f.repo
      JOIN names p ON p.id = f.path
    WHERE ${where('f', query, params)} AND ${WHOLE_READ}
    GROUP BY f.session, f.repo, f.path
    HAVING COUNT(*) > 1
    ORDER BY TOTAL(f.bytes) - MAX(f.bytes) DESC, COUNT(*) DESC, p.text
    LIMIT ${FILE_ROWS_MAX}`,
    params,
    FILE_ROWS_MAX,
  )
  const list = result.rows.map((row): InsightReread => {
    const repo = text(row[1])
    return {
      sessionId: text(row[0]) ?? '',
      ...(repo !== undefined ? { repo } : {}),
      path: text(row[2]) ?? '',
      reads: num(row[3]),
      readBytes: num(row[4]),
      extraBytes: num(row[5]),
    }
  })
  return { by: 'reread', rereads: list }
}
