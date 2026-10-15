// The shell tools' host arguments and foreground / background results:
// the always-background middle layer's timeout rewrite, the no-timeout-cap
// sentinel the host recognises, the leading-sleep guard, and the result
// shapes a shell call answers with. Pure functions; exported for the unit
// tests that pin them.
import type { ToolCallContext } from '../../toolCallContext'
import type { SubAgentSnapshot } from '../../../team/subAgentController'
import { SHELL_TOOL_ID } from '../../../prompting/processToolNames'
import { joinRuntimePath } from '../../../utils/runtimePaths'
import { taskLogFile, resolveSessionStorageBase } from '../../../utils/conversationStoragePaths'
import { idleWaitRejection, detectBlockedSleepPatternPS } from '../glic/bashCommandUtils'

export const PWSH_TOOL_ID = 'PowerShell'

/** Bash or PowerShell — the host tools that run a command. */
export function isShellToolName(toolName: string): boolean {
  return toolName === SHELL_TOOL_ID || toolName === PWSH_TOOL_ID
}

export function getBackgroundShellOutputPath(
  context: ToolCallContext,
  shellId: string,
): string {
  const { homeDir, projectRoot, sessionId, sessionStorageBase } = context.options
  const basePath =
    resolveSessionStorageBase({
      storageBase: sessionStorageBase,
      homeDir,
      projectRoot,
    }) ?? joinRuntimePath(projectRoot, '.velloc')
  return taskLogFile(basePath, sessionId, shellId)
}

// A model Bash/PowerShell command always launches as a background `local_bash` task
// and blocks inline for the model's `timeout` (default 2 min, max 10 min), then is
// backgrounded, not killed. The tool description's "default 2 minutes / max 10
// minutes" is only true under these values.
export const SHELL_DEFAULT_TIMEOUT_MS = 120_000
const SHELL_MAX_TIMEOUT_MS = 600_000
// A leading-sleep command is KILLED at its timeout (see below); the inline wait
// runs this much past the timeout so the kill finalizes and returns inline.
const SHELL_KILL_FINALIZE_GRACE_MS = 5_000
// The sleep guard exempts a leading sleep whose explicit timeout is shorter than
// this: it is killed at that timeout, so it cannot hold the turn for long.
const SLEEP_GUARD_SHORT_TIMEOUT_MS = 15_000

// Contract: a background `Spawn`'s `timeout` is a hard kill and an absent one means
// the host default (120s), so a detached command sends this explicit "no wall-clock
// cap" value. INT32_MAX so an older binary clamps it to kMaxBashTimeoutMs. Must equal
// C++ kNoTimeoutCapSentinelMs.
export const SHELL_NO_TIMEOUT_CAP_SENTINEL_MS = 2_147_483_647

// A command whose LEADING token is a bare sleep (`sleep`, or PowerShell's
// `Start-Sleep`) is never auto-backgrounded: its timeout (the model's, or the
// 2-minute default) KILLS it. Every other command is detached-and-kept-running
// when its timeout elapses.
const NEVER_DETACH_WORDS = new Set(['sleep', 'start-sleep'])
function isAutoBackgroundAllowed(command: unknown): boolean {
  if (typeof command !== 'string') return true
  const base = command.trim().split(/\s+/)[0]?.toLowerCase()
  return !base || !NEVER_DETACH_WORDS.has(base)
}

/**
 * Contract: forced-background args are always `run_in_background: true`. A leading
 * `sleep`/`Start-Sleep` is sent with the timeout so the host KILLS it there; every
 * other command detaches at the timeout and the host gets the no-timeout-cap sentinel.
 */
/**
 * The model's `timeout` (or the 2-minute default), clamped to the 10-minute max:
 * where a foreground command is backgrounded, or killed if never auto-backgrounded.
 */
function clampShellTimeoutMs(raw: Record<string, unknown>): number {
  const t = raw.timeout
  return typeof t === 'number' && Number.isFinite(t) && t > 0
    ? Math.min(t, SHELL_MAX_TIMEOUT_MS)
    : SHELL_DEFAULT_TIMEOUT_MS
}

