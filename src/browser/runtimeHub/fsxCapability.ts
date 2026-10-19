/**
 * Security: `fsx` — the runtime's file capability for clients; the C++ `fs` routes are never
 * advertised. `full` (the local desktop) resolves any path. Below `full` a path must stay inside the
 * session's project root or cwd, checked on the literal path AND on the host's realpath (or, for a
 * missing path, its nearest existing ancestor's), against both forms of each root; else
 * `forbidden_scope`. `~/.velloc` (credentials, every transcript) is excluded even inside a root;
 * a root strictly inside it (an unbound session's shared workspace) reaches only itself.
 * Uploads land where the runtime decides, under `<cwd>/.velloc/uploads/<session>/`.
 * Directory listings (`listDir`, `listTree`) are root-bound like reads; the tree is walked here,
 * one `fs.readdir` per directory, so VCS, dependency and runtime directories can be left out, and
 * below `full` every directory is root-checked before the walk enters it: the host reports no links
 * from a directory read, so a junction out of the project reads as a directory and only the
 * realpath check catches it.
 * File search (`findFiles`, `searchText`) root-checks the searched folder like `listDir`, then hands it
 * to `FsxSearchService`, which never leaves it.
 */
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { checkWithinRoot } from '../../permissions/untrustedReadBoundary'
import { getNexusWorkspaceDir } from '../../utils/conversationStoragePaths'
import {
  basenameRuntimePath,
  dirnameRuntimePath,
  isAbsoluteRuntimePath,
  joinRuntimePath,
  relativeRuntimePath,
  resolveRuntimePath,
} from '../../utils/runtimePaths'
import {
  FSX_ACTION_SCOPES,
  FSX_CAPABILITY,
  FSX_FIND_MAX_LIMIT,
  FSX_LIST_MAX_ENTRIES,
  FSX_SEARCH_QUERY_MAX_LENGTH,
  FSX_SEARCH_TEXT_MAX_LIMIT,
  FSX_STAT_BATCH_MAX_PATHS,
  FSX_TREE_DEFAULT_DEPTH,
  FSX_TREE_MAX_DEPTH,
  FSX_TREE_MAX_ENTRIES,
  isBlobRef,
  wireError,
  type FsxCancelSearchPayload,
  type FsxCommitUploadPayload,
  type FsxCommitUploadResult,
  type FsxDirEntry,
  type FsxFindFilesPayload,
  type FsxListDirPayload,
  type FsxListDirResult,
  type FsxListTreePayload,
  type FsxListTreeResult,
  type FsxReadBlobResult,
  type FsxReadPayload,
  type FsxReadTextResult,
  type FsxSearchStartResult,
  type FsxSearchTextPayload,
  type FsxStatBatchPayload,
  type FsxStatBatchResult,
  type FsxStatEntry,
  type FsxTreeEntry,
  type FsxUserHomeResult,
  type FsxWriteTextPayload,
} from '../runtimeProtocol'
import type { CapabilityRegistry } from './CapabilityRegistry'
import type { FsxSearchService } from './fsxSearch'
import { callHostFs, hostOf, resolveHostHome } from './hostFs'
import type { ActionSpec, HandlerRequest, HostBridge, RuntimeContext } from './types'

export type FsxSessionRoots = { cwd: string; projectRoot?: string }

export type FsxHost = {
  /** The session's cwd and project root, or `null` for a session this runtime does not hold. */
  sessionRoots(sessionId: string): FsxSessionRoots | null
}

type Dict = Record<string, unknown>
const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

function isReadPayload(value: unknown): value is FsxReadPayload {
  return isDict(value) && isNonEmptyString(value.sessionId) && isNonEmptyString(value.path)
}

function isStatBatchPayload(value: unknown): value is FsxStatBatchPayload {
  return (
    isDict(value) &&
    isNonEmptyString(value.sessionId) &&
    Array.isArray(value.paths) &&
    value.paths.length <= FSX_STAT_BATCH_MAX_PATHS &&
    value.paths.every(isNonEmptyString)
  )
}

function isListDirPayload(value: unknown): value is FsxListDirPayload {
  return isReadPayload(value)
}

