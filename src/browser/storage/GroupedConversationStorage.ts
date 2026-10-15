/**
 * Routing facade over per-project session storage
 * (`~/.velloc/projects/<projectFolderKey(projectRoot)>/<sessionId>/transcript.jsonl`): routes
 * each per-session call to a cached child backend for that session's project dir (F-17).
 */
import type {
  BrowserConversationStorageBackend,
  BrowserConversationStoragePayload,
  BrowserSessionMetadata,
  BrowserSessionSummary,
  BrowserTranscriptWriteEntry,
  SessionMetaFile,
} from '../../sessions/sessionStore'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import type { SkillInvocationEvent } from '../../skillLibrary/skillInvocationLog'
import {
  getConversationMetaPath,
  getConversationTranscriptPath,
  getLegacyConversationMetaSidecarPath,
} from '../../utils/conversationStoragePaths'
import {
  buildSessionSummaryFromMeta,
  deriveSessionMetaFromEntries,
  deriveSessionMetaFromText,
  metadataFromSessionMeta,
  parseSessionMetaFile,
  SESSION_SUMMARY_TAIL_BYTES,
} from '../../sessions/sessionStore'
import {
  isTeammateSessionId,
  TEAMMATES_DIR_NAME,
} from '../../utils/sidechainStoragePaths'
import type { SessionTreeRow, SessionTreeScanResult } from './sessionTreeScan'
import type { SqliteSessionMetaStore } from './SqliteSessionMetaStore'
import {
  MIGRATION_READ_FAILURE_LIMIT,
  SESSION_META_MIGRATION_V1,
} from './SqliteSessionMetaStore'

/** One file (or byte range of one) to fetch in a batched read. */
export type SummarySourceRequest = {
  path: string
  offset?: number
  length?: number
}

/** The batched read's answer, 1:1 with the request. `bytes` is null for a
 *  path that could not be read at all. */
export type SummarySourceResult = {
  path: string
  ok: boolean
  bytes: Uint8Array | null
  /** The host's reason for an `ok:false` item. A missing file is an ordinary
   *  answer; anything else is a read that FAILED (the migration retries it). */
  error?: string
}

/** The host words a missing file ENOENT-style (same rule as
 *  `BridgeFsSessionStorage`'s `isMissingFileError`). An `ok:false` item with
 *  no reason at all is read as missing — it cannot be told apart. */
function isFailedRead(result: SummarySourceResult | undefined): boolean {
  if (!result || result.ok || !result.error) return false
  return !/ENOENT|not[ _]found|no such file/i.test(result.error)
}

export type GroupedConversationStorageOptions = {
  /** `~/.velloc/projects` — parent of the per-project dirs. */
  projectsRoot: string
  /** Project dir for sessions with no known projectRoot (the workspace sandbox). */
  defaultProjectDir: string
  /** Build a flat child backend rooted at `basePath` (one per project dir). */
  createBackend: (basePath: string) => BrowserConversationStorageBackend
  /**
   * One depth-3 scan of `projectsRoot`. MUST resolve empty for a missing root but THROW on a
   * failed scan; whatever it could not list it MUST report as `truncated` (a bare array is complete).
   */
  scanSessionTree: () => Promise<SessionTreeRow[] | SessionTreeScanResult>
  /** Fetch many files (or ranges) in one round-trip. Per-item failure must
   *  come back as `ok:false`, never as a rejection. */
  readSummarySources: (
    items: readonly SummarySourceRequest[],
  ) => Promise<SummarySourceResult[]>
  /** Join `projectsRoot` with a child dir name in the host's path style. */
  joinPath: (base: string, child: string) => string
  /**
   * The ONE sqlite meta store for every project. Authoritative for the sidebar:
   * `listSessions` reads it in a single query (after a one-time seed from the
   * legacy `meta.json` files) instead of scanning every project folder, and per-
   * session meta ops route here. The child backends own only transcript +
   * tool-details on fs.
   */
  metaStore: SqliteSessionMetaStore
  /**
   * The project dir a session's meta belongs to — `metadata.projectRoot` when
   * bound, else the per-type shared workspace. The single DB is keyed by
   * `sessionId` (readable without knowing the dir), so this is only needed to
   * restore the `sessionId → projectDir` routing map for transcript I/O.
   */
  resolveProjectDirForMeta: (meta: SessionMetaFile) => string
}

