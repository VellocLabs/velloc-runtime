/**
 * File-path rule matching (`Read/Edit/Write(<path>)`): exact path, directory
 * prefix, `*` within a segment, `**` across segments, `?`; paths normalized
 * (`\` → `/`, `./` stripped). Known limitation: `!` negation and `[abc]`
 * classes are unsupported and never match, so such a deny rule is a no-op.
 */

function normalizePath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
}

/** Build an anchored regex from a glob: `**` crosses `/`, `*`/`?` don't. */
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        // Swallow a separator right after `**` so `src/**/x` and `src/**`
        // both behave (the `**` already consumed the directory boundary).
        if (glob[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/** Whether `filePath` is covered by a permission rule's path `pattern`. */
export function pathMatchesRule(pattern: string, filePath: string): boolean {
  const pat = normalizePath(pattern)
  const path = normalizePath(filePath)
  if (!pat || !path) return false
  if (pat === path) return true
  const hasGlob = /[*?]/.test(pat)
  // A literal directory pattern matches everything beneath it.
  if (!hasGlob && path.startsWith(pat.endsWith('/') ? pat : `${pat}/`)) {
    return true
  }
  if (hasGlob) {
    return globToRegExp(pat).test(path)
  }
  return false
}

/**
 * The absolute root a rule pattern is anchored to: `//…` → `/`, `~/…` →
 * `homeDir`, `/…` → `projectRoot` (the source's settings root); `null` for
 * `./x` / `x`, which match anywhere.
 */
export function resolvePatternRoot(
  pattern: string,
  roots: { homeDir?: string; projectRoot?: string },
): string | null {
  const pat = pattern.trim()
  if (pat.startsWith('//')) return '/'
  if (pat.startsWith('~/') || pat === '~') return roots.homeDir ?? null
  if (pat.startsWith('/')) return roots.projectRoot ?? null
  return null // rootless — matches anywhere
}

/**
 * Match a rule pattern against a file path WITH root resolution. A rooted pattern (`~/x`, `/abs/x`, `//x`) is
 * resolved against its root and matched relative to it; a rootless pattern
 * (`./x` / `x`) matches the path anywhere. Falls back to plain `pathMatchesRule`
 * when no root context is available.
 */
export function pathMatchesRuleWithRoot(
  pattern: string,
  filePath: string,
  roots: { homeDir?: string; projectRoot?: string; cwd?: string },
): boolean {
  const pat = pattern.trim()
  const root = resolvePatternRoot(pat, roots)
  // Rootless pattern — match against cwd-relative path (relative rules are
  // anchored to the project). Also try the raw path as a fallback.
  if (root === null) {
    const stripped = pat.replace(/^\.\//, '')
    if (pathMatchesRule(stripped, filePath)) return true
    // Try resolving against cwd (the most common anchor for relative rules).
    if (roots.cwd) {
      const absPattern = `${roots.cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${stripped}`
      return pathMatchesRule(absPattern, filePath)
    }
    return false
  }
  // Rooted pattern — resolve the pattern to an absolute path, then match.
  let relPattern = pat
  if (pat.startsWith('//')) {
    relPattern = pat.slice(1) // `//x` → `/x` under root `/`
  } else if (pat.startsWith('~/') || pat === '~') {
    relPattern = pat === '~' ? '' : pat.slice(2)
  } else if (pat.startsWith('/')) {
    relPattern = pat.slice(1)
  }
  const absPattern = relPattern
    ? `${root.replace(/\/+$/, '')}/${relPattern}`
    : root
  return pathMatchesRule(absPattern, filePath)
}

/** The path argument a file tool's permission rule matches against. */
export function extractFilePath(
  input: Record<string, unknown>,
): string | undefined {
  for (const key of ['file_path', 'notebook_path', 'path'] as const) {
    const v = input[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}
