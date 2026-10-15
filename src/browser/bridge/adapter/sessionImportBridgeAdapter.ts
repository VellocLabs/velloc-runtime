/**
 * `sessionImport` WebUI-bridge adapter — the I/O half of session import, in the
 * SharedWorker. Conversion runs in the window's Worker (a SharedWorker cannot
 * spawn one); bundles go through `SharedWorkerSessionManager.writeSessionBundle`.
 */

import {
  IMPORT_LITE_READ_BYTES,
  IMPORT_PAGE_SIZE,
  type ImportConvertResult,
  type ImportLiteItem,
  type ImportSubAgentBundle,
  type ImportSessionLiteRow,
  type ImportSource,
  type ImportWorkerRequest,
  type ImportWorkerResponse,
} from '../../../sessionImport/protocol'
import { applyAgentTaskAck } from '../../../sessionImport/sources/claude-code/agentTaskAck'
import { TERMINAL_AGENT_SOURCE_ID } from '../../../sessionImport/sources/claude-code/sourceIdentity'
import { sessionUuidFromFileName } from '../../../sessionImport/sources/claude-code/parseLite'
import { sessionIdFromPath as codexSessionIdFromPath } from '../../../sessionImport/sources/codex/parseLite'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import { joinRuntimePath } from '../../../utils/runtimePaths'
import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  BrowserBridgeTransport,
} from '../protocol/core'
import { createBridgeRoute } from '../protocol/core'
import type { SqlValue, SqliteQueryResult } from '../protocol/sqlite'
import {
  sliceReadBatch,
  type BridgeFsReadBatchItem,
  type BridgeFsTreeEntry,
} from '../protocol/fs'
import type {
  DetectedImportSource,
  ImportSessionListRow,
  SessionImportBridgeActionMap,
} from '../protocol/sessionImport'

export type SessionImportAction = keyof SessionImportBridgeActionMap

/** The slice of the session manager the adapter writes through. An
 *  interface (not the class) so tests can hand in a fake. */
export type SessionImportWriter = {
  writeSessionBundle(args: {
    sessionId: string
    entries: ImportConvertResult['entries']
    meta: ImportConvertResult['meta']
    toolDetails: ImportConvertResult['toolDetails']
    projectRoot?: string
    templateType?: string
  }): Promise<void>
  listStoredSessionIds(): Promise<Set<string>>
  hasStoredSession(sessionId: string): Promise<boolean>
  /** Write one imported sub-agent under an already-written parent. */
  writeSubAgentBundle(
    spawnerSessionId: string,
    bundle: ImportSubAgentBundle,
  ): Promise<void>
}

export type SessionImportAdapterContext = {
  /** User home — the root every source locator is relative to. */
  homeDir: string
  fs: RuntimeFs
  /** Direct bridge to C++ for the bulk routes (`readdirTree`, `readBatch`)
   *  that `RuntimeFs` does not expose. `null` on mock hosts → every
   *  action but `detect` answers `import_unavailable`. */
  directBridge: BrowserBridgeTransport | null
  /** `null` when no session manager is active (mock host). */
  writer: SessionImportWriter | null
  /** The lite parse. Defaults to a lazy import of the converter module's
   *  inline runner; tests inject it. */
  runInline?: (request: ImportWorkerRequest) => Promise<ImportWorkerResponse>
}

/** Where a source keeps its sessions and how to recognise one. */
type SourceLocator = {
  /** Sessions root, relative to the user home. */
  rootSegments: string[]
  /** Levels below the root a session file sits at. */
  depth: number
  /** Session id for a relative `'/'`-separated tree path at `depth`, or
   *  null when the file is not a session. */
  sessionIdFor(relativePath: string): string | null
  /** A source whose sessions are NOT a directory scan (e.g. a SQLite thread
   *  index) supplies its own enumeration; when present it REPLACES the tree
   *  scan. Everything downstream (lite read → dedup → convert → write) is
   *  unchanged — the whole provider difference is producing this list. */
  enumerate?(ctx: SessionImportAdapterContext): Promise<SessionFile[]>
}

