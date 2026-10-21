/**
 * Contract: snapshot storage in the session dir (`snapshots/<id>` blobs,
 * `snapshots.sqlite` rows), removed with it by `deleteSession` (F-6).
 * Chromium SQLite: no `ON CONFLICT DO UPDATE`, no `json()`; ids come from an
 * in-memory counter seeded with `MAX(snapshot_id)` (single writer per
 * session), not AUTOINCREMENT; `rowsAffected` is never trusted.
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
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { joinRuntimePath } from '../../utils/runtimePaths'

export const SNAPSHOT_DB_FILE_NAME = 'snapshots.sqlite'
export const SNAPSHOT_BLOB_DIR_NAME = 'snapshots'

/** One captured (or declined) file state. `snapshotId === null` with
 *  `exists: true` means the content was NOT captured (`skipped`: over the
 *  size cap, or a directory placeholder). */
export type SnapshotFileState = {
  exists: boolean
  snapshotId: number | null
  /** Content deliberately not captured (size cap / directory). */
  skipped: boolean
}

export type SnapshotTurnRow = {
  turnSeq: number
  userMessageUuid: string | null
  promptPreview: string
  startedAt: number
  finalized: boolean
}

export type SnapshotTurnFileRow = {
  turnSeq: number
  /** Normalized identity key (`normalizePathKey`). */
  path: string
  /** First-seen spelling, for display. */
  displayPath: string
  before: SnapshotFileState
  /** null until the turn is finalized. */
  after: SnapshotFileState | null
}

export type SnapshotSessionFileRow = {
  path: string
  displayPath: string
  original: SnapshotFileState
}

// --- SQL (exported so unit-test fakes key off the exact statements) --------

export const SQL_CREATE_META =
  'CREATE TABLE IF NOT EXISTS snapshot_meta (key TEXT PRIMARY KEY, value TEXT)'
export const SQL_CREATE_SNAPSHOTS =
  'CREATE TABLE IF NOT EXISTS snapshots (snapshot_id INTEGER PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL)'
export const SQL_CREATE_SESSION_FILES =
  'CREATE TABLE IF NOT EXISTS session_files (path TEXT PRIMARY KEY, display_path TEXT NOT NULL, original_exists INTEGER NOT NULL, original_snapshot_id INTEGER, original_skipped INTEGER NOT NULL DEFAULT 0)'
export const SQL_CREATE_TURNS =
  'CREATE TABLE IF NOT EXISTS turns (turn_seq INTEGER PRIMARY KEY, user_message_uuid TEXT, prompt_preview TEXT NOT NULL, started_at INTEGER NOT NULL, finalized INTEGER NOT NULL DEFAULT 0)'
export const SQL_CREATE_TURN_FILES =
  'CREATE TABLE IF NOT EXISTS turn_files (turn_seq INTEGER NOT NULL, path TEXT NOT NULL, display_path TEXT NOT NULL, before_exists INTEGER NOT NULL, before_snapshot_id INTEGER, before_skipped INTEGER NOT NULL DEFAULT 0, after_exists INTEGER, after_snapshot_id INTEGER, after_skipped INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (turn_seq, path))'
export const SQL_SEED_SCHEMA_VERSION =
  "INSERT OR IGNORE INTO snapshot_meta (key, value) VALUES ('schema_version', '1')"
export const SQL_MAX_SNAPSHOT_ID = 'SELECT MAX(snapshot_id) FROM snapshots'
export const SQL_INSERT_SNAPSHOT =
  'INSERT INTO snapshots (snapshot_id, size, created_at) VALUES (?, ?, ?)'
export const SQL_INSERT_TURN =
  'INSERT OR IGNORE INTO turns (turn_seq, user_message_uuid, prompt_preview, started_at, finalized) VALUES (?, ?, ?, ?, 0)'
