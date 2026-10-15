/**
 * Security: read boundary for a session on an untrusted provider: everything
 * read is uploaded, so read scope is leak scope. Enforced at hosted-tool
 * dispatch and SuperEdit path resolution when
 * `ToolUseContext.options.untrustedReadRoot` is set. Links are resolved first
 * (`realpath(..., { resolveLinks: true })`) so a link cannot escape the root.
 */
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  isAbsoluteRuntimePath,
  relativeRuntimePath,
  resolveRuntimePath,
} from '../utils/runtimePaths'

export type BoundaryVerdict = { ok: true } | { ok: false; reason: string }

/** Is `resolved` inside `root` after collapsing `..`? */
function isInside(root: string, resolved: string): boolean {
  const rel = relativeRuntimePath(root, resolved)
  if (rel === '.' || rel === '') return true
  // A relative path that climbs out, or that came back absolute (different
  // drive / no common prefix), is outside.
  return !rel.startsWith('..') && !isAbsoluteRuntimePath(rel)
}

/**
 * Pure containment check: inside `root`, and outside every `excluded` root.
 *
 * `excluded` exists for the session-storage tree. That tree is not the user's
 * project but it sits under the same home directory, and it holds every other
 * session's transcript — including the lead's, which is where the user's
 * unrelated work is written down.
 */
export function checkWithinRoot(
  resolvedAbs: string,
  root: string,
  excluded: readonly string[] = [],
): BoundaryVerdict {
  if (!isInside(root, resolvedAbs)) {
    return {
      ok: false,
      reason: `the path is outside this session's allowed root (${root})`,
    }
  }
  for (const ex of excluded) {
    if (isInside(ex, resolvedAbs)) {
      return { ok: false, reason: 'the path is inside the session storage tree' }
    }
  }
  return { ok: true }
}

/**
 * What a refused read tells the model — the hosted-tool dispatch's result
 * for a path outside the boundary, and an @-mentioned directory's listing.
 */
export function untrustedReadDeniedMessage(
  verdict: { reason: string },
  root: string | undefined,
): string {
  return `Denied: ${verdict.reason}. This session may only access files under ${root}.`
}

/**
 * Whether a tool may touch `rawPath` in this context.
 *
 * Returns ok for every session with no `untrustedReadRoot` — which is every
 * session that is not a child on an untrusted provider — so this is a no-op
 * on the ordinary path.
 */
export async function assertUntrustedReadAllowed(
  rawPath: string,
  context: {
    options: {
      cwd: string
      untrustedReadRoot?: string
      sessionStoragePath?: string
    }
  },
  fs: RuntimeFs | undefined,
): Promise<BoundaryVerdict> {
  const root = context.options.untrustedReadRoot
  if (!root) return { ok: true }
  const abs = resolveRuntimePath(context.options.cwd, rawPath)
  const excluded = context.options.sessionStoragePath
    ? [context.options.sessionStoragePath]
    : []
  // BOTH forms must pass: the literal path and what it actually resolves to.
  // Checking only the literal one lets a link inside the root read anything
  // on the disk.
  const literal = checkWithinRoot(abs, root, excluded)
  if (!literal.ok) return literal
  const resolved = await resolveLinks(abs, fs)
  if (resolved === undefined || resolved === abs) return { ok: true }

  // The resolved form is also held against the RESOLVED root and storage
  // tree. A root that is itself reached through a link (a project opened via
  // a junction, a subst drive, an 8.3 %TEMP%) resolves as well, and without
  // its resolved form every file under it would read as outside. Resolving
  // them can only add a form that is allowed for the root and one that is
  // denied for the storage tree — the literal forms always stay.
  const rootForms = [root]
  if (!isInside(root, resolved)) {
    const realRoot = await resolveConstantLinks(root, fs)
    if (realRoot !== undefined) rootForms.push(realRoot)
  }
  if (!rootForms.some(form => isInside(form, resolved))) {
    return {
      ok: false,
      reason: `the path is outside this session's allowed root (${root})`,
    }
  }
  const excludedForms = [...excluded]
  for (const ex of excluded) {
    const realEx = await resolveConstantLinks(ex, fs)
    if (realEx !== undefined) excludedForms.push(realEx)
  }
  if (excludedForms.some(form => isInside(form, resolved))) {
    return { ok: false, reason: 'the path is inside the session storage tree' }
  }
  return { ok: true }
}

/**
 * Resolved forms of the session's CONSTANTS — its root and its storage tree —
 * per fs implementation (one per session), so they are resolved once rather
 * than on every checked path: each realpath is a host round trip, and a
 * SuperEdit run touching hundreds of files paid two or three per file for an
 * answer that cannot change. A failed resolution is not cached, so a root
 * that does not exist yet is retried the next time.
 */
const constantLinks = new WeakMap<RuntimeFs, Map<string, string>>()

async function resolveConstantLinks(
  path: string,
  fs: RuntimeFs | undefined,
): Promise<string | undefined> {
  if (!fs?.realpath) return undefined
  let cache = constantLinks.get(fs)
  if (!cache) {
    cache = new Map()
    constantLinks.set(fs, cache)
  }
  const hit = cache.get(path)
  if (hit !== undefined) return hit
  const resolved = await resolveLinks(path, fs)
  if (resolved !== undefined) cache.set(path, resolved)
  return resolved
}

/**
 * `path` with its links resolved, or `undefined` when there is no `realpath`
 * or it fails — then the literal check is all there is, as before.
 */
async function resolveLinks(
  path: string,
  fs: RuntimeFs | undefined,
): Promise<string | undefined> {
  if (!fs?.realpath) return undefined
  try {
    return await fs.realpath(path, { resolveLinks: true })
  } catch {
    // Cannot be resolved (an older host on POSIX answers a path that does not
    // exist yet this way) — the literal check above still applies.
    return undefined
  }
}