function isListTreePayload(value: unknown): value is FsxListTreePayload {
  if (!isReadPayload(value)) return false
  const depth = (value as Dict).depth
  return (
    depth === undefined ||
    (typeof depth === 'number' && Number.isInteger(depth) && depth >= 1 && depth <= FSX_TREE_MAX_DEPTH)
  )
}

const isOptionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean'
const isOptionalLimit = (value: unknown, max: number): boolean =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max)
const isSearchQuery = (value: unknown): value is string =>
  isNonEmptyString(value) && value.length <= FSX_SEARCH_QUERY_MAX_LENGTH

function isFindFilesPayload(value: unknown): value is FsxFindFilesPayload {
  if (!isReadPayload(value)) return false
  const payload = value as Dict
  return isSearchQuery(payload.query) && isOptionalLimit(payload.limit, FSX_FIND_MAX_LIMIT) && isOptionalBoolean(payload.refresh)
}

function isSearchTextPayload(value: unknown): value is FsxSearchTextPayload {
  if (!isReadPayload(value)) return false
  const payload = value as Dict
  return (
    isSearchQuery(payload.query) &&
    isOptionalLimit(payload.limit, FSX_SEARCH_TEXT_MAX_LIMIT) &&
    isOptionalBoolean(payload.caseSensitive) &&
    isOptionalBoolean(payload.wholeWord) &&
    isOptionalBoolean(payload.regex)
  )
}

function isCancelSearchPayload(value: unknown): value is FsxCancelSearchPayload {
  return isDict(value) && isNonEmptyString(value.searchId)
}

function isWriteTextPayload(value: unknown): value is FsxWriteTextPayload {
  return isReadPayload(value) && typeof (value as Dict).text === 'string'
}

function isCommitUploadPayload(value: unknown): value is FsxCommitUploadPayload {
  return (
    isDict(value) &&
    isNonEmptyString(value.sessionId) &&
    isBlobRef(value.blob) &&
    isNonEmptyString(value.name)
  )
}

const sessionOf = (payload: unknown): string | undefined =>
  isDict(payload) && typeof payload.sessionId === 'string' ? payload.sessionId : undefined

/** A file name safe to create in the uploads directory: no separators, no oddities. */
export function sanitizeUploadFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? name
  const safeName = base.replace(/[^a-zA-Z0-9._-]/g, '_')
  return safeName || 'attachment'
}

/** One path segment of the uploads layout (the session id, the random prefix). */
export function sanitizeUploadPathSegment(value: string, fallback = 'attachment'): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '_')
  return sanitized || fallback
}

async function realpathOrNull(host: HostBridge, path: string): Promise<string | null> {
  try {
    // `resolveLinks`: the default form does not follow Windows junctions, so a
    // link under the root pointing out of it would pass. An older host ignores
    // the key and answers the default form.
    const result = await callHostFs<{ path?: unknown }>(host, 'realpath', { path, resolveLinks: true })
    return typeof result?.path === 'string' && result.path ? result.path : null
  } catch {
    // Missing, or unresolvable: the literal check still applies.
    return null
  }
}

/**
 * Security: the roots a scoped path is judged against (project root and cwd, as given and resolved),
 * each with the excluded `~/<runtime dir>` forms that apply to it. `realpaths` memoises the host's
 * answers per request.
 */
type RootForms = {
  forms: ReadonlyMap<string, readonly string[]>
  realpaths: Map<string, Promise<string | null>>
}

/** Is `path` below `tree`, and not `tree` itself? */
function isStrictlyInside(tree: string, path: string): boolean {
  const rel = relativeRuntimePath(tree, path)
  return rel !== '' && rel !== '.' && !rel.startsWith('..') && !isAbsoluteRuntimePath(rel)
}

/** `realpathOrNull`, asked once per path per request (`RootForms.realpaths`). */
function realpathMemo(host: HostBridge, memo: Map<string, Promise<string | null>>, path: string): Promise<string | null> {
  let pending = memo.get(path)
  if (!pending) {
    pending = realpathOrNull(host, path)
    memo.set(path, pending)
  }
  return pending
}

/** The user's home for a scoped check: the runtime's, else the host's; '' when neither knows. */
function scopedHomeOf(ctx: RuntimeContext): Promise<string> {
  return resolveHostHome(ctx).catch(() => '')
}

