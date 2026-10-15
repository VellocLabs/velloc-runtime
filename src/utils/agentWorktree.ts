/**
 * Per-subagent git worktree lifecycle (`isolation:'worktree'`). Only the
 * subagent's cwd moves into the worktree; `projectRoot` stays on the main repo
 * so storage is never keyed to an ephemeral worktree. Git runs through the host
 * Bash tool with `git -C <dir>`: success resolves with output, a non-zero exit
 * throws.
 */
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { joinPath } from '../memory/memoryPaths'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { readShellStreams } from '../toolkit/builtin/host/resultText'

/** Bash tool wire name (see declarations/process_tool/bash.tool.json). */
const BASH_WIRE_NAME = 'Bash'

/** A git-bash-friendly quoted path token: forward slashes + double quotes so
 *  Windows drive paths and spaces both survive the shell. */
function shellPath(p: string): string {
  return `"${p.replace(/\\/g, '/')}"`
}

/** Branch / directory slug derived from the (already-safe) sidechain agentId.
 *  The id from `createSidechainAgentId` is `<label≤32>_<rand>_<ts>`; uniqueness
 *  lives in the trailing two segments. A blind `slice(0, N)` would drop them for
 *  a long label, collapsing distinct parallel sub-agents onto ONE worktree
 *  path/branch (silent isolation loss) — so when truncating we keep the label
 *  prefix short but ALWAYS preserve the unique suffix. */
function agentSlug(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, '') || 'agent'
  if (safe.length <= 40) return safe
  const segs = safe.split('_')
  const suffix = segs.slice(-2).join('_')
  const prefix = segs
    .slice(0, -2)
    .join('_')
    .slice(0, Math.max(1, 40 - suffix.length - 1))
  return prefix ? `${prefix}_${suffix}` : suffix
}

/**
 * Minimal unwrap of the `callTool` `{data, agent_meta}` envelope — `unwrapData`
 * in toolkit/builtin/host/hostTools.ts is module-private. A successful Bash call
 * answers with the host's structured result; its stdout is the command's output.
 */
function unwrapToString(raw: unknown): string {
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

export type GitRunResult = { ok: boolean; stdout: string }

/** Run one git/shell command on the host via the Bash hosted tool. */
async function runGit(
  context: ToolCallContext,
  command: string,
): Promise<GitRunResult> {
  const browser = context.platformCapabilities?.browser
  if (!browser?.callTool) {
    return { ok: false, stdout: 'browser capability unavailable; cannot run git' }
  }
  try {
    const raw = await browser.callTool({
      name: BASH_WIRE_NAME,
      args: { command },
      executionContext: { sessionId: context.options.sessionId || undefined },
    })
    const text = unwrapToString(raw)
    // OnBashExecDone emits "(no output)" for an empty (but successful) command.
    return { ok: true, stdout: text === '(no output)' ? '' : text }
  } catch (e) {
    return { ok: false, stdout: e instanceof Error ? e.message : String(e) }
  }
}

export type AgentWorktree = {
  checkoutDir: string
  branch: string
  /** HEAD at creation — the baseline for change detection. Empty if unresolved. */
  baseCommit: string
}

/** Git-safe scratch branch name for a subagent's worktree. */
export function worktreeBranchFor(agentId: string): string {
  return `nexus-agent-${agentSlug(agentId)}`
}

/** Worktree directory for a subagent, under `<repoRoot>/.velloc/worktrees/`. */
export function agentCheckoutDir(repoRoot: string, agentId: string): string {
  return joinPath(repoRoot, RUNTIME_DIR_NAME, 'worktrees', agentSlug(agentId))
}

/**
 * Create an isolated worktree for a subagent off the repo's current HEAD.
 * Returns `null` on failure so the caller can fall back to the shared tree.
 */
export async function openAgentCheckout(
  context: ToolCallContext,
  repoRoot: string,
  agentId: string,
): Promise<AgentWorktree | null> {
  const checkoutDir = agentCheckoutDir(repoRoot, agentId)
  const branch = worktreeBranchFor(agentId)

  const add = await runGit(
    context,
    `git -C ${shellPath(repoRoot)} worktree add -B ${branch} ${shellPath(
      checkoutDir,
    )} HEAD`,
  )
  if (!add.ok) return null

  const head = await runGit(
    context,
    `git -C ${shellPath(checkoutDir)} rev-parse HEAD`,
  )
  return { checkoutDir, branch, baseCommit: head.ok ? head.stdout.trim() : '' }
}

/**
 * True if the worktree has uncommitted changes or new commits since `baseCommit`.
 * Fails closed: an inspection error or a missing `baseCommit` reports `true`, so
 * the caller keeps the worktree rather than force-removing unread work.
 */
export async function worktreeHasChanges(
  context: ToolCallContext,
  worktree: AgentWorktree,
): Promise<boolean> {
  const status = await runGit(
    context,
    `git -C ${shellPath(worktree.checkoutDir)} status --porcelain`,
  )
  if (!status.ok) return true
  if (status.stdout.trim() !== '') return true

  // No baseline commit (a partial `openAgentCheckout` whose `rev-parse HEAD`
  // failed) → we cannot tell whether work was committed, so keep the worktree.
  if (!worktree.baseCommit) return true

  const count = await runGit(
    context,
    `git -C ${shellPath(worktree.checkoutDir)} rev-list --count ${
      worktree.baseCommit
    }..HEAD`,
  )
  if (!count.ok) return true
  return Number(count.stdout.trim()) > 0
}

/** Remove a worktree and delete its scratch branch. Best-effort — failures are
 *  swallowed (an orphaned worktree is cleaned by `git worktree prune` later). */
export async function closeAgentCheckout(
  context: ToolCallContext,
  repoRoot: string,
  worktree: AgentWorktree,
): Promise<void> {
  await runGit(
    context,
    `git -C ${shellPath(repoRoot)} worktree remove --force ${shellPath(
      worktree.checkoutDir,
    )}`,
  )
  await runGit(
    context,
    `git -C ${shellPath(repoRoot)} branch -D ${worktree.branch}`,
  )
}