/**
 * Guest-side chunking for the batched read, well inside the host's caps (512 items / 32 MiB).
 * Kept small on purpose: one large batch starves boot-critical worker traffic.
 */
const BATCH_MAX_ITEMS = 32
const BATCH_MAX_BYTES = 2 * 1024 * 1024

const TEXT_DECODER = new TextDecoder()

/** What the scan told us about one session, kept for the preload. */
type ScannedSession = {
  projectDir: string
  transcriptSize: number
  /** Has a `meta.json` — the summary source. */
  hasMeta: boolean
  /** Still has the retired `meta.jsonl` — the preferred MIGRATION source for
   *  a session without `meta.json`. */
  hasLegacyMeta: boolean
}

/** Which file a summary read targets. `meta` is the steady state; the other
 *  two are one-time migration sources for a session without `meta.json`. */
type SummarySourceKind = 'meta' | 'legacy-sidecar' | 'tail'

/**
 * True when `challenger` should displace `incumbent` as a session's project dir: "has messages"
 * ranks first, then newer `updatedAt`; ties keep the incumbent; an unreadable copy scores as an empty stub.
 */
function rankCopies(
  incumbent: BrowserSessionSummary | null,
  challenger: BrowserSessionSummary | null,
): boolean {
  const incumbentHasMessages = (incumbent?.messageCount ?? 0) > 0
  const challengerHasMessages = (challenger?.messageCount ?? 0) > 0
  if (incumbentHasMessages !== challengerHasMessages) {
    return challengerHasMessages
  }
  return (challenger?.updatedAt ?? 0) > (incumbent?.updatedAt ?? 0)
}

/** Split a batched read into calls bounded by BOTH item count and requested
 *  bytes, keeping each request paired with its caller key. */
function chunkSummaryRequests<K>(
  requests: readonly SummarySourceRequest[],
  keys: readonly K[],
): Array<{ requests: SummarySourceRequest[]; keys: K[] }> {
  const chunks: Array<{ requests: SummarySourceRequest[]; keys: K[] }> = []
  let current: { requests: SummarySourceRequest[]; keys: K[] } = {
    requests: [],
    keys: [],
  }
  let bytes = 0
  requests.forEach((request, index) => {
    const cost = request.length ?? SESSION_SUMMARY_TAIL_BYTES
    if (
      current.requests.length > 0 &&
      (current.requests.length >= BATCH_MAX_ITEMS ||
        bytes + cost > BATCH_MAX_BYTES)
    ) {
      chunks.push(current)
      current = { requests: [], keys: [] }
      bytes = 0
    }
    current.requests.push(request)
    current.keys.push(keys[index]!)
    bytes += cost
  })
  if (current.requests.length > 0) {
    chunks.push(current)
  }
  return chunks
}

