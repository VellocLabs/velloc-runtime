import type {
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
} from '../bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../bridge/browserBridgeProtocol'
import type { SqlValue } from '../bridge/protocol/sqlite'
import type { BrowserLlmSelection } from '../bridge/protocol/nexus_llm'
import type {
  BrowserSessionCounters,
  BrowserSessionMetadata,
  SessionMetaFile,
} from '../../sessions/sessionStore'
import {
  isSessionMetaFile,
  SESSION_META_FILE_SCHEMA_VERSION,
} from '../../sessions/sessionStore'
import { dirnameRuntimePath } from '../../utils/runtimePaths'
// The sub-agent id predicate lives with the directory layout it implies
// (`sidechainStoragePaths` imports only `runtimePaths`, so this stays free of
// any worker/services dependency). Sub-agent rows live in the same DB but must
// never surface in the sidebar list (`listAll`).
import { isSubAgentSessionId } from '../../utils/sidechainStoragePaths'

/**
 * Contract: the ONE global SQLite store of every session's `SessionMetaFile`, one typed-column row
 * per session in `session_meta`. `COLUMNS` is the ordered source of truth: the bridge returns rows
 * positionally, so SELECT and INSERT lists must keep its order.
 * Writers in the SharedWorker share one direct port and adapter, whose per-file runner serializes
 * them; separate adapters are not serialized, so `runSqlite` retries on BUSY.
 */

/** Marker recorded in `meta_migrations` once the one-time `meta.json` → sqlite
 *  seed has run for a DB, so later boots skip the scan and read the DB only.
 *  Shared by the grouped router and the flat backend (separate DBs, so the same
 *  name never collides). */
export const SESSION_META_MIGRATION_V1 = 'meta-json-to-sqlite-v1'

/** Boots on which a migration source read may FAIL before the migration stops
 *  waiting for it: the source is then skipped (its row in
 *  `meta_migration_failures` stays as the record of what was left behind) and
 *  the done-marker may be written. Below the limit the marker is withheld so
 *  the next boot retries the read. */
export const MIGRATION_READ_FAILURE_LIMIT = 3

/** How many deleted session ids the store remembers to reject late writes for.
 *  Mirrors `BridgeFsConversationStorageBackend`'s tombstone bound. */
const MAX_DELETED_SESSION_TOMBSTONES = 1024

/**
 * Lock retry: writers on another adapter (a worktree sub-agent) contend on the same
 * `sessions.sqlite`. Retry with backoff; a read that still fails throws ("couldn't read", not "no rows"). */
const SQLITE_LOCK_RETRIES = 6
const SQLITE_LOCK_BACKOFF_MS = 25

/** True for a transient lock/contention failure worth retrying — a busy/locked
 *  code, or the plain `SQLITE_ERROR: database is locked` the host emits for
 *  cross-adapter contention. A contended-open `SQLITE_CANTOPEN` is ALSO
 *  transient, but it is handled separately (`runSqlite`'s `retryOpen`) because
 *  it is ambiguous: for a WRITE, or a READ once the schema is up, it is a
 *  contended open worth retrying; for a READ before that it means "no DB
 *  yet", which `query` reads as "no rows" so a fresh profile does not pay the
 *  backoff. Everything else here (syntax, constraint) is a real error. */
function isLockError(error: { code: string; message: string }): boolean {
  return (
    error.code === 'SQLITE_BUSY' ||
    error.code === 'SQLITE_LOCKED' ||
    // A COMMIT that loses a race reports this rather than a busy code, and it
    // is the same transient contention: the host could not get the reserved
    // lock at commit time. Team sessions made this reachable in practice — a
    // lead and each of its children write session meta independently — and
    // without it the failure surfaced as a failed TURN. Retrying a genuinely
    // permanent commit failure costs one bounded backoff and then reports the
    // same error, which is the trade the clauses above already make.
    /database is locked|database table is locked|failed to commit transaction/i.test(
      error.message,
    )
  )
}

/**
 * Ordered column list — the contract for positional row mapping. Adding a
 * `SessionMetaFile` field later is one entry here + one line in each of
 * `metaToRow`/`rowToMeta`; `ensureSchema` adds the column to existing DBs.
 */