export const SQL_INSERT_SESSION_FILE =
  'INSERT OR IGNORE INTO session_files (path, display_path, original_exists, original_snapshot_id, original_skipped) VALUES (?, ?, ?, ?, ?)'
export const SQL_INSERT_TURN_FILE =
  'INSERT OR IGNORE INTO turn_files (turn_seq, path, display_path, before_exists, before_snapshot_id, before_skipped) VALUES (?, ?, ?, ?, ?, ?)'
export const SQL_SELECT_TURN_FILE =
  'SELECT turn_seq, path, display_path, before_exists, before_snapshot_id, before_skipped, after_exists, after_snapshot_id, after_skipped FROM turn_files WHERE turn_seq = ? AND path = ?'
export const SQL_SELECT_PRIOR_TURN_FILE =
  'SELECT turn_seq, path, display_path, before_exists, before_snapshot_id, before_skipped, after_exists, after_snapshot_id, after_skipped FROM turn_files WHERE path = ? AND turn_seq < ? ORDER BY turn_seq DESC LIMIT 1'
export const SQL_SELECT_NEXT_TURN_FILE =
  'SELECT turn_seq, path, display_path, before_exists, before_snapshot_id, before_skipped, after_exists, after_snapshot_id, after_skipped FROM turn_files WHERE path = ? AND turn_seq > ? ORDER BY turn_seq ASC LIMIT 1'
export const SQL_LIST_TURN_FILES =
  'SELECT turn_seq, path, display_path, before_exists, before_snapshot_id, before_skipped, after_exists, after_snapshot_id, after_skipped FROM turn_files WHERE turn_seq = ? ORDER BY path'
export const SQL_LIST_TURN_FILES_FROM =
  'SELECT turn_seq, path, display_path, before_exists, before_snapshot_id, before_skipped, after_exists, after_snapshot_id, after_skipped FROM turn_files WHERE turn_seq >= ? ORDER BY turn_seq, path'
export const SQL_LIST_TURN_FILES_FOR_PATH =
  'SELECT turn_seq, path, display_path, before_exists, before_snapshot_id, before_skipped, after_exists, after_snapshot_id, after_skipped FROM turn_files WHERE path = ? ORDER BY turn_seq'
export const SQL_UPDATE_TURN_FILE_AFTER =
  'UPDATE turn_files SET after_exists = ?, after_snapshot_id = ?, after_skipped = ? WHERE turn_seq = ? AND path = ?'
export const SQL_LIST_TURNS =
  'SELECT turn_seq, user_message_uuid, prompt_preview, started_at, finalized FROM turns ORDER BY turn_seq'
export const SQL_LIST_UNFINALIZED_TURNS =
  'SELECT turn_seq, user_message_uuid, prompt_preview, started_at, finalized FROM turns WHERE finalized = 0 ORDER BY turn_seq'
export const SQL_MARK_TURN_FINALIZED =
  'UPDATE turns SET finalized = 1 WHERE turn_seq = ?'
export const SQL_LIST_SESSION_FILES =
  'SELECT path, display_path, original_exists, original_snapshot_id, original_skipped FROM session_files ORDER BY path'
export const SQL_SELECT_SESSION_FILE =
  'SELECT path, display_path, original_exists, original_snapshot_id, original_skipped FROM session_files WHERE path = ?'
export const SQL_DELETE_TURN_FILE =
  'DELETE FROM turn_files WHERE turn_seq = ? AND path = ?'
export const SQL_COUNT_TURN_FILES_FOR_PATH =
  'SELECT COUNT(*) FROM turn_files WHERE path = ?'
export const SQL_DELETE_SESSION_FILE =
  'DELETE FROM session_files WHERE path = ?'
export const SQL_COUNT_SNAPSHOT_TURN_REFS =
  'SELECT COUNT(*) FROM turn_files WHERE before_snapshot_id = ? OR after_snapshot_id = ?'
export const SQL_COUNT_SNAPSHOT_SESSION_REFS =
  'SELECT COUNT(*) FROM session_files WHERE original_snapshot_id = ?'
