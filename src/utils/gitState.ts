/**
 * The git state of a folder, read once over the host shell for the model's
 * first turn (F-19): `git status --porcelain=v1 -b`, the branch line parsed,
 * the change lines kept up to a cap. Tries the same shell tools as the
 * branch chip. `undefined` when no shell answered; `repository: false` when
 * one did and the folder is not a repository.
 */
import { HostToolError } from '../browser/bridge/hostToolError'
import { readShellStreams } from '../toolkit/builtin/host/resultText'
import { SHELL_TOOL_CANDIDATES, unwrapShellOutput, type BranchToolCaller } from './projectBranch'

export const GIT_STATE_CHANGE_LINES = 40
/** How long the first turn waits for git. A normal repository answers in
 *  well under a second, a loaded machine in a few; a network share or a host
 *  still coming up would not answer at all, and the turn goes out without
 *  the snapshot. */
export const GIT_STATE_TIMEOUT_MS = 10_000

export type GitState =
  | { repository: false }
  /** The shell ran but has no `git`: whether the folder is a repository is
   *  not known from here. */
  | { repository: 'unavailable' }
  | {
      repository: true
      /** The repository's top folder as git prints it (forward slashes). */
      root?: string
      /** Absent on a detached HEAD or before the first commit. */
      branch?: string
      upstream?: string
      ahead?: number
      behind?: number
      /** Porcelain change lines, at most `GIT_STATE_CHANGE_LINES`. */
      changes: string[]
      /** How many change lines the cap left out. */
      more: number
    }

const NOT_A_REPOSITORY = /not a git repository/i
/** bash: `git: command not found`; PowerShell: `The term 'git' is not recognized`. */
const GIT_MISSING = /git:? .*(command not found|not recognized|no such file)|'git' is not recognized/i

/** The one command, for either shell: the top folder, then the status of the
 *  working directory's own subtree (paths relative to that top folder, as
 *  git prints them). `;` and not `&&`: an older PowerShell has no `&&`, and
 *  outside a repository both halves say so. */
export const GIT_STATE_COMMAND = 'git rev-parse --show-toplevel; git status --porcelain=v1 -b -- .'

/** Parse the command's output. `undefined` when the text is not that output
 *  (an error, or nothing). */
export function parseGitStatus(stdout: string, stderr = ''): GitState | undefined {
  if (NOT_A_REPOSITORY.test(stderr) || NOT_A_REPOSITORY.test(stdout)) return { repository: false }
  if (GIT_MISSING.test(stderr) || GIT_MISSING.test(stdout)) return { repository: 'unavailable' }
  const lines = stdout.replace(/\r\n/g, '\n').split('\n')
  let root: string | undefined
  if (lines[0] !== undefined && !lines[0].startsWith('## ') && lines[0].trim().length > 0) {
    root = lines.shift()!.trim()
  }
  const header = lines[0] ?? ''
  if (!header.startsWith('## ')) return undefined
  const state: Extract<GitState, { repository: true }> = { repository: true, changes: [], more: 0 }
  if (root !== undefined) state.root = root
  const ref = header.slice(3).trim()
  const head = ref.match(/^(.*?)\.\.\.(\S+)(?: \[(.*)\])?$/)
  if (head) {
    state.branch = head[1]
    state.upstream = head[2]
    const counts = head[3] ?? ''
    const ahead = counts.match(/ahead (\d+)/)
    const behind = counts.match(/behind (\d+)/)
    if (ahead) state.ahead = Number(ahead[1])
    if (behind) state.behind = Number(behind[1])
  } else if (ref.startsWith('HEAD ')) {
    // "HEAD (no branch)": detached.
  } else if (ref.startsWith('No commits yet on ')) {
    state.branch = ref.slice('No commits yet on '.length)
  } else if (ref.length > 0) {
    state.branch = ref
  }
  const changes = lines.slice(1).filter(line => line.length > 0)
  state.changes = changes.slice(0, GIT_STATE_CHANGE_LINES)
  state.more = Math.max(0, changes.length - state.changes.length)
  return state
}

/** The folder's git state over the host shell, or `undefined` when no shell
 *  tool answered (a host still coming up, or none installed). */
export async function readGitState(
  callTool: BranchToolCaller,
  folder: string | undefined,
  sessionId?: string,
): Promise<GitState | undefined> {
  if (!folder) return undefined
  const command = GIT_STATE_COMMAND
  const settle = (stdout: string, stderr: string): GitState | undefined => {
    const parsed = parseGitStatus(stdout, stderr)
    if (parsed) return parsed
    // Anything else that came back is a shell that ran and no repository.
    return stdout.trim() || stderr.trim() ? { repository: false } : undefined
  }
  for (const name of SHELL_TOOL_CANDIDATES) {
    try {
      const raw = await callTool({
        name,
        // The host kills the command at the same bound the caller stops
        // waiting at, so a hung git is not left running.
        args: { command, cwd: folder, timeout: GIT_STATE_TIMEOUT_MS },
        executionContext: { sessionId },
      })
      const streams = readShellStreams(
        raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)
          ? (raw as { data?: unknown }).data
          : raw,
      )
      const settled = settle(streams ? streams.stdout : unwrapShellOutput(raw), streams ? streams.stderr : '')
      if (settled) return settled
    } catch (error) {
      // A command that exits non-zero (git outside a repository exits 128) is
      // a host error carrying the streams; one without them is a shell that
      // is not on the host, so the next is tried.
      const streams = error instanceof HostToolError ? readShellStreams(error.params) : undefined
      if (streams) {
        const settled = settle(streams.stdout, streams.stderr)
        if (settled) return settled
      }
    }
  }
  return undefined
}
