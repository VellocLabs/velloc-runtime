/**
 * The request log's tables (F-27): one `sends` row per model request sent,
 * an hourly rollup beside it, and one lookup table for every string.
 *
 * Security: the column lists below are everything the file holds. No prompt
 * or reply text, tool argument, header, credential, base URL or account name
 * has a column, and none may be added to a lookup string.
 */

/** Raised when a later build changes a table; `SCHEMA_STEPS` then carries the
 *  statements that take a file from each older version to the next. */
export const REQUEST_LOG_SCHEMA_VERSION = 1

/** `SCHEMA_STEPS[n]`: the statements that take a version `n` file to `n + 1`. */
export const SCHEMA_STEPS: Readonly<Record<number, readonly string[]>> = {}

/** `sends.outcome`. An aborted request (cancelled, or left by its reader) is
 *  not a failure. */
export const OUTCOME_OK = 0
export const OUTCOME_FAILED = 1
export const OUTCOME_ABORTED = 2

/**
 * The detail table's columns, in order. A string column holds a `names.id`.
 * `router`, `router_row`, `from_provider`, `from_model` and `switch_kind` are
 * NULL for a request no router sent or moved; `failure` and `http_status` are
 * NULL unless the provider reported them.
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
] as const

/** The rollup's columns, in order. `router` and `router_row` are 0, not NULL,
 *  for a request no router sent: a NULL would not be unique in the key. */
export const HOURLY_COLUMNS = [
  'hour',
  'provider',
  'model',
  'router',
  'router_row',
  'requests',
  'failures',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'switches',
] as const

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

export const CREATE_STATEMENTS: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS log_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
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
    http_status INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS sends_started ON sends (started_ms)',
  `CREATE TABLE IF NOT EXISTS hourly (
    hour INTEGER NOT NULL,
    provider INTEGER NOT NULL,
    model INTEGER NOT NULL,
    router INTEGER NOT NULL DEFAULT 0,
    router_row INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    switches INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, provider, model, router, router_row)
  )`,
  `INSERT OR IGNORE INTO log_meta (key, value) VALUES ('schema_version', ${REQUEST_LOG_SCHEMA_VERSION})`,
]

export const READ_VERSION_SQL = "SELECT value FROM log_meta WHERE key = 'schema_version'"
export const WRITE_VERSION_SQL = "UPDATE log_meta SET value = ? WHERE key = 'schema_version'"

/** The id of a lookup string; NULL for a NULL parameter. */
export const NAME_ID = '(SELECT id FROM names WHERE text = ?)'

export const INTERN_NAME_SQL = 'INSERT OR IGNORE INTO names (text) VALUES (?)'

/** Parameters, in order: started_ms, duration_ms, session, call_id, hop,
 *  provider, model, router, router_row, from_provider, from_model,
 *  switch_kind, the four token counts, outcome, failure, http_status. */
export const INSERT_SEND_SQL = `INSERT INTO sends (${SEND_COLUMNS.slice(1).join(', ')}) VALUES (
  ?, ?, ${NAME_ID}, ?, ?, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID}, ${NAME_ID},
  ?, ?, ?, ?, ?, ${NAME_ID}, ?)`

const HOURLY_KEY = `hour = ? AND provider = ${NAME_ID} AND model = ${NAME_ID}
  AND router = COALESCE(${NAME_ID}, 0) AND router_row = COALESCE(${NAME_ID}, 0)`

/** Parameters: hour, provider, model, router, router_row. */
export const SEED_HOURLY_SQL = `INSERT OR IGNORE INTO hourly (hour, provider, model, router, router_row)
  VALUES (?, ${NAME_ID}, ${NAME_ID}, COALESCE(${NAME_ID}, 0), COALESCE(${NAME_ID}, 0))`

/** Parameters: failures, the four token counts, switches, then the key as in
 *  `SEED_HOURLY_SQL`. */
export const ADD_HOURLY_SQL = `UPDATE hourly SET
  requests = requests + 1,
  failures = failures + ?,
  input_tokens = input_tokens + ?,
  output_tokens = output_tokens + ?,
  cache_read_tokens = cache_read_tokens + ?,
  cache_write_tokens = cache_write_tokens + ?,
  switches = switches + ?
  WHERE ${HOURLY_KEY}`

/** The rollup, computed again from the detail rows. */
export const REBUILD_HOURLY_STATEMENTS: readonly string[] = [
  'DELETE FROM hourly',
  `INSERT INTO hourly (${HOURLY_COLUMNS.join(', ')})
    SELECT started_ms / ${HOUR_MS}, provider, model, COALESCE(router, 0), COALESCE(router_row, 0),
      COUNT(*),
      SUM(CASE WHEN outcome = ${OUTCOME_FAILED} THEN 1 ELSE 0 END),
      SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
      SUM(CASE WHEN from_provider IS NOT NULL THEN 1 ELSE 0 END)
    FROM sends
    GROUP BY started_ms / ${HOUR_MS}, provider, model, COALESCE(router, 0), COALESCE(router_row, 0)`,
]