/** Resolved ONCE per request, so a large `statBatch` asks the host about each root once. */
async function rootFormsOf(host: HostBridge, roots: FsxSessionRoots, homeDir: string): Promise<RootForms> {
  // Security: fail closed — with no home the excluded tree cannot be placed.
  if (!homeDir) throw wireError('forbidden_scope', 'the user home is not known, so scoped file access is refused')
  const realpaths = new Map<string, Promise<string | null>>()
  const rootPaths = new Set<string>()
  for (const root of new Set([roots.projectRoot, roots.cwd])) {
    if (!root) continue
    rootPaths.add(root)
    const real = await realpathMemo(host, realpaths, root)
    if (real) rootPaths.add(real)
  }
  // The excluded tree in both forms too, like the roots: with a home
  // directory that is a link (`/home/me` -> `/data/me`) the resolved path of
  // `~/<runtime dir>` sits inside the resolved root and outside the literal
  // exclusion, and a request naming it would have read the credentials file.
  const excluded: string[] = []
  const literal = joinRuntimePath(homeDir, RUNTIME_DIR_NAME)
  excluded.push(literal)
  const real = await realpathMemo(host, realpaths, literal)
  if (real && real !== literal) excluded.push(real)
  const sandbox = getNexusWorkspaceDir(homeDir)
  // Security: a root strictly inside the shared sandbox (literal or resolved) is confined to its
  // own subtree, so the excluded tree's exclusion would refuse the whole root. Any other root
  // inside the excluded tree — the bare sandbox, which holds every per-type sandbox, or the tree
  // itself — keeps it.
  const forms = new Map<string, readonly string[]>()
  for (const root of rootPaths) {
    const inside = excluded.filter(tree => isStrictlyInside(tree, root))
    let ownSandbox = false
    if (inside.length > 0) {
      const realSandbox = await realpathMemo(host, realpaths, sandbox)
      ownSandbox = [sandbox, realSandbox].some(form => !!form && isStrictlyInside(form, root))
    }
    forms.set(root, ownSandbox ? excluded.filter(tree => !inside.includes(tree)) : excluded)
  }
  return { forms, realpaths }
}

/**
 * The host's realpath of `abs`, or — for a path that does not exist yet —
 * the realpath of its nearest existing ancestor with the missing tail joined
 * back on. A leaf about to be created under `<root>/link/` has no realpath
 * of its own, but the host WILL follow the link when it writes, so the
 * directory the write lands in is what has to be checked. `null` when no
 * ancestor resolves either (the host cannot say where the path leads).
 */
async function realpathOfNearest(
  host: HostBridge,
  abs: string,
  memo: Map<string, Promise<string | null>>,
): Promise<string | null> {
  const real = await realpathMemo(host, memo, abs)
  if (real) return real
  const tail: string[] = []
  let ancestor = abs
  for (;;) {
    const parent = dirnameRuntimePath(ancestor)
    if (parent === ancestor || parent === '.') return null
    tail.unshift(basenameRuntimePath(ancestor))
    ancestor = parent
    const realAncestor = await realpathMemo(host, memo, ancestor)
    if (realAncestor) return joinRuntimePath(realAncestor, ...tail)
  }
}

/**
 * `null` when the connection may touch `abs`, else why not. `full` is never
 * asked. Both the literal path and its realpath must sit inside some form of
 * some root and outside every excluded tree (`rootFormsOf`). A path the host
 * cannot place at all (no existing ancestor) is refused: the literal check
 * alone is what a link would slip past.
 */
async function rootViolation(
  host: HostBridge,
  abs: string,
  rootForms: RootForms,
): Promise<string | null> {
  const candidates = [abs]
  const real = await realpathOfNearest(host, abs, rootForms.realpaths)
  if (real === null) return `'${abs}' cannot be resolved on the host`
  if (real !== abs) candidates.push(real)
  for (const candidate of candidates) {
    const inside = Array.from(rootForms.forms).some(
      ([root, excluded]) => checkWithinRoot(candidate, root, excluded).ok,
    )
    if (!inside) return `'${candidate}' is outside this session's project`
  }
  return null
}

/** `rootForms` is `null` for `full`, else the request's memoised roots for further checks. */
type Resolved = { abs: string; roots: FsxSessionRoots; host: HostBridge; rootForms: RootForms | null }

