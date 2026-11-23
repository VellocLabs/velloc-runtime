/**
 * Security: the usage log's tables (F-27), one `sends` row per model request,
 * one `file_ops` row per file a file tool touched, and one lookup table for
 * every string. These column lists are everything the file holds: no prompt
 * or reply text, file content, tool argument, header, credential or base URL
 * has a column or may become a lookup string. A lookup string may be a file
 * path or a project root, which can carry an account name.
 */

/** Raised when a later build changes a table; `SCHEMA_STEPS` then carries the
 *  statements that take a file from each older version to the next. */
export const REQUEST_LOG_SCHEMA_VERSION = 2

/** `SCHEMA_STEPS[n]`: the statements that take a version `n` file to `n + 1`. */
export const SCHEMA_STEPS: Readonly<Record<number, readonly string[]>> = {
  1: [
    'ALTER TABLE sends ADD COLUMN project INTEGER',
    'ALTER TABLE sends ADD COLUMN purpose INTEGER',
    'ALTER TABLE sends ADD COLUMN source INTEGER',
    'ALTER TABLE sends ADD COLUMN agent INTEGER',
    'DROP TABLE IF EXISTS hourly',
  ],
}

/** `sends.outcome`. An aborted request (cancelled, or left by its reader) is
 *  not a failure. */
export const OUTCOME_OK = 0
export const OUTCOME_FAILED = 1
export const OUTCOME_ABORTED = 2

/**
 * The detail table's columns, in order. A string column holds a `names.id`.
 * `router`, `router_row`, `from_provider`, `from_model` and `switch_kind` are
 * NULL for a request no router sent or moved; `failure` and `http_status` are
 * NULL unless the provider reported them. `project`, `purpose`, `source` (the
 * caller tag) and `agent` (the loop under the session: a sub-agent or a side
 * run) are NULL when the request did not name them.
 */
export const SEND_COLUMNS = [
  'id',
  'started_ms',
  'duration_ms',
  'session',
  'call_id',
  'hop',
  'provider',
  'model',
  'router',
  'router_row',
  'from_provider',
  'from_model',
  'switch_kind',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'outcome',
  'failure',
  'http_status',
  'project',
  'purpose',
  'source',
  'agent',
] as const

/** `file_ops.op`. */
export const FILE_OP_CODES = { read: 1, edit: 2, write: 3, remove: 4, move: 5 } as const

/**
 * The file table's columns, in order. A string column holds a `names.id`.
 * `project` is the session's project root; `repo` and `path` name the file by
 * its own repository, and `path` is absolute when `repo` is NULL. `bytes` and
 * `lines` are what a read returned; for a change `bytes` is the file's size
 * afterwards. `added` and `removed` count every call, so a change made and
 * undone counts twice.
 */
export const FILE_OP_COLUMNS = [
  'id',
  'at_ms',
  'session',
  'agent',
  'call_id',
  'project',
  'repo',
  'worktree',
  'path',
  'from_path',
  'tool',
  'op',
  'bytes',
  'lines',
  'added',
  'removed',
  'partial',
  'created',
  'outcome',
  'failure',
] as const

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** Created first, alone, so a newer build's file is refused before anything else is written to it. */
export const CREATE_META_SQL = 'CREATE TABLE IF NOT EXISTS log_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)'

export const CREATE_STATEMENTS: readonly string[] = [
  CREATE_META_SQL,
  'CREATE TABLE IF NOT EXISTS names (id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE)',
  `CREATE TABLE IF NOT EXISTS sends (
    id INTEGER PRIMARY KEY,
    started_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    session INTEGER,
    call_id INTEGER NOT NULL,
    hop INTEGER NOT NULL,
    provider INTEGER NOT NULL,
    model INTEGER NOT NULL,
    router INTEGER,
    router_row INTEGER,
    from_provider INTEGER,
    from_model INTEGER,
    switch_kind INTEGER,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    outcome INTEGER NOT NULL,
    failure INTEGER,
    http_status INTEGER,
    project INTEGER,
    purpose INTEGER,
    source INTEGER,
    agent INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS sends_started ON sends (started_ms)',
  `CREATE TABLE IF NOT EXISTS file_ops (
    id INTEGER PRIMARY KEY,
    at_ms INTEGER NOT NULL,
    session INTEGER,
    agent INTEGER,
    call_id INTEGER,
    project INTEGER,
    repo INTEGER,
    worktree INTEGER,
    path INTEGER NOT NULL,
    from_path INTEGER,
    tool INTEGER NOT NULL,
    op INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    lines INTEGER NOT NULL,
    added INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    partial INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL DEFAULT 0,
    outcome INTEGER NOT NULL,
    failure INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS file_ops_at ON file_ops (at_ms)',
  'CREATE INDEX IF NOT EXISTS file_ops_file ON file_ops (repo, path)',
  'CREATE INDEX IF NOT EXISTS file_ops_project ON file_ops (project, at_ms)',
  `INSERT OR IGNORE INTO log_meta (key, value) VALUES ('schema_version', ${REQUEST_LOG_SCHEMA_VERSION})`,
]

export const READ_VERSION_SQL = "SELECT value FROM log_meta WHERE key = 'schema_version'"
export const WRITE_VERSION_SQL = "UPDATE log_meta SET value = ? WHERE key = 'schema_version'"

/** The id of a lookup string; NULL for a NULL parameter. */
export const NAME_ID = '(SELECT id FROM names WHERE text = ?)'

export const INTERN_NAME_SQL = 'INSERT OR IGNORE INTO names (text) VALUES (?)'

/** Parameters, in order: started_ms, duration_ms, session, call_id, hop,
 *  provider, model, router, router_row, from_provider, from_model,
 *  switch_kind, the four token counts, outcome, failure, http_status,
 *  project, purpose, source, agent. */
export const INSERT_SEND_SQL = `INSERT INTO sends (${SEND_COLUMNS.slice(1).join(', ')}) VALUES (
  ?, ?, ${NAME_ID}, ?, ?, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID},
  ?, ?, ?, ?, ?, ${NAME_ID}, ?, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID})`

/** Parameters, in order: at_ms, session, agent, call_id, project, repo, worktree,
 *  path, from_path, tool, op, bytes, lines, added, removed, partial, created,
 *  outcome, failure. */
export const INSERT_FILE_OP_SQL = `INSERT INTO file_ops (${FILE_OP_COLUMNS.slice(1).join(', ')}) VALUES (
  ?, ${NAME_ID}, ${NAME_ID}, ?, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID},
  ?, ?, ?, ?, ?, ?, ?, ?, ${NAME_ID})`

/** Rows of both tables. Only the oldest rows are ever deleted, so the span of
 *  a table's ids is its count. */
export const COUNT_ROWS_SQL = `SELECT
  COALESCE((SELECT MAX(id) - MIN(id) + 1 FROM sends), 0) +
  COALESCE((SELECT MAX(id) - MIN(id) + 1 FROM file_ops), 0)`

/** The time of the oldest row of either table; NULL when both are empty. */
export const OLDEST_ROW_SQL = `SELECT MIN(t) FROM (
  SELECT MIN(started_ms) AS t FROM sends UNION ALL SELECT MIN(at_ms) FROM file_ops)`

/** Each takes one parameter: rows older than it are deleted. */
export const TRIM_STATEMENTS: readonly string[] = [
  'DELETE FROM sends WHERE started_ms < ?',
  'DELETE FROM file_ops WHERE at_ms < ?',
]
