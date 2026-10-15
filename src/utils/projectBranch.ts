/**
 * The project folder's git branch for the composer chip, via the host shell
 * tool (`git rev-parse --abbrev-ref HEAD`). The per-call `cwd` is required (no
 * session cwd is set); tries `Bash`, then `PowerShell` (a no-bash host offers
 * only the latter). `undefined` when not a repo, no shell, or detached HEAD;
 * `shellResponded` tells those apart.
 */
import { readShellStreams } from '../toolkit/builtin/host/resultText'

export type BranchToolCaller = (req: {
  name: string
  args: Record<string, unknown>
  executionContext?: { sessionId?: string }
}) => Promise<unknown>

export type ProjectBranchResult = {
  /** The branch, or `undefined` for a non-repo / detached HEAD / no shell. */
  branch?: string
  /**
   * Whether ANY shell candidate actually answered — i.e. the host shell path
   * works. A `branch: undefined, shellResponded: true` is a SETTLED answer
   * ("this folder has no branch to show"); `shellResponded: false` means every
   * candidate threw or came back empty, so the shell never ran at all. Only the
   * latter is worth retrying — see `AgentRuntimeWorker.refreshProjectBranch`,
   * where a bridge that is still coming up at boot is exactly this case.
   */
  shellResponded: boolean
}

/** Host shell tools to try, in order. `git` is shell-agnostic; we only need a
 *  shell that exists on the host: a no-git-bash Windows host exposes only
 *  `PowerShell`, POSIX exposes only `Bash`, a full Windows host exposes both. */
export const SHELL_TOOL_CANDIDATES = ['Bash', 'PowerShell'] as const

/** Unwrap the `callTool` `{data, agent_meta}` envelope to the shell output string. */
export function unwrapShellOutput(raw: unknown): string {
  let value: unknown = raw
  if (
    raw &&
    typeof raw === 'object' &&
    'agent_meta' in (raw as Record<string, unknown>)
  ) {
    value = (raw as { data?: unknown }).data ?? raw
  }
  if (typeof value === 'string') return value
  const streams = readShellStreams(value)
  if (streams) return streams.stdout
  if (
    value &&
    typeof value === 'object' &&
    'output' in (value as Record<string, unknown>)
  ) {
    return String((value as { output?: unknown }).output ?? '')
  }
  return value == null ? '' : String(value)
}

/** Extract a branch name from `rev-parse --abbrev-ref HEAD` output. A real branch
 *  is a single whitespace-free ref and is never literally `HEAD` (detached).
 *  Output containing whitespace is an error / usage string (e.g. a "tool not
 *  found" rejection surfaced as text), not a branch — reject it so the chip
 *  never shows garbage. */
function parseBranch(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed || trimmed === '(no output)') return undefined
  const lines = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
  // git prints the ref on its own (last) line; take it and validate.
  const last = lines[lines.length - 1]
  if (!last || /\s/.test(last) || last === 'HEAD') return undefined
  return last
}

export async function readProjectBranch(
  callTool: BranchToolCaller,
  projectRoot: string | undefined,
  sessionId?: string,
): Promise<ProjectBranchResult> {
  if (!projectRoot) return { shellResponded: false }
  const command = 'git rev-parse --abbrev-ref HEAD'
  let shellResponded = false
  for (const name of SHELL_TOOL_CANDIDATES) {
    try {
      const raw = await callTool({
        name,
        // `cwd` is the per-call override process_tool.cc applies; it is required
        // because the session cwd is unset (see the file header).
        args: { command, cwd: projectRoot },
        executionContext: { sessionId },
      })
      const text = unwrapShellOutput(raw)
      // Any non-empty answer means this shell RAN — even "fatal: not a git
      // repository" or a detached `HEAD`. That is a settled result, not a
      // transport failure, so the caller must not keep retrying it.
      if (text.trim()) shellResponded = true
      const branch = parseBranch(text)
      if (branch) return { branch, shellResponded: true }
    } catch {
      // This shell tool isn't on the host (e.g. no git-bash → no `Bash` tool) or
      // git failed; try the next candidate.
    }
  }
  return { shellResponded }
}
