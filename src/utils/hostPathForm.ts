/**
 * Path spellings at the runtime -> host boundary. On a Windows host, shell-form
 * paths (`/c/Users/me`, `/cygdrive/c/…`, `//server/share`) are rewritten to the
 * native form, which the host tools require. The platform is read from the
 * (absolute, native) session cwd. WSL `/mnt/<drive>/` is deliberately left
 * as-is so the host rejects it rather than guessing a drive.
 */

const CYGDRIVE_ROOT = '/cygdrive'

function isAsciiLetter(ch: string | undefined): boolean {
  if (ch === undefined || ch.length !== 1) return false
  const code = ch.charCodeAt(0) | 0x20 // fold A-Z onto a-z
  return code >= 0x61 && code <= 0x7a
}

function withBackslashes(text: string): string {
  return text.split('/').join('\\')
}

function withForwardSlashes(text: string): string {
  return text.split('\\').join('/')
}

/** `X:\…` or `X:/…` — a drive letter followed by a separator. */
function hasDriveRoot(path: string): boolean {
  return (
    isAsciiLetter(path[0]) &&
    path[1] === ':' &&
    (path[2] === '\\' || path[2] === '/')
  )
}

/** True for a native absolute Windows path: drive-rooted or `\\`-UNC. */
export function isNativeWindowsAbsolute(path: string): boolean {
  return hasDriveRoot(path) || path.startsWith('\\\\')
}

/**
 * `/x` or `/x/…` with a single drive letter `x`; returns the upper-cased
 * drive and whatever follows it (empty for a bare drive).
 */
function readSlashDrive(path: string): { drive: string; tail: string } | null {
  if (path[0] !== '/' || !isAsciiLetter(path[1])) return null
  if (path.length > 2 && path[2] !== '/') return null
  return { drive: path[1]!.toUpperCase(), tail: path.slice(2) }
}

/**
 * Shell form -> Windows form. `/c/x` and `/cygdrive/c/x` become `C:\x` (a bare
 * drive becomes its root, `C:\`); every other input — `//server/share`
 * included — just has its forward slashes turned into backslashes.
 */
export function shellPathToWindows(path: string): string {
  const underCygdrive = path.startsWith(CYGDRIVE_ROOT + '/')
    ? readSlashDrive(path.slice(CYGDRIVE_ROOT.length))
    : null
  const parsed = underCygdrive ?? readSlashDrive(path)
  if (!parsed) return withBackslashes(path)
  return `${parsed.drive}:${parsed.tail ? withBackslashes(parsed.tail) : '\\'}`
}

/**
 * Windows form -> shell form. `C:\x` (either separator) becomes `/c/x` with a
 * lower-case drive; every other input — UNC included — just has its
 * backslashes turned into forward slashes.
 */
export function windowsPathToShell(path: string): string {
  if (!hasDriveRoot(path)) return withForwardSlashes(path)
  return `/${path[0]!.toLowerCase()}${withForwardSlashes(path.slice(2))}`
}

/**
 * `//c/x` and `///c` are typos for the drive form `/c/x`; read as UNC they
 * would name a share called `c` that the host accepts and chdirs into. Drop
 * the extra leading slashes when a single drive letter follows them. A real
 * server name (more than one character) is left alone.
 */
function collapseDoubledDriveSlash(path: string): string {
  let slashes = 0
  while (path[slashes] === '/') slashes++
  if (slashes < 2 || !isAsciiLetter(path[slashes])) return path
  const after = path[slashes + 1]
  if (after !== undefined && after !== '/') return path
  return path.slice(slashes - 1)
}

/**
 * Rewrite `value` (a per-call `cwd`, or a file tool's `file_path` / `path`)
 * into the form the host expects, given the session cwd `sessionCwd`.
 *
 * Only a shell-form absolute value on a Windows host is rewritten. Empty,
 * relative and already-native values, and every value on a non-Windows host,
 * come back unchanged — the host resolves or rejects those itself.
 */
export function nativizeForHost(value: string, sessionCwd: string): string {
  if (value === '' || value[0] !== '/') return value
  if (!isNativeWindowsAbsolute(sessionCwd)) return value
  return shellPathToWindows(collapseDoubledDriveSlash(value))
}
