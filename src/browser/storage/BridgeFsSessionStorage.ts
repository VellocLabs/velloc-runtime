import type {
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
  BridgeFsDirentResult,
} from '../bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../bridge/browserBridgeProtocol'
import { sliceReadBatch } from '../bridge/protocol/fs'
import type {
  BrowserConversationStorageBackend,
  BrowserConversationStoragePayload,
  BrowserSessionMetadata,
  BrowserSessionSummary,
  BrowserTranscriptEntry,
  BrowserTranscriptWriteEntry,
  SessionMetaFile,
} from '../../sessions/sessionStore'
import {
  isBrowserAiTitleEntry,
  isBrowserSessionMetaEntry,
  buildSessionSummaryFromMeta,
  deriveSessionMetaFromEntries,
  deriveSessionMetaFromText,
  isMessageLike,
  metadataFromSessionMeta,
  parseSessionMetaFile,
  SESSION_SUMMARY_TAIL_BYTES,
} from '../../sessions/sessionStore'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import type { SkillInvocationEvent } from '../../skillLibrary/skillInvocationLog'
import {
  getConversationMetaPath,
  getConversationSessionDirectoryPath,
  getConversationSkillEventsPath,
  getConversationToolDetailPath,
  getConversationToolDetailsDirectoryPath,
  getConversationTranscriptPath,
  getLegacyConversationMetaSidecarPath,
} from '../../utils/conversationStoragePaths'
import { getSessionTracer } from '../../utils/sessionTrace'
import { stampTranscriptLineCount } from '../../utils/transcriptLineCount'
import type { SqliteSessionMetaStore } from './SqliteSessionMetaStore'
import {
  MIGRATION_READ_FAILURE_LIMIT,
  SESSION_META_MIGRATION_V1,
} from './SqliteSessionMetaStore'

const TEXT_DECODER = new TextDecoder()
const TEXT_ENCODER = new TextEncoder()

/**
 * Files per `fs.readBatch` in `loadToolCallDetails`. Calls run sequentially so
 * the worker serves other sessions between them; no timer yield (it cost ~400 ms on Windows).
 */
const TOOL_DETAIL_BATCH_ITEMS = 32
/** The host's per-call budget answer (nexus_fs_host.cc). Such items were not
 *  read, only deferred — they go into the next call. */
const READ_BATCH_BUDGET_ERROR = 'Batch byte budget exhausted'
/** Single `readFile`s in flight when the batch cannot be used. */
const TOOL_DETAIL_SINGLE_READS_IN_FLIGHT = 6
/** `readToolCallDetail`'s answer for a read that failed, as opposed to null
 *  for a file that is not there. */
const DETAIL_READ_FAILED = Symbol('detail-read-failed')

/** How many deleted session ids a backend remembers to reject late writes for
 *  (see `deletedSessions`). Ample: the race it closes is a round-trip wide. */
const MAX_DELETED_SESSION_TOMBSTONES = 1024

/** LEGACY `__session_meta` line — pre-`meta.json` transcripts carry them.
 *  Kept on load (skipped for the chain) so the one-time migration can read
 *  the last one; never written. */
function isLegacySessionMetaEntry(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === '__session_meta' &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string'
  )
}

/** The one-shot session-title action records (`custom-title` / `ai-title`).
 *  Kept on load so the store can reconcile `meta.json` against the log. */
function isTitleEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const type = (value as { type?: unknown }).type
  return (
    (type === 'custom-title' || type === 'ai-title') &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string'
  )
}

/**
 * Records of which only the LAST valid one counts (`normalizeConversationState`
 * overwrites earlier ones), recognised by their `JSON.stringify` prefix; other spellings parse as usual.
 */
const LAST_ONE_WINS: ReadonlyArray<{ prefix: string; isValid: (value: unknown) => boolean }> = [
  { prefix: '{"type":"__session_meta",', isValid: isBrowserSessionMetaEntry },
  { prefix: '{"type":"ai-title",', isValid: isBrowserAiTitleEntry },
]

/**
 * Physical lines whose parse can be skipped: every `LAST_ONE_WINS` record
 * other than the last one the normalizer accepts. Found by testing prefixes,
 * then parsing from the end until a valid one turns up. When none of a kind
 * is valid, none of that kind is skipped — the load is then exactly as before.
 */
function findSupersededRecordLines(lines: readonly string[]): {
  superseded: Set<number>
  /** The kept records, already parsed — the loop reuses them. */
  parsed: Map<number, unknown>
} {
  const superseded = new Set<number>()
  const parsed = new Map<number, unknown>()
  for (const kind of LAST_ONE_WINS) {
    const candidates: number[] = []
    lines.forEach((line, index) => {
      if (line.startsWith(kind.prefix)) candidates.push(index)
    })
    if (candidates.length < 2) continue
    let kept = -1
    for (let i = candidates.length - 1; i >= 0 && kept < 0; i--) {
      try {
        const value: unknown = JSON.parse(lines[candidates[i]!]!)
        if (kind.isValid(value)) {
          kept = candidates[i]!
          parsed.set(kept, value)
        }
      } catch {
        // torn — keep looking further back
      }
    }
    if (kept < 0) continue
    for (const index of candidates) {
      if (index !== kept) superseded.add(index)
    }
  }
  return { superseded, parsed }
}