export const SQL_DELETE_SNAPSHOT =
  'DELETE FROM snapshots WHERE snapshot_id = ?'

// Bounded lock retry — same rationale as SqliteSessionMetaStore, but this DB
// is single-writer (one recorder per session serializes every op), so
// contention can only come from an external reader; keep the retry short.
const LOCK_RETRIES = 4
const LOCK_BACKOFF_MS = 25

function isLockError(error: { code: string; message: string }): boolean {
  return (
    error.code === 'SQLITE_BUSY' ||
    error.code === 'SQLITE_LOCKED' ||
    /database is locked|database table is locked/i.test(error.message)
  )
}

type BridgeResponse<
  C extends BrowserBridgeCapability,
  A extends BrowserBridgeAction<C>,
> =
  | { ok: true; result: BrowserBridgeResult<C, A> }
  | { ok: false; error: { code: string; message: string } }

export type SessionSnapshotStoreOptions = {
  transport: BrowserBridgeTransport
  fs: RuntimeFs
  /** Absolute path of THIS session's directory (`<projectDir>/<sessionId>`). */
  sessionDir: string
  createRequestId?: () => string
  /** Injected clock for tests; production uses Date.now. */
  now?: () => number
}

function num(v: SqlValue | undefined): number | null {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && '$int' in v) return Number(v.$int)
  return null
}

function text(v: SqlValue | undefined): string | null {
  return typeof v === 'string' ? v : null
}

function rowToTurnFile(row: SqlValue[]): SnapshotTurnFileRow {
  const afterExists = num(row[6])
  return {
    turnSeq: num(row[0]) ?? 0,
    path: text(row[1]) ?? '',
    displayPath: text(row[2]) ?? '',
    before: {
      exists: num(row[3]) === 1,
      snapshotId: num(row[4]),
      skipped: num(row[5]) === 1,
    },
    after:
      afterExists === null
        ? null
        : {
            exists: afterExists === 1,
            snapshotId: num(row[7]),
            skipped: num(row[8]) === 1,
          },
  }
}

function rowToTurn(row: SqlValue[]): SnapshotTurnRow {
  return {
    turnSeq: num(row[0]) ?? 0,
    userMessageUuid: text(row[1]),
    promptPreview: text(row[2]) ?? '',
    startedAt: num(row[3]) ?? 0,
    finalized: num(row[4]) === 1,
  }
}

function rowToSessionFile(row: SqlValue[]): SnapshotSessionFileRow {
  return {
    path: text(row[0]) ?? '',
    displayPath: text(row[1]) ?? '',
    original: {
      exists: num(row[2]) === 1,
      snapshotId: num(row[3]),
      skipped: num(row[4]) === 1,
    },
  }
}

export class SessionSnapshotStore {
  private readonly transport: BrowserBridgeTransport
  private readonly fs: RuntimeFs
  private readonly sessionDir: string
  private readonly dbPath: string
  private readonly blobDir: string
  private readonly createRequestId: () => string
  private readonly now: () => number
  private ready?: Promise<void>
  private nextSnapshotId = 1

  constructor(options: SessionSnapshotStoreOptions) {
    this.transport = options.transport
    this.fs = options.fs
    this.sessionDir = options.sessionDir
    this.dbPath = joinRuntimePath(options.sessionDir, SNAPSHOT_DB_FILE_NAME)
    this.blobDir = joinRuntimePath(options.sessionDir, SNAPSHOT_BLOB_DIR_NAME)
    this.createRequestId =
      options.createRequestId ??
      (() => globalThis.crypto?.randomUUID?.() ?? `snap-${Date.now()}`)
    this.now = options.now ?? (() => Date.now())
  }

  snapshotRoot(): string {
    return this.sessionDir
  }

  getDbPath(): string {
    return this.dbPath
  }