function rootsOf(host: FsxHost, sessionId: string): FsxSessionRoots {
  const roots = host.sessionRoots(sessionId)
  if (!roots) throw wireError('not_found', `no session '${sessionId}'`)
  return roots
}

async function resolveForConnection(
  request: HandlerRequest,
  ctx: RuntimeContext,
  fsxHost: FsxHost,
  sessionId: string,
  path: string,
): Promise<Resolved> {
  const roots = rootsOf(fsxHost, sessionId)
  const host = hostOf(ctx)
  const abs = resolveRuntimePath(roots.cwd, path)
  let rootForms: RootForms | null = null
  if (request.conn.scope.mode !== 'full') {
    rootForms = await rootFormsOf(host, roots, await scopedHomeOf(ctx))
    const violation = await rootViolation(host, abs, rootForms)
    if (violation) throw wireError('forbidden_scope', violation)
  }
  return { abs, roots, host, rootForms }
}

async function ensureDirectory(host: HostBridge, path: string): Promise<void> {
  if (await callHostFs<boolean>(host, 'exists', { path })) return
  try {
    await callHostFs(host, 'mkdir', { path })
  } catch (error) {
    // Lost a race with another writer: fine if it is there now.
    if (!(await callHostFs<boolean>(host, 'exists', { path }))) throw error
  }
}

type StatResult = { isFile?: boolean; isDirectory?: boolean; size?: number } | null

/** Root checks in flight at once in a scoped `statBatch`: each is host round trips. */
const STAT_BATCH_CHECKS_IN_FLIGHT = 8

/** `work` over `items`, at most `limit` at once, started in order; results in item order. */
async function mapInFlight<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

async function statBatch(
  request: HandlerRequest<FsxStatBatchPayload>,
  ctx: RuntimeContext,
  fsxHost: FsxHost,
): Promise<FsxStatBatchResult> {
  const { sessionId, paths } = request.payload
  const roots = rootsOf(fsxHost, sessionId)
  const host = hostOf(ctx)
  const absent = (path: string): FsxStatEntry => ({ path, exists: false, isFile: false, isDirectory: false })
  // Which requested paths this connection may see; the rest read as absent.
  const rootForms = request.conn.scope.mode === 'full' ? null : await rootFormsOf(host, roots, await scopedHomeOf(ctx))
  const resolved = paths.map(path => ({ path, abs: resolveRuntimePath(roots.cwd, path) }))
  let visible: Array<{ path: string; abs: string }>
  if (rootForms === null) {
    visible = resolved
  } else {
    // The checks are independent host round trips (several per absent path,
    // down its ancestors): a few at a time, in request order, not one by one.
    const allowed = await mapInFlight(
      resolved,
      STAT_BATCH_CHECKS_IN_FLIGHT,
      async entry => (await rootViolation(host, entry.abs, rootForms)) === null,
    )
    visible = resolved.filter((_, index) => allowed[index])
  }
  const stats = new Map<string, StatResult>()
  if (visible.length > 0) {
    try {
      const batch = await callHostFs<Array<{ path: string; stat: StatResult }>>(host, 'statBatch', {
        paths: visible.map(entry => entry.abs),
      })
      batch.forEach((entry, index) => stats.set(visible[index]!.abs, entry.stat))
    } catch {
      // An older host without `fs.statBatch`: one `fs.stat` each, a rejection
      // meaning "not there" — an answer here, not an error.
      for (const entry of visible) {
        stats.set(entry.abs, await callHostFs<StatResult>(host, 'stat', { path: entry.abs }).catch(() => null))
      }
    }
  }
  const byPath = new Map(visible.map(entry => [entry.path, entry.abs]))
  return paths.map(path => {
    const abs = byPath.get(path)
    const stat = abs !== undefined ? stats.get(abs) : null
    if (!stat) return absent(path)
    return { path, exists: true, isFile: stat.isFile === true, isDirectory: stat.isDirectory === true }
  })
}

/**
 * Directories a `listTree` walk never enters, at any depth: VCS internals, dependency trees and
 * the runtime's own directory. The host's `readdirTree` has no exclude list, so with a
 * `node_modules` present its row cap would fill with dependencies before the project's own files.
 */