const SOURCE_LOCATORS: Record<ImportSource, SourceLocator> = {
  // `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl`. Sub-agent transcripts
  // live one level deeper (`<uuid>/subagents/…`) and are not sessions.
  [TERMINAL_AGENT_SOURCE_ID]: {
    rootSegments: ['.claude', 'projects'],
    depth: 2,
    sessionIdFor: relativePath => sessionUuidFromFileName(relativePath),
  },
  // Codex indexes threads in `~/.codex/state_5.sqlite`; transcripts live at
  // `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Enumeration reads
  // the DB (not a tree scan) via the native `sqlite` capability; rootSegments /
  // sessionIdFor stay the read/write path-allow contract for those transcripts.
  codex: {
    rootSegments: ['.codex', 'sessions'],
    depth: 4,
    sessionIdFor: relativePath => codexSessionIdFromPath(relativePath),
    enumerate: enumerateCodexSessions,
  },
}

const IMPORT_SOURCES = Object.keys(SOURCE_LOCATORS) as ImportSource[]

/** Bytes per `fs.readRange` call when reading a whole file for import. */
const IMPORT_READ_CHUNK_BYTES = 2 * 1024 * 1024

function sourceRoot(homeDir: string, source: ImportSource): string {
  return joinRuntimePath(homeDir, ...SOURCE_LOCATORS[source].rootSegments)
}