const COLUMNS = [
  'session_id',
  'schema_version',
  'updated_at',
  'custom_title',
  'custom_title_at',
  'ai_title',
  'first_prompt',
  'preview_text',
  'template_type',
  'project_root',
  'message_count',
  'leaf_uuid',
  'permission_mode',
  'forked_from_session_id',
  'composer_draft',
  'last_composer_edit_at',
  'last_terminal_reason',
  'last_terminal_timestamp',
  'llm_provider_id',
  'llm_model_id',
  'llm_thinking_tier',
  'counter_tool',
  'counter_tool_fail',
  'counter_mcp',
  'counter_mcp_fail',
  // Routing ground truth — the resolved project DIRECTORY the session's
  // transcript lives under (`~/.velloc/projects/<projectFolderKey(projectRoot)>`).
  // Distinct from `project_root`: the old runtime NEVER persisted `projectRoot`
  // to `meta.json`, and `projectFolderKey` is lossy (every non-alnum char → `-`),
  // so the folder can't be reversed to a `projectRoot`. The folder itself is
  // therefore the ONLY durable routing key for a session that predates
  // projectRoot persistence — the migration records the scanned folder here.
  // Routing prefers `project_root` when present (live/re-bound), else this.
  'project_dir',
  // JSON of every open `metadata` key without a dedicated column, so the round-trip is lossless.
  // Plain TEXT + JS `JSON` (the host has `SQLITE_OMIT_JSON`); overwritten on every write.
  'extra_metadata',
  // Team sessions. APPEND-ONLY, and these two must stay LAST: `rowToMeta`
  // reads the block above by hard-coded index, so inserting anywhere earlier
  // silently shifts every field after it.
  'parent_session_id',
  'teammate_name',
  'shutdown',
  'shutdown_at',
] as const

/** SQLite column type per `COLUMNS` entry, used to build the CREATE TABLE and
 *  the `ALTER TABLE ADD COLUMN` reconciliation. */
const COLUMN_DEFS: Record<(typeof COLUMNS)[number], string> = {
  session_id: 'TEXT PRIMARY KEY',
  schema_version: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL DEFAULT 0',
  custom_title: 'TEXT',
  custom_title_at: 'INTEGER',
  ai_title: 'TEXT',
  first_prompt: 'TEXT',
  preview_text: 'TEXT',
  template_type: 'TEXT',
  project_root: 'TEXT',
  message_count: 'INTEGER',
  leaf_uuid: 'TEXT',
  permission_mode: 'TEXT',
  forked_from_session_id: 'TEXT',
  composer_draft: 'TEXT',
  last_composer_edit_at: 'INTEGER',
  last_terminal_reason: 'TEXT',
  last_terminal_timestamp: 'INTEGER',
  llm_provider_id: 'TEXT',
  llm_model_id: 'TEXT',
  llm_thinking_tier: 'TEXT',
  counter_tool: 'INTEGER',
  counter_tool_fail: 'INTEGER',
  counter_mcp: 'INTEGER',
  counter_mcp_fail: 'INTEGER',
  project_dir: 'TEXT',
  extra_metadata: 'TEXT',
  parent_session_id: 'TEXT',
  teammate_name: 'TEXT',
  shutdown: 'INTEGER',
  shutdown_at: 'INTEGER',
}

/**
 * `metadata` keys that HAVE a dedicated column (so they never go into the
 * `extra_metadata` JSON catch-all). `customTitle` is excluded from BOTH — it is
 * a read-time projection (`resolveSessionTitle`) rebuilt from `custom_title` /
 * `ai_title`, never persisted inside `metadata`. Everything else on the OPEN
 * `BrowserSessionMetadata` (`importedFrom`, `extraMetadata`, …) rides
 * `extra_metadata`.
 */
const COLUMN_METADATA_KEYS: ReadonlySet<string> = new Set([
  'firstPrompt',
  'previewText',
  'templateType',
  'projectRoot',
  'messageCount',
  'leafUuid',
  'permissionMode',
  'forkedFromSessionId',
  'composerDraft',
  'lastComposerEditAt',
  'lastTerminalReason',
  'lastTerminalTimestamp',
  'llmSelection',
  'counters',
  'customTitle',
  'spawnerSessionId',
  'teammateName',
  'shutdown',
  'shutdownAt',
])

/** Position of `project_dir` in `COLUMNS` — read out of a positional row
 *  alongside the reconstructed `SessionMetaFile` (which does not carry it). */
const PROJECT_DIR_INDEX = COLUMNS.indexOf('project_dir')
const EXTRA_METADATA_INDEX = COLUMNS.indexOf('extra_metadata')
const PARENT_SESSION_ID_INDEX = COLUMNS.indexOf('parent_session_id')
const TEAMMATE_NAME_INDEX = COLUMNS.indexOf('teammate_name')
const SHUTDOWN_INDEX = COLUMNS.indexOf('shutdown')
const SHUTDOWN_AT_INDEX = COLUMNS.indexOf('shutdown_at')

const COLUMN_LIST = COLUMNS.join(', ')
const PLACEHOLDERS = COLUMNS.map(() => '?').join(', ')
/**
 * UPDATE assignments for `upsertMeta`: every non-key column, except `project_dir` is kept when the
 * write omits it; `UPDATE_SQL_KEEP_EXTRA` also keeps `extra_metadata` when it failed to serialize.
 * UPDATE-then-INSERT, not UPSERT: the host's SQLite has `SQLITE_OMIT_UPSERT`.
 */