export function resolveForcedBackgroundShellArgs(input: unknown): {
  effectiveInput: Record<string, unknown>
  foregroundBudgetMs: number
} {
  const raw = (input ?? {}) as Record<string, unknown>
  const onTimeoutMs = clampShellTimeoutMs(raw)
  if (!isAutoBackgroundAllowed(raw.command)) {
    return {
      effectiveInput: { ...raw, run_in_background: true, timeout: onTimeoutMs },
      foregroundBudgetMs: onTimeoutMs + SHELL_KILL_FINALIZE_GRACE_MS,
    }
  }
  const { timeout: _droppedForegroundTimeout, ...rest } = raw
  return {
    effectiveInput: {
      ...rest,
      run_in_background: true,
      timeout: SHELL_NO_TIMEOUT_CAP_SENTINEL_MS,
    },
    foregroundBudgetMs: onTimeoutMs,
  }
}

/**
 * Args for a model-requested `run_in_background: true`: only `timeout` is
 * rewritten, so an explicit background (a leading `sleep` included) has no kill
 * deadline and runs to completion.
 */
export function resolveExplicitBackgroundShellArgs(input: unknown): {
  effectiveInput: Record<string, unknown>
} {
  const raw = (input ?? {}) as Record<string, unknown>
  return {
    effectiveInput: {
      ...raw,
      timeout: SHELL_NO_TIMEOUT_CAP_SENTINEL_MS,
    },
  }
}

/** A foreground-completed background shell snapshot shaped as the raw `Exec` result
 *  `{output, exit_code}` (`-1` = no code reported), plus the `local_bash` `taskId`
 *  the conversation card uses to jump to the task. */
export function buildForegroundShellResult(
  snap: SubAgentSnapshot,
  taskId?: string,
): Record<string, unknown> {
  return {
    output: snap.output || '(no output)',
    exit_code: snap.exitCode ?? -1,
    ...(taskId ? { task_id: taskId } : {}),
  }
}

export function buildBackgroundShellRunningResult(
  shellId: string,
  outputFilePath: string,
  autoBackgrounded: boolean,
): Record<string, unknown> {
  return {
    task_id: shellId,
    status: 'running',
    output_file: outputFilePath,
    message: autoBackgrounded
      ? `The command ran past its timeout and was moved to the background as shell id ${shellId}. A notification will arrive when it finishes; until then its output accumulates in ${outputFilePath}, which Read can show you.`
      : `Started in the background as shell id ${shellId}. A notification will arrive when it finishes; its output accumulates in ${outputFilePath}, which Read can show you.`,
  }
}

/**
 * The sleep guard (spec 2-6-4 / 2-7-4): a standalone or leading `sleep N`
 * (Bash) or `Start-Sleep N` / `sleep N` (PowerShell), N ≥ 2, is refused
 * unless the command is explicitly backgrounded — the model should use
 * `run_in_background: true` or the Sleep tool instead.
 */
export async function shellSleepGuard(
  toolName: string,
  input: Record<string, unknown> | undefined,
): Promise<{ result: true } | { result: false; message: string; errorCode: number }> {
  const args = (input ?? {}) as Record<string, unknown>
  if (args.run_in_background === true) return { result: true as const }
  // A leading sleep with an explicit short timeout is KILLED by C++ at
  // that timeout (resolveForcedBackgroundShellArgs), so it cannot hold
  // the turn for long. Exempt it from the sleep guard — the test
  // contract is that a leading sleep with a timeout is killed at the
  // timeout, not blocked.
  const timeout = args.timeout
  if (
    typeof timeout === 'number' &&
    timeout > 0 &&
    timeout < SLEEP_GUARD_SHORT_TIMEOUT_MS
  ) {
    return { result: true as const }
  }
  const command = typeof args.command === 'string' ? args.command : ''
  const sleepPattern =
    toolName === PWSH_TOOL_ID
      ? detectBlockedSleepPatternPS(command)
      : idleWaitRejection(command)
  if (sleepPattern !== null) {
    return {
      result: false as const,
      message: `Refused: ${sleepPattern}. A command that waits should run with run_in_background: true, which reports back when it finishes; to watch a log or poll an endpoint, use the Monitor tool. A deliberate pause for pacing must stay under 2 seconds.`,
      errorCode: 10,
    }
  }
  return { result: true as const }
}