function createRequestId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)}`
}

class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SessionImportAdapterError'
  }
}

async function defaultRunInline(
  request: ImportWorkerRequest,
): Promise<ImportWorkerResponse> {
  const { runImportRequest } = await import('../../../sessionImport/inline')
  return runImportRequest(request)
}

async function bridgeRequest<T>(
  bridge: BrowserBridgeTransport,
  action: 'readdirTree' | 'readBatch' | 'readRange',
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await bridge.request({
    id: createRequestId(`import-${action}`),
    route: createBridgeRoute('fs', action),
    payload: payload as never,
  })
  if (!response.ok) {
    throw new AdapterError(
      'fs_error',
      `fs.${action}: ${response.error.code}: ${response.error.message}`,
    )
  }
  return response.result as T
}

async function isDirectory(fs: RuntimeFs, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

async function handleDetect(
  ctx: SessionImportAdapterContext,
): Promise<SessionImportBridgeActionMap['detect']['result']> {
  const sources: DetectedImportSource[] = []
  if (!ctx.homeDir) return { sources }
  for (const source of IMPORT_SOURCES) {
    const rootPath = sourceRoot(ctx.homeDir, source)
    if (await isDirectory(ctx.fs, rootPath)) {
      sources.push({ source, rootPath })
    }
  }
  return { sources }
}

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

type SessionFile = {
  /** Absolute path (host separators, built with `joinRuntimePath`). */
  path: string
  sessionId: string
  size: number
  mtimeMs: number
}

/** Every session file under the source root, newest first. */
async function scanSessionFiles(
  bridge: BrowserBridgeTransport,
  source: ImportSource,
  rootPath: string,
): Promise<SessionFile[]> {
  const locator = SOURCE_LOCATORS[source]
  const result = await bridgeRequest<{
    entries?: BridgeFsTreeEntry[]
    truncated?: boolean
  }>(bridge, 'readdirTree', { path: rootPath, maxDepth: locator.depth })
  if (result.truncated) {
    console.warn(
      `[sessionImport] ${source}: session tree scan hit its entry cap; ` +
        'some sessions are not listed',
    )
  }
  const files: SessionFile[] = []
  for (const entry of result.entries ?? []) {
    if (entry.isDirectory || entry.size <= 0) continue
    // Tree paths are '/'-separated on every platform (wire contract).
    if (entry.path.split('/').length !== locator.depth) continue
    const sessionId = locator.sessionIdFor(entry.path)
    if (!sessionId) continue
    files.push({
      path: joinRuntimePath(rootPath, ...entry.path.split('/')),
      sessionId,
      size: entry.size,
      mtimeMs: entry.mtimeMs ?? 0,
    })
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
  return files
}

// --- codex: SQLite-indexed enumeration -------------------------------------

/** Run one `sqlite.query` over the native bridge (same shape as `bridgeRequest`
 *  but for the `sqlite` capability). */
async function sqliteQuery(
  bridge: BrowserBridgeTransport,
  payload: {
    path: string
    sql: string
    params?: SqlValue[]
    copyBeforeOpen?: boolean
    maxRows?: number
  },
): Promise<SqliteQueryResult> {
  const response = await bridge.request({
    id: createRequestId('import-sqlite'),
    route: createBridgeRoute('sqlite', 'query'),
    payload: payload as never,
  })
  if (!response.ok) {
    throw new AdapterError(
      'sqlite_error',
      `sqlite.query: ${response.error.code}: ${response.error.message}`,
    )
  }
  return response.result as SqliteQueryResult
}

function codexRowString(value: SqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function codexRowNumber(value: SqlValue | undefined): number | null {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object' && '$int' in value) {
    const n = Number((value as { $int: string }).$int)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Strip a Windows extended-length prefix (`\\?\D:\…` → `D:\…`) the thread
 *  index can store, so the path matches the sessions root. */
function normalizeCodexPath(path: string): string {
  return path.replace(/^\\\\\?\\/, '')
}

/** Enumerate Codex sessions from `~/.codex/state_5.sqlite` (its thread index)
 *  instead of a directory scan. Reads the DB read-only through a private copy
 *  (Codex may hold it open). `size` is a lite-read sentinel: the lite pass only
 *  needs the head (session_meta + first prompt), and the whole-file read at
 *  import time stats the file itself. mtime comes from the DB. */
async function enumerateCodexSessions(
  ctx: SessionImportAdapterContext,
): Promise<SessionFile[]> {
  const bridge = requireBridge(ctx)
  const dbPath = joinRuntimePath(ctx.homeDir, '.codex', 'state_5.sqlite')
  const rootPath = joinRuntimePath(ctx.homeDir, '.codex', 'sessions')
  let result: SqliteQueryResult
  try {
    result = await sqliteQuery(bridge, {
      path: dbPath,
      sql:
        'SELECT id, rollout_path, updated_at_ms FROM threads ' +
        'WHERE COALESCE(archived, 0) = 0 ORDER BY updated_at_ms DESC LIMIT 5000',
      copyBeforeOpen: true,
    })
  } catch {
    // No thread index (or unreadable) — nothing to list.
    return []
  }
  const files: SessionFile[] = []
  for (const row of result.rows) {
    const sessionId = codexRowString(row[0])
    const rawPath = codexRowString(row[1])
    if (!sessionId || !rawPath) continue
    const path = normalizeCodexPath(rawPath)
    // The rollout must live under ~/.codex/sessions (the path-allow root) so
    // the later read/write path check passes; skip anything else.
    if (!isUnderRoot(path, rootPath)) continue
    files.push({
      path,
      sessionId,
      size: IMPORT_LITE_READ_BYTES,
      mtimeMs: codexRowNumber(row[2]) ?? 0,
    })
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
  return files
}

/** Head + tail text of each file, via as many `fs.readBatch` calls as the
 *  host's byte budget needs. A file at most `2 × lite` bytes is read once. */
async function readLiteSlices(
  bridge: BrowserBridgeTransport,
  files: readonly SessionFile[],
): Promise<ImportLiteItem[]> {
  type Slot = { file: SessionFile; head: string; tail: string }
  const slots: Slot[] = files.map(file => ({ file, head: '', tail: '' }))
  type Want = { slot: Slot; part: 'head' | 'tail' | 'whole'; item: BridgeFsReadBatchItem }
  let wanted: Want[] = []
  for (const slot of slots) {
    const { path, size } = slot.file
    if (size <= IMPORT_LITE_READ_BYTES * 2) {
      wanted.push({ slot, part: 'whole', item: { path, offset: 0, length: size } })
    } else {
      wanted.push({
        slot,
        part: 'head',
        item: { path, offset: 0, length: IMPORT_LITE_READ_BYTES },
      })
      wanted.push({
        slot,
        part: 'tail',
        item: {
          path,
          offset: size - IMPORT_LITE_READ_BYTES,
          length: IMPORT_LITE_READ_BYTES,
        },
      })
    }
  }
  const decoder = new TextDecoder('utf-8')
  // Loop: the host stops at its per-call byte budget and flags `truncated`;
  // the items it did not reach come back `ok:false` and are re-requested.
  while (wanted.length > 0) {
    const items = wanted.map(w => w.item)
    const result = await bridgeRequest<{
      entries: Array<{
        path: string
        ok: boolean
        byteOffset: number
        byteLength: number
        error?: string
      }>
      truncated: boolean
      blob: Uint8Array
    }>(bridge, 'readBatch', { items })
    const sliced = sliceReadBatch(items, result)
    const retry: Want[] = []
    let progressed = false
    sliced.forEach((entry, index) => {
      const want = wanted[index]!
      if (!entry.ok || !entry.bytes) {
        if (result.truncated) retry.push(want)
        // else: unreadable file — leave its slices empty; the row still
        // lists (untitled) and import reports the real error.
        return
      }
      progressed = true
      const text = decoder.decode(entry.bytes)
      if (want.part === 'whole') {
        want.slot.head = text
        want.slot.tail = text
      } else {
        want.slot[want.part] = text
      }
    })
    if (!progressed) break
    wanted = retry
  }
  return slots.map(({ file, head, tail }) => ({
    path: file.path,
    head,
    tail,
    size: file.size,
    mtimeMs: file.mtimeMs,
  }))
}

async function handleListSessions(
  payload: SessionImportBridgeActionMap['listSessions']['payload'],
  ctx: SessionImportAdapterContext,
): Promise<SessionImportBridgeActionMap['listSessions']['result']> {
  const bridge = requireBridge(ctx)
  const source = requireSource(payload.source)
  const rootPath = sourceRoot(ctx.homeDir, source)
  const pageSize = Math.max(1, Math.min(payload.pageSize ?? IMPORT_PAGE_SIZE, 200))
  const locator = SOURCE_LOCATORS[source]
  const files = locator.enumerate
    ? await locator.enumerate(ctx)
    : await scanSessionFiles(bridge, source, rootPath)
  const total = files.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(0, Math.floor(payload.page ?? 0)), pageCount - 1)
  const pageFiles = files.slice(page * pageSize, page * pageSize + pageSize)

  const items = await readLiteSlices(bridge, pageFiles)
  const response = await (ctx.runInline ?? defaultRunInline)({
    id: createRequestId('lite'),
    kind: 'parseLite',
    source,
    items,
  })
  if (!response.ok) {
    throw new AdapterError(response.error.code, response.error.message)
  }
  const liteRows = response.result as ImportSessionLiteRow[]
  const stored = ctx.writer ? await ctx.writer.listStoredSessionIds() : new Set<string>()
  const rows: ImportSessionListRow[] = liteRows.map((row, index) => {
    // The locator's id (from the filename) is authoritative; the lite pass
    // only falls back to the file's own `sessionId` field.
    const sessionId = pageFiles[index]?.sessionId ?? row.sessionId
    return { ...row, sessionId, alreadyImported: stored.has(sessionId) }
  })
  return { source, rootPath, total, page, pageSize, rows }
}

// ---------------------------------------------------------------------------
// readSession / writeSession
// ---------------------------------------------------------------------------

/** The whole file as one buffer, read in `IMPORT_READ_CHUNK_BYTES` ranges
 *  (the bulk routes cap a single read; a transcript can exceed it). */
async function readWholeFile(
  ctx: SessionImportAdapterContext,
  bridge: BrowserBridgeTransport,
  path: string,
): Promise<Uint8Array> {
  const stat = await ctx.fs.stat(path)
  const size = stat.size ?? 0
  const out = new Uint8Array(size)
  let offset = 0
  while (offset < size) {
    const length = Math.min(IMPORT_READ_CHUNK_BYTES, size - offset)
    const result = await bridgeRequest<{ data: Uint8Array; bytesRead: number }>(
      bridge,
      'readRange',
      { path, offset, length },
    )
    const data = result.data ?? new Uint8Array(0)
    const bytesRead = Math.min(result.bytesRead ?? data.byteLength, data.byteLength)
    if (bytesRead <= 0) break
    out.set(data.subarray(0, bytesRead), offset)
    offset += bytesRead
  }
  return offset === size ? out : out.slice(0, offset)
}

/** Validate a UI-supplied path: under the source root and a session file. */
function resolveSessionPath(
  ctx: SessionImportAdapterContext,
  source: ImportSource,
  value: unknown,
): { path: string; sessionId: string } {
  const path = typeof value === 'string' ? value : ''
  const rootPath = sourceRoot(ctx.homeDir, source)
  // Only files under the source root are readable — the path is
  // UI-supplied, and this adapter must not become a generic file reader.
  if (!isUnderRoot(path, rootPath)) {
    throw new AdapterError('invalid_path', 'Path is outside the import source')
  }
  const sessionId = SOURCE_LOCATORS[source].sessionIdFor(path)
  if (!sessionId) {
    throw new AdapterError('invalid_path', 'Not a session file')
  }
  return { path, sessionId }
}

async function handleReadSession(
  payload: SessionImportBridgeActionMap['readSession']['payload'],
  ctx: SessionImportAdapterContext,
): Promise<SessionImportBridgeActionMap['readSession']['result']> {
  const bridge = requireBridge(ctx)
  const source = requireSource(payload.source)
  const writer = requireWriter(ctx)
  const { path, sessionId } = resolveSessionPath(ctx, source, payload.path)
  // Idempotent: the session id is the source's, so "already on disk" is the
  // whole dedup check — before a single byte is read.
  if (await writer.hasStoredSession(sessionId)) {
    return { sessionId, skipped: true }
  }
  const bytes = await readWholeFile(ctx, bridge, path)
  const subagents = await readSubAgentFiles(ctx, bridge, source, path, sessionId)
  return { sessionId, skipped: false, bytes, subagents }
}

const SUBAGENT_FILE_RE = /^agent-(.+)\.jsonl$/
/** Levels below `<session>/subagents/` a transcript may sit at — the source
 *  groups some runs into a subdir (`subagents/workflows/<runId>/`). */
const SUBAGENT_SCAN_DEPTH = 3

/**
 * The session's sub-agent transcripts: every `agent-<id>.jsonl` under
 * `<dir of session file>/<sessionId>/subagents/` (any depth), read whole,
 * with its `agent-<id>.meta.json` sidecar when present. Missing dir → [].
 */
async function readSubAgentFiles(
  ctx: SessionImportAdapterContext,
  bridge: BrowserBridgeTransport,
  source: ImportSource,
  sessionPath: string,
  sessionId: string,
): Promise<
  Array<{
    agentId: string
    path: string
    bytes: Uint8Array
    meta?: { agentType?: string; description?: string }
  }>
> {
  if (source !== TERMINAL_AGENT_SOURCE_ID) return []
  const sessionDir = sessionPath.replace(/[\\/][^\\/]*$/, '')
  const subagentsDir = joinRuntimePath(sessionDir, sessionId, 'subagents')
  if (!(await isDirectory(ctx.fs, subagentsDir))) return []
  const tree = await bridgeRequest<{ entries?: BridgeFsTreeEntry[] }>(
    bridge,
    'readdirTree',
    { path: subagentsDir, maxDepth: SUBAGENT_SCAN_DEPTH },
  )
  const metaPaths = new Set<string>()
  const transcripts: Array<{ agentId: string; relative: string }> = []
  for (const entry of tree.entries ?? []) {
    if (entry.isDirectory) continue
    const name = entry.path.split('/').pop() ?? ''
    if (name.endsWith('.meta.json')) {
      metaPaths.add(entry.path)
      continue
    }
    const match = SUBAGENT_FILE_RE.exec(name)
    if (match && entry.size > 0) {
      transcripts.push({ agentId: match[1]!, relative: entry.path })
    }
  }
  const out = []
  for (const { agentId, relative } of transcripts) {
    const path = joinRuntimePath(subagentsDir, ...relative.split('/'))
    const bytes = await readWholeFile(ctx, bridge, path)
    const metaRelative = relative.replace(/\.jsonl$/, '.meta.json')
    let meta: { agentType?: string; description?: string } | undefined
    if (metaPaths.has(metaRelative)) {
      try {
        const metaPath = joinRuntimePath(subagentsDir, ...metaRelative.split('/'))
        const text = new TextDecoder().decode(await readWholeFile(ctx, bridge, metaPath))
        const parsed = JSON.parse(text) as { agentType?: unknown; description?: unknown }
        meta = {
          ...(typeof parsed.agentType === 'string' ? { agentType: parsed.agentType } : {}),
          ...(typeof parsed.description === 'string'
            ? { description: parsed.description }
            : {}),
        }
      } catch {
        // A torn sidecar only loses the label; the transcript still imports.
      }
    }
    out.push({ agentId, path, bytes, ...(meta ? { meta } : {}) })
  }
  return out
}

/** A transcript entry is well-formed when it is a plain object carrying the
 *  two fields every native record has — a string `type` and a string
 *  `sessionId`. The converter only ever emits `custom-title`/`ai-title`
 *  records and sanitized messages, all of which satisfy this. Junk (numbers,
 *  arrays, bare strings, `null`) is what `storage.append` would serialize
 *  into a JSONL line the transcript loader chokes on. */
function isWellFormedTranscriptEntry(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    typeof (entry as { type?: unknown }).type === 'string' &&
    typeof (entry as { sessionId?: unknown }).sessionId === 'string'
  )
}

/** A sub-agent session id becomes a directory name under the parent's
 *  `subagents/` dir, so the `subagent-<agentId>` suffix must be a single
 *  safe path segment. The agentId can originate in transcript content (the
 *  legacy inline form reads `raw.agentId`), so reject anything that could
 *  redirect the write out of that dir: an empty suffix, a path separator, a
 *  NUL, or a `..`. */
function isSafeSubAgentSessionId(sessionId: string): boolean {
  const agentId = sessionId.slice('subagent-'.length)
  return (
    agentId.length > 0 &&
    !agentId.includes('/') &&
    !agentId.includes('\\') &&
    !agentId.includes('\0') &&
    !agentId.includes('..')
  )
}

async function handleWriteSession(
  payload: SessionImportBridgeActionMap['writeSession']['payload'],
  ctx: SessionImportAdapterContext,
): Promise<SessionImportBridgeActionMap['writeSession']['result']> {
  const source = requireSource(payload.source)
  const writer = requireWriter(ctx)
  const result = payload.result
  if (
    !result ||
    typeof result !== 'object' ||
    result.source !== source ||
    typeof result.sessionId !== 'string' ||
    !Array.isArray(result.entries) ||
    !result.meta ||
    result.meta.sessionId !== result.sessionId
  ) {
    throw new AdapterError('invalid_result', 'Malformed import result')
  }
  // The envelope is structurally sound, but `entries` being an array is not
  // enough — a valid envelope can still carry junk entries (e.g. `[1, 2, 3]`)
  // that `writeSessionBundle` would append verbatim as JSONL. Every entry
  // must be a native record before a byte is written.
  if (!result.entries.every(isWellFormedTranscriptEntry)) {
    throw new AdapterError('invalid_result', 'Malformed transcript entry')
  }
  // The bundle's id must be one the source could have produced — the same
  // check `readSession` applied to the path it came from.
  if (!SOURCE_LOCATORS[source].sessionIdFor(`${result.sessionId}.jsonl`)) {
    throw new AdapterError('invalid_result', 'Not a session id for this source')
  }
  if (await writer.hasStoredSession(result.sessionId)) {
    return { sessionId: result.sessionId, skipped: true }
  }
  // Sub-agents are written BEFORE the parent: transcript storage is append-only and
  // the parent's acks must reflect what landed. Each bundle is validated (safe id,
  // well-formed `entries`, array `toolDetails`); a bad one is skipped.
  const landed: ImportSubAgentBundle[] = []
  for (const bundle of Array.isArray(result.subAgents) ? result.subAgents : []) {
    if (
      !bundle ||
      typeof bundle !== 'object' ||
      typeof bundle.sessionId !== 'string' ||
      !bundle.sessionId.startsWith('subagent-') ||
      !isSafeSubAgentSessionId(bundle.sessionId) ||
      !Array.isArray(bundle.entries) ||
      !bundle.entries.every(isWellFormedTranscriptEntry) ||
      !bundle.meta ||
      bundle.meta.sessionId !== bundle.sessionId ||
      !Array.isArray(bundle.toolDetails) ||
      !bundle.task ||
      typeof bundle.task !== 'object'
    ) {
      continue
    }
    try {
      await writer.writeSubAgentBundle(result.sessionId, bundle)
      landed.push(bundle)
    } catch (error) {
      console.warn(
        `[sessionImport] sub-agent ${bundle.sessionId} not written:`,
        error instanceof Error ? error.message : error,
      )
    }
  }
  // Stamp the launch ack onto the parent's Agent tool result for every sub-agent
  // that landed — and for none that did not, so a failed write leaves no dead
  // "Open in Background Tasks" jump (the converter emits ack-free entries; see
  // agentTaskAck.ts). Mutates `result.entries` in place before the parent write.
  for (const bundle of landed) {
    if (typeof bundle.parentToolCallId === 'string') {
      applyAgentTaskAck(result.entries, bundle.parentToolCallId, bundle.taskId)
    }
  }
  await writer.writeSessionBundle({
    sessionId: result.sessionId,
    entries: result.entries,
    meta: result.meta,
    toolDetails: Array.isArray(result.toolDetails) ? result.toolDetails : [],
    projectRoot: result.projectRoot,
    templateType: result.meta.metadata?.templateType,
  })
  return { sessionId: result.sessionId, skipped: false }
}

function isUnderRoot(path: string, rootPath: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const p = normalize(path)
  const root = normalize(rootPath)
  return p.startsWith(`${root}/`) && !p.includes('/../')
}

function requireBridge(ctx: SessionImportAdapterContext): BrowserBridgeTransport {
  if (!ctx.directBridge) {
    throw new AdapterError('import_unavailable', 'No host bridge is connected')
  }
  if (!ctx.homeDir) {
    throw new AdapterError('import_unavailable', 'No user home directory')
  }
  return ctx.directBridge
}

function requireWriter(ctx: SessionImportAdapterContext): SessionImportWriter {
  if (!ctx.writer) {
    throw new AdapterError('import_unavailable', 'No session store is active')
  }
  return ctx.writer
}

function requireSource(value: unknown): ImportSource {
  if (typeof value === 'string' && value in SOURCE_LOCATORS) {
    return value as ImportSource
  }
  throw new AdapterError('unknown_source', `Unknown import source: ${String(value)}`)
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function handleSessionImportBridgeRequest(
  request: BrowserBridgeRequest,
  ctx: SessionImportAdapterContext,
): Promise<BrowserBridgeResponse> {
  const action = request.route.action as SessionImportAction
  try {
    let result: SessionImportBridgeActionMap[SessionImportAction]['result']
    switch (action) {
      case 'detect':
        result = await handleDetect(ctx)
        break
      case 'listSessions':
        result = await handleListSessions(
          request.payload as SessionImportBridgeActionMap['listSessions']['payload'],
          ctx,
        )
        break
      case 'readSession':
        result = await handleReadSession(
          request.payload as SessionImportBridgeActionMap['readSession']['payload'],
          ctx,
        )
        break
      case 'writeSession':
        result = await handleWriteSession(
          request.payload as SessionImportBridgeActionMap['writeSession']['payload'],
          ctx,
        )
        break
      default: {
        const _exhaustive: never = action
        return {
          id: request.id,
          route: request.route,
          ok: false,
          error: {
            code: 'unknown_action',
            message: `Unknown sessionImport action: ${String(_exhaustive)}`,
          },
        }
      }
    }
    return { id: request.id, route: request.route, ok: true, result }
  } catch (error) {
    return {
      id: request.id,
      route: request.route,
      ok: false,
      error: {
        code: error instanceof AdapterError ? error.code : 'import_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