const PRESERVE_ON_OMIT: ReadonlySet<string> = new Set(['project_dir'])
const PRESERVE_ON_OMIT_KEEP_EXTRA: ReadonlySet<string> = new Set([
  ...PRESERVE_ON_OMIT,
  'extra_metadata',
])
function buildUpdateSet(preserve: ReadonlySet<string>): string {
  return COLUMNS.filter(c => c !== 'session_id')
    .map(c => (preserve.has(c) ? `${c}=COALESCE(?, ${c})` : `${c}=?`))
    .join(', ')
}
const UPDATE_SET = buildUpdateSet(PRESERVE_ON_OMIT)
const UPDATE_SET_KEEP_EXTRA = buildUpdateSet(PRESERVE_ON_OMIT_KEEP_EXTRA)

const CREATE_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS session_meta (\n  ` +
  COLUMNS.map(c => `${c} ${COLUMN_DEFS[c]}`).join(',\n  ') +
  `\n)`
const CREATE_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_session_meta_updated_at ON session_meta(updated_at)'
const CREATE_MIGRATIONS_SQL =
  'CREATE TABLE IF NOT EXISTS meta_migrations (name TEXT PRIMARY KEY)'
/** Per-migration count of boots on which a source file's read failed (see
 *  `MIGRATION_READ_FAILURE_LIMIT`). A row at or past the limit is a SKIPPED
 *  source, kept so it is never silently lost. */
const CREATE_MIGRATION_FAILURES_SQL =
  'CREATE TABLE IF NOT EXISTS meta_migration_failures (' +
  'migration TEXT NOT NULL, path TEXT NOT NULL, failures INTEGER NOT NULL, ' +
  'PRIMARY KEY (migration, path))'

/** `upsertMeta` update leg (see `UPDATE_SET`). */
const UPDATE_SQL = `UPDATE session_meta SET ${UPDATE_SET} WHERE session_id = ?`
/** The update leg for a write whose `extra_metadata` failed to serialize —
 *  preserves the stored blob instead of nulling it (see `UPDATE_SET`). */
const UPDATE_SQL_KEEP_EXTRA = `UPDATE session_meta SET ${UPDATE_SET_KEEP_EXTRA} WHERE session_id = ?`
/** Row-materializing leg of BOTH the migration seed AND `upsertMeta` (via
 *  `writeRow`): `INSERT OR IGNORE` creates the row when absent and is a no-op
 *  when it exists, so a live write never clobbers a fresher row's routing and
 *  never needs SQLite UPSERT. */
const SEED_SQL =
  `INSERT OR IGNORE INTO session_meta (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`
const SELECT_ONE_SQL = `SELECT ${COLUMN_LIST} FROM session_meta WHERE session_id = ?`
const SELECT_ALL_SQL = `SELECT ${COLUMN_LIST} FROM session_meta`
const DELETE_SQL = 'DELETE FROM session_meta WHERE session_id = ?'
const DELETE_BY_PARENT_SQL =
  'DELETE FROM session_meta WHERE parent_session_id = ?'

/** `undefined`/non-string → null; a stored value stays a string. */
function toText(value: string | undefined | null): SqlValue {
  return typeof value === 'string' ? value : null
}
/** `undefined`/non-finite → null; a finite number stays a number. */
function toInt(value: number | undefined | null): SqlValue {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
/** SqlValue → string | undefined (null and the `{$int}`/`{$blob}` tagged forms,
 *  which our columns never store, read as undefined). */
function readText(value: SqlValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function readInt(value: SqlValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

type MetaWriteJob = {
  meta: SessionMetaFile
  /** Routing dir to record, or undefined to preserve the stored one (COALESCE). */
  projectDir: string | undefined
  started: boolean
  promise: Promise<void>
}

/** A session's stored meta plus its routing dir (the `project_dir` column,
 *  which the reconstructed `SessionMetaFile` does not carry). */
export type StoredSessionMeta = {
  meta: SessionMetaFile
  /** The resolved project dir the migration recorded, or undefined for a
   *  session that persists its `projectRoot`/`templateType` instead. */
  projectDir?: string
}

type BridgeResponse<C extends BrowserBridgeCapability, A extends BrowserBridgeAction<C>> =
  | { ok: true; result: BrowserBridgeResult<C, A> }
  | { ok: false; error: { code: string; message: string } }

export type SqliteSessionMetaStoreOptions = {
  transport: BrowserBridgeTransport
  /** Full path to the single DB file (`getSessionMetaDbPath(root)`). */
  dbPath: string
  createRequestId?: () => string
}

export class SqliteSessionMetaStore {
  private readonly transport: BrowserBridgeTransport
  private readonly dbPath: string
  private readonly createRequestId: () => string
  private schemaReady?: Promise<void>
  /**
   * True once `runSchema` has completed at least once — the `rwc` DDL batch
   * CREATED the file if it was absent, so from here on the DB is known to
   * exist and a `SQLITE_CANTOPEN` on a read can only be a contended open (the
   * host reports every failed `Open()` as CANTOPEN), never "no DB yet".
   * `query` keys its CANTOPEN handling on this: retry-then-throw after,
   * "no rows" before.
   */
  private dbKnownToExist = false
  /** Sessions deleted through this store — a late `upsertMeta` for one is
   *  dropped, so a fire-and-forget write can't resurrect a globally-visible
   *  sidebar row after a delete. */
  private readonly deletedSessions = new Set<string>()
  /**
   * Per-session latest-wins write coalescing: a write not yet started is REPLACED by the next, and
   * every caller receives the landing promise of the write carrying its state.
   */
  private readonly metaWrites = new Map<string, MetaWriteJob>()
  private readonly metaWriteTails = new Map<string, Promise<void>>()

  constructor(options: SqliteSessionMetaStoreOptions) {
    this.transport = options.transport
    this.dbPath = options.dbPath
    this.createRequestId =
      options.createRequestId ??
      (() => globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}`)
  }

  /** The session's meta, or null when the row is missing / torn / another
   *  session's. A read that FAILS (BUSY, corrupt) throws — callers must not
   *  mistake "could not read now" for "no row" and rebuild over it
   *  (F-17). */
  async readMeta(sessionId: string): Promise<SessionMetaFile | null> {
    return (await this.readStoredMeta(sessionId))?.meta ?? null
  }

  /** As `readMeta`, but also returns the stored routing dir (`project_dir`) so
   *  the router can restore a projectRoot-less session's folder. */
  async readStoredMeta(sessionId: string): Promise<StoredSessionMeta | null> {
    await this.ensureSchema()
    const rows = await this.query(SELECT_ONE_SQL, [sessionId])
    const row = rows[0]
    if (!row) return null
    const meta = this.rowToMeta(sessionId, row)
    if (!meta) return null
    return { meta, projectDir: readText(row[PROJECT_DIR_INDEX]) }
  }

  /** Replace (insert or update) a session's meta. Tombstone-guarded and
   *  coalesced per session (latest wins) — see `metaWrites`. `projectDir` is
   *  optional: omit it (the common live write) and the stored routing dir is
   *  preserved via COALESCE; pass it to record/relocate the folder. */
  upsertMeta(
    sessionId: string,
    meta: SessionMetaFile,
    projectDir?: string,
  ): Promise<void> {
    if (this.deletedSessions.has(sessionId)) {
      return Promise.resolve()
    }
    const queued = this.metaWrites.get(sessionId)
    if (queued && !queued.started) {
      // Fold into the pending write: it has not read `meta` yet.
      queued.meta = meta
      // Keep any dir the pending write already carried if this one omits it.
      queued.projectDir = projectDir ?? queued.projectDir
      return queued.promise
    }
    const job: MetaWriteJob = {
      meta,
      projectDir,
      started: false,
      promise: Promise.resolve(),
    }
    const previous = this.metaWriteTails.get(sessionId) ?? Promise.resolve()
    job.promise = previous.then(async () => {
      job.started = true
      if (this.metaWrites.get(sessionId) === job) {
        this.metaWrites.delete(sessionId)
      }
      if (this.deletedSessions.has(sessionId)) {
        return
      }
      await this.ensureSchema()
      await this.writeRow(sessionId, job.meta, job.projectDir)
    })
    this.metaWrites.set(sessionId, job)
    // The STORED tail never rejects, so one failed write can't poison later
    // writes for this session; callers still get the real promise.
    this.metaWriteTails.set(sessionId, job.promise.catch(() => {}))
    return job.promise
  }

  /** Seed a row ONLY if absent (`INSERT OR IGNORE`) — the one-time migration
   *  from legacy `meta.json`, which must never clobber a fresher live write.
   *  `projectDir` is the scanned folder the winning copy lived in — the routing
   *  key for a session that never persisted its `projectRoot`. */
  async seedMeta(
    sessionId: string,
    meta: SessionMetaFile,
    projectDir?: string,
  ): Promise<void> {
    if (this.deletedSessions.has(sessionId)) {
      return
    }
    await this.ensureSchema()
    const { row } = this.metaToRow(sessionId, meta, projectDir)
    try {
      await this.execute(SEED_SQL, row, {
        shouldAbort: () => this.deletedSessions.has(sessionId),
      })
    } catch (error) {
      // A delete that landed mid-retry: the seed is DROPPED, not failed.
      if (this.deletedSessions.has(sessionId)) return
      throw error
    }
  }

  /**
   * Insert-or-update ONE row: `INSERT OR IGNORE` then `UPDATE` (no UPSERT, no `rowsAffected` read).
   * The tombstone is re-checked before EVERY lock retry, so a delete is never undone by a retry.
   */
  private async writeRow(
    sessionId: string,
    meta: SessionMetaFile,
    projectDir: string | undefined,
  ): Promise<void> {
    const { row, extraJsonFailed } = this.metaToRow(sessionId, meta, projectDir)
    // ONE atomic batch (single DB open + one transaction), not two separate
    // `execute` opens: it halves the file-lock footprint that contends with a
    // worktree sub-agent's concurrent write (the "database is locked" path), and
    // makes SEED+UPDATE indivisible so a delete can't slip between them.
    try {
      await this.batch(
        [
          { sql: SEED_SQL, params: row },
          {
            sql: extraJsonFailed ? UPDATE_SQL_KEEP_EXTRA : UPDATE_SQL,
            params: [...row.slice(1), row[0]!],
          },
        ],
        { shouldAbort: () => this.deletedSessions.has(sessionId) },
      )
    } catch (error) {
      // A delete that landed mid-retry: the write is DROPPED (exactly as if
      // the tombstone had been there up front), not surfaced as a failure.
      if (this.deletedSessions.has(sessionId)) return
      throw error
    }
  }

  async deleteMeta(sessionId: string): Promise<void> {
    // Tombstone BEFORE the delete so a write already queued (but not started)
    // is dropped rather than resurrecting the row.
    this.rememberDeleted(sessionId)
    this.metaWrites.delete(sessionId)
    this.metaWriteTails.delete(sessionId)
    await this.ensureSchema()
    await this.execute(DELETE_SQL, [sessionId])
  }

  /** Cascade: drop every child row of a deleted lead. The lead's directory
   *  delete already sweeps the children's FILES (they are nested under it);
   *  without this their rows would leak — never listed (hidden by their absent
   *  parent) but never removed either. */
  async deleteMetaByParent(spawnerSessionId: string): Promise<void> {
    await this.ensureSchema()
    await this.execute(DELETE_BY_PARENT_SQL, [spawnerSessionId])
  }

  /** Every session's meta in one query — the sidebar's whole read. Sub-agent
   *  rows are filtered out (they live in the DB but never list). Each entry
   *  carries its stored routing dir (`project_dir`) so the router can restore a
   *  projectRoot-less session's folder without a per-folder scan. */
  async listAll(): Promise<Array<{ sessionId: string } & StoredSessionMeta>> {
    await this.ensureSchema()
    const rows = await this.query(SELECT_ALL_SQL, [])
    const out: Array<{ sessionId: string } & StoredSessionMeta> = []
    for (const row of rows) {
      const sessionId = readText(row[0])
      if (!sessionId || isSubAgentSessionId(sessionId)) {
        continue
      }
      const meta = this.rowToMeta(sessionId, row)
      if (meta) {
        out.push({ sessionId, meta, projectDir: readText(row[PROJECT_DIR_INDEX]) })
      }
    }
    return out
  }

  async hasMigration(name: string): Promise<boolean> {
    await this.ensureSchema()
    const rows = await this.query(
      'SELECT 1 FROM meta_migrations WHERE name = ?',
      [name],
    )
    return rows.length > 0
  }

  async markMigration(name: string): Promise<void> {
    await this.ensureSchema()
    await this.execute(
      'INSERT OR IGNORE INTO meta_migrations (name) VALUES (?)',
      [name],
    )
  }

  /**
   * Count one more failed boot against each path whose read failed THIS run,
   * and split them: `pending` paths are still under
   * `MIGRATION_READ_FAILURE_LIMIT` (the caller must withhold its done-marker
   * so the next boot retries them); `skipped` paths have now failed on that
   * many boots and no longer hold the marker — their rows stay in the table as
   * the record of what the migration left behind. Call at most once per run.
   */
  async noteMigrationReadFailures(
    name: string,
    paths: Iterable<string>,
  ): Promise<{ pending: string[]; skipped: string[] }> {
    const unique = [...new Set(paths)]
    if (unique.length === 0) return { pending: [], skipped: [] }
    const prior = await this.readMigrationFailures(name)
    const counts = unique.map(path => ({
      path,
      failures: (prior.get(path) ?? 0) + 1,
    }))
    await this.recordMigrationFailures(name, counts)
    const pending: string[] = []
    const skipped: string[] = []
    for (const { path, failures } of counts) {
      ;(failures >= MIGRATION_READ_FAILURE_LIMIT ? skipped : pending).push(path)
    }
    return { pending, skipped }
  }

  /** `path → failed boots` for one migration's source reads. */
  async readMigrationFailures(name: string): Promise<Map<string, number>> {
    await this.ensureSchema()
    const rows = await this.query(
      'SELECT path, failures FROM meta_migration_failures WHERE migration = ?',
      [name],
    )
    const out = new Map<string, number>()
    for (const row of rows) {
      const path = readText(row[0])
      if (path) out.set(path, readInt(row[1]) ?? 0)
    }
    return out
  }

  /** Store each path's ABSOLUTE failed-boot count, in one transaction. No
   *  UPSERT on the host's SQLite — INSERT OR IGNORE, then UPDATE. */
  async recordMigrationFailures(
    name: string,
    counts: ReadonlyArray<{ path: string; failures: number }>,
  ): Promise<void> {
    if (counts.length === 0) return
    await this.ensureSchema()
    await this.batch(
      counts.flatMap(({ path, failures }) => [
        {
          sql:
            'INSERT OR IGNORE INTO meta_migration_failures ' +
            '(migration, path, failures) VALUES (?, ?, 0)',
          params: [name, path],
        },
        {
          sql:
            'UPDATE meta_migration_failures SET failures = ? ' +
            'WHERE migration = ? AND path = ?',
          params: [failures, name, path],
        },
      ]),
    )
  }

  // --- schema ---------------------------------------------------------------

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.runSchema().catch(error => {
        // A failed bring-up must not memoize — the next call retries.
        this.schemaReady = undefined
        throw error
      })
    }
    return this.schemaReady
  }

  private async runSchema(): Promise<void> {
    // `rwc` creates the DB file but not its parent dir; the host's mkdir is
    // recursive (same call `ensureBaseDir` relies on).
    await this.rawRequest(createBridgeRoute('fs', 'mkdir'), {
      path: dirnameRuntimePath(this.dbPath),
    })
    const batch = await this.runSqlite(
      createBridgeRoute('sqlite', 'batch'),
      {
        path: this.dbPath,
        mode: 'rwc',
        atomic: true,
        statements: [
          { sql: CREATE_TABLE_SQL },
          { sql: CREATE_INDEX_SQL },
          { sql: CREATE_MIGRATIONS_SQL },
          { sql: CREATE_MIGRATION_FAILURES_SQL },
        ],
      },
      { retryOpen: true },
    )
    if (!batch.ok) {
      throw new Error(`${batch.error.code}: ${batch.error.message}`)
    }
    await this.reconcileColumns()
    this.dbKnownToExist = true
  }

  /** Add any `COLUMNS` entry a pre-existing (older-schema) DB lacks. SQLite has
   *  no `ADD COLUMN IF NOT EXISTS`, so diff against `PRAGMA table_info`. */
  private async reconcileColumns(): Promise<void> {
    const info = await this.runSqlite(createBridgeRoute('sqlite', 'query'), {
      path: this.dbPath,
      sql: 'PRAGMA table_info(session_meta)',
      mode: 'ro',
    })
    if (!info.ok) {
      throw new Error(`${info.error.code}: ${info.error.message}`)
    }
    // PRAGMA table_info rows: (cid, name, type, notnull, dflt_value, pk) —
    // column NAME is index 1.
    const existing = new Set(
      info.result.rows.map(row => readText(row[1])).filter(Boolean),
    )
    for (const column of COLUMNS) {
      if (existing.has(column)) {
        continue
      }
      // A freshly created table already has every column, so this only fires
      // for a DB written by an older version of this store.
      const add = await this.runSqlite(
        createBridgeRoute('sqlite', 'execute'),
        {
          path: this.dbPath,
          mode: 'rw',
          sql: `ALTER TABLE session_meta ADD COLUMN ${column} ${COLUMN_DEFS[column]}`,
        },
        { retryOpen: true },
      )
      if (!add.ok) {
        throw new Error(`${add.error.code}: ${add.error.message}`)
      }
    }
  }

  // --- column <-> SessionMetaFile mapping -----------------------------------

  /** The positional row (COLUMNS order) plus whether the open-key blob could
   *  not be serialized — `writeRow` then preserves the stored `extra_metadata`
   *  instead of nulling it (`UPDATE_SQL_KEEP_EXTRA`). */
  private metaToRow(
    sessionId: string,
    meta: SessionMetaFile,
    projectDir?: string,
  ): { row: SqlValue[]; extraJsonFailed: boolean } {
    const m = meta.metadata ?? {}
    const llm = m.llmSelection ?? null
    const counters = m.counters
    // Every OPEN metadata key without a dedicated column (importedFrom,
    // extraMetadata, …) is preserved as JSON in `extra_metadata` so the
    // round-trip is lossless. Empty → null (no blob for the common case).
    const extra: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(m)) {
      if (!COLUMN_METADATA_KEYS.has(key) && value !== undefined) {
        extra[key] = value
      }
    }
    // Guard the stringify: a non-serializable open value (BigInt, circular ref)
    // must not throw and take the WHOLE meta write down with it. On failure the
    // extra blob is omitted AND flagged: a NULL alone would read as "no open
    // keys" and the UPDATE would wipe the stored blob — the flag makes
    // `writeRow` use the COALESCE form so the prior one is kept while the
    // known columns still persist.
    let extraJson: string | undefined
    let extraJsonFailed = false
    if (Object.keys(extra).length > 0) {
      try {
        extraJson = JSON.stringify(extra)
      } catch {
        extraJson = undefined
        extraJsonFailed = true
      }
    }
    // `metadata.customTitle` is deliberately NOT stored — it is a read-time
    // projection (resolveSessionTitle) rebuilt from custom_title/ai_title.
    const row: SqlValue[] = [
      sessionId,
      toInt(meta.schemaVersion),
      toInt(meta.updatedAt),
      toText(meta.customTitle),
      toInt(meta.customTitleAt),
      toText(meta.aiTitle),
      toText(m.firstPrompt),
      toText(m.previewText),
      toText(m.templateType),
      toText(m.projectRoot),
      toInt(m.messageCount),
      toText(m.leafUuid ?? undefined),
      toText(m.permissionMode),
      toText(m.forkedFromSessionId),
      toText(m.composerDraft),
      toInt(m.lastComposerEditAt),
      toText(m.lastTerminalReason),
      toInt(m.lastTerminalTimestamp),
      toText(llm?.providerId),
      toText(llm?.modelId),
      toText(llm?.thinkingTier),
      toInt(counters?.tool),
      toInt(counters?.toolFail),
      toInt(counters?.mcp),
      toInt(counters?.mcpFail),
      toText(projectDir),
      toText(extraJson),
      toText(m.spawnerSessionId),
      toText(m.teammateName),
      m.shutdown === true ? 1 : null,
      toInt(m.shutdownAt),
    ]
    return { row, extraJsonFailed }
  }

  /** Rebuild a `SessionMetaFile` from a positional row (COLUMNS order), setting
   *  only the fields whose column is non-null, then validate with
   *  `isSessionMetaFile` so a torn/foreign row → null (same as a bad blob). */
  private rowToMeta(sessionId: string, row: SqlValue[]): SessionMetaFile | null {
    const metadata: BrowserSessionMetadata = {}
    // Open metadata keys FIRST (from the JSON catch-all), so the typed columns
    // below win on any overlap. A torn/foreign JSON blob is ignored (best-effort
    // — the row's typed fields still reconstruct).
    const extraRaw = readText(row[EXTRA_METADATA_INDEX])
    if (extraRaw) {
      try {
        const parsed: unknown = JSON.parse(extraRaw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (!COLUMN_METADATA_KEYS.has(key) && value !== undefined) {
              metadata[key] = value
            }
          }
        }
      } catch {
        // ignore a corrupt blob — typed columns are authoritative
      }
    }
    const set = <K extends keyof BrowserSessionMetadata>(
      key: K,
      value: BrowserSessionMetadata[K] | undefined,
    ) => {
      if (value !== undefined) {
        metadata[key] = value
      }
    }
    set('firstPrompt', readText(row[6]))
    set('previewText', readText(row[7]))
    set('templateType', readText(row[8]))
    set('projectRoot', readText(row[9]))
    set('messageCount', readInt(row[10]))
    set('leafUuid', readText(row[11]))
    set('permissionMode', readText(row[12]))
    set('forkedFromSessionId', readText(row[13]))
    set('composerDraft', readText(row[14]))
    set('lastComposerEditAt', readInt(row[15]))
    set('lastTerminalReason', readText(row[16]))
    set('lastTerminalTimestamp', readInt(row[17]))
    // Appended columns — read by name-derived index, not a literal (see COLUMNS).
    set('spawnerSessionId', readText(row[PARENT_SESSION_ID_INDEX]))
    set('teammateName', readText(row[TEAMMATE_NAME_INDEX]))
    if (readInt(row[SHUTDOWN_INDEX]) === 1) metadata.shutdown = true
    set('shutdownAt', readInt(row[SHUTDOWN_AT_INDEX]))

    const providerId = readText(row[18])
    const modelId = readText(row[19])
    if (providerId !== undefined && modelId !== undefined) {
      const thinkingTier = readText(row[20])
      const llmSelection: BrowserLlmSelection = { providerId, modelId }
      if (thinkingTier !== undefined) {
        llmSelection.thinkingTier = thinkingTier
      }
      metadata.llmSelection = llmSelection
    }

    const tool = readInt(row[21])
    const toolFail = readInt(row[22])
    const mcp = readInt(row[23])
    const mcpFail = readInt(row[24])
    if (
      tool !== undefined ||
      toolFail !== undefined ||
      mcp !== undefined ||
      mcpFail !== undefined
    ) {
      const counters: BrowserSessionCounters = {
        tool: tool ?? 0,
        toolFail: toolFail ?? 0,
        mcp: mcp ?? 0,
        mcpFail: mcpFail ?? 0,
      }
      metadata.counters = counters
    }

    const meta: SessionMetaFile = {
      schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
      sessionId,
      updatedAt: readInt(row[2]) ?? 0,
      metadata,
    }
    const customTitle = readText(row[3])
    if (customTitle !== undefined) {
      meta.customTitle = customTitle
    }
    const customTitleAt = readInt(row[4])
    if (customTitleAt !== undefined) {
      meta.customTitleAt = customTitleAt
    }
    const aiTitle = readText(row[5])
    if (aiTitle !== undefined) {
      meta.aiTitle = aiTitle
    }
    return isSessionMetaFile(meta, sessionId) ? meta : null
  }

  // --- transport ------------------------------------------------------------

  private rememberDeleted(sessionId: string): void {
    this.deletedSessions.add(sessionId)
    while (this.deletedSessions.size > MAX_DELETED_SESSION_TOMBSTONES) {
      const oldest = this.deletedSessions.values().next()
      if (oldest.done) break
      this.deletedSessions.delete(oldest.value)
    }
  }

  /** One-shot SELECT; BUSY is retried, other failures propagate (a failed read is not "no rows").
   *  `SQLITE_CANTOPEN` reads as "no rows" before the schema is up, and is retried, then thrown, after. */
  private async query(sql: string, params: SqlValue[]): Promise<SqlValue[][]> {
    const res = await this.runSqlite(
      createBridgeRoute('sqlite', 'query'),
      {
        path: this.dbPath,
        sql,
        params,
        mode: 'ro',
      },
      { retryOpen: this.dbKnownToExist },
    )
    if (!res.ok) {
      if (res.error.code === 'SQLITE_CANTOPEN' && !this.dbKnownToExist) {
        return []
      }
      throw new Error(`${res.error.code}: ${res.error.message}`)
    }
    return res.result.rows
  }

  /** Run several statements in ONE atomic transaction (one DB open). Used by
   *  `writeRow` so INSERT-OR-IGNORE + UPDATE land together and hold the file
   *  lock once, not twice. Throws on error (lock AND contended-open retried in
   *  `runSqlite` via `retryOpen` — a write's open must not fail the turn). */
  private async batch(
    statements: Array<{ sql: string; params?: SqlValue[] }>,
    opts?: { shouldAbort?: () => boolean },
  ): Promise<void> {
    const res = await this.runSqlite(
      createBridgeRoute('sqlite', 'batch'),
      {
        path: this.dbPath,
        mode: 'rwc',
        atomic: true,
        statements,
      },
      { retryOpen: true, shouldAbort: opts?.shouldAbort },
    )
    if (!res.ok) {
      throw new Error(`${res.error.code}: ${res.error.message}`)
    }
  }

  /** Run a write (INSERT OR IGNORE / UPDATE / DELETE / DDL). Throws on error;
   *  the reported `rowsAffected` is intentionally unused — `writeRow` is
   *  INSERT-OR-IGNORE-then-UPDATE precisely so it never has to trust it (the
   *  native one-shot bridge does not reliably report 0 changes). */
  private async execute(
    sql: string,
    params: SqlValue[],
    opts?: { shouldAbort?: () => boolean },
  ): Promise<void> {
    const res = await this.runSqlite(
      createBridgeRoute('sqlite', 'execute'),
      {
        path: this.dbPath,
        sql,
        params,
        mode: 'rwc',
      },
      { retryOpen: true, shouldAbort: opts?.shouldAbort },
    )
    if (!res.ok) {
      throw new Error(`${res.error.code}: ${res.error.message}`)
    }
  }

  /** A sqlite request with bounded retry of lock errors. `retryOpen` also retries `SQLITE_CANTOPEN`
   *  (the host reports a contended open that way). `shouldAbort` is checked before every retry;
   *  on abort the last failed response is returned. */
  private async runSqlite<A extends BrowserBridgeAction<'sqlite'>>(
    route: BrowserBridgeRoute<'sqlite', A>,
    payload: BrowserBridgeRequestPayload<'sqlite', A>,
    opts?: { retryOpen?: boolean; shouldAbort?: () => boolean },
  ): Promise<BridgeResponse<'sqlite', A>> {
    const retryable = (error: { code: string; message: string }): boolean =>
      isLockError(error) ||
      (opts?.retryOpen === true && error.code === 'SQLITE_CANTOPEN')
    let res = await this.rawRequest(route, payload)
    for (
      let attempt = 1;
      attempt <= SQLITE_LOCK_RETRIES && !res.ok && retryable(res.error);
      attempt += 1
    ) {
      if (opts?.shouldAbort?.()) break
      await sleep(SQLITE_LOCK_BACKOFF_MS * attempt)
      // Re-check AFTER the backoff too — that is the window a delete lands in.
      if (opts?.shouldAbort?.()) break
      res = await this.rawRequest(route, payload)
    }
    return res
  }

  private async rawRequest<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    route: BrowserBridgeRoute<C, A>,
    payload: BrowserBridgeRequestPayload<C, A>,
  ): Promise<BridgeResponse<C, A>> {
    return (await this.transport.request({
      id: this.createRequestId(),
      route,
      payload,
    })) as BridgeResponse<C, A>
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
