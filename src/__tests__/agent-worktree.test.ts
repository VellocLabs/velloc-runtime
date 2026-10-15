import { describe, it, expect } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  openAgentCheckout,
  closeAgentCheckout,
  worktreeBranchFor,
  worktreeHasChanges,
  agentCheckoutDir,
  type AgentWorktree,
} from '../utils/agentWorktree'

type CallTool = (params: {
  name: string
  args: Record<string, unknown>
  executionContext?: unknown
}) => Promise<unknown>

function ctx(callTool: CallTool): ToolCallContext {
  return {
    platformCapabilities: { browser: { callTool } },
    options: { sessionId: 'sess-1' },
  } as unknown as ToolCallContext
}

/**
 * Build a fake host-Bash whose result is decided per-command. Returning an
 * `Error` simulates the OnBashExecDone reject-on-nonzero-exit contract; a
 * string simulates a successful command's combined-output body.
 */
function recorder(handler: (command: string) => string | Error) {
  const commands: string[] = []
  const callTool: CallTool = async ({ args }) => {
    const command = String((args as { command?: unknown }).command ?? '')
    commands.push(command)
    const r = handler(command)
    if (r instanceof Error) throw r
    return r
  }
  return { callTool, commands }
}

describe('agentWorktree — path/branch helpers', () => {
  it('derives a git-safe branch + worktree path from the agentId', () => {
    expect(worktreeBranchFor('subagent_AbC-123')).toBe(
      'nexus-agent-subagent_AbC-123',
    )
    // Unsafe shell/path chars are stripped from the slug.
    expect(worktreeBranchFor('a/b c:d')).toBe('nexus-agent-abcd')
    expect(agentCheckoutDir('/home/me/repo', 'idX')).toBe(
      '/home/me/repo/.velloc/worktrees/idX',
    )
  })

  it('keeps distinct paths/branches for long agent labels (preserves the unique id suffix)', () => {
    // createSidechainAgentId → `<label≤32>_<rand>_<ts>`. A blind 32-char slice
    // would drop the unique suffix for a long label, collapsing two parallel
    // sub-agents onto one worktree (silent isolation loss). The slug must keep
    // the suffix so distinct ids stay distinct.
    const long = 'a'.repeat(32)
    const idA = `${long}_aaaaaaaa_lx1`
    const idB = `${long}_bbbbbbbb_lx2`
    expect(agentCheckoutDir('/r', idA)).not.toBe(agentCheckoutDir('/r', idB))
    expect(worktreeBranchFor(idA)).not.toBe(worktreeBranchFor(idB))
  })
})

describe('agentWorktree — openAgentCheckout', () => {
  it('runs `git worktree add` off HEAD and returns the worktree + base commit', async () => {
    const { callTool, commands } = recorder(cmd =>
      cmd.includes('rev-parse HEAD') ? 'deadbeef\n' : '(no output)',
    )
    const wt = await openAgentCheckout(ctx(callTool), '/home/me/repo', 'idX')
    expect(wt).toEqual({
      checkoutDir: '/home/me/repo/.velloc/worktrees/idX',
      branch: 'nexus-agent-idX',
      baseCommit: 'deadbeef',
    })
    expect(commands[0]).toContain('git -C "/home/me/repo"')
    expect(commands[0]).toContain('worktree add -B nexus-agent-idX')
    expect(commands[0]).toContain('HEAD')
  })

  it('returns null when `git worktree add` fails (rejects)', async () => {
    const { callTool } = recorder(() => new Error('fatal: already exists'))
    expect(
      await openAgentCheckout(ctx(callTool), '/home/me/repo', 'idX'),
    ).toBeNull()
  })
})