export class GroupedConversationStorage
  implements BrowserConversationStorageBackend
{
  private readonly opts: GroupedConversationStorageOptions
  /** projectDir → child backend (created lazily, cached). */
  private readonly backends = new Map<string, BrowserConversationStorageBackend>()
  /** sessionId → projectDir (filled by `listSessions` + `setSessionProjectDir`). */
  private readonly sessionDir = new Map<string, string>()
  /** Last scan's per-session facts — used ONLY by the one-time migration to
   *  decide meta-vs-sidecar-vs-tail per session without an extra probe. */
  private readonly scanned = new Map<string, ScannedSession>()
  /** Summaries parsed from the last `metaStore.listAll()` (populated by
   *  `listSessions`), so `loadSessionSummariesBatch` serves the sidebar from
   *  memory instead of re-reading the DB per session. */
  private readonly summaryCache = new Map<string, BrowserSessionSummary>()
  /** Guards the one-time `meta.json` → sqlite seed (runs inside `listSessions`). */
  private migrationDone = false
  /** In-flight migration, memoized so overlapping `listSessions` calls share it. */
  private migrationPromise?: Promise<void>

  constructor(opts: GroupedConversationStorageOptions) {
    this.opts = opts
  }

  /**
   * Register a (new) session's project dir before its first write, so the
   * worker's `append`/`load` for that session route to the right child backend.
   * The manager calls this on mount, computing the dir from the session's
   * projectRoot via `getSessionStorageBaseForProject`.
   */
  setSessionProjectDir(sessionId: string, projectDir: string): void {
    this.sessionDir.set(sessionId, projectDir)
  }

  /** Current routing for a session (undefined when never seen). Used by the
   *  manager's re-bind path to find the OLD dir before re-routing. */
  projectRouteOf(sessionId: string): string | undefined {
    return this.sessionDir.get(sessionId)
  }

  /**
   * Fill in ONE session's routing from the meta store, without the full scan; returns the routed dir.
   * Fills a gap only: an established route is returned unchanged.
   */
  async routeSessionFromMeta(sessionId: string): Promise<string | undefined> {
    const established = this.sessionDir.get(sessionId)
    if (established !== undefined) return established
    let stored: Awaited<
      ReturnType<SqliteSessionMetaStore['readStoredMeta']>
    > | null = null
    try {
      stored = await this.opts.metaStore.readStoredMeta(sessionId)
    } catch {
      return undefined
    }
    if (!stored) return undefined
    const dir = await this.resolveDirFromStore(sessionId, stored)
    this.sessionDir.set(sessionId, dir)
    return dir
  }

  /** `resolveDir` plus the teammate nesting, reading the LEAD's row from the
   *  store when the lead is not routed yet. Mirrors `resolveNestedDir`, which
   *  does the same thing against a whole scan. */
  private async resolveDirFromStore(
    sessionId: string,
    stored: { meta: SessionMetaFile; projectDir?: string },
  ): Promise<string> {
    const own = this.resolveDir(stored.meta, stored.projectDir)
    const spawnerSessionId = stored.meta.metadata?.spawnerSessionId
    if (!spawnerSessionId || !isTeammateSessionId(sessionId)) return own
    let leadDir = this.sessionDir.get(spawnerSessionId)
    if (leadDir === undefined) {
      try {
        const lead = await this.opts.metaStore.readStoredMeta(spawnerSessionId)
        leadDir = lead ? this.resolveDir(lead.meta, lead.projectDir) : undefined
      } catch {
        leadDir = undefined
      }
    }
    if (leadDir === undefined) return own
    return this.opts.joinPath(
      this.opts.joinPath(leadDir, spawnerSessionId),
      TEAMMATES_DIR_NAME,
    )
  }

  /** Routing-only eviction (no fs). Used when a background sub-agent is reaped
   *  by the parent-close cascade: the parent's recursive `deleteSession` already
   *  removes the sub-agent's nested files (it lives under the parent dir now), so
   *  re-issuing `deleteSession` per sub-agent would just re-resolve + rm an
   *  already-gone path. This only drops the `sessionId → projectDir` map entry so
   *  a later re-used `subagent-<id>` can't route to the deleted parent's dir. */
  dropSessionRouting(sessionId: string): void {
    this.sessionDir.delete(sessionId)
  }

  /**
   * Delete a session's files from a SPECIFIC project dir without touching
   * the routing map. The re-bind relocation uses this to remove the pre-bind
   * stub from the old (workspace) dir — `deleteSession` would route to the
   * NEW dir and delete the live transcript instead.
   */
  async deleteSessionInDir(
    projectDir: string,
    sessionId: string,
  ): Promise<void> {
    await this.backendForDir(projectDir).deleteSession?.(sessionId)
  }

  private dirFor(sessionId: string): string {
    return this.sessionDir.get(sessionId) ?? this.opts.defaultProjectDir
  }

  private backendForDir(projectDir: string): BrowserConversationStorageBackend {
    let backend = this.backends.get(projectDir)
    if (!backend) {
      backend = this.opts.createBackend(projectDir)
      this.backends.set(projectDir, backend)
    }
    return backend
  }

  private backendFor(sessionId: string): BrowserConversationStorageBackend {
    return this.backendForDir(this.dirFor(sessionId))
  }

  async append(
    sessionId: string,
    entry: BrowserTranscriptWriteEntry,
  ): Promise<void> {
    return this.backendFor(sessionId).append(sessionId, entry)
  }

  async load(sessionId: string): Promise<BrowserConversationStoragePayload> {
    return this.backendFor(sessionId).load(sessionId)
  }

  async flush(): Promise<void> {
    await Promise.all([...this.backends.values()].map(b => b.flush()))
  }

  // Meta is owned by the single sqlite store, not the per-project child
  // backends (which own transcript + tool-details only). Reading is keyed by
  // sessionId — no project dir needed — which is why the store can answer
  // before routing is known.
  async readSessionMeta(sessionId: string): Promise<SessionMetaFile | null> {
    return this.opts.metaStore.readMeta(sessionId)
  }

  async writeSessionMeta(
    sessionId: string,
    meta: SessionMetaFile,
  ): Promise<void> {
    return this.opts.metaStore.upsertMeta(sessionId, meta)
  }

  async migrateLegacySessionMeta(
    sessionId: string,
  ): Promise<SessionMetaFile | null> {
    // The one-time file→sqlite seed already ran in `listSessions`; the DB is
    // authoritative, so this is just a read.
    return this.opts.metaStore.readMeta(sessionId)
  }

  getBasePath(): string | undefined {
    // Sidechain anchoring is done worker-side off the per-session backend, not
    // this manager-side router; expose the projects root for any diagnostic use.
    return this.opts.projectsRoot
  }

  /**
   * Every session id, in one meta-store query; restores the `sessionId → projectDir` routing and
   * caches the summaries. The first call on a pre-store profile runs `migrateToSqlite`.
   */
  async listSessions(): Promise<string[]> {
    await this.ensureMigrated()
    const all = await this.opts.metaStore.listAll()
    this.summaryCache.clear()
    // Two passes, because a TEAMMATE's dir is derived from its LEAD's: pass one
    // resolves every row's own dir, pass two re-points each teammate at the
    // nested `<leadDir>/<headSessionId>/teammates` its transcript is actually
    // written to (`prepareWorkerStorageTarget`). A single pass cannot do it —
    // `listAll` has no parent-before-child ordering.
    const ownDir = new Map<string, string>()
    for (const { sessionId, meta, projectDir } of all) {
      ownDir.set(sessionId, this.resolveDir(meta, projectDir))
    }
    const ids: string[] = []
    for (const { sessionId, meta } of all) {
      const dir = this.resolveNestedDir(sessionId, meta, ownDir)
      this.sessionDir.set(sessionId, dir)
      const summary = buildSessionSummaryFromMeta(meta)
      if (summary) {
        summary.projectDir = dir
        this.summaryCache.set(sessionId, summary)
      }
      ids.push(sessionId)
    }
    return ids
  }

  /**
   * Where a row's transcript lives: `resolveDir`'s dir, or for a TEAMMATE
   * `<leadDir>/<headSessionId>/teammates`; a teammate whose lead is missing keeps its own dir.
   */
  private resolveNestedDir(
    sessionId: string,
    meta: SessionMetaFile,
    ownDir: ReadonlyMap<string, string>,
  ): string {
    const own = ownDir.get(sessionId) ?? this.opts.defaultProjectDir
    const spawnerSessionId = meta.metadata?.spawnerSessionId
    if (!spawnerSessionId || !isTeammateSessionId(sessionId)) {
      return own
    }
    const leadDir = ownDir.get(spawnerSessionId)
    if (!leadDir) {
      return own
    }
    return this.opts.joinPath(
      this.opts.joinPath(leadDir, spawnerSessionId),
      TEAMMATES_DIR_NAME,
    )
  }

  /**
   * A session's project dir: `projectRoot` wins, then the migration-recorded `project_dir`, then
   * the per-type default. The single source for every reader of where a session lives.
   */
  private resolveDir(meta: SessionMetaFile, storedProjectDir?: string): string {
    if (meta.metadata?.projectRoot) {
      return this.opts.resolveProjectDirForMeta(meta)
    }
    return storedProjectDir ?? this.opts.resolveProjectDirForMeta(meta)
  }

  private ensureMigrated(): Promise<void> {
    if (this.migrationDone) return Promise.resolve()
    // Memoize the in-flight migration so overlapping `listSessions` calls (the
    // sidebar preload + a resume's `ensureSessionRouting`) share ONE scan+seed
    // rather than each running it. (`seedMeta` is INSERT-OR-IGNORE, so a double
    // run would be correct anyway — this just avoids the wasted scan.)
    if (!this.migrationPromise) {
      this.migrationPromise = this.migrateToSqlite()
        .then(() => {
          this.migrationDone = true
        })
        .catch(error => {
          this.migrationPromise = undefined
          throw error
        })
    }
    return this.migrationPromise
  }

  /**
   * One-time seed of the sqlite store from legacy `meta.json` files, via `seedMeta` (INSERT OR
   * IGNORE). Duplicate copies resolve via `rankCopies`. The done-marker is written only for a
   * COMPLETE run, except that a path failing on `MIGRATION_READ_FAILURE_LIMIT` boots is skipped.
   */
  private async migrateToSqlite(): Promise<void> {
    if (await this.opts.metaStore.hasMigration(SESSION_META_MIGRATION_V1)) {
      return
    }
    const scan = await this.opts.scanSessionTree()
    const rows = Array.isArray(scan) ? scan : scan.rows
    let complete = Array.isArray(scan) ? true : !scan.truncated
    this.scanned.clear()
    const candidates = new Map<string, string[]>()
    for (const row of rows) {
      const projectDir = this.opts.joinPath(
        this.opts.projectsRoot,
        row.projectDirName,
      )
      this.scanned.set(`${projectDir} ${row.sessionId}`, {
        projectDir,
        transcriptSize: row.transcriptSize ?? 0,
        hasMeta: row.metaSize !== null && row.metaSize > 0,
        hasLegacyMeta: row.legacyMetaSize !== null && row.legacyMetaSize > 0,
      })
      const dirs = candidates.get(row.sessionId) ?? []
      if (!dirs.includes(projectDir)) {
        dirs.push(projectDir)
      }
      candidates.set(row.sessionId, dirs)
    }

    const derived = await this.deriveMetasBatched(candidates)
    const metas = derived.metas
    for (const [sessionId, dirs] of candidates) {
      let winner = metas.get(`${dirs[0]!} ${sessionId}`) ?? null
      // Track WHICH dir the winner came from: the legacy `meta.json` never
      // stored `projectRoot`, and `projectFolderKey` is lossy, so the folder is the
      // only durable routing key. Seed it as `project_dir` so `listSessions`
      // routes this session back to where its transcript actually lives instead
      // of the type-default sandbox (the empty-session bug).
      let winnerDir = dirs[0]!
      for (const challengerDir of dirs.slice(1)) {
        const challenger = metas.get(`${challengerDir} ${sessionId}`) ?? null
        if (
          rankCopies(
            winner ? buildSessionSummaryFromMeta(winner) : null,
            challenger ? buildSessionSummaryFromMeta(challenger) : null,
          )
        ) {
          winner = challenger
          winnerDir = challengerDir
        }
      }
      if (winner) {
        await this.opts.metaStore.seedMeta(sessionId, winner, winnerDir)
      }
    }
    // After the seeds, so a seed that throws (the whole run retries) never
    // counts a boot against a path twice.
    if (derived.failedPaths.size > 0) {
      const { pending, skipped } =
        await this.opts.metaStore.noteMigrationReadFailures(
          SESSION_META_MIGRATION_V1,
          derived.failedPaths.values(),
        )
      for (const path of skipped) {
        console.warn(
          '[GroupedConversationStorage] session meta migration SKIPPED ' +
            `${path}: its read failed on ${MIGRATION_READ_FAILURE_LIMIT} ` +
            'boots (recorded in meta_migration_failures)',
        )
      }
      if (pending.length > 0) complete = false
    }
    if (!complete) {
      console.warn(
        '[GroupedConversationStorage] session meta migration was incomplete ' +
          '(truncated scan or failed reads); leaving the done-marker unset so ' +
          'the next boot rescans',
      )
      return
    }
    await this.opts.metaStore.markMigration(SESSION_META_MIGRATION_V1)
  }

  /**
   * Read every candidate copy's legacy source in batches and derive a full `SessionMetaFile`, keyed
   * `${projectDir} ${sessionId}`. `failedPaths` holds copies that yielded no meta because a read failed.
   */
  private async deriveMetasBatched(
    candidates: ReadonlyMap<string, string[]>,
  ): Promise<{
    metas: Map<string, SessionMetaFile | null>
    failedPaths: Map<string, string>
  }> {
    const failedPaths = new Map<string, string>()
    const requests: SummarySourceRequest[] = []
    const keys: Array<{
      sessionId: string
      projectDir: string
      kind: SummarySourceKind
    }> = []
    for (const [sessionId, dirs] of candidates) {
      for (const projectDir of dirs) {
        const source = this.summarySourceFor(sessionId, projectDir)
        if (!source) continue
        requests.push(source.request)
        keys.push({ sessionId, projectDir, kind: source.kind })
      }
    }

    const out = new Map<string, SessionMetaFile | null>()
    const chunks = chunkSummaryRequests(requests, keys)
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!
      if (index > 0) {
        // Yield between chunks — background work on the single-threaded worker.
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      let results: SummarySourceResult[]
      try {
        results = await this.opts.readSummarySources(chunk.requests)
      } catch {
        // The chunk's sessions go unseeded THIS run (unless the full-load
        // fallback below recovers them); the unset marker makes the next boot
        // try them again.
        chunk.keys.forEach((key, i) => {
          failedPaths.set(
            `${key.projectDir} ${key.sessionId}`,
            chunk.requests[i]!.path,
          )
        })
        continue
      }
      chunk.keys.forEach((key, i) => {
        const cacheKey = `${key.projectDir} ${key.sessionId}`
        if (isFailedRead(results[i])) {
          failedPaths.set(cacheKey, chunk.requests[i]!.path)
        }
        out.set(
          cacheKey,
          this.deriveFullMeta(key.sessionId, key.kind, chunk.requests[i]!, results[i]),
        )
      })
    }

    // Full-transcript fallback: a new-format transcript carries no legacy
    // record, so its tail yields nothing — rebuild from a full load. Rare (a
    // damaged/absent projection), so the serial cost is fine.
    for (const [sessionId, dirs] of candidates) {
      for (const projectDir of dirs) {
        const cacheKey = `${projectDir} ${sessionId}`
        if (out.get(cacheKey)) continue
        const scan = this.scanned.get(cacheKey)
        if (!scan || scan.transcriptSize <= 0) continue
        try {
          const payload = await this.backendForDir(projectDir).load(sessionId)
          const meta = deriveSessionMetaFromEntries(sessionId, payload)
          if (meta) {
            out.set(cacheKey, meta)
            // Recovered — whatever batched read failed no longer matters.
            failedPaths.delete(cacheKey)
          }
        } catch {
          // best-effort — the session doesn't seed this run, and the unset
          // marker retries it next boot
          if (!failedPaths.has(cacheKey)) {
            failedPaths.set(
              cacheKey,
              getConversationTranscriptPath(projectDir, sessionId),
            )
          }
        }
      }
    }
    return { metas: out, failedPaths }
  }

  /** Decode one batched-read slice into a full `SessionMetaFile` per its source
   *  kind (mirrors the child's `ingestSummarySource`, but returns the whole
   *  meta the seed needs, not a summary). */
  private deriveFullMeta(
    sessionId: string,
    kind: SummarySourceKind,
    request: SummarySourceRequest,
    result: SummarySourceResult | undefined,
  ): SessionMetaFile | null {
    const text =
      result && result.ok && result.bytes
        ? TEXT_DECODER.decode(result.bytes)
        : null
    if (!text) return null
    if (kind === 'meta') {
      return parseSessionMetaFile(text, sessionId)
    }
    return deriveSessionMetaFromText(
      sessionId,
      text,
      kind === 'tail' && (request.offset ?? 0) > 0,
    )
  }

  /**
   * Summaries from the `summaryCache` filled by `listSessions`; a miss falls back to one keyed read.
   * The options are ignored (kept for signature compatibility).
   */
  async loadSessionSummariesBatch(
    sessionIds: readonly string[],
    _options?: { skipCommit?: ReadonlySet<string> },
  ): Promise<Map<string, BrowserSessionSummary>> {
    const summaries = new Map<string, BrowserSessionSummary>()
    const misses: string[] = []
    for (const sessionId of sessionIds) {
      const cached = this.summaryCache.get(sessionId)
      if (cached) {
        summaries.set(sessionId, cached)
      } else {
        misses.push(sessionId)
      }
    }
    for (const sessionId of misses) {
      const stored = await this.opts.metaStore.readStoredMeta(sessionId)
      const summary = stored ? buildSessionSummaryFromMeta(stored.meta) : null
      if (summary && stored) {
        summary.projectDir = this.resolveDir(stored.meta, stored.projectDir)
        summaries.set(sessionId, summary)
      }
    }
    return summaries
  }

  /**
   * Which file to read for a session's summary, from what the scan saw:
   * `meta.json` when it has one, else the migration source — the retired
   * sidecar, else the transcript tail. `forceTail` (the torn-file retry)
   * skips both files and goes straight to the tail.
   */
  private summarySourceFor(
    sessionId: string,
    projectDir: string,
    forceTail = false,
  ): { request: SummarySourceRequest; kind: SummarySourceKind } | null {
    const scan =
      this.scanned.get(`${projectDir} ${sessionId}`) ??
      this.scanned.get(sessionId)
    if (!scan) return null

    if (scan.hasMeta && !forceTail) {
      return {
        request: { path: getConversationMetaPath(projectDir, sessionId) },
        kind: 'meta',
      }
    }

    if (scan.hasLegacyMeta && !forceTail) {
      return {
        request: {
          path: getLegacyConversationMetaSidecarPath(projectDir, sessionId),
        },
        kind: 'legacy-sidecar',
      }
    }

    const size = scan.transcriptSize
    const length = Math.min(SESSION_SUMMARY_TAIL_BYTES, size)
    if (length <= 0) return null
    return {
      request: {
        path: getConversationTranscriptPath(projectDir, sessionId),
        offset: Math.max(0, size - length),
        length,
      },
      kind: 'tail',
    }
  }

  async loadSessionSummary(
    sessionId: string,
    _options?: { migrate?: boolean },
  ): Promise<BrowserSessionSummary | null> {
    const stored = await this.opts.metaStore.readStoredMeta(sessionId)
    if (!stored) return null
    const summary = buildSessionSummaryFromMeta(stored.meta)
    if (summary) {
      // The reconcile routes an unbound session from this — carry the folder.
      summary.projectDir = this.resolveDir(stored.meta, stored.projectDir)
    }
    return summary
  }

  async loadSessionMetadata(
    sessionId: string,
  ): Promise<BrowserSessionMetadata | null> {
    const meta = await this.opts.metaStore.readMeta(sessionId)
    return meta ? metadataFromSessionMeta(meta) : null
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Children carry no store, so the meta row is dropped here (not in `deleteSessionInDir`, a relocation).
    // Row FIRST (it tombstones the id), then files; the caches clear either way.
    const backend = this.backendFor(sessionId)
    try {
      await this.opts.metaStore.deleteMeta(sessionId)
      await backend.deleteSession?.(sessionId)
    } finally {
      this.summaryCache.delete(sessionId)
      this.sessionDir.delete(sessionId)
    }
  }

  /** Cascade the meta rows of a deleted lead's children. Their FILES are
   *  already gone (nested under the lead's directory, swept by
   *  `deleteSession`); this drops the rows that would otherwise leak. */
  async deleteMetaByParent(spawnerSessionId: string): Promise<void> {
    await this.opts.metaStore.deleteMetaByParent(spawnerSessionId)
  }

  /** The TEAMMATE children a lead has on record — `sessionId`, display name,
   *  whether each is already marked shutdown, and (when it is) whether that
   *  marker was written because the child was LOST to a restart rather than
   *  shut down on purpose. One query over the store (the same `listAll` the
   *  sidebar scan runs). `TeamCoordinator.reconcileLost` needs both halves:
   *  the marker alone cannot tell the two apart. */
  async listTeammateChildren(spawnerSessionId: string): Promise<
    Array<{
      sessionId: string
      teammateName?: string
      shutdown: boolean
      lostAt?: number
    }>
  > {
    const all = await this.opts.metaStore.listAll()
    return all
      .filter(
        ({ sessionId, meta }) =>
          isTeammateSessionId(sessionId) &&
          meta.metadata?.spawnerSessionId === spawnerSessionId,
      )
      .map(({ sessionId, meta }) => ({
        sessionId,
        ...(meta.metadata?.teammateName
          ? { teammateName: meta.metadata.teammateName }
          : {}),
        shutdown: meta.metadata?.shutdown === true,
        ...(typeof meta.metadata?.lostAt === 'number'
          ? { lostAt: meta.metadata.lostAt }
          : {}),
      }))
  }

  async saveToolCallDetail(
    sessionId: string,
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    await this.backendFor(sessionId).saveToolCallDetail?.(sessionId, detail)
  }

  async loadToolCallDetail(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    return (
      (await this.backendFor(sessionId).loadToolCallDetail?.(
        sessionId,
        toolCallId,
      )) ?? null
    )
  }

  async loadToolCallDetails(
    sessionId: string,
    toolCallIds: readonly string[],
    unreadable?: Set<string>,
  ): Promise<Map<string, BrowserToolCallDetailRecord>> {
    const backend = this.backendFor(sessionId)
    if (backend.loadToolCallDetails) {
      return backend.loadToolCallDetails(sessionId, toolCallIds, unreadable)
    }
    const found = new Map<string, BrowserToolCallDetailRecord>()
    for (const toolCallId of toolCallIds) {
      const record = await backend.loadToolCallDetail?.(sessionId, toolCallId)
      if (record) found.set(toolCallId, record)
    }
    return found
  }

  async saveSkillEvents(
    sessionId: string,
    events: readonly SkillInvocationEvent[],
  ): Promise<void> {
    await this.backendFor(sessionId).saveSkillEvents?.(sessionId, events)
  }

  async loadSkillEvents(
    sessionId: string,
  ): Promise<SkillInvocationEvent[] | null> {
    return (
      (await this.backendFor(sessionId).loadSkillEvents?.(sessionId)) ?? null
    )
  }
}
