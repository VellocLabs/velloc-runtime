/**
 * The `sqlite` capability — host SQLite files (P-3). `query`/`execute`/`batch`
 * take either a file `path` (one-shot) or an open `handle` — pass exactly one.
 */

/**
 * A wire SQL value. Plain JSON for the common cases; a tagged object for the
 * two lossy ones — a 64-bit integer past 2^53 as `{ $int: "<decimal>" }` and a
 * blob as base64 `{ $blob: "<base64>" }`.
 */
export type SqlValue =
  | null
  | boolean
  | number
  | string
  | { $int: string }
  | { $blob: string }

export type SqliteOpenMode = 'ro' | 'rw' | 'rwc'

/** Open-time options honoured only in ONE-SHOT (`path`) mode; ignored when a
 *  `handle` is supplied (the connection was already opened). */
type SqliteOpenFields = {
  /** Copy the db (incl. `-wal`/`-shm` sidecars) to a private temp dir and open
   *  the copy read-only — for reading a DB another process may hold open.
   *  Implies read-only. */
  copyBeforeOpen?: boolean
  busyTimeoutMs?: number
}

export type SqliteQueryResult = {
  /** One array per row, values in `SELECT` order. No column names in v1
   *  (`sql::Statement` exposes none). */
  rows: SqlValue[][]
  rowCount: number
  /** True if `maxRows` cut the result — page with `LIMIT`/`OFFSET`. */
  truncated: boolean
}

/** Writes report only rows affected. `lastInsertRowId` is intentionally absent
 *  in v1 (its host accessor DCHECKs after a non-INSERT); use
 *  `SELECT last_insert_rowid()`. */
export type SqliteWriteResult = {
  rowsAffected: number
}

export type SqliteBatchResult = {
  results: SqliteWriteResult[]
}

export type SqliteBridgeActionMap = {
  query: {
    payload: {
      /** Exactly one of `path` / `handle`. */
      path?: string
      handle?: string
      sql: string
      /** Positional bind params (`?` placeholders). */
      params?: SqlValue[]
      /** Default 10_000; hard ceiling 100_000. */
      maxRows?: number
      /** How to encode 64-bit integers; default 'auto'. */
      bigIntMode?: 'auto' | 'number' | 'string'
      /** One-shot (`path`) only; default 'ro'. */
      mode?: 'ro' | 'rw'
    } & SqliteOpenFields
    result: SqliteQueryResult
  }
  execute: {
    payload: {
      path?: string
      handle?: string
      sql: string
      params?: SqlValue[]
      /** One-shot (`path`) only; default 'rw'. */
      mode?: 'rw' | 'rwc'
    } & SqliteOpenFields
    result: SqliteWriteResult
  }
  batch: {
    payload: {
      path?: string
      handle?: string
      statements: Array<{ sql: string; params?: SqlValue[] }>
      /** Default true — wrap in a transaction, roll back on any failure. */
      atomic?: boolean
      mode?: 'rw' | 'rwc'
    } & SqliteOpenFields
    result: SqliteBatchResult
  }
  open: {
    payload: {
      path: string
      mode?: SqliteOpenMode
    } & SqliteOpenFields
    result: { handle: string }
  }
  close: {
    payload: { handle: string }
    result: { ok: true }
  }
}
