/**
 * Hook command runner: the host runs the command in an EXPLICIT shell
 * (`bash -c` / `pwsh -Command`, `use_shell:false`) with the hook input on stdin
 * and env exported natively, via the Bash tool's `hook_shell` / `hook_stdin` /
 * `hook_env` fields, returning raw `{ output, exit_code }`. `shell: powershell`
 * runs pwsh; the default prefers bash and retries pwsh on BINARY_NOT_FOUND.
 */

import { SHELL_TOOL_ID } from '../prompting/processToolNames'
import { hostToolErrorParam } from '../browser/bridge/hostToolError'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ShellHookSpec } from './hookTypes'

export type HookCommandRunnerInput = {
  command: string
  shell?: ShellHookSpec['shell']
  /** Hook input JSON (already serialized) delivered to the command's stdin. */
  stdin: string
  /** Env vars exported for the command (e.g. CLAUDE_PROJECT_DIR). */
  env: Record<string, string>
  /** Hard timeout in milliseconds, forwarded to the Bash tool. */
  timeoutMs: number
}

export type HookCommandRunnerResult = {
  /** Combined stdout+stderr from the host (it does not separate them). */
  stdout: string
  exitCode: number
}

export type HookCommandRunner = (
  input: HookCommandRunnerInput,
) => Promise<HookCommandRunnerResult>

const POSIX_SHELLS = new Set<string>(['bash', 'sh', 'zsh'])
const PWSH_SHELLS = new Set<string>(['pwsh', 'powershell'])

/**
 * Resolve a hook's `shell` field into the ordered list of shell ids to try.
 * Explicit shells resolve to themselves (PowerShell aliases collapse to a
 * pwsh-then-powershell try). The default prefers bash and falls back to
 * PowerShell so a Windows host without bash can still run a (PowerShell-)
 * authored hook — bash is the default, and "if the system can't run bash,
 * use PowerShell" still holds.
 */
export function resolveShellPreference(
  shell: ShellHookSpec['shell'],
): string[] {
  if (shell && PWSH_SHELLS.has(shell)) {
    return ['pwsh', 'powershell']
  }
  if (shell && POSIX_SHELLS.has(shell)) {
    return [shell]
  }
  return ['bash', 'powershell']
}

/**
 * True when a host reject means "the requested shell isn't installed" rather
 * than "the command ran and failed". Only the former should trigger the
 * bash→PowerShell fallback; a command that ran and exited non-zero comes back
 * as a RESOLVE with that exit code, not a reject.
 */
export function isShellUnavailableError(error: unknown): boolean {
  // The host rejects with its own code (`hook_exec_failed`); the shell
  // service's code is the `service_code` param.
  const serviceCode = hostToolErrorParam(error, 'service_code')?.toLowerCase()
  if (serviceCode === 'binary_not_found' || serviceCode === 'command_not_allowed') {
    return true
  }
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase()
  return (
    message.includes('binary_not_found') ||
    message.includes('command_not_allowed') ||
    message.includes('not found') ||
    message.includes('not allowed') ||
    message.includes('no_default_shell')
  )
}

function readBashResult(raw: unknown): HookCommandRunnerResult {
  let obj = raw as Record<string, unknown> | undefined
  // The raw callTool envelope may be `{ output, exit_code }` or wrapped as
  // `{ data: { output, exit_code }, agent_meta }`.
  if (obj && typeof obj === 'object' && obj.data && typeof obj.data === 'object') {
    obj = obj.data as Record<string, unknown>
  }
  const stdout = typeof obj?.output === 'string' ? (obj.output as string) : ''
  const exitCode = typeof obj?.exit_code === 'number' ? (obj.exit_code as number) : 0
  return { stdout, exitCode }
}

/**
 * Build a runner backed by the C++ Bash tool, or `undefined` when this
 * runtime has no `browser` capability (mock host / tests) — in which case the
 * executor leaves command hooks unexecuted (`not_implemented`).
 */
export function createBashHookCommandRunner(
  context: ToolCallContext,
): HookCommandRunner | undefined {
  const browser = context.platformCapabilities?.browser
  if (!browser?.callTool) {
    return undefined
  }
  const modelId = context.options.mainLoopModel
  const executionContext = {
    sessionId: context.options.sessionId || undefined,
    providerId: context.options.mainLoopProviderId,
    modelId: modelId && modelId !== 'inherit' ? modelId : undefined,
  }

  return async (
    input: HookCommandRunnerInput,
  ): Promise<HookCommandRunnerResult> => {
    const shells = resolveShellPreference(input.shell)
    const envJson =
      Object.keys(input.env).length > 0 ? JSON.stringify(input.env) : ''

    let lastError: unknown
    for (let i = 0; i < shells.length; i++) {
      try {
        const raw = await browser.callTool!({
          name: SHELL_TOOL_ID,
          // `hook_*` are the Bash tool's internal hook fields: run `command`
          // in `hook_shell` with `hook_stdin` on stdin and `hook_env`
          // exported. The host returns the raw { output, exit_code }.
          args: {
            command: input.command,
            hook_shell: shells[i]!,
            hook_stdin: input.stdin,
            hook_env: envJson,
            timeout: input.timeoutMs,
          },
          executionContext,
        })
        return readBashResult(raw)
      } catch (error) {
        lastError = error
        // Fall back to the next shell (bash → powershell) only when the host
        // says the requested shell isn't available. A command that ran and
        // exited non-zero is a RESOLVE handled above, not a reject.
        if (i < shells.length - 1 && isShellUnavailableError(error)) {
          continue
        }
        throw error
      }
    }
    throw lastError ?? new Error('hook command runner: no shell available')
  }
}