describe('agentWorktree — worktreeHasChanges', () => {
  const wt: AgentWorktree = {
    checkoutDir: '/repo/.velloc/worktrees/idX',
    branch: 'b',
    baseCommit: 'base1',
  }

  it('true when `status --porcelain` reports files', async () => {
    const { callTool } = recorder(cmd =>
      cmd.includes('status --porcelain') ? ' M src/a.ts' : '0',
    )
    expect(await worktreeHasChanges(ctx(callTool), wt)).toBe(true)
  })

  it('true when there are new commits since base', async () => {
    const { callTool } = recorder(cmd =>
      cmd.includes('status --porcelain') ? '(no output)' : '3',
    )
    expect(await worktreeHasChanges(ctx(callTool), wt)).toBe(true)
  })

  it('false when clean — no files and no new commits', async () => {
    const { callTool } = recorder(cmd =>
      cmd.includes('status --porcelain') ? '(no output)' : '0',
    )
    expect(await worktreeHasChanges(ctx(callTool), wt)).toBe(false)
  })

  // The host answers a successful Bash call with structured streams, inside
  // the `{data, agent_meta}` envelope; only `stdout` is the command's output.
  it("reads stdout from the host's structured shell result", async () => {
    const shell = (stdout: string) => ({
      data: { stdout, stderr: '', exit_code: 0, timed_out: false, truncated: false },
      agent_meta: {},
    })
    const clean: CallTool = async ({ args }) =>
      shell(String((args as { command?: unknown }).command).includes('rev-list') ? '0\n' : '')
    expect(await worktreeHasChanges(ctx(clean), wt)).toBe(false)
    const dirty: CallTool = async ({ args }) =>
      shell(String((args as { command?: unknown }).command).includes('status') ? ' M a.ts\n' : '0\n')
    expect(await worktreeHasChanges(ctx(dirty), wt)).toBe(true)
  })

  // Regression (G7-1): fail CLOSED. A failed `git status` must NOT be read as
  // "no changes" — that would let onCleanup `remove --force` a tree we could
  // not inspect, destroying uncommitted work. Any non-zero git exit therefore
  // reports changes.
  it('true (fail-closed) when `git status --porcelain` errors', async () => {
    const { callTool } = recorder(cmd =>
      cmd.includes('status --porcelain')
        ? new Error('fatal: not a git repository')
        : '0',
    )
    expect(await worktreeHasChanges(ctx(callTool), wt)).toBe(true)
  })

  // Regression (G7-1): fail closed on a `rev-list` error too (clean tree, but
  // we cannot verify there are no new commits → keep).
  it('true (fail-closed) when `rev-list --count` errors', async () => {
    const { callTool } = recorder(cmd =>
      cmd.includes('status --porcelain')
        ? '(no output)'
        : new Error('fatal: bad revision'),
    )
    expect(await worktreeHasChanges(ctx(callTool), wt)).toBe(true)
  })

  // Regression (G7-4): an empty baseCommit (partial openAgentCheckout where
  // `rev-parse HEAD` failed) means we cannot diff for committed work — keep the
  // worktree rather than removing a clean tree that may hold commits.
  it('true (fail-closed) when there is no baseCommit baseline', async () => {
    const noBase: AgentWorktree = { ...wt, baseCommit: '' }
    const { callTool } = recorder(() => '(no output)')
    expect(await worktreeHasChanges(ctx(callTool), noBase)).toBe(true)
  })
})

describe('agentWorktree — closeAgentCheckout', () => {
  it('removes the worktree and deletes the scratch branch', async () => {
    const wt: AgentWorktree = {
      checkoutDir: '/repo/.velloc/worktrees/idX',
      branch: 'nexus-agent-idX',
      baseCommit: 'b',
    }
    const { callTool, commands } = recorder(() => '(no output)')
    await closeAgentCheckout(ctx(callTool), '/repo', wt)
    expect(commands.some(c => c.includes('worktree remove --force'))).toBe(true)
    expect(commands.some(c => c.includes('branch -D nexus-agent-idX'))).toBe(
      true,
    )
  })
})