  blobPath(snapshotId: number): string {
    return joinRuntimePath(this.blobDir, String(snapshotId))
  }

  /** True when a snapshot DB already exists on disk — the cheap probe the
   *  recorder's recovery path uses so a never-mutated session costs nothing. */
  async hasPersistedState(): Promise<boolean> {
    try {
      await this.fs.stat(this.dbPath)
      return true
    } catch {
      return false
    }
  }

  /** Create dirs + schema once, and seed the id counter from MAX(snapshot_id).
   *  Idempotent; memoized on the first successful run. */
  ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.initialize().catch(err => {
        // Allow a later retry rather than caching the failure forever.
        this.ready = undefined
        throw err
      })
    }
    return this.ready
  }

  private async initialize(): Promise<void> {
    // The session dir usually exists (the transcript writer creates it), but
    // a first-mutation-before-first-persist ordering must not fail here.
    for (const dir of [this.sessionDir, this.blobDir]) {
      try {
        await this.fs.mkdir(dir)
      } catch {
        // exists (or created concurrently) — the write below is the real check
      }
    }
    await this.batch([
      { sql: SQL_CREATE_META },
      { sql: SQL_CREATE_SNAPSHOTS },
      { sql: SQL_CREATE_SESSION_FILES },
      { sql: SQL_CREATE_TURNS },
      { sql: SQL_CREATE_TURN_FILES },
      { sql: SQL_SEED_SCHEMA_VERSION },
    ])
    const rows = await this.query(SQL_MAX_SNAPSHOT_ID, [])
    const max = rows[0] ? num(rows[0][0]) : null
    this.nextSnapshotId = (max ?? 0) + 1
  }

  /** Write one content blob + its `snapshots` row; returns the new id. The
   *  blob file lands BEFORE the row, so a crash between the two leaves only
   *  an unreferenced file (swept with the session dir). */
  async writeSnapshotBlob(bytes: Uint8Array): Promise<number> {
    await this.ensureReady()
    const id = this.nextSnapshotId++
    await this.fs.writeFile(this.blobPath(id), bytes)
    await this.execute(SQL_INSERT_SNAPSHOT, [id, bytes.length, this.now()])
    return id
  }

  /** Blob content by id, or null when unreadable (missing/torn). */
  async readSnapshotBlob(snapshotId: number): Promise<Uint8Array | null> {
    try {
      return await this.fs.readFileBytes(this.blobPath(snapshotId))
    } catch {
      return null
    }
  }

  /**
   * Record one before-capture ATOMICALLY: the turn row (OR IGNORE — several
   * captures share a turn), the session-file original (OR IGNORE — first
   * touch in the session wins), and the turn-file before row (OR IGNORE —
   * the recorder pre-checks, this guards a crash-then-retry duplicate).
   */
  async recordBeforeCapture(args: {
    turn: { seq: number; uuid?: string; preview: string }
    path: string
    displayPath: string
    before: SnapshotFileState
  }): Promise<void> {
    await this.ensureReady()
    const { turn, path, displayPath, before } = args
    await this.batch([
      {
        sql: SQL_INSERT_TURN,
        params: [turn.seq, turn.uuid ?? null, turn.preview, this.now()],
      },
      {
        sql: SQL_INSERT_SESSION_FILE,
        params: [
          path,
          displayPath,
          before.exists ? 1 : 0,
          before.snapshotId,
          before.skipped ? 1 : 0,
        ],
      },
      {
        sql: SQL_INSERT_TURN_FILE,
        params: [
          turn.seq,
          path,
          displayPath,
          before.exists ? 1 : 0,
          before.snapshotId,
          before.skipped ? 1 : 0,
        ],
      },
    ])
  }

  async getTurnFile(
    turnSeq: number,
    path: string,
  ): Promise<SnapshotTurnFileRow | null> {
    await this.ensureReady()
    const rows = await this.query(SQL_SELECT_TURN_FILE, [turnSeq, path])
    return rows[0] ? rowToTurnFile(rows[0]) : null
  }

  /** The latest turn-file row for `path` BEFORE `turnSeq` (dedup source). */
  async getPriorTurnFile(
    path: string,
    turnSeq: number,
  ): Promise<SnapshotTurnFileRow | null> {
    await this.ensureReady()
    const rows = await this.query(SQL_SELECT_PRIOR_TURN_FILE, [path, turnSeq])
    return rows[0] ? rowToTurnFile(rows[0]) : null
  }

  /** The earliest turn-file row for `path` AFTER `turnSeq` (finalize source:
   *  a later turn's before IS this turn's after for the same path). */
  async getNextTurnFile(
    path: string,
    turnSeq: number,
  ): Promise<SnapshotTurnFileRow | null> {
    await this.ensureReady()
    const rows = await this.query(SQL_SELECT_NEXT_TURN_FILE, [path, turnSeq])
    return rows[0] ? rowToTurnFile(rows[0]) : null
  }

  async listTurnFiles(turnSeq: number): Promise<SnapshotTurnFileRow[]> {
    await this.ensureReady()
    const rows = await this.query(SQL_LIST_TURN_FILES, [turnSeq])
    return rows.map(rowToTurnFile)
  }

  /** All turn-file rows with `turn_seq >= fromSeq` (revert-to-point scan). */
  async listTurnFilesFrom(fromSeq: number): Promise<SnapshotTurnFileRow[]> {
    await this.ensureReady()
    const rows = await this.query(SQL_LIST_TURN_FILES_FROM, [fromSeq])
    return rows.map(rowToTurnFile)
  }

  /** Every turn-file row for one `path`, oldest→newest — the session-total
   *  diff's per-file continuity walk (adjacent after/before links). */
  async listTurnFilesForPath(path: string): Promise<SnapshotTurnFileRow[]> {
    await this.ensureReady()
    const rows = await this.query(SQL_LIST_TURN_FILES_FOR_PATH, [path])
    return rows.map(rowToTurnFile)
  }

  async setTurnFileAfter(
    turnSeq: number,
    path: string,
    after: SnapshotFileState,
  ): Promise<void> {
    await this.ensureReady()
    await this.execute(SQL_UPDATE_TURN_FILE_AFTER, [
      after.exists ? 1 : 0,
      after.snapshotId,
      after.skipped ? 1 : 0,
      turnSeq,
      path,
    ])
  }

  async listTurns(): Promise<SnapshotTurnRow[]> {
    await this.ensureReady()
    const rows = await this.query(SQL_LIST_TURNS, [])
    return rows.map(rowToTurn)
  }

  async listUnfinalizedTurns(): Promise<SnapshotTurnRow[]> {
    await this.ensureReady()
    const rows = await this.query(SQL_LIST_UNFINALIZED_TURNS, [])
    return rows.map(rowToTurn)
  }

  async markTurnFinalized(turnSeq: number): Promise<void> {
    await this.ensureReady()
    await this.execute(SQL_MARK_TURN_FINALIZED, [turnSeq])
  }

  async listSessionFiles(): Promise<SnapshotSessionFileRow[]> {
    await this.ensureReady()
    const rows = await this.query(SQL_LIST_SESSION_FILES, [])
    return rows.map(rowToSessionFile)
  }

  async getSessionFile(path: string): Promise<SnapshotSessionFileRow | null> {
    await this.ensureReady()
    const rows = await this.query(SQL_SELECT_SESSION_FILE, [path])
    return rows[0] ? rowToSessionFile(rows[0]) : null
  }

  /** Remove one turn-file row — a probe capture the command left unchanged. */
  async deleteTurnFile(turnSeq: number, path: string): Promise<void> {
    await this.ensureReady()
    await this.execute(SQL_DELETE_TURN_FILE, [turnSeq, path])
  }

  async countTurnFilesForPath(path: string): Promise<number> {
    await this.ensureReady()
    const rows = await this.query(SQL_COUNT_TURN_FILES_FOR_PATH, [path])
    return num(rows[0]?.[0]) ?? 0
  }

  async deleteSessionFile(path: string): Promise<void> {
    await this.ensureReady()
    await this.execute(SQL_DELETE_SESSION_FILE, [path])
  }

  /** Rows (turn before/after and session originals) that point at a blob. */
  async countSnapshotReferences(snapshotId: number): Promise<number> {
    await this.ensureReady()
    const [turnRefs, sessionRefs] = await Promise.all([
      this.query(SQL_COUNT_SNAPSHOT_TURN_REFS, [snapshotId, snapshotId]),
      this.query(SQL_COUNT_SNAPSHOT_SESSION_REFS, [snapshotId]),
    ])
    return (num(turnRefs[0]?.[0]) ?? 0) + (num(sessionRefs[0]?.[0]) ?? 0)
  }

  /** Drop a blob's row and file. The caller has checked it is unreferenced;
   *  an unlink failure leaves an orphan blob the session-dir delete sweeps. */
  async deleteSnapshot(snapshotId: number): Promise<void> {
    await this.ensureReady()
    await this.execute(SQL_DELETE_SNAPSHOT, [snapshotId])
    try {
      await this.fs.unlink(this.blobPath(snapshotId))
    } catch {
      // Orphan blob — swept with the session directory.
    }
  }

  // --- transport ------------------------------------------------------------

  private async query(sql: string, params: SqlValue[]): Promise<SqlValue[][]> {
    const res = await this.runSqlite(createBridgeRoute('sqlite', 'query'), {
      path: this.dbPath,
      sql,
      params,
      mode: 'ro',
    })
    if (!res.ok) {
      // Reads run behind ensureReady (the DB file exists), so CANTOPEN here is
      // a real failure, not "no DB yet" — propagate like any other error.
      throw new Error(`${res.error.code}: ${res.error.message}`)
    }
    return res.result.rows
  }

  private async execute(sql: string, params: SqlValue[]): Promise<void> {
    const res = await this.runSqlite(
      createBridgeRoute('sqlite', 'execute'),
      { path: this.dbPath, sql, params, mode: 'rwc' },
      { retryOpen: true },
    )
    if (!res.ok) {
      throw new Error(`${res.error.code}: ${res.error.message}`)
    }
  }

  private async batch(
    statements: Array<{ sql: string; params?: SqlValue[] }>,
  ): Promise<void> {
    const res = await this.runSqlite(
      createBridgeRoute('sqlite', 'batch'),
      { path: this.dbPath, mode: 'rwc', atomic: true, statements },
      { retryOpen: true },
    )
    if (!res.ok) {
      throw new Error(`${res.error.code}: ${res.error.message}`)
    }
  }

  /** Bounded-retry sqlite request. `retryOpen` (writes only) also retries
   *  SQLITE_CANTOPEN — the host collapses every failed open into that code,
   *  so under cross-process contention a writable open can report it
   *  transiently (see SqliteSessionMetaStore for the full rationale). */
  private async runSqlite<A extends BrowserBridgeAction<'sqlite'>>(
    route: BrowserBridgeRoute<'sqlite', A>,
    payload: BrowserBridgeRequestPayload<'sqlite', A>,
    opts?: { retryOpen?: boolean },
  ): Promise<BridgeResponse<'sqlite', A>> {
    const retryable = (error: { code: string; message: string }): boolean =>
      isLockError(error) ||
      (opts?.retryOpen === true && error.code === 'SQLITE_CANTOPEN')
    let res = await this.rawRequest(route, payload)
    for (
      let attempt = 1;
      attempt <= LOCK_RETRIES && !res.ok && retryable(res.error);
      attempt += 1
    ) {
      await new Promise(resolve => setTimeout(resolve, LOCK_BACKOFF_MS * attempt))
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