/** The host reports a missing file as an ENOENT-style error; anything else is
 *  a read that FAILED (sharing violation, bridge error) — see `readSessionMeta`. */
function isMissingFileError(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|not[ _]found|no such file/i.test(message)
}

function isConversationRecord(
  value: unknown,
): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
    Array.isArray((value as { messages?: unknown }).messages)
  )
}

/** Schema tag on the persisted `skill-events.json` payload. */
const SKILL_EVENTS_SCHEMA_VERSION = 1

/**
 * Validate a parsed `skill-events.json` payload into a clean event array.
 * Lenient: individually malformed events are dropped rather than failing the
 * whole recovery, and a missing `skillPath`/`agentId` is defaulted — so a torn
 * or partially-written sidecar still recovers what it can. Returns null when the
 * top-level shape is unusable (recovery then falls back to the transcript scan).
 */
function parseSkillEventsFile(parsed: unknown): SkillInvocationEvent[] | null {
  const events = (parsed as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) return null
  const out: SkillInvocationEvent[] = []
  for (const raw of events) {
    const e = raw as
      | (Omit<Partial<SkillInvocationEvent>, 'status'> & { status?: unknown })
      | null
    // A sidecar written before the re-entry dedup was removed may carry
    // `duplicated` rows. The body WAS injected (as a short note pointing at the
    // live copy, whose `detailId`/`size` the row carries), so it reads back as
    // `loaded` — dropping it would erase that history on the next rewrite.
    const status =
      e?.status === 'duplicated' ? 'loaded' : e?.status
    if (
      !e ||
      typeof e.id !== 'string' ||
      typeof e.skillName !== 'string' ||
      typeof e.invokedAt !== 'number' ||
      (status !== 'loaded' && status !== 'failed')
    ) {
      continue
    }
    out.push({
      id: e.id,
      skillName: e.skillName,
      skillPath: typeof e.skillPath === 'string' ? e.skillPath : '',
      invokedAt: e.invokedAt,
      status,
      agentId: typeof e.agentId === 'string' ? e.agentId : null,
      ...(typeof e.size === 'number' ? { size: e.size } : {}),
      ...(typeof e.detailId === 'string' ? { detailId: e.detailId } : {}),
      ...(typeof e.error === 'string' ? { error: e.error } : {}),
    })
  }
  return out
}

/** One queued `meta.json` write. `meta` is REPLACED while the job has not
 *  started (latest wins); `promise` is the landing promise every caller
 *  folded into the job receives. */
type MetaWriteJob = {
  meta: SessionMetaFile
  started: boolean
  promise: Promise<void>
}

export type BridgeFsSessionStorageOptions = {
  transport: BrowserBridgeTransport
  basePath: string
  createRequestId?: () => string
  /**
   * The SQLite meta store. When present it is AUTHORITATIVE for every session-meta op and the
   * `meta.json` path below is never reached; grouped-router child backends get none (the router owns meta).
   */
  metaStore?: SqliteSessionMetaStore
}

/**
 * Filesystem-backed session storage over the bridge transport's async fs methods (worker or UI
 * thread). Layout: `{basePath}/{sessionId}/transcript.jsonl` plus `meta.json`.
 */