export const FSX_TREE_SKIPPED_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', RUNTIME_DIR_NAME])

/** Host calls in flight at once in a `listTree` walk. */
const TREE_WALK_CALLS_IN_FLIGHT = 8

/** Most paths the host's `fs.statBatch` accepts in one call. */
const HOST_STAT_BATCH_MAX_PATHS = 2000

type HostDirent = { name?: unknown; isFile?: unknown; isDirectory?: unknown; isSymbolicLink?: unknown }

function toDirEntry(raw: HostDirent): FsxDirEntry | null {
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null
  return {
    name: raw.name,
    isFile: raw.isFile === true,
    isDirectory: raw.isDirectory === true,
    isSymbolicLink: raw.isSymbolicLink === true,
  }
}

/** Folders first, then names case-insensitively; equal names fall back to the exact spelling. */
function compareDirEntries(left: FsxDirEntry, right: FsxDirEntry): number {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
  const a = left.name.toLowerCase()
  const b = right.name.toLowerCase()
  if (a !== b) return a < b ? -1 : 1
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/** `fs.readdir` of `abs`, sorted. A directory that is not there is `not_found`; a file is `conflict`. */
async function readDirectory(host: HostBridge, abs: string): Promise<FsxDirEntry[]> {
  let raw: unknown
  try {
    raw = await callHostFs<unknown>(host, 'readdir', { path: abs })
  } catch (error) {
    // The host's readdir failure names no cause; what is at the path decides.
    const stat = await callHostFs<StatResult>(host, 'stat', { path: abs }).catch(() => null)
    if (!stat) throw wireError('not_found', `no directory '${abs}'`)
    if (!stat.isDirectory) throw wireError('conflict', `'${abs}' is not a directory`)
    throw error
  }
  if (!Array.isArray(raw)) return []
  return (raw as HostDirent[]).flatMap(entry => toDirEntry(entry) ?? []).sort(compareDirEntries)
}

async function listDir(
  request: HandlerRequest<FsxListDirPayload>,
  ctx: RuntimeContext,
  fsxHost: FsxHost,
): Promise<FsxListDirResult> {
  const { sessionId, path } = request.payload
  const { abs, host } = await resolveForConnection(request, ctx, fsxHost, sessionId, path)
  const entries = await readDirectory(host, abs)
  const truncated = entries.length > FSX_LIST_MAX_ENTRIES
  return { entries: truncated ? entries.slice(0, FSX_LIST_MAX_ENTRIES) : entries, truncated }
}

/** The byte size of each file, by absolute path, from `fs.statBatch`; a file the host cannot stat is absent. */
async function fileSizes(host: HostBridge, paths: readonly string[]): Promise<Map<string, number>> {
  const chunks: string[][] = []
  for (let start = 0; start < paths.length; start += HOST_STAT_BATCH_MAX_PATHS) {
    chunks.push(paths.slice(start, start + HOST_STAT_BATCH_MAX_PATHS))
  }
  const batches = await mapInFlight(chunks, TREE_WALK_CALLS_IN_FLIGHT, chunk =>
    callHostFs<Array<{ path: string; stat: StatResult }>>(host, 'statBatch', { paths: chunk }).catch(() => []),
  )
  const sizes = new Map<string, number>()
  for (const batch of batches) {
    if (!Array.isArray(batch)) continue
    for (const entry of batch) {
      if (typeof entry?.stat?.size === 'number') sizes.set(entry.path, entry.stat.size)
    }
  }
  return sizes
}

/**
 * A breadth-first walk of `fs.readdir` calls: one level is complete before the next starts, so
 * a cut at the cap keeps the shallow entries, the ones a tree shows first. A directory that
 * cannot be read below the root (gone, unreadable) is skipped. Security: below `full` a directory
 * is entered only when `rootViolation` clears it, like a `readText` of it would be — the host's
 * dirents never flag a link, so a junction out of the project is a plain directory to them and
 * would otherwise be walked. Such a directory is listed, not entered.
 */
async function listTree(
  request: HandlerRequest<FsxListTreePayload>,
  ctx: RuntimeContext,
  fsxHost: FsxHost,
): Promise<FsxListTreeResult> {
  const { sessionId, path, depth = FSX_TREE_DEFAULT_DEPTH } = request.payload
  const { abs, host, rootForms } = await resolveForConnection(request, ctx, fsxHost, sessionId, path)
  type Dir = { abs: string; rel: string; level: number }
  const entries: FsxTreeEntry[] = []
  const filesByAbs: Array<{ abs: string; index: number }> = []
  let truncated = false
  let pending: Dir[] = []
  const take = (parent: Dir | null, listed: FsxDirEntry[]): void => {
    for (const entry of listed) {
      if (entry.isDirectory && FSX_TREE_SKIPPED_DIRS.has(entry.name)) continue
      if (entries.length >= FSX_TREE_MAX_ENTRIES) {
        truncated = true
        return
      }
      const rel = parent ? `${parent.rel}/${entry.name}` : entry.name
      const level = parent ? parent.level + 1 : 1
      if (!entry.isDirectory) filesByAbs.push({ abs: joinRuntimePath(abs, ...rel.split('/')), index: entries.length })
      entries.push({ path: rel, isDirectory: entry.isDirectory, size: 0 })
      if (entry.isDirectory && level < depth) {
        pending.push({ abs: joinRuntimePath(abs, ...rel.split('/')), rel, level })
      }
    }
  }
  take(null, await readDirectory(host, abs))
  while (pending.length > 0 && !truncated) {
    const level = pending
    pending = []
    const enterable = rootForms
      ? await mapInFlight(level, TREE_WALK_CALLS_IN_FLIGHT, async dir => (await rootViolation(host, dir.abs, rootForms)) === null)
      : level.map(() => true)
    const listings = await mapInFlight(
      level.map((dir, index) => ({ dir, enter: enterable[index] === true })),
      TREE_WALK_CALLS_IN_FLIGHT,
      ({ dir, enter }) => (enter ? readDirectory(host, dir.abs).catch((): FsxDirEntry[] => []) : Promise.resolve([])),
    )
    for (let index = 0; index < level.length && !truncated; index += 1) take(level[index]!, listings[index]!)
  }
  const sizes = await fileSizes(host, filesByAbs.map(file => file.abs))
  for (const file of filesByAbs) {
    const size = sizes.get(file.abs)
    if (size !== undefined) entries[file.index]!.size = size
  }
  return { entries, truncated }
}

/** The folder a search runs in: root-checked like a listing; `not_found` when missing, `conflict` for a file. */
async function searchRoot(
  request: HandlerRequest<FsxReadPayload>,
  ctx: RuntimeContext,
  fsxHost: FsxHost,
  search: FsxSearchService | undefined,
): Promise<{ abs: string; search: FsxSearchService }> {
  const { sessionId, path } = request.payload
  const { abs, host } = await resolveForConnection(request, ctx, fsxHost, sessionId, path)
  if (!search) throw wireError('host_unavailable', 'file search is not available in this runtime')
  const stat = await callHostFs<StatResult>(host, 'stat', { path: abs }).catch(() => null)
  if (!stat) throw wireError('not_found', `no directory '${abs}'`)
  if (!stat.isDirectory) throw wireError('conflict', `'${abs}' is not a directory`)
  return { abs, search }
}

async function commitUpload(
  request: HandlerRequest<FsxCommitUploadPayload>,
  ctx: RuntimeContext,
  fsxHost: FsxHost,
): Promise<FsxCommitUploadResult> {
  const { sessionId, blob, name } = request.payload
  const roots = rootsOf(fsxHost, sessionId)
  const host = hostOf(ctx)
  const content = await request.blobs.receive(blob, request.signal)
  const runtimeDir = joinRuntimePath(roots.cwd, RUNTIME_DIR_NAME)
  const uploadsDir = joinRuntimePath(runtimeDir, 'uploads')
  const sessionDir = joinRuntimePath(uploadsDir, sanitizeUploadPathSegment(sessionId, 'session'))
  await ensureDirectory(host, runtimeDir)
  await ensureDirectory(host, uploadsDir)
  await ensureDirectory(host, sessionDir)
  const prefix = sanitizeUploadPathSegment(crypto.randomUUID().slice(0, 8))
  const path = joinRuntimePath(sessionDir, `${prefix}-${sanitizeUploadFileName(name)}`)
  await callHostFs(host, 'writeFile', { path, content })
  return { path }
}

/** `search` serves `findFiles` / `searchText` / `cancelSearch`; without it they answer `host_unavailable`. */
export function registerFsxCapability(
  registry: CapabilityRegistry,
  fsxHost: FsxHost,
  search?: FsxSearchService,
): void {
  const spec = (action: keyof typeof FSX_ACTION_SCOPES, guard: (payload: unknown) => boolean): ActionSpec => ({
    scope: FSX_ACTION_SCOPES[action],
    sessionOf,
    guard,
  })
  registry.registerCapability({
    cap: FSX_CAPABILITY,
    actions: {
      userHome: { scope: FSX_ACTION_SCOPES.userHome },
      statBatch: spec('statBatch', isStatBatchPayload),
      readText: spec('readText', isReadPayload),
      readBlob: spec('readBlob', isReadPayload),
      listDir: spec('listDir', isListDirPayload),
      listTree: spec('listTree', isListTreePayload),
      findFiles: spec('findFiles', isFindFilesPayload),
      searchText: spec('searchText', isSearchTextPayload),
      cancelSearch: { scope: FSX_ACTION_SCOPES.cancelSearch, guard: isCancelSearchPayload },
      writeText: spec('writeText', isWriteTextPayload),
      commitUpload: spec('commitUpload', isCommitUploadPayload),
    },
    handle: async (request, ctx) => {
      switch (request.route.act) {
        case 'userHome':
          return { path: await resolveHostHome(ctx) } satisfies FsxUserHomeResult
        case 'statBatch':
          return statBatch(request as HandlerRequest<FsxStatBatchPayload>, ctx, fsxHost)
        case 'readText': {
          const { sessionId, path } = request.payload as FsxReadPayload
          const { abs, host } = await resolveForConnection(request, ctx, fsxHost, sessionId, path)
          const bytes = await callHostFs<Uint8Array>(host, 'readFile', { path: abs })
          return { text: new TextDecoder().decode(bytes) } satisfies FsxReadTextResult
        }
        case 'readBlob': {
          const { sessionId, path } = request.payload as FsxReadPayload
          const { abs, host } = await resolveForConnection(request, ctx, fsxHost, sessionId, path)
          const bytes = await callHostFs<Uint8Array>(host, 'readFile', { path: abs })
          return { blob: request.blobs.offer(bytes) } satisfies FsxReadBlobResult
        }
        case 'listDir':
          return listDir(request as HandlerRequest<FsxListDirPayload>, ctx, fsxHost)
        case 'listTree':
          return listTree(request as HandlerRequest<FsxListTreePayload>, ctx, fsxHost)
        case 'findFiles': {
          const payload = request.payload as FsxFindFilesPayload
          const { abs, search: service } = await searchRoot(request as HandlerRequest<FsxReadPayload>, ctx, fsxHost, search)
          const owner = { connectionId: request.conn.connectionId, sessionId: payload.sessionId }
          return { searchId: service.startFindFiles(owner, abs, payload) } satisfies FsxSearchStartResult
        }
        case 'searchText': {
          const payload = request.payload as FsxSearchTextPayload
          const { abs, search: service } = await searchRoot(request as HandlerRequest<FsxReadPayload>, ctx, fsxHost, search)
          const owner = { connectionId: request.conn.connectionId, sessionId: payload.sessionId }
          return { searchId: service.startSearchText(owner, abs, payload) } satisfies FsxSearchStartResult
        }
        case 'cancelSearch': {
          const { searchId } = request.payload as FsxCancelSearchPayload
          search?.cancel(request.conn.connectionId, searchId)
          return undefined
        }
        case 'writeText': {
          const { sessionId, path, text } = request.payload as FsxWriteTextPayload
          const { abs, host } = await resolveForConnection(request, ctx, fsxHost, sessionId, path)
          await callHostFs(host, 'writeFile', { path: abs, content: new TextEncoder().encode(text) })
          return undefined
        }
        case 'commitUpload':
          return commitUpload(request as HandlerRequest<FsxCommitUploadPayload>, ctx, fsxHost)
        default:
          throw wireError('unknown_route', `fsx has no action '${request.route.act}'`)
      }
    },
  })
}
