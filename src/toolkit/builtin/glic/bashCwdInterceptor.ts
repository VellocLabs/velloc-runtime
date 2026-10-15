/**
 * Makes a pure `cd <path>` persist across hosted Bash calls (each call is a fresh
 * subprocess at the session cwd): resolve, push via
 * `session.setAgentLoopSettings({cwd})`, synthesize a success. Compound commands
 * fall through to the host. Moves the live `cwd` only, never `projectRoot` (F-11).
 */

import type { PlatformCapabilities } from '../../../runtime/interfaces/PlatformCapabilities'
import type { RuntimeConfig } from '../../../runtime/interfaces/RuntimeConfig'
import type { ToolCallContext } from '../../toolCallContext'
import { nativizeForHost } from '../../../utils/hostPathForm'

// ============================================================================
// Mutable session-cwd state
// ============================================================================

/** Last pushed cwd per sessionId, so consecutive `cd`s in one turn resolve against it. */
const lastKnownCwdBySession = new Map<string, string>()

/** Test-only — drop the cache between test runs. */
export function _resetBashCwdInterceptorForTests(): void {
  lastKnownCwdBySession.clear()
}

/** Read the live cwd for a session: cached value > context snapshot. Exported
 *  for SuperShellTool, whose scripts start where the session's last `cd` left
 *  off (the context snapshot can predate that `cd`). */
export function getLiveCwd(context: ToolCallContext): string {
  const sessionId = context.options.sessionId
  return lastKnownCwdBySession.get(sessionId) ?? context.options.cwd
}

// ============================================================================
// `cd` parsing
// ============================================================================

/**
 * The target path when the whole command is exactly `cd <path>` (optional `builtin`,
 * trailing `;`); `null` for compound commands, no-arg `cd`, and anything else.
 */
export function parseBashCdCommand(rawCommand: string): string | null {
  const trimmed = rawCommand.trim().replace(/;+$/, '').trim()
  if (trimmed.length === 0) return null

  // Reject anything that contains a shell separator. We use a tolerant
  // scan rather than a full shell parser — overzealous rejection is
  // strictly safer (the command just runs through the subprocess) than
  // misparsing a quoted string.
  if (/[;&|]/.test(trimmed)) return null

  // Strip optional `builtin ` prefix.
  const withoutBuiltin = trimmed.replace(/^builtin\s+/, '')

  // Must start with `cd ` followed by an argument.
  const match = withoutBuiltin.match(/^cd(?:\s+(.+))?$/)
  if (!match) return null
  const arg = match[1]?.trim()
  if (!arg) return null

  // Strip surrounding quotes on the argument.
  const unquoted = stripWrappingQuotes(arg)
  if (unquoted.length === 0) return null
  return unquoted
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value.charAt(0)
  const last = value.charAt(value.length - 1)
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

// ============================================================================
// Path resolution
// ============================================================================

function detectSeparator(value: string): '/' | '\\' {
  return value.includes('\\') && !value.includes('/') ? '\\' : '/'
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function isAbsolutePath(value: string): boolean {
  if (value.length === 0) return false
  if (value[0] === '/' || value[0] === '\\') return true
  return /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Resolve `..` and `.` segments in a path string. Stays within the
 * same separator style as the input (preserves the platform shape
 * the host gave us). Used so `cd ../sibling` lands on a clean
 * absolute path before we push it to the C++ side.
 */
function normalizeSegments(value: string): string {
  const sep = detectSeparator(value)
  const isAbs = isAbsolutePath(value)

  // Preserve a Windows drive prefix (`C:`) so the rebuild below
  // doesn't mangle it.
  let drive = ''
  let rest = value
  const driveMatch = value.match(/^([A-Za-z]:)([\\/].*)?$/)
  if (driveMatch) {
    drive = driveMatch[1]!
    rest = driveMatch[2] ?? ''
  }

  const segments: string[] = []
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (segments.length > 0) segments.pop()
      // When already at root, `..` is a no-op (matches POSIX `cd ..`
      // from `/` semantics — stays at `/`).
      continue
    }
    segments.push(seg)
  }

  if (drive) {
    return drive + sep + segments.join(sep)
  }
  return (isAbs ? sep : '') + segments.join(sep)
}

/**
 * Absolute path for a `cd` target: `~` / `~/sub` via `homeDir` (when provided),
 * absolute as-is, relative joined onto `currentCwd`; `.` / `..` normalised. `null`
 * when the result isn't absolute or is empty.
 */
export function resolveCdTarget(
  target: string,
  currentCwd: string,
  homeDir: string | undefined,
): string | null {
  const sep = detectSeparator(currentCwd)

  let candidate = target
  if (candidate === '~') {
    if (!homeDir) return null
    candidate = homeDir
  } else if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    if (!homeDir) return null
    candidate = trimTrailingSeparators(homeDir) + sep + candidate.slice(2)
  }

  if (!isAbsolutePath(candidate)) {
    candidate = trimTrailingSeparators(currentCwd) + sep + candidate
  }

  const normalised = normalizeSegments(candidate)
  if (!isAbsolutePath(normalised)) return null
  // Reject "/" / "C:\" — too dangerous as a working directory.
  if (normalised.length < 3 || /^[A-Za-z]:$/.test(normalised)) return null
  return normalised
}

// ============================================================================
// Bash-call interception
// ============================================================================

export type BashCommandArgs = {
  command: string
  timeout?: number
  description?: string
}

export type BashCdResult =
  | { kind: 'cd'; appliedCwd: string; resultText: string }
  | { kind: 'passthrough' }
  | { kind: 'error'; resultText: string }

/**
 * A pure `cd`: push the cwd to the host, cache it, return a synthetic success.
 * Otherwise, or when the push fails, `passthrough` (never a success the host
 * didn't honour).
 */
export async function interceptBashCd(
  args: BashCommandArgs,
  context: ToolCallContext,
  runtimeConfig: RuntimeConfig,
): Promise<BashCdResult> {
  const target = parseBashCdCommand(args.command)
  if (target === null) return { kind: 'passthrough' }

  const currentCwd = getLiveCwd(context)
  const homeDir =
    runtimeConfig.getEnv('HOME') ?? runtimeConfig.getEnv('USERPROFILE') ?? undefined

  const newCwd = resolveCdTarget(target, currentCwd, homeDir)
  if (!newCwd) {
    return {
      kind: 'error',
      resultText: `cd: cannot resolve "${target}" against current cwd`,
    }
  }

  // The C++ session cwd (`ToolSession::set_cwd`) wants a host-native path; a
  // git-bash `/c/…` cd target is rejected on Windows, so convert it before
  // pushing. No-op on POSIX hosts / already-native targets.
  const hostCwd = nativizeForHost(newCwd, context.options.cwd)

  const session = context.platformCapabilities?.session
  if (!session?.setAgentLoopSettings) {
    // No host route available — fall through to the subprocess. The
    // builtin `cd` will run there but won't persist, which is the
    // pre-existing behaviour.
    return { kind: 'passthrough' }
  }

  try {
    const result = await session.setAgentLoopSettings({
      cwd: hostCwd,
      executionContext: { sessionId: context.options.sessionId },
    })
    const appliedCwd = result.appliedCwd ?? hostCwd
    lastKnownCwdBySession.set(context.options.sessionId, appliedCwd)
    return {
      kind: 'cd',
      appliedCwd,
      resultText: `Changed working directory to ${appliedCwd}`,
    }
  } catch {
    // Older C++ builds may not implement the route, or the path may
    // have been rejected. Let the subprocess take a swing at it — at
    // least the model gets the real shell error.
    return { kind: 'passthrough' }
  }
}