export class BridgeFsConversationStorageBackend
  implements BrowserConversationStorageBackend
{
  private readonly transport: BrowserBridgeTransport
  private readonly basePath: string
  private readonly createRequestId: () => string
  /** Authoritative session-meta store when present (see options). */
  private readonly metaStore?: SqliteSessionMetaStore
  /** Guards the flat-layout one-time `meta.json` → sqlite migration. */
  private flatMigration?: Promise<void>
  private baseDirEnsured = false
  private readonly ensuredSessionDirs = new Set<string>()
  private readonly ensuredToolDetailDirs = new Set<string>()
  /**
   * Sessions this backend has deleted; writes for them are dropped, or a late write's re-issued
   * `mkdir` would resurrect the deleted directory. Per backend instance (per project dir), so a
   * relocated session keeps writing through its new dir's backend.
   */
  private readonly deletedSessions = new Set<string>()
  /** Sessions whose `skill-events.json` read FAILED (not: was missing) and has
   *  not succeeded since — see `loadSkillEvents`. */
  private readonly skillEventsUnread = new Set<string>()
  /**
   * Per-session `meta.json` write queue (latest wins): a write not yet started is REPLACED by the
   * next, and its callers get the landing promise of the write that carries their state.
   */
  private readonly metaWrites = new Map<string, MetaWriteJob>()
  /** Tail of the per-session chain (never-rejecting, so one failed write
   *  cannot poison every later write for that session). */
  private readonly metaWriteTails = new Map<string, Promise<void>>()
  /**
   * Sessions whose legacy sources this instance has probed and, when a file was derived, written.
   * Set only on SUCCESS; memoizes "probed", never "not a session".
   */
  private readonly legacyProbed = new Set<string>()
  /**
   * Serializes this instance's migration writes from the batched preload: one at a time per
   * backend instance (per project dir), instead of hundreds in parallel at first boot.
   */
  private migrationWrites: Promise<void> = Promise.resolve()
  /** In-flight migrations, memoized as promises (see `migrateLegacySessionMeta`). */
  private readonly legacyMigrations = new Map<
    string,
    Promise<SessionMetaFile | null>
  >()

  constructor(options: BridgeFsSessionStorageOptions) {
    this.transport = options.transport
    this.basePath = options.basePath
    this.metaStore = options.metaStore
    this.createRequestId =
      options.createRequestId ??
      (() => globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}`)
  }

  /** Storage root — lets the runtime anchor sidechain transcripts under the
   *  same tree as the main session transcript (see
   *  `BrowserConversationStorageBackend.getBasePath`). */
  getBasePath(): string | undefined {
    return this.basePath
  }

  async append(
    sessionId: string,
    entry: BrowserTranscriptWriteEntry,
  ): Promise<void> {
    if (this.deletedSessions.has(sessionId)) {
      return
    }
    await this.ensureSessionDir(sessionId)
    const filePath = this.transcriptPath(sessionId)
    const line = JSON.stringify(entry)
    await this.send(createBridgeRoute('fs', 'appendFile'), {
      path: filePath,
      data: TEXT_ENCODER.encode(line + '\n'),
    })
  }

  async load(
    sessionId: string,
  ): Promise<BrowserConversationStoragePayload> {
    const tracer = getSessionTracer()
    const loadSpan = tracer.span('worker.transcript.load', {
      attrs: { sessionId },
    })
    const filePath = this.transcriptPath(sessionId)
    let content: Uint8Array
    const readSpan = tracer.span('worker.fs.readFile', {
      traceId: loadSpan.traceId,
      parentSpanId: loadSpan.spanId,
      attrs: { path: filePath },
    })
    try {
      content = await this.send(createBridgeRoute('fs', 'readFile'), {
        path: filePath,
      })
      readSpan.end({ bytes: content.length })
    } catch {
      readSpan.end({ ok: false })
      loadSpan.end({ ok: false, reason: 'readFile_failed' })
      return null
    }

    const decodedContent = TEXT_DECODER.decode(content)
    // NOT `.filter(Boolean)`. Each entry is stamped below with its
    // PHYSICAL line number, and the search host counts the same way — its
    // ordinal advances for every line in the file, blank ones included,
    // before it decides whether the line is indexable. Dropping blanks
    // first would shift every stamp after the first empty line, and every
    // search jump past it would land on a neighbouring message.
    const lines = decodedContent.split('\n')
    const nonEmpty = lines.filter(line => line.trim().length > 0)
    if (nonEmpty.length === 0) {
      loadSpan.end({ entries: 0 })
      return null
    }

    if (nonEmpty.length === 1) {
      try {
        const single = JSON.parse(nonEmpty[0]!) as unknown
        if (isConversationRecord(single)) {
          loadSpan.end({ entries: 1, shape: 'record' })
          return single as BrowserConversationStoragePayload
        }
        if (Array.isArray(single)) {
          loadSpan.end({ entries: single.length, shape: 'array' })
          return single as BrowserTranscriptEntry[]
        }
      } catch {
        // fall through to JSONL parsing
      }
    }

    const { superseded, parsed: preParsed } = findSupersededRecordLines(lines)
    const entries: BrowserTranscriptEntry[] = []
    for (let physicalLine = 0; physicalLine < lines.length; physicalLine++) {
      const line = lines[physicalLine]!
      if (line.trim().length === 0 || superseded.has(physicalLine)) {
        continue
      }
      try {
        const parsed = (preParsed.get(physicalLine) ?? JSON.parse(line)) as unknown
        if (
          isMessageLike(parsed) ||
          isLegacySessionMetaEntry(parsed) ||
          isTitleEntry(parsed)
        ) {
          // The line this entry came from, counted the way the search host
          // counts. Rendered rows declare the lines they cover from these
          // numbers, which is how a search hit finds its message.
          ;(parsed as { transcriptLine?: number }).transcriptLine = physicalLine
          entries.push(parsed as BrowserTranscriptEntry)
        }
      } catch {
        // skip malformed lines — the counter has already moved past them,
        // so later stamps stay true to the file
      }
    }

    loadSpan.end({ entries: entries.length, shape: 'jsonl' })
    if (entries.length === 0) {
      return null
    }
    // A whole file — newline-terminated — has `lines.length - 1` physical
    // lines, and the next append lands on exactly that line number. A torn
    // last line would merge with the next append, so it carries no count.
    if (decodedContent.endsWith('\n')) {
      stampTranscriptLineCount(entries, lines.length - 1)
    }
    return entries
  }

  async flush(): Promise<void> {}

  /**
   * The session's `meta.json`, or null when missing / torn / another
   * session's. Never creates anything — the sidebar's speculative
   * `reconcilePersistedSessionBinding` reads probe project dirs a session may
   * not live in, and a mkdir here would plant the very stub `rankCopies`
   * exists to paper over.
   */
  async readSessionMeta(sessionId: string): Promise<SessionMetaFile | null> {
    if (this.metaStore) {
      return this.metaStore.readMeta(sessionId)
    }
    return this.readLegacyMetaFile(sessionId)
  }

  /**
   * The session's on-disk `meta.json` (fs), or null when missing / torn /
   * another session's — the legacy read. In the sqlite world this is used ONLY
   * by the migration to seed the DB from the retired file; the live
   * `readSessionMeta` above goes to the store. Any read failure that is NOT
   * "missing" rethrows, so callers don't rebuild over a transient error.
   */
  private async readLegacyMetaFile(
    sessionId: string,
  ): Promise<SessionMetaFile | null> {
    let bytes: Uint8Array
    try {
      bytes = await this.send(createBridgeRoute('fs', 'readFile'), {
        path: this.metaPath(sessionId),
      })
    } catch (error) {
      // Missing is the ordinary answer. Anything else — the host mid-replace
      // (atomic writes swap the file; a reader can lose a sharing-violation
      // retry race), a bridge error — must NOT read as "no file": callers
      // rebuild over a null, and that would erase the unlogged fields.
      if (isMissingFileError(error)) {
        return null
      }
      throw error
    }
    if (bytes.length === 0) {
      return null
    }
    return parseSessionMetaFile(TEXT_DECODER.decode(bytes), sessionId)
  }

  /**
   * Replace the session's `meta.json`. The one write that creates a session
   * on disk (`ensureSessionDir`); tombstone-guarded like every other write.
   * Queued per session, latest wins — see `metaWrites`.
   */
  writeSessionMeta(sessionId: string, meta: SessionMetaFile): Promise<void> {
    if (this.metaStore) {
      return this.metaStore.upsertMeta(sessionId, meta)
    }
    if (this.deletedSessions.has(sessionId)) {
      return Promise.resolve()
    }
    const queued = this.metaWrites.get(sessionId)
    if (queued && !queued.started) {
      // Fold into the pending write: it has not read `meta` yet, so replacing
      // it means the write that lands carries this newer state.
      queued.meta = meta
      return queued.promise
    }

    const job: MetaWriteJob = {
      meta,
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
      await this.ensureSessionDir(sessionId)
      await this.send(createBridgeRoute('fs', 'writeFile'), {
        path: this.metaPath(sessionId),
        content: TEXT_ENCODER.encode(JSON.stringify(job.meta)),
        atomic: true,
      })
    })
    this.metaWrites.set(sessionId, job)
    // The STORED link is the never-rejecting one, so a single failed write
    // cannot poison every later write for this session; callers still get
    // the real promise.
    this.metaWriteTails.set(sessionId, job.promise.catch(() => {}))
    return job.promise
  }

  /**
   * One-time backfill of `meta.json` from the retired `meta.jsonl`, the transcript's 64KB tail, or a
   * full transcript load. A concurrent writer wins; null when nothing on disk describes a session (never mkdirs then).
   */
  async migrateLegacySessionMeta(
    sessionId: string,
  ): Promise<SessionMetaFile | null> {
    if (this.metaStore) {
      // The one-time file→sqlite migration already ran (listSessions); the DB
      // is authoritative, so "migrate" is just a read.
      return this.metaStore.readMeta(sessionId)
    }
    const inFlight = this.legacyMigrations.get(sessionId)
    if (inFlight) {
      return inFlight
    }
    if (this.legacyProbed.has(sessionId)) {
      return this.readSessionMeta(sessionId)
    }
    const run = (async (): Promise<SessionMetaFile | null> => {
      const derived = await this.deriveLegacySessionMeta(sessionId)
      const committed = await this.commitMigratedMeta(sessionId, derived)
      // Only a run that got this far — derived (or proved there is nothing
      // to derive) and landed its write — is memoized. A throw above leaves
      // the session un-probed so the next read tries again.
      this.legacyProbed.add(sessionId)
      return committed
    })()
    // Memoized as a PROMISE while it runs so the batched preload and a
    // concurrent `refreshFsSummary` share one migration instead of racing.
    this.legacyMigrations.set(sessionId, run)
    try {
      return await run
    } finally {
      this.legacyMigrations.delete(sessionId)
    }
  }

  /**
   * The READ-ONLY half of the migration: the `meta.json` a session's legacy
   * sources describe — retired `meta.jsonl` first, else the transcript (tail,
   * then full load) — without writing anything. `loadSessionSummary(…,
   * {migrate: false})` uses it for a session whose own runtime is bound: that
   * store owns `meta.json`, and a manager-side write would race its first
   * persist (the bind backfill, the model pick, the draft).
   */
  private async deriveLegacySessionMeta(
    sessionId: string,
  ): Promise<SessionMetaFile | null> {
    const sidecar = await this.readLegacyMetaSidecarText(sessionId)
    if (sidecar !== null) {
      const fromSidecar = deriveSessionMetaFromText(sessionId, sidecar, false)
      if (fromSidecar) {
        return fromSidecar
      }
    }
    return this.deriveLegacyMetaFromTranscript(sessionId)
  }

  /**
   * Build a summary from bytes already fetched by the batched sidebar preload, with the SAME parse
   * as `loadSessionSummary` / `migrateLegacySessionMeta`. A torn `meta.json` or an empty source
   * yields null; a migration source also writes the derived file (async, best-effort).
   */
  ingestSummarySource(
    sessionId: string,
    source: {
      kind: 'meta' | 'legacy-sidecar' | 'tail'
      text: string | null
      /** Byte offset the tail read started at; 0 for a whole-file read. */
      tailOffset: number
      /**
       * Write the derived `meta.json` back (default). `false` for a read
       * whose result must stay on the reader's side: a live session (its own
       * store owns the file) or a duplicate-copy tiebreak (the loser dir
       * must not gain a stub).
       */
      commit?: boolean
    },
  ): BrowserSessionSummary | null {
    if (source.text === null || source.text.length === 0) {
      return null
    }
    if (source.kind === 'meta') {
      const meta = parseSessionMetaFile(source.text, sessionId)
      return meta ? buildSessionSummaryFromMeta(meta) : null
    }
    // A tail read that started mid-file has a partial first line.
    const derived = deriveSessionMetaFromText(
      sessionId,
      source.text,
      source.kind === 'tail' && source.tailOffset > 0,
    )
    if (!derived) {
      return null
    }
    if (source.commit !== false) {
      // Persist the migration off the batch's critical path; the summary is
      // already in hand. One write at a time per instance (see
      // `migrationWrites`); `commitMigratedMeta` re-reads before writing, and
      // the session is memoized as probed only once that write has landed.
      this.migrationWrites = this.migrationWrites
        .then(async () => {
          await this.commitMigratedMeta(sessionId, derived)
          this.legacyProbed.add(sessionId)
        })
        .catch(() => {})
    }
    return buildSessionSummaryFromMeta(derived)
  }

  /**
   * Sidebar summary for a session — from `meta.json`, one ~1KB whole-file
   * read. Only a session that has NO `meta.json` yet (a pre-migration one)
   * touches its transcript, and only once: the derived file is written back.
   * Deliberately uncached: the read IS the cache, and always reading keeps
   * `refreshFsSummary` (which fires on every streamed message batch) from
   * ever serving a stale draft / model / title.
   */
  async loadSessionSummary(
    sessionId: string,
    options?: { migrate?: boolean },
  ): Promise<BrowserSessionSummary | null> {
    if (this.metaStore) {
      // The DB is authoritative; `migrate`/`skipCommit` no longer apply (a read
      // never writes a derived file under a live session's feet).
      const meta = await this.metaStore.readMeta(sessionId)
      return meta ? buildSessionSummaryFromMeta(meta) : null
    }
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (options?.migrate === false
        ? await this.deriveLegacySessionMeta(sessionId)
        : await this.migrateLegacySessionMeta(sessionId))
    return meta ? buildSessionSummaryFromMeta(meta) : null
  }

  /**
   * The latest persisted metadata with the resolved title folded into
   * `customTitle` — `meta.json` projected the way `getSessionMetadata` is.
   * Used by the fork flow to carry the source's config.
   */
  async loadSessionMetadata(
    sessionId: string,
  ): Promise<BrowserSessionMetadata | null> {
    if (this.metaStore) {
      const meta = await this.metaStore.readMeta(sessionId)
      return meta ? metadataFromSessionMeta(meta) : null
    }
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (await this.migrateLegacySessionMeta(sessionId))
    return meta ? metadataFromSessionMeta(meta) : null
  }

  async listSessions(): Promise<string[]> {
    if (this.metaStore) {
      await this.ensureFlatMigration()
      return (await this.metaStore.listAll()).map(row => row.sessionId)
    }
    return this.listSessionDirsOnDisk()
  }

  /**
   * One-time flat-layout migration: seed the sqlite store from every on-disk
   * `meta.json` (preferred) / legacy source under this backend's base, then
   * mark it done. Grouped mode migrates in the router; this covers the flat
   * fallback layout. Best-effort per session; the transcript files are left in
   * place as inert backups.
   */
  private ensureFlatMigration(): Promise<void> {
    if (!this.flatMigration) {
      this.flatMigration = this.runFlatMigration().catch(() => {
        // A failed run un-memoizes so the next list retries.
        this.flatMigration = undefined
      })
    }
    return this.flatMigration
  }

  private async runFlatMigration(): Promise<void> {
    const store = this.metaStore
    if (!store || (await store.hasMigration(SESSION_META_MIGRATION_V1))) {
      return
    }
    const ids = await this.listSessionDirsOnDisk()
    // The done-marker is written only when EVERY session seeded (or proved it
    // had nothing to seed). A session whose read/seed threw is skipped this
    // run — `seedMeta` is INSERT OR IGNORE, so the rerun is idempotent — and
    // the unset marker makes the next boot retry it instead of losing it.
    // A READ that fails is also counted per path in the store: once the same
    // file has failed on MIGRATION_READ_FAILURE_LIMIT boots it is skipped (its
    // row records it) and stops holding the marker, so one permanently
    // unreadable `meta.json` cannot re-run this on every boot forever.
    let complete = true
    const failedReads: string[] = []
    for (const sessionId of ids) {
      let meta: SessionMetaFile | null
      try {
        meta =
          (await this.readLegacyMetaFile(sessionId)) ??
          (await this.deriveLegacySessionMeta(sessionId))
      } catch {
        // best-effort — one unreadable session must not stall the migration.
        // `readLegacyMetaFile` is the read that throws (missing reads null).
        failedReads.push(this.metaPath(sessionId))
        continue
      }
      try {
        if (meta) {
          await store.seedMeta(sessionId, meta)
        }
      } catch {
        complete = false
      }
    }
    if (failedReads.length > 0) {
      const { pending, skipped } = await store.noteMigrationReadFailures(
        SESSION_META_MIGRATION_V1,
        failedReads,
      )
      for (const path of skipped) {
        console.warn(
          '[BridgeFsSessionStorage] flat session meta migration SKIPPED ' +
            `${path}: its read failed on ${MIGRATION_READ_FAILURE_LIMIT} ` +
            'boots (recorded in meta_migration_failures)',
        )
      }
      if (pending.length > 0) complete = false
    }
    if (!complete) {
      console.warn(
        '[BridgeFsSessionStorage] flat session meta migration was incomplete; ' +
          'leaving the done-marker unset so the next boot retries',
      )
      return
    }
    await store.markMigration(SESSION_META_MIGRATION_V1)
  }

  private async listSessionDirsOnDisk(): Promise<string[]> {
    let entries: BridgeFsDirentResult[]
    try {
      entries = await this.send(createBridgeRoute('fs', 'readdir'), {
        path: this.basePath,
      })
    } catch {
      return []
    }

    const directories = entries.filter(entry => entry.isDirectory)
    if (directories.length === 0) {
      return []
    }

    // A session is a dir with a `meta.json` — an empty New Thread has that and
    // nothing else — or, until it is migrated, a `transcript.jsonl`.
    const pathToSessionId = new Map<string, string>()
    const paths: string[] = []
    for (const entry of directories) {
      for (const path of [
        this.metaPath(entry.name),
        this.transcriptPath(entry.name),
      ]) {
        pathToSessionId.set(path, entry.name)
        paths.push(path)
      }
    }

    try {
      const batchResults = await this.send(
        createBridgeRoute('fs', 'statBatch'),
        { paths },
      )
      const found = new Set<string>()
      for (const result of batchResults) {
        if (!result.stat?.isFile) continue
        const sessionId = pathToSessionId.get(result.path)
        if (sessionId) found.add(sessionId)
      }
      return directories
        .map(entry => entry.name)
        .filter(name => found.has(name))
    } catch {
      // statBatch not supported by host; fall back to individual stat calls
    }

    const sessionIds = await Promise.all(
      directories.map(async entry => {
        for (const path of [
          this.metaPath(entry.name),
          this.transcriptPath(entry.name),
        ]) {
          try {
            const stat = await this.send(createBridgeRoute('fs', 'stat'), {
              path,
            })
            if (stat.isFile) return entry.name
          } catch {
            // try the next marker
          }
        }
        return null
      }),
    )

    return sessionIds.filter(
      (sessionId): sessionId is string => typeof sessionId === 'string',
    )
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Tombstone BEFORE the rm, not after: a write that is already awaiting a
    // bridge round-trip lands somewhere inside this method's own await, and a
    // tombstone set afterwards would miss it.
    this.rememberDeleted(sessionId)
    // Remove the session's meta row when this backend OWNS meta (the flat
    // top-level / worker backend). The grouped router's children carry no store
    // — it deletes the row itself, and `deleteSessionInDir` (a relocation, not
    // a real delete) must NOT drop the row, which is why that stays store-less.
    await this.metaStore?.deleteMeta(sessionId)
    const sessionDirPath = this.sessionDirectoryPath(sessionId)
    try {
      await this.send(createBridgeRoute('fs', 'rm'), {
        path: sessionDirPath,
        recursive: true,
        force: true,
      })
    } catch {
      // directory may not exist
    }
    this.ensuredSessionDirs.delete(sessionId)
    this.ensuredToolDetailDirs.delete(sessionId)
    // The recursive rm took `meta.json` with the directory; drop the queued
    // write state too, so a recreated session id starts from disk rather than
    // from the dead session's pending write.
    this.metaWrites.delete(sessionId)
    this.metaWriteTails.delete(sessionId)
    this.legacyProbed.delete(sessionId)
    this.legacyMigrations.delete(sessionId)
  }

  async saveToolCallDetail(
    sessionId: string,
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    if (this.deletedSessions.has(sessionId)) {
      return
    }
    await this.ensureToolDetailDir(sessionId)
    await this.send(createBridgeRoute('fs', 'writeFile'), {
      path: this.toolDetailPath(sessionId, detail.toolCallId),
      content: TEXT_ENCODER.encode(JSON.stringify(detail)),
      // Whole-file replace: a reader must see the old detail or the new one,
      // never a torn half (same as `writeSessionMeta`).
      atomic: true,
    })
  }

  async loadToolCallDetail(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const read = await this.readToolCallDetail(sessionId, toolCallId)
    return read === DETAIL_READ_FAILED ? null : read
  }

  /** `loadToolCallDetail`, telling a read that FAILED (sharing violation,
   *  bridge error — the file may be there) from one that found no record. */
  private async readToolCallDetail(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null | typeof DETAIL_READ_FAILED> {
    let bytes: Uint8Array
    try {
      bytes = await this.send(createBridgeRoute('fs', 'readFile'), {
        path: this.toolDetailPath(sessionId, toolCallId),
      })
    } catch (error) {
      return isMissingFileError(error) ? null : DETAIL_READ_FAILED
    }
    return parseToolCallDetail(bytes)
  }

  /**
   * `loadToolCallDetail` for many ids via `fs.readBatch`, with identical results: items the batch
   * could not read are re-read singly, and an id whose own read FAILED (not missing) is in `unreadable`.
   */
  async loadToolCallDetails(
    sessionId: string,
    toolCallIds: readonly string[],
    unreadable?: Set<string>,
  ): Promise<Map<string, BrowserToolCallDetailRecord>> {
    const found = new Map<string, BrowserToolCallDetailRecord>()
    const readAlone: string[] = []
    let pending = [...new Set(toolCallIds)]
    let batchUsable = true
    while (pending.length > 0 && batchUsable) {
      const chunk = pending.slice(0, TOOL_DETAIL_BATCH_ITEMS)
      pending = pending.slice(TOOL_DETAIL_BATCH_ITEMS)
      const items = chunk.map(id => ({ path: this.toolDetailPath(sessionId, id) }))
      let entries: ReturnType<typeof sliceReadBatch>
      try {
        entries = sliceReadBatch(
          items,
          await this.send(createBridgeRoute('fs', 'readBatch'), { items }),
        )
      } catch {
        // No `readBatch` on this host, or an answer that does not line up:
        // read this chunk and the rest one by one.
        batchUsable = false
        readAlone.push(...chunk, ...pending)
        pending = []
        break
      }
      const deferred: string[] = []
      entries.forEach((entry, index) => {
        const id = chunk[index]!
        if (entry.ok && entry.bytes) {
          const record = parseToolCallDetail(entry.bytes)
          if (record) found.set(id, record)
          return
        }
        if (entry.error === READ_BATCH_BUDGET_ERROR) deferred.push(id)
        else readAlone.push(id)
      })
      if (deferred.length === chunk.length) {
        // Nothing fit: the budget is not the batch's to solve.
        readAlone.push(...deferred)
      } else {
        pending = [...deferred, ...pending]
      }
    }
    await forEachBounded(readAlone, TOOL_DETAIL_SINGLE_READS_IN_FLIGHT, async id => {
      const record = await this.readToolCallDetail(sessionId, id)
      if (record === DETAIL_READ_FAILED) unreadable?.add(id)
      else if (record) found.set(id, record)
    })
    return found
  }

  /**
   * Persist the session's Skills-tab invocation event log (truncate-and-rewrite,
   * the whole capped array) to its `skill-events.json` sidecar. Tombstone-guarded
   * like every other write; creates the session dir if needed.
   */
  async saveSkillEvents(
    sessionId: string,
    events: readonly SkillInvocationEvent[],
  ): Promise<void> {
    if (this.deletedSessions.has(sessionId)) {
      return
    }
    if (this.skillEventsUnread.has(sessionId)) {
      // The sidecar could not be read, so `events` was never merged with the
      // history in it — this whole-file rewrite would erase that history.
      throw new Error(
        `skill-events.json of ${sessionId} was not readable; not overwriting it`,
      )
    }
    await this.ensureSessionDir(sessionId)
    await this.send(createBridgeRoute('fs', 'writeFile'), {
      path: this.skillEventsPath(sessionId),
      content: TEXT_ENCODER.encode(
        JSON.stringify({ v: SKILL_EVENTS_SCHEMA_VERSION, events }),
      ),
      // Truncate-and-rewrite of the whole log — atomic so a crash mid-write
      // cannot leave a torn sidecar (same as `writeSessionMeta`).
      atomic: true,
    })
  }

  /**
   * The persisted Skills-tab event log, or null when missing / empty / torn. Any other read failure
   * rethrows, and `saveSkillEvents` then refuses to overwrite the file until a load succeeds.
   */
  async loadSkillEvents(
    sessionId: string,
  ): Promise<SkillInvocationEvent[] | null> {
    let bytes: Uint8Array
    try {
      bytes = await this.send(createBridgeRoute('fs', 'readFile'), {
        path: this.skillEventsPath(sessionId),
      })
    } catch (error) {
      if (isMissingFileError(error)) {
        this.skillEventsUnread.delete(sessionId)
        return null
      }
      this.skillEventsUnread.add(sessionId)
      throw error
    }
    this.skillEventsUnread.delete(sessionId)
    if (bytes.length === 0) return null
    try {
      return parseSkillEventsFile(JSON.parse(TEXT_DECODER.decode(bytes)))
    } catch {
      return null
    }
  }

  /** Whole-file read of the retired `meta.jsonl`, or null when there is none. */
  private async readLegacyMetaSidecarText(
    sessionId: string,
  ): Promise<string | null> {
    let bytes: Uint8Array
    try {
      bytes = await this.send(createBridgeRoute('fs', 'readFile'), {
        path: this.legacyMetaSidecarPath(sessionId),
      })
    } catch {
      return null
    }
    return bytes.length === 0 ? null : TEXT_DECODER.decode(bytes)
  }

  /**
   * Migration source #2 / #3: the transcript's 64KB tail, then — when the tail
   * carries no legacy `__session_meta` but the file is non-empty — the whole
   * transcript, which can still describe a session by its messages alone.
   */
  private async deriveLegacyMetaFromTranscript(
    sessionId: string,
  ): Promise<SessionMetaFile | null> {
    const filePath = this.transcriptPath(sessionId)
    let size: number
    try {
      const stat = await this.send(createBridgeRoute('fs', 'stat'), {
        path: filePath,
      })
      if (!stat.isFile || stat.size <= 0) {
        return null
      }
      size = stat.size
    } catch {
      return null
    }

    try {
      const length = Math.min(SESSION_SUMMARY_TAIL_BYTES, size)
      const offset = Math.max(0, size - length)
      const result = await this.send(createBridgeRoute('fs', 'readRange'), {
        path: filePath,
        offset,
        length,
      })
      if (result.bytesRead > 0) {
        const tail = TEXT_DECODER.decode(
          result.data.subarray(0, result.bytesRead),
        )
        const fromTail = deriveSessionMetaFromText(sessionId, tail, offset > 0)
        if (fromTail) {
          return fromTail
        }
      }
    } catch {
      // fall through to the full load
    }

    return deriveSessionMetaFromEntries(sessionId, await this.load(sessionId))
  }

  /**
   * Land a derived `meta.json`: re-read first (a concurrent writer — the
   * session's own store, another sidebar refresh — may have won, and its file
   * is fresher than anything derived from legacy sources), write, then remove
   * the retired sidecar. Only after the write has landed, so a crash between
   * the two never leaves a session with neither.
   */
  private async commitMigratedMeta(
    sessionId: string,
    derived: SessionMetaFile | null,
  ): Promise<SessionMetaFile | null> {
    if (!derived) {
      return null
    }
    const existing = await this.readSessionMeta(sessionId)
    if (existing) {
      return existing
    }
    await this.writeSessionMeta(sessionId, derived)
    try {
      await this.send(createBridgeRoute('fs', 'rm'), {
        path: this.legacyMetaSidecarPath(sessionId),
        recursive: false,
        force: true,
      })
    } catch {
      // best-effort — a leftover sidecar is inert; nothing reads it now
    }
    return derived
  }

  private transcriptPath(sessionId: string): string {
    return getConversationTranscriptPath(this.basePath, sessionId)
  }

  private metaPath(sessionId: string): string {
    return getConversationMetaPath(this.basePath, sessionId)
  }

  private legacyMetaSidecarPath(sessionId: string): string {
    return getLegacyConversationMetaSidecarPath(this.basePath, sessionId)
  }

  private sessionDirectoryPath(sessionId: string): string {
    return getConversationSessionDirectoryPath(this.basePath, sessionId)
  }

  private toolDetailsDirectoryPath(sessionId: string): string {
    return getConversationToolDetailsDirectoryPath(this.basePath, sessionId)
  }

  private toolDetailPath(sessionId: string, toolCallId: string): string {
    return getConversationToolDetailPath(this.basePath, sessionId, toolCallId)
  }

  private skillEventsPath(sessionId: string): string {
    return getConversationSkillEventsPath(this.basePath, sessionId)
  }

  /**
   * Record a deleted session, bounded so a long-lived SharedWorker that
   * deletes thousands of sessions does not grow the set without limit.
   * Evicting the oldest ids is safe: a resurrecting write races its own
   * delete by at most a round-trip, so an id that has since been pushed out
   * by `MAX_DELETED_SESSION_TOMBSTONES` newer deletes can no longer have one
   * in flight. `Set` preserves insertion order, so the first key is oldest.
   */
  private rememberDeleted(sessionId: string): void {
    this.deletedSessions.add(sessionId)
    while (this.deletedSessions.size > MAX_DELETED_SESSION_TOMBSTONES) {
      const oldest = this.deletedSessions.values().next()
      if (oldest.done) break
      this.deletedSessions.delete(oldest.value)
    }
  }

  private async ensureBaseDir(): Promise<void> {
    if (this.baseDirEnsured) return
    try {
      await this.send(createBridgeRoute('fs', 'mkdir'), {
        path: this.basePath,
      })
    } catch {
      // directory may already exist
    }
    this.baseDirEnsured = true
  }

  private async ensureSessionDir(sessionId: string): Promise<void> {
    if (this.ensuredSessionDirs.has(sessionId)) {
      return
    }

    await this.ensureBaseDir()
    try {
      await this.send(createBridgeRoute('fs', 'mkdir'), {
        path: this.sessionDirectoryPath(sessionId),
      })
    } catch {
      // directory may already exist
    }
    this.ensuredSessionDirs.add(sessionId)
  }

  private async ensureToolDetailDir(sessionId: string): Promise<void> {
    if (this.ensuredToolDetailDirs.has(sessionId)) {
      return
    }

    await this.ensureSessionDir(sessionId)
    try {
      await this.send(createBridgeRoute('fs', 'mkdir'), {
        path: this.toolDetailsDirectoryPath(sessionId),
      })
    } catch {
      // directory may already exist
    }
    this.ensuredToolDetailDirs.add(sessionId)
  }

  private async send<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    route: BrowserBridgeRoute<C, A>,
    payload: BrowserBridgeRequestPayload<C, A>,
  ): Promise<BrowserBridgeResult<C, A>> {
    const response = await this.transport.request({
      id: this.createRequestId(),
      route,
      payload,
    }) as { ok: true; result: BrowserBridgeResult<C, A> } | {
      ok: false
      error: { code: string; message: string }
    }
    if (!response.ok) {
      throw new Error(
        `${response.error.code}: ${response.error.message}`,
      )
    }
    return response.result
  }
}

function isToolCallDetailRecord(
  value: unknown,
): value is BrowserToolCallDetailRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toolCallId?: unknown }).toolCallId === 'string' &&
    typeof (value as { toolName?: unknown }).toolName === 'string'
  )
}

/** A detail file's bytes as `loadToolCallDetail` reads them: a valid record,
 *  else null (torn, foreign, not JSON). */
function parseToolCallDetail(bytes: Uint8Array): BrowserToolCallDetailRecord | null {
  try {
    const parsed = JSON.parse(TEXT_DECODER.decode(bytes)) as unknown
    return isToolCallDetailRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Run `task` over `items`, at most `limit` at a time. */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      await task(items[next++]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}
