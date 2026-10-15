/**
 * Security: `fsx` — the runtime's file capability for clients; the C++ `fs` routes are never
 * advertised. `full` (the local desktop) resolves any path. Below `full` a path must stay inside the
 * session's project root or cwd, checked on the literal path AND on the host's realpath (or, for a
 * missing path, its nearest existing ancestor's), against both forms of each root; else
 * `forbidden_scope`. `~/.velloc` (credentials, every transcript) is excluded even inside a root.
 * Uploads land where the runtime decides, under `<cwd>/.velloc/uploads/<session>/`.
 */
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { checkWithinRoot } from '../../permissions/untrustedReadBoundary'
import {
  basenameRuntimePath,
  dirnameRuntimePath,
  joinRuntimePath,
  resolveRuntimePath,
} from '../../utils/runtimePaths'
import {
  FSX_ACTION_SCOPES,
  FSX_CAPABILITY,
  FSX_STAT_BATCH_MAX_PATHS,
  isBlobRef,
  wireError,
  type FsxCommitUploadPayload,
  type FsxCommitUploadResult,
  type FsxReadBlobResult,
  type FsxReadPayload,
  type FsxReadTextResult,
  type FsxStatBatchPayload,
  type FsxStatBatchResult,
  type FsxStatEntry,
  type FsxUserHomeResult,
  type FsxWriteTextPayload,
} from '../runtimeProtocol'
import type { CapabilityRegistry } from './CapabilityRegistry'
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
 * Security: the roots a scoped path is judged against (project root and cwd, as given and resolved)
 * and the excluded `~/<runtime dir>` tree. `realpaths` memoises the host's answers per request.
 */
type RootForms = {
  forms: ReadonlySet<string>
  excluded: readonly string[]
  realpaths: Map<string, Promise<string | null>>
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

/**
 * Resolved ONCE per request: a `statBatch` of 500 paths used to re-resolve
 * both roots for every path, three host round trips per path where one
 * suffices.
 */
async function rootFormsOf(host: HostBridge, roots: FsxSessionRoots, homeDir: string): Promise<RootForms> {
  const realpaths = new Map<string, Promise<string | null>>()
  const forms = new Set<string>()
  for (const root of new Set([roots.projectRoot, roots.cwd])) {
    if (!root) continue
    forms.add(root)
    const real = await realpathMemo(host, realpaths, root)
    if (real) forms.add(real)
  }
  // The excluded tree in both forms too, like the roots: with a home
  // directory that is a link (`/home/me` -> `/data/me`) the resolved path of
  // `~/<runtime dir>` sits inside the resolved root and outside the literal
  // exclusion, and a request naming it would have read the credentials file.
  const excluded: string[] = []
  if (homeDir) {
    const literal = joinRuntimePath(homeDir, RUNTIME_DIR_NAME)
    excluded.push(literal)
    const real = await realpathMemo(host, realpaths, literal)
    if (real && real !== literal) excluded.push(real)
  }
  return { forms, excluded, realpaths }
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
      root => checkWithinRoot(candidate, root, rootForms.excluded).ok,
    )
    if (!inside) return `'${candidate}' is outside this session's project`
  }
  return null
}

type Resolved = { abs: string; roots: FsxSessionRoots; host: HostBridge }

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
  if (request.conn.scope.mode !== 'full') {
    const violation = await rootViolation(host, abs, await rootFormsOf(host, roots, ctx.homeDir))
    if (violation) throw wireError('forbidden_scope', violation)
  }
  return { abs, roots, host }
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

type StatResult = { isFile?: boolean; isDirectory?: boolean } | null

/** Root checks in flight at once in a scoped `statBatch`: each is host round trips. */
const STAT_BATCH_CHECKS_IN_FLIGHT = 8

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
  const rootForms = request.conn.scope.mode === 'full' ? null : await rootFormsOf(host, roots, ctx.homeDir)
  const resolved = paths.map(path => ({ path, abs: resolveRuntimePath(roots.cwd, path) }))
  let visible: Array<{ path: string; abs: string }>
  if (rootForms === null) {
    visible = resolved
  } else {
    // The checks are independent host round trips (several per absent path,
    // down its ancestors): a few at a time, in request order, not one by one.
    const allowed = new Array<boolean>(resolved.length)
    let next = 0
    const check = async (): Promise<void> => {
      while (next < resolved.length) {
        const index = next++
        allowed[index] = (await rootViolation(host, resolved[index]!.abs, rootForms)) === null
      }
    }
    await Promise.all(Array.from({ length: Math.min(STAT_BATCH_CHECKS_IN_FLIGHT, resolved.length) }, check))
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

export function registerFsxCapability(registry: CapabilityRegistry, fsxHost: FsxHost): void {
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
