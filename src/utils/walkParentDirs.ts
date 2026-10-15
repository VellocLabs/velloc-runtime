/**
 * Walk parent directories from a starting cwd up to the filesystem root or the
 * user's home directory (inclusive stop), whichever comes first. Pure path
 * manipulation; callers do their own fs I/O.
 */

export type WalkParentDirsEntry = {
  /** Absolute directory path, with no trailing separator. */
  dir: string
  /** True when `dir === homeDir` (only meaningful if homeDir provided). */
  isHome: boolean
  /** True when the parent of `dir` equals `dir` itself (filesystem root). */
  isRoot: boolean
}

export type WalkParentDirsOptions = {
  /**
   * The user's home directory. When set, the walk stops after yielding
   * this directory. Pass `undefined` to walk to the filesystem root.
   */
  homeDir?: string
  /**
   * Maximum number of directories to yield. Defaults to 64 — enough for
   * any reasonable filesystem layout, prevents infinite loops if the
   * separator detection gets confused.
   */
  maxDepth?: number
}

function detectSeparator(value: string): '/' | '\\' {
  return value.includes('\\') && !value.includes('/') ? '\\' : '/'
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

/**
 * Compute the parent of `dir`. Returns the directory itself when `dir`
 * is already the filesystem root.
 *
 * Recognized roots:
 *  - POSIX `/`
 *  - Windows drive root `C:\` / `C:/`
 */
export function getParentDir(dir: string): string {
  const trimmed = trimTrailingSeparators(dir)
  // POSIX root: stripping the trailing slash leaves an empty string.
  if (trimmed.length === 0) return dir
  // Windows drive root: `C:` after trim.
  if (/^[A-Za-z]:$/.test(trimmed)) return dir

  // Find the last separator. Use the separator style present in the
  // input so the parent inherits the same convention.
  const lastSlash = Math.max(
    trimmed.lastIndexOf('/'),
    trimmed.lastIndexOf('\\'),
  )
  if (lastSlash < 0) return dir // no separator, already at top-level
  if (lastSlash === 0) {
    // POSIX: `/home` → parent is `/`. The slice would produce `""`,
    // which is wrong; emit the root separator explicitly.
    return trimmed[0]!
  }

  const parent = trimmed.slice(0, lastSlash)
  // Special-case Windows drive: parent of `C:\Users` is `C:\` not `C:`.
  if (/^[A-Za-z]:$/.test(parent)) {
    return parent + detectSeparator(dir)
  }
  return parent
}

function comparableForm(value: string): string {
  // Strip trailing separators, lowercase Windows drive letters so two
  // path strings that refer to the same dir compare equal regardless
  // of which slash style or drive-letter case the caller used.
  const trimmed = trimTrailingSeparators(value)
  if (/^[A-Za-z]:/.test(trimmed)) {
    return trimmed[0]!.toUpperCase() + trimmed.slice(1).replace(/\\/g, '/')
  }
  return trimmed.replace(/\\/g, '/')
}

/**
 * Yield directories from `start` (first) upward to the root or `homeDir`.
 * Bounded by `maxDepth`.
 */
export function* walkParentDirs(
  start: string,
  options: WalkParentDirsOptions = {},
): Generator<WalkParentDirsEntry, void, undefined> {
  const { homeDir, maxDepth = 64 } = options
  const homeNorm = homeDir ? comparableForm(homeDir) : null

  let current = trimTrailingSeparators(start)
  let depth = 0

  while (depth < maxDepth) {
    const parent = getParentDir(current)
    const isRoot = comparableForm(parent) === comparableForm(current)
    const isHome = homeNorm !== null && comparableForm(current) === homeNorm

    yield { dir: current, isHome, isRoot }

    if (isHome) return
    if (isRoot) return

    current = parent
    depth += 1
  }
}
